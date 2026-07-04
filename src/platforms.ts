import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { writeAtomic } from "./atomic.js";
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
  /** Merge strategy: json-merges for shared config files, write for ours,
   *  write-if-absent for shared files we must not clobber (e.g. AGENTS.md). */
  mode: "write" | "write-if-absent" | "json-merge-mcp" | "json-merge-hooks";
}

/** Hook wiring for Claude Code settings.json (Layer 2 enforcement). The
 * SessionStart hook makes the loop's first step automatic (protocol + memory
 * injected without the agent calling load_session); Stop keeps session-end
 * resumable; PreCompact saves before compaction; PreToolUse hard-redirects
 * large raw Reads to knitbrain_read; PostToolUse skeletonizes the output of
 * the host tools PreToolUse can't redirect (Bash/Grep/Glob/WebFetch) inline. */
export const KNITBRAIN_HOOKS = {
  SessionStart: [
    {
      matcher: "",
      hooks: [{ type: "command", command: "knitbrain-hook sessionstart" }],
    },
  ],
  UserPromptSubmit: [
    {
      matcher: "",
      hooks: [{ type: "command", command: "knitbrain-hook userpromptsubmit" }],
    },
  ],
  PreToolUse: [
    {
      matcher: "Read",
      hooks: [{ type: "command", command: "knitbrain-hook pretooluse" }],
    },
  ],
  PostToolUse: [
    {
      matcher: "Bash|Grep|Glob|WebFetch|WebSearch",
      hooks: [{ type: "command", command: "knitbrain-hook posttooluse" }],
    },
  ],
  PreCompact: [
    {
      matcher: "",
      hooks: [{ type: "command", command: "knitbrain-hook precompact" }],
    },
  ],
  Stop: [
    {
      matcher: "",
      hooks: [{ type: "command", command: "knitbrain-hook stop" }],
    },
  ],
} as const;

const NOTATION_GUIDE = `Knit Brain compresses large tool outputs into skeletons. A \`⟨recall:HASH⟩\` marker means the exact original is stored locally — call the \`knitbrain_retrieve\` tool with that hash to read it byte-for-byte. Check \`knitbrain_context_meter\` periodically; when it says to, save a handoff with \`knitbrain_save_handoff\` and start a fresh session (\`knitbrain_load_session\` restores everything). When the user states a task, call \`knitbrain_run\` first and follow its directive (skill + agents + commands).

**Reading files:** for any file you expect to be large (>~150 lines) or that you only need to navigate (find a function, check structure), use \`knitbrain_read\` instead of the host's raw read — same information shape at ~70-90% fewer tokens, exact original one \`knitbrain_retrieve\` away. Use the raw read only when you need every line verbatim right now (e.g. just before editing a specific region).`;

/**
 * Terse mode — output-side token optimization (the input side is the
 * optimizer/CCR). Answer telegraphically: same technical content, far fewer
 * tokens. Levels mirror common practice (lite/full/ultra).
 */
export const TERSE_MODE = `## Terse mode (output tokens)

Answer terse. Same facts, fewer words:
- Drop filler, pleasantries, hedging ("I'd be happy to", "it seems that", "you might want to consider").
- Drop articles where meaning survives. Fragments OK.
- Tables/bullets over prose. Code over description.
- Never drop: technical content, numbers, file paths, caveats that change decisions.
- Levels: lite = drop filler only · full (default) = fragments OK · ultra = bare telegraphic.
- User says "verbose"/"explain fully" → switch off for that answer.

Example — verbose: "The reason your component re-renders is likely that you're creating a new object reference on each render; consider useMemo."
Terse: "New object ref each render → re-render. Wrap in useMemo."`;

export type TerseLevel = "lite" | "full" | "ultra";

/** Output-side terse instruction at a chosen level. Single source: the CLI
 * (`knitbrain terse`), the /terse slash command, and the rules files all use
 * TERSE_MODE; this just stamps the active level on it. */
export function terseGuide(level: TerseLevel = "full"): string {
  return `${TERSE_MODE}\n\nActive level: **${level}**.`;
}

/** Universal: AGENTS.md is the cross-agent standard (Codex, Amp, Gemini,
 * OpenCode, Cursor, … all read it). Written for every setup, never clobbering
 * a user's existing AGENTS.md. The MCP server itself is the integration; this
 * carries the notation + terse guidance to agents we don't write native config
 * for. */
