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
  /** Merge strategy: json-merges for shared config files, write for ours. */
  mode: "write" | "json-merge-mcp" | "json-merge-hooks";
}

/** Hook wiring for Claude Code settings.json (Layer 2 enforcement). */
export const KNITBRAIN_HOOKS = {
  PreToolUse: [
    {
      matcher: "Read",
      hooks: [{ type: "command", command: "knitbrain-hook pretooluse" }],
    },
  ],
  PreCompact: [
    {
      matcher: "",
      hooks: [{ type: "command", command: "knitbrain-hook precompact" }],
    },
  ],
} as const;

const NOTATION_GUIDE = `Knit Brain compresses large tool outputs into skeletons. A \`⟨ccr:HASH⟩\` marker means the exact original is stored locally — call the \`knitbrain_retrieve\` tool with that hash to read it byte-for-byte. Check \`knitbrain_context_meter\` periodically; when it says to, save a handoff with \`knitbrain_save_handoff\` and start a fresh session (\`knitbrain_load_session\` restores everything). When the user states a task, call \`knitbrain_run\` first and follow its directive (skill + agents + commands).

**Reading files:** for any file you expect to be large (>~150 lines) or that you only need to navigate (find a function, check structure), use \`knitbrain_read\` instead of the host's raw read — same information shape at ~70-90% fewer tokens, exact original one \`knitbrain_retrieve\` away. Use the raw read only when you need every line verbatim right now (e.g. just before editing a specific region).`;

/**
 * Terse mode — output-side token optimization (the input side is the
 * optimizer/CCR). Answer telegraphically: same technical content, far fewer
 * tokens. Levels mirror common practice (lite/full/ultra).
 */
const TERSE_MODE = `## Terse mode (output tokens)

Answer terse. Same facts, fewer words:
- Drop filler, pleasantries, hedging ("I'd be happy to", "it seems that", "you might want to consider").
- Drop articles where meaning survives. Fragments OK.
- Tables/bullets over prose. Code over description.
- Never drop: technical content, numbers, file paths, caveats that change decisions.
- Levels: lite = drop filler only · full (default) = fragments OK · ultra = bare telegraphic.
- User says "verbose"/"explain fully" → switch off for that answer.

Example — verbose: "The reason your component re-renders is likely that you're creating a new object reference on each render; consider useMemo."
Terse: "New object ref each render → re-render. Wrap in useMemo."`;

/** Claude Code: .mcp.json + native slash commands. */
export function claudeArtifacts(cfg: SetupConfig): Artifact[] {
  return [
    { path: ".mcp.json", content: "", mode: "json-merge-mcp" },
    { path: ".claude/settings.json", content: "", mode: "json-merge-hooks" },
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
      content: `# Knit Brain\n\n${NOTATION_GUIDE}\n\n${TERSE_MODE}\n\nProxy (optional, API-key setups): start \`knitbrain-proxy\` and set \`ANTHROPIC_BASE_URL=${cfg.proxyEnv["ANTHROPIC_BASE_URL"]}\`.\n`,
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
      content: `---\ndescription: Knit Brain memory + token optimization\nalwaysApply: true\n---\n\n${NOTATION_GUIDE}\n\n${TERSE_MODE}\n`,
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
      content: `---\napplyTo: "**"\n---\n\n${NOTATION_GUIDE}\n\n${TERSE_MODE}\n`,
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

/**
 * Slash-command registry — what the AGENT can run itself on each platform.
 * Surfaced by knitbrain_run so the loop is autonomous: knitbrain says which
 * host command to invoke, the agent invokes it.
 */
export function slashCommands(platform: string): Array<{ cmd: string; when: string }> {
  if (platform === "claude-code") {
    return [
      { cmd: "/meter", when: "check context window (knitbrain meter)" },
      { cmd: "/handoff", when: "save session handoff before clearing" },
      { cmd: "/clear", when: "after handoff saved — start fresh window" },
      { cmd: "/compact", when: "mid-task when window warn but can't clear yet" },
    ];
  }
  if (platform === "cursor") {
    return [{ cmd: "@knitbrain rules", when: "re-read knitbrain usage rules" }];
  }
  return [];
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
    if (a.mode === "json-merge-mcp" || a.mode === "json-merge-hooks") {
      let parsed: Record<string, unknown> = {};
      if (existsSync(full)) {
        try {
          parsed = JSON.parse(readFileSync(full, "utf8")) as Record<string, unknown>;
        } catch {
          parsed = {};
        }
      }
      if (a.mode === "json-merge-mcp") {
        const key = mcpKeyFor(a.path);
        const servers = { ...((parsed[key] as Record<string, unknown>) ?? {}), ...cfg.mcpServers };
        content = JSON.stringify({ ...parsed, [key]: servers }, null, 2) + "\n";
      } else {
        // Merge our hook entries into existing hooks, deduped by command —
        // never clobber the user's own hooks.
        const hooks = { ...((parsed["hooks"] as Record<string, unknown[]>) ?? {}) };
        for (const [event, entries] of Object.entries(KNITBRAIN_HOOKS)) {
          const existing = (hooks[event] ?? []) as Array<{ hooks?: Array<{ command?: string }> }>;
          const ours = entries.filter(
            (e) => !existing.some((x) => x.hooks?.some((h) => h.command === e.hooks[0].command)),
          );
          hooks[event] = [...existing, ...ours];
        }
        content = JSON.stringify({ ...parsed, hooks }, null, 2) + "\n";
      }
    }
    const tmp = `${full}.${process.pid}.tmp`;
    writeFileSync(tmp, content, "utf8");
    renameSync(tmp, full);
    written.push(a.path);
  }
  return written;
}
