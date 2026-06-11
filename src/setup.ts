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
export function runSetup(cwd: string = process.cwd()): number {
  const platforms = detectPlatforms({ env: process.env, exists: existsSync, home: homedir() });
  const cfg = generateConfig();

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
  if (platforms.includes("codex")) {
    console.log("  Codex CLI detected — its MCP config is global; add this yourself:");
    for (const line of codexSnippet(cfg).split("\n")) console.log(`    ${line}`);
  }
  if (platforms.includes("windsurf")) {
    console.log("  Windsurf detected — rules written; MCP config is global, add this yourself:");
    for (const line of windsurfSnippet().split("\n")) console.log(`    ${line}`);
  }
  if (platforms.includes("zed")) {
    console.log("  Zed detected — MCP config is global, add this yourself:");
    for (const line of zedSnippet().split("\n")) console.log(`    ${line}`);
  }
  if (platforms.includes("copilot-cli")) {
    // VS Code Copilot is covered by the vscode artifacts (.vscode/mcp.json +
    // .github/instructions); the standalone CLI keeps its config global.
    console.log("  Copilot CLI detected — its MCP config is global, add this yourself:");
    for (const line of copilotSnippet().split("\n")) console.log(`    ${line}`);
  }
  console.log("");
  console.log("  The operating protocol itself needs NO setup: it rides the MCP handshake");
  console.log("  (any MCP client gets it). For platforms without MCP-instructions support,");
  console.log("  paste the output of:  knitbrain prompt");

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
