import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SetupConfig } from "./setup.js";

/**
 * Platform adapter matrix — each coding platform gets its NATIVE integration
 * artifacts, not a lowest-common-denominator. The MCP server is the universal
 * core; adapters add what each platform uniquely supports (slash commands,
 * rules files, config shapes). The proxy is only suggested where the platform
 * supports a base-URL override.
 */
export interface Artifact {
  /** Path relative to the project root. */
  path: string;
  content: string;
  /** Merge strategy: json-merge for shared config files, write for ours. */
  mode: "write" | "json-merge-mcp";
}

const NOTATION_GUIDE = `Knit Brain compresses large tool outputs into skeletons. A \`⟨ccr:HASH⟩\` marker means the exact original is stored locally — call the \`knitbrain_retrieve\` tool with that hash to read it byte-for-byte. Check \`knitbrain_context_meter\` periodically; when it says to, save a handoff with \`knitbrain_save_handoff\` and start a fresh session (\`knitbrain_load_session\` restores everything).`;

/** Claude Code: .mcp.json + native slash commands. */
export function claudeArtifacts(cfg: SetupConfig): Artifact[] {
  return [
    { path: ".mcp.json", content: "", mode: "json-merge-mcp" },
    {
      path: ".claude/commands/meter.md",
      mode: "write",
      content: `---\ndescription: Show the Knit Brain context-window meter (usage %, tokens saved, handoff advice)\n---\n\nCall the \`knitbrain_context_meter\` tool and present the reading clearly: usage %, tokens saved this session, and the advice line. If status is "handoff", follow the advice now.\n`,
    },
    {
      path: ".claude/commands/handoff.md",
      mode: "write",
      content: `---\ndescription: Save a Knit Brain session handoff (goal, state, next steps) so a fresh session resumes cleanly\n---\n\nSummarize the current goal, completed work, in-flight files, and concrete next steps, then call \`knitbrain_save_handoff\` with that summary as \`state\`. Confirm to the user that a fresh session will resume via \`knitbrain_load_session\`.\n`,
    },
    {
      path: ".claude/rules/knitbrain.md",
      mode: "write",
      content: `# Knit Brain\n\n${NOTATION_GUIDE}\n\nProxy (optional, API-key setups): start \`knitbrain-proxy\` and set \`ANTHROPIC_BASE_URL=${cfg.proxyEnv["ANTHROPIC_BASE_URL"]}\`.\n`,
    },
  ];
}

/** Cursor: .cursor/mcp.json + an always-on rules file. */
export function cursorArtifacts(): Artifact[] {
  return [
    { path: ".cursor/mcp.json", content: "", mode: "json-merge-mcp" },
    {
      path: ".cursor/rules/knitbrain.mdc",
      mode: "write",
      content: `---\ndescription: Knit Brain memory + token optimization\nalwaysApply: true\n---\n\n${NOTATION_GUIDE}\n`,
    },
  ];
}

/** VS Code (Copilot): .vscode/mcp.json (uses "servers" key) + instructions. */
export function vscodeArtifacts(): Artifact[] {
  return [
    { path: ".vscode/mcp.json", content: "", mode: "json-merge-mcp" },
    {
      path: ".github/instructions/knitbrain.instructions.md",
      mode: "write",
      content: `---\napplyTo: "**"\n---\n\n${NOTATION_GUIDE}\n`,
    },
  ];
}

/** Codex CLI: global config — print a snippet rather than touching ~/.codex. */
export function codexSnippet(cfg: SetupConfig): string {
  return [
    "# Add to ~/.codex/config.toml :",
    "[mcp_servers.knitbrain]",
    'command = "knitbrain"',
    "",
    "# Optional proxy (Codex supports base-URL override):",
    `#   export OPENAI_BASE_URL=${cfg.proxyEnv["OPENAI_BASE_URL"]}`,
  ].join("\n");
}

/** VS Code's mcp.json uses {"servers": …}; everyone else uses {"mcpServers": …}. */
function mcpKeyFor(path: string): "servers" | "mcpServers" {
  return path.startsWith(".vscode/") ? "servers" : "mcpServers";
}

/** Apply an artifact list into a project, non-clobbering. Returns written paths. */
export function applyArtifacts(root: string, artifacts: Artifact[], cfg: SetupConfig): string[] {
  const written: string[] = [];
  for (const a of artifacts) {
    const full = join(root, a.path);
    mkdirSync(dirname(full), { recursive: true });
    let content = a.content;
    if (a.mode === "json-merge-mcp") {
      const key = mcpKeyFor(a.path);
      let parsed: Record<string, unknown> = {};
      if (existsSync(full)) {
        try {
          parsed = JSON.parse(readFileSync(full, "utf8")) as Record<string, unknown>;
        } catch {
          parsed = {};
        }
      }
      const servers = { ...((parsed[key] as Record<string, unknown>) ?? {}), ...cfg.mcpServers };
      content = JSON.stringify({ ...parsed, [key]: servers }, null, 2) + "\n";
    }
    const tmp = `${full}.${process.pid}.tmp`;
    writeFileSync(tmp, content, "utf8");
    renameSync(tmp, full);
    written.push(a.path);
  }
  return written;
}
