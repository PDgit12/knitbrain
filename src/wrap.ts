import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `knitbrain wrap <agent>` — launch a coding agent with the optimizer proxy
 * already wired in. Removes the manual `export ANTHROPIC_BASE_URL=…` step:
 * starts the loopback proxy if it isn't up, points the agent's base-URL at
 * it, then execs the agent with inherited stdio. The agent talks to the proxy,
 * the proxy compresses requests and forwards upstream.
 */
export interface WrapPlan {
  /** The agent binary to exec. */
  binary: string;
  /** Which base-URL env var the agent honors. */
  envVar: "ANTHROPIC_BASE_URL" | "OPENAI_BASE_URL";
  /** The loopback proxy URL to point it at. */
  baseUrl: string;
}

export const DEFAULT_PROXY_PORT = 8788;

/** Map an agent name to its binary + the base-URL env var the proxy sets.
 * Pure (no IO) so the mapping is unit-tested; the spawn is the thin part. */
export function resolveWrap(agent: string, port: number = DEFAULT_PROXY_PORT): WrapPlan | { error: string } {
  const base = `http://127.0.0.1:${port}`;
  switch (agent) {
    case "claude":
      return { binary: "claude", envVar: "ANTHROPIC_BASE_URL", baseUrl: base };
    case "codex":
      return { binary: "codex", envVar: "OPENAI_BASE_URL", baseUrl: `${base}/v1` };
    case "aider":
      return { binary: "aider", envVar: "OPENAI_BASE_URL", baseUrl: `${base}/v1` };
    case "copilot":
      return { binary: "copilot", envVar: "OPENAI_BASE_URL", baseUrl: `${base}/v1` };
    default:
      return { error: `unknown agent "${agent}" — supported: claude, codex, aider, copilot` };
  }
}

/** API-key setups are proxyable; OAuth/subscription traffic is not (the proxy
 * only sees requests the agent sends with an overridable base URL). */
export function hasApiKey(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env["ANTHROPIC_API_KEY"] || env["OPENAI_API_KEY"]);
}

/** Is something already listening on the loopback proxy port? */
async function proxyHealthy(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Resolve the installed `knitbrain-proxy` entrypoint (sibling of this file). */
function proxyEntry(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "proxy", "index.js");
}

/** CLI runtime: start the proxy if needed, then exec the agent. */
export async function runWrap(argv: string[]): Promise<number> {
  const agent = argv[0];
  if (!agent) {
    console.error("usage: knitbrain wrap <claude|codex|aider|copilot> [-- agent args]");
    return 1;
  }
  // Everything after a literal `--` is passed through to the agent.
  const sep = argv.indexOf("--");
  const agentArgs = sep >= 0 ? argv.slice(sep + 1) : argv.slice(1);

  const port = Number(process.env["KNITBRAIN_PROXY_PORT"] ?? DEFAULT_PROXY_PORT);
  const plan = resolveWrap(agent, port);
  if ("error" in plan) {
    console.error(plan.error);
    return 1;
  }

  const subscription = argv.includes("--subscription");
  if (!hasApiKey(process.env) && !subscription) {
    // Safe default: never silently route someone's subscription OAuth through
    // a proxy. Launch direct; tell them the opt-in exists.
    console.error(
      "[knitbrain] No API key in env — you're likely on a subscription (OAuth).\n" +
        "  Launching the agent normally (no proxy). Your MCP-side optimization + memory still work.\n" +
        "  To ALSO compress subscription traffic on the wire, re-run with --subscription (see the note it prints).",
    );
    const direct = spawn(plan.binary, agentArgs, { stdio: "inherit", env: process.env });
    return new Promise((resolve) => direct.on("exit", (code) => resolve(code ?? 0)));
  }
  if (subscription && !hasApiKey(process.env)) {
    // Explicit opt-in: disclose exactly what happens to the token before we do it.
    console.error(
      "[knitbrain] --subscription: routing " + plan.binary + " through a LOCAL proxy (127.0.0.1) to\n" +
        "  compress requests. Your auth token is forwarded ONLY to the provider, never logged or stored\n" +
        "  (proven by the proxy's token-leak test). This routes subscription traffic through a local\n" +
        "  proxy — review your provider's terms if you're unsure. Continuing.",
    );
  }

  // Reuse a running proxy, else start one detached on the loopback port.
  if (!(await proxyHealthy(port))) {
    console.error(`[knitbrain] starting optimizer proxy on 127.0.0.1:${port} …`);
    const proxy = spawn(process.execPath, [proxyEntry()], {
      stdio: "ignore",
      detached: true,
      env: { ...process.env, KNITBRAIN_PROXY_PORT: String(port) },
    });
    proxy.unref();
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !(await proxyHealthy(port))) {
      await new Promise((r) => setTimeout(r, 150));
    }
    if (!(await proxyHealthy(port))) {
      console.error("[knitbrain] proxy did not come up in time — launching agent without it.");
    }
  }

  console.error(`[knitbrain] wrapping ${plan.binary} → ${plan.envVar}=${plan.baseUrl}`);
  const child = spawn(plan.binary, agentArgs, {
    stdio: "inherit",
    env: { ...process.env, [plan.envVar]: plan.baseUrl },
  });
  return new Promise((resolve) => {
    child.on("error", (err) => {
      console.error(`[knitbrain] failed to launch "${plan.binary}": ${String(err)}`);
      resolve(127);
    });
    child.on("exit", (code) => resolve(code ?? 0));
  });
}