export function universalArtifacts(): Artifact[] {
  return [
    {
      path: "AGENTS.md",
      mode: "write-if-absent",
      content: `# Knit Brain\n\n${NOTATION_GUIDE}\n\n${TERSE_MODE}\n`,
    },
  ];
}

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
      path: ".claude/commands/terse.md",
      mode: "write",
      content: `---\ndescription: Terse knitbrain output (lite|full|ultra) — same facts, fewer output tokens\nargument-hint: [lite|full|ultra]\n---\n\nAdopt terse output for the rest of this session. Run \`knitbrain terse $ARGUMENTS\` and follow the printed guide (default level: full). Say "verbose" to switch off.\n`,
    },
    {
      path: ".claude/commands/goal.md",
      mode: "write",
      content: `---\ndescription: Run the full knitbrain workflow for a goal — orchestrate skill + agents, then drive to a checkable gate until met\nargument-hint: <goal, e.g. "ship X: all boxes ticked">\n---\n\nDrive \`$ARGUMENTS\` to done with the full knitbrain workflow. The gate is the truth, not your judgment.\n\n1. Treat \`$ARGUMENTS\` as the goal. If it names or implies a checkbox goal file (e.g. a \`goal.md\`), use that file; otherwise state the goal inline.\n2. ORCHESTRATE FIRST — call the \`knitbrain_run\` tool with the goal and ADHERE to the verdict:\n   - \`autoPlanMode=true\` → enter your host's plan mode and get approval before any edit;\n   - adopt the returned SKILL; refine it while working, then \`knitbrain_skill_save\`;\n   - if it proposes agents, spawn them via your host's sub-agent mechanism and coordinate on \`knitbrain_team_post\` / \`knitbrain_team_board\`;\n   - run the listed host slash-commands when useful.\n3. Pick the verify command by precedence: an explicit \`--verify\` in the args, else the goal file's \`VERIFY:\` line, else \`npm test\` when a package.json exists. If none is derivable, ASK the user for the gate — do NOT invent a command that passes.\n4. Read an optional \`--for <duration>\` from the args (e.g. \`30m\`, \`1h\`, \`90s\`) and convert it to milliseconds — that's the wall-clock budget.\n5. Call the \`knitbrain_run_loop\` tool with \`{ goal, verify_cmd, max_iters, deadline_ms }\` (max_iters default 6; omit \`deadline_ms\` when no \`--for\` was given).\n6. Each cycle, follow the returned directive: make the smallest real fix (delegating to the spawned agents where apt), then call \`knitbrain_run_loop\` again with the SAME goal so iteration + the time budget carry across calls.\n7. NEVER fake \`met=true\`. Stop only at a real \`met=true\`, OR \`max_iters\`, OR the \`--for\` deadline (\`stopped:"deadline"\`), then report the honest final state (what passed, what's still open) and close the loop: \`knitbrain_record_learning\` + \`knitbrain_skill_outcome\`.\n`,
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

/** Copilot CLI: MCP config is global (~/.copilot) — print a snippet. The
 * project-side .github/instructions file is shared with VS Code Copilot. */
export function copilotSnippet(): string {
  return [
    "# Add to ~/.copilot/mcp-config.json :",
    '{ "mcpServers": { "knitbrain": { "type": "local", "command": "knitbrain", "tools": ["*"] } } }',
  ].join("\n");
}

/** VS Code (GitHub Copilot agent mode): .vscode/mcp.json (uses "servers"
 * key) + .github/instructions — the native Copilot instruction surface. */
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

/** Windsurf: project rules are native; MCP config is global (snippet). */
export function windsurfArtifacts(): Artifact[] {
  return [
    {
      path: ".windsurf/rules/knitbrain.md",
      mode: "write",
      content: `---\ntrigger: always_on\n---\n\n${NOTATION_GUIDE}\n\n${TERSE_MODE}\n`,
    },
  ];
}

/** Windsurf's MCP config lives in ~/.codeium/windsurf — never clobber it. */
export function windsurfSnippet(): string {
  return [
    "# Add to ~/.codeium/windsurf/mcp_config.json :",
    '{ "mcpServers": { "knitbrain": { "command": "knitbrain" } } }',
  ].join("\n");
}

/** Zed: MCP servers live in global settings — print a snippet. */
export function zedSnippet(): string {
  return [
    "# Add to Zed settings.json (cmd-,) :",
    '"context_servers": { "knitbrain": { "command": { "path": "knitbrain" } } }',
  ].join("\n");
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
    // Shared standard files (AGENTS.md): never clobber a user's existing one.
    if (a.mode === "write-if-absent" && existsSync(full)) continue;
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
    writeAtomic(full, content);
    written.push(a.path);
  }
  return written;
}
