import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  applyArtifacts,
  claudeArtifacts,
  codexSnippet,
  cursorArtifacts,
  vscodeArtifacts,
  windsurfArtifacts,
  windsurfSnippet,
  zedSnippet,
  copilotSnippet,
} from "./platforms.js";
import { applyGlobalConfig, type GlobalConfigKind } from "./global-config.js";

export type Platform =
  | "claude-code"
  | "cursor"
  | "codex"
  | "vscode"
  | "windsurf"
  | "zed"
  | "copilot-cli"
  | "unknown";

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
  if (inp.exists(join(inp.home, ".vscode")) || inp.env["TERM_PROGRAM"] === "vscode") {
    found.push("vscode");
  }
  if (inp.exists(join(inp.home, ".codeium", "windsurf"))) found.push("windsurf");
  if (inp.exists(join(inp.home, ".config", "zed"))) found.push("zed");
  if (inp.exists(join(inp.home, ".copilot"))) found.push("copilot-cli");
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

/**
 * CLI: detect platforms and emit each one's NATIVE artifacts (adapter matrix):
 * Claude Code → .mcp.json + slash commands + rules; Cursor → .cursor/mcp.json
 * + rules; VS Code/Copilot → .vscode/mcp.json + instructions; Codex → config
 * snippet (its config is global — we never clobber it). Unknown → .mcp.json.
 */
/** Map a detected global-config platform to its writer kind. */
const GLOBAL_KIND: Partial<Record<Platform, GlobalConfigKind>> = {
  codex: "codex",
  windsurf: "windsurf",
  zed: "zed",
  "copilot-cli": "copilot-cli",
};

export function runSetup(cwd: string = process.cwd(), argv: string[] = process.argv.slice(3)): number {
  const platforms = detectPlatforms({ env: process.env, exists: existsSync, home: homedir() });
  const cfg = generateConfig();
  // --yes writes global configs (Codex/Windsurf/Zed/Copilot CLI) directly,
  // backed up + non-clobbering, instead of printing a snippet to paste.
  const writeGlobals = argv.includes("--yes") || argv.includes("-y");

  console.log("knitbrain setup");
  console.log(`  detected platform(s): ${platforms.join(", ")}`);

  const artifacts = [];
  if (platforms.includes("claude-code") || platforms.includes("unknown")) {
    artifacts.push(...claudeArtifacts(cfg));
  }
  if (platforms.includes("cursor")) artifacts.push(...cursorArtifacts());
  if (platforms.includes("vscode")) artifacts.push(...vscodeArtifacts());
  if (platforms.includes("windsurf")) artifacts.push(...windsurfArtifacts());
  for (const path of applyArtifacts(cwd, artifacts, cfg)) console.log(`  ✓ wrote ${path}`);
  // Global-config platforms: with --yes we WRITE the config (backed up,
  // non-clobbering); otherwise we print the snippet to paste (safe default).
  const snippets: Partial<Record<Platform, () => string>> = {
    codex: () => codexSnippet(cfg),
    windsurf: windsurfSnippet,
    zed: zedSnippet,
    "copilot-cli": copilotSnippet,
  };
  let printedGlobalHint = false;
  for (const platform of ["codex", "windsurf", "zed", "copilot-cli"] as Platform[]) {
    if (!platforms.includes(platform)) continue;
    const kind = GLOBAL_KIND[platform]!;
    if (writeGlobals) {
      const { path, status } = applyGlobalConfig(kind, homedir());
      console.log(`  ✓ ${status} ${path}${status === "written" ? " (backed up)" : ""}`);
    } else {
      console.log(`  ${platform} detected — its MCP config is global. Paste this, or re-run with --yes to write it:`);
      for (const line of snippets[platform]!().split("\n")) console.log(`    ${line}`);
      printedGlobalHint = true;
    }
  }
  if (printedGlobalHint) console.log("  (tip: knitbrain setup --yes writes these for you, backed up + non-clobbering)");
  console.log("");
  console.log("  The operating protocol itself needs NO setup: it rides the MCP handshake");
  console.log("  (any MCP client gets it). For platforms without MCP-instructions support,");
  console.log("  paste the output of:  knitbrain prompt");

  console.log("");
  console.log("  Statusline badge (lifetime tokens saved) — add to .claude/settings.json:");
  console.log('    "statusLine": { "type": "command", "command": "knitbrain statusline" }');
  console.log("    (one tool owns the statusline; KNITBRAIN_STATUSLINE=0 silences it)");

  // Billing-mode detection: an API key in the environment means API /
  // pay-as-you-go traffic that CAN be proxied; no key usually means a
  // subscription (Pro/Max) OAuth session that cannot — MCP-side optimization
  // carries those users (tool outputs are the bulk of context burn).
  const hasKey = Boolean(process.env["ANTHROPIC_API_KEY"] || process.env["OPENAI_API_KEY"]);
  console.log("");
  if (hasKey) {
    console.log("  API key detected (API / pay-as-you-go) — BOTH optimization doors apply.");
    console.log("  Route LLM requests through the optimizer proxy:");
    console.log("    knitbrain-proxy");
    for (const [k, v] of Object.entries(cfg.proxyEnv)) console.log(`    export ${k}=${v}`);
  } else {
    console.log("  No API key in env — likely a subscription plan (Pro/Max/OAuth).");
    console.log("  The proxy doesn't apply to OAuth traffic; MCP-side optimization is active");
    console.log("  (tool outputs, memory, meter, skills — the bulk of context burn).");
    console.log("  If you DO use an API key, export it and re-run setup for proxy wiring.");
  }
  return 0;
}
