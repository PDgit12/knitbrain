import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Platform = "claude-code" | "cursor" | "codex" | "unknown";

export interface DetectInputs {
  env: NodeJS.ProcessEnv;
  exists: (path: string) => boolean;
  home: string;
}

/** Detect which coding platform(s) are present (pure — inputs injected). */
export function detectPlatforms(inp: DetectInputs): Platform[] {
  const found: Platform[] = [];
  if (
    inp.env["CLAUDECODE"] ||
    inp.env["CLAUDE_CODE"] ||
    inp.exists(join(inp.home, ".claude.json")) ||
    inp.exists(join(inp.home, ".claude"))
  ) {
    found.push("claude-code");
  }
  if (inp.exists(join(inp.home, ".cursor"))) found.push("cursor");
  if (inp.exists(join(inp.home, ".codex"))) found.push("codex");
  return found.length > 0 ? found : ["unknown"];
}

export interface SetupConfig {
  mcpServers: Record<string, { command: string }>;
  proxyEnv: Record<string, string>;
  proxyPort: number;
}

/** The config knitbrain wires up: an MCP server entry + the proxy base URLs. */
export function generateConfig(opts: { proxyPort?: number } = {}): SetupConfig {
  const port = opts.proxyPort ?? 8788;
  return {
    mcpServers: { knitbrain: { command: "knitbrain" } },
    proxyEnv: {
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
      OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`,
    },
    proxyPort: port,
  };
}

/** Merge knitbrain's MCP server into a project-local .mcp.json (safe, non-clobbering). */
export function mergeMcpJson(existing: string | null, cfg: SetupConfig): string {
  let parsed: { mcpServers?: Record<string, unknown> } = {};
  if (existing) {
    try {
      parsed = JSON.parse(existing) as { mcpServers?: Record<string, unknown> };
    } catch {
      parsed = {};
    }
  }
  const mcpServers = { ...(parsed.mcpServers ?? {}), ...cfg.mcpServers };
  return JSON.stringify({ ...parsed, mcpServers }, null, 2) + "\n";
}

/** CLI: detect the platform, wire a project-local .mcp.json, print proxy setup. */
export function runSetup(cwd: string = process.cwd()): number {
  const platforms = detectPlatforms({ env: process.env, exists: existsSync, home: homedir() });
  const cfg = generateConfig();

  const mcpPath = join(cwd, ".mcp.json");
  const merged = mergeMcpJson(existsSync(mcpPath) ? readFileSync(mcpPath, "utf8") : null, cfg);
  const tmp = `${mcpPath}.${process.pid}.tmp`;
  writeFileSync(tmp, merged, "utf8");
  renameSync(tmp, mcpPath);

  console.log("knitbrain setup");
  console.log(`  detected platform(s): ${platforms.join(", ")}`);
  console.log(`  ✓ registered MCP server in ${mcpPath}`);
  console.log("");
  console.log("  To route prompts through the optimizer proxy, start it:");
  console.log("    knitbrain-proxy");
  console.log("  and point your client at it:");
  for (const [k, v] of Object.entries(cfg.proxyEnv)) console.log(`    export ${k}=${v}`);
  return 0;
}
