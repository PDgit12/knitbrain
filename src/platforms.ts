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
  mode: "write" | "write-if-absent" | "json-merge-mcp" | "json-merge-hooks" | "json-merge-cursor-hooks";
  /** json-merge-hooks only: which hook map to merge in (defaults to
   *  KNITBRAIN_HOOKS/Claude's shape for back-compat) — lets Codex/Gemini
   *  reuse the same merge logic with their own event names. */
  hooksData?: Record<string, ReadonlyArray<{ matcher?: string; hooks: ReadonlyArray<{ type: string; command: string }> }>>;
  /** json-merge-hooks only: true (default) nests entries under a "hooks" key
   *  (settings.json-style, shared with other settings); false means the file
   *  IS the hooks map at the top level (a dedicated hooks.json). */
  hooksWrapped?: boolean;
  /** json-merge-cursor-hooks only: which flat {command}-schema hook map to
   *  merge in (defaults to CURSOR_HOOKS) — lets Windsurf reuse the same
   *  flat-entry merge logic (dedupe by command, hooks:{event:[...]} wrapper)
   *  with its own event names. */
  flatHooksData?: Record<string, ReadonlyArray<{ command: string }>>;
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
  SubagentStart: [
    {
      matcher: "",
      hooks: [{ type: "command", command: "knitbrain-hook subagentstart" }],
    },
  ],
  SubagentStop: [
    {
      matcher: "",
      hooks: [{ type: "command", command: "knitbrain-hook subagentstop" }],
    },
  ],
} as const;

/** Codex CLI: repo `.codex/hooks.json` uses the SAME event names + hook entry
 * schema as Claude Code (verified official docs, July 2026) — reuse the map
 * verbatim rather than duplicating it. */
export const CODEX_HOOKS = KNITBRAIN_HOOKS;

/** Gemini CLI: repo `.gemini/settings.json`, PascalCase events that map 1:1
 * onto our four hook points; AfterAgent is Gemini's loop-enforcement point
 * (mirrors Claude's Stop). Entry schema mirrors Claude's (matcher/hooks/command). */
export const GEMINI_HOOKS = {
  SessionStart: KNITBRAIN_HOOKS.SessionStart,
  BeforeTool: KNITBRAIN_HOOKS.PreToolUse,
  AfterTool: KNITBRAIN_HOOKS.PostToolUse,
  PreCompress: KNITBRAIN_HOOKS.PreCompact,
  AfterAgent: KNITBRAIN_HOOKS.Stop,
} as const;

/** Cursor: repo `.cursor/hooks.json`, camelCase events, FLAT entry schema
 * ({command} only — no matcher/type wrapper). beforeReadFile/
 * beforeShellExecution/beforeMCPExecution all gate to our pretooluse hook
 * since Cursor splits what Claude covers with one PreToolUse matcher. */
export const CURSOR_HOOKS: Record<string, ReadonlyArray<{ command: string }>> = {
  beforeReadFile: [{ command: "knitbrain-hook pretooluse" }],
  beforeShellExecution: [{ command: "knitbrain-hook pretooluse" }],
  beforeMCPExecution: [{ command: "knitbrain-hook pretooluse" }],
  postToolUse: [{ command: "knitbrain-hook posttooluse" }],
  stop: [{ command: "knitbrain-hook stop" }],
  sessionStart: [{ command: "knitbrain-hook sessionstart" }],
} as const;

/** Windsurf: repo `.windsurf/hooks.json`, flat {command} schema (same shape
 *  as Cursor's, hooks:{event:[...]} wrapper) — deny-only surface (exit-2),
 *  no matcher/type wrapper. pre_run_command/pre_read_code/pre_mcp_tool_use
 *  all gate to our pretooluse hook. */
export const WINDSURF_HOOKS: Record<string, ReadonlyArray<{ command: string }>> = {
  pre_run_command: [{ command: "knitbrain-hook pretooluse" }],
  pre_read_code: [{ command: "knitbrain-hook pretooluse" }],
  pre_mcp_tool_use: [{ command: "knitbrain-hook pretooluse" }],
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

/**
 * Goal-loop steering (Gap 6 — the thesis: turn any platform into a loop).
 * Injected every turn by the UserPromptSubmit hook so the DEFAULT stance is
 * "drive this to a checkable gate", not "answer once" — the loop is opt-out
 * (pure questions), not opt-in (/goal). Kept to one line: it costs tokens on
 * every prompt, so it states the stance and defers mechanics to knitbrain_run.
 */
export const GOAL_LOOP_NUDGE =
  "Every actionable request is a GOAL — don't just answer once, DRIVE it: knitbrain_run to classify + get the skill/agents, then close on a checkable gate with knitbrain_run_loop (loop until met OR max_iters OR --for deadline, not a single pass). Pure question/inquiry → answer directly, no loop.";

/** Forward name for GOAL_LOOP_NUDGE (same content) — GOAL_LOOP_NUDGE kept
 * as the export so existing imports (hooks/index.ts, tests) don't break. */
export const GOAL_FRAME = GOAL_LOOP_NUDGE;

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
      content: `---\ndescription: Run the full knitbrain workflow for a goal — orchestrate skill + agents, then drive to a checkable gate until met\nargument-hint: <goal, e.g. "ship X: all boxes ticked">\n---\n\nDrive \`$ARGUMENTS\` to done with the full knitbrain workflow. The gate is the truth, not your judgment.\n\n1. Treat \`$ARGUMENTS\` as the goal. If it names or implies a checkbox goal file (e.g. a \`goal.md\`), use that file; otherwise state the goal inline.\n2. ORCHESTRATE FIRST — call the \`knitbrain_run\` tool with the goal and ADHERE to the verdict:\n   - \`autoPlanMode=true\` → enter your host's plan mode and get approval before any edit;\n   - adopt the returned SKILL; refine it while working, then \`knitbrain_skill_save\`;\n   - if it proposes agents, spawn them via your host's sub-agent mechanism and coordinate on \`knitbrain_team_post\` / \`knitbrain_team_board\`;\n   - run the listed host slash-commands when useful.\n3. Pick the verify command by precedence: an explicit \`--verify\` in the args, else the goal file's \`VERIFY:\` line, else \`npm test\` when a package.json exists. If none is derivable, ASK the user for the gate — do NOT invent a command that passes.\n4. Read an optional \`--for <duration>\` from the args (e.g. \`30m\`, \`1h\`, \`90s\`) and convert it to milliseconds — that's the wall-clock budget.\n5. Call the \`knitbrain_run_loop\` tool with \`{ goal, verify_cmd, max_iters, deadline_ms }\` (max_iters default 6; omit \`deadline_ms\` when no \`--for\` was given).\n6. Each cycle, follow the returned directive: make the smallest real fix (delegating to the spawned agents where apt), then call \`knitbrain_run_loop\` again with the SAME goal so iteration + the time budget carry across calls.\n7. NEVER fake \`met=true\`. Stop only at a real \`met=true\`, OR \`max_iters\`, OR the \`--for\` deadline (\`stopped:"deadline"\`), then report the honest final state (what passed, what's still open) and close the loop: \`knitbrain_record_learning\` + \`knitbrain_skill_outcome\`.\n\nSibling: \`/loop <goalfile>\` HANDS OFF to the EXTERNAL runner (\`knitbrain loop\`) — a detached background process that spawns a fresh agent per iteration and owns the loop itself, surviving your context window. Use \`/goal\` to drive a gate in THIS session; use \`/loop\` for hands-off autonomous runs.\n`,
    },
    {
      path: ".claude/rules/knitbrain.md",
      mode: "write",
      content: `# Knit Brain\n\n${NOTATION_GUIDE}\n\n${TERSE_MODE}\n\nProxy (optional, API-key setups): start \`knitbrain-proxy\` and set \`ANTHROPIC_BASE_URL=${cfg.proxyEnv["ANTHROPIC_BASE_URL"]}\`.\n`,
    },
  ];
}

/** Claude Code: /loop command — same engine as /goal, plus an explicit
 * --for/--iters budget and self-heal from prior-cycle failures (LoopState.failures,
 * surfaced automatically by knitbrain_run_loop's directive). Kept OUT of
 * claudeArtifacts() (applied separately in runSetup) so the artifact-count
 * test on claudeArtifacts() stays stable. */
export function claudeLoopArtifacts(): Artifact[] {
  return [
    {
      path: ".claude/commands/loop.md",
      mode: "write",
      content: `---\ndescription: Launch the autonomous external runner — a detached process that spawns a FRESH agent per iteration until the goal file's boxes are ticked or the time budget elapses\nargument-hint: <goalfile.md> [--for 1h] [--max N] [--agent "cmd"] [--verify "cmd"]\n---\n\n\`/loop\` LAUNCHES knitbrain's external runner (\`knitbrain loop\`) — a background process that OWNS the loop: for each \`- [ ]\` task in the goal file it spawns a FRESH agent (\`claude -p\` by default), runs the verify gate, ticks \`- [x]\` only on green, and repeats until all boxes are done, \`--max\` iterations, or the \`--for\` budget elapses. It survives your context window (fresh agent each iteration) and does NOT depend on any model choosing to continue — the runner re-invokes. A slash command cannot BE an hour-long loop (that would freeze this chat), so it LAUNCHES the runner detached and hands you a watch handle.\n\n1. Resolve the goal file from \`$ARGUMENTS\`: a path to a markdown file with \`- [ ] task\` checkboxes. If none is given, use \`goal.md\` in the cwd; if that is missing, tell the user to run \`knitbrain onboard\` first (it writes a goal.md) and stop — do NOT invent tasks.\n2. LAUNCH DETACHED so this chat is not frozen for the whole budget. Run in the background: \`nohup knitbrain loop <goalfile> <flags> > <goalfile>.loop.log 2>&1 & echo "loop PID $!"\`. Pass \`--for\`, \`--max\`, \`--agent\`, \`--verify\`, \`--reviewer\` straight through from \`$ARGUMENTS\`; the runner picks its gate itself (--verify > the goal file's VERIFY: line > npm test).\n3. Report to the user: the PID, the log path (\`<goalfile>.loop.log\`), and how to watch — \`- [ ]\`→\`- [x]\` boxes tick in the goal file as tasks pass, \`<goalfile>.progress\` appends one line per done task, and \`knitbrain dashboard\` shows the badge. Stop early with \`kill <PID>\`.\n4. Do NOT block waiting on it, and do NOT tick any box yourself — the runner's verify (and optional reviewer) gate is the ONLY thing that marks a task done. No false green.\n\nSibling: \`/goal <task>\` drives a gate WITH YOU in THIS session (single context, interactive, you make the fixes). \`/loop\` HANDS OFF to the external runner (fresh context per iteration, autonomous, background).\n`,
    },
  ];
}

/**
 * Body for a platform \`/loop\` command. None of these platforms can BE the
 * loop (a command runs inside one turn), so each LAUNCHES the external runner
 * (\`knitbrain loop\`) detached and reports a watch handle. \`workerAgent\` is the
 * headless CLI the runner spawns per iteration (claude -p / codex exec /
 * gemini -p). IDE-embedded hosts (VS Code, Windsurf, Cursor) have no headless
 * self → they drive an installed CLI worker (default claude -p; override with
 * --agent). Uniform text keeps the loop honest everywhere.
 */
export function loopLaunchInstructions(workerAgent: string): string {
  return [
    "Launch knitbrain's EXTERNAL runner in the BACKGROUND, then report the handle. Do NOT run the loop inline — it would block this session.",
    "1. Resolve a goal file from the arguments: a markdown file with `- [ ] task` checkboxes (default `goal.md`). If it is missing, tell the user to run `knitbrain onboard` first and stop — do NOT invent tasks.",
    "2. Using your terminal tool, run DETACHED (pass through any --for/--max/--verify/--reviewer the user gave):",
    "   nohup knitbrain loop <goalfile> --for 1h --agent \"" + workerAgent + "\" > <goalfile>.loop.log 2>&1 & echo \"loop PID $!\"",
    "3. Report the PID + log path (`<goalfile>.loop.log`). The runner spawns a FRESH \"" + workerAgent + "\" per `- [ ]` task, runs the verify gate, and ticks `- [x]` only on green. Watch the boxes tick, tail the log, or run `knitbrain dashboard`. Stop early with `kill <PID>`.",
    "4. Do NOT tick any box yourself — only the runner's verify (and optional reviewer) gate marks a task done. No false green.",
  ].join("\n");
}

/**
 * Body for a platform \`/goal\` command: drive a goal to a verify gate WITH YOU
 * in THIS session (single context, in-chat orchestration). Mirror of the Claude
 * goal.md steps, shared so no platform drifts. For a hands-off autonomous run
 * (fresh agent per iteration, background), it points to /loop instead.
 */
export function goalOrchestrationInstructions(): string {
  return [
    "Drive the goal in the arguments to done WITH YOU in THIS session (single context). The verify gate is the truth, not your judgment.",
    "1. Treat the arguments as the goal (or a `goal.md` checkbox file if one is named).",
    "2. ORCHESTRATE FIRST — call the knitbrain_run tool with the goal and ADHERE to its verdict: adopt the returned SKILL (refine it, then knitbrain_skill_save); if it proposes agents, spawn them via your host's sub-agent mechanism and coordinate on knitbrain_team_post.",
    "3. Pick the verify command by precedence: an explicit --verify > the goal file's `VERIFY:` line > `npm test` when a package.json exists. If none is derivable, ASK the user for the gate — do NOT invent a command that passes.",
    "4. Read an optional --for <30m|1h> and convert it to deadline_ms.",
    "5. Drive the knitbrain_run_loop tool each cycle with { goal, verify_cmd, max_iters, deadline_ms }: make the smallest real fix, then call knitbrain_run_loop again with the SAME goal so iteration + the time budget carry across calls.",
    "6. NEVER fake met=true. Stop only at a real met=true, OR max_iters, OR the --for deadline, then report the honest final state (what passed, what is still open) and close the loop: knitbrain_record_learning + knitbrain_skill_outcome.",
    "",
    "For a HANDS-OFF autonomous run (a FRESH agent per iteration, in the background), use /loop instead — it launches the external runner (knitbrain loop).",
  ].join("\n");
}

/** Cursor: .cursor/mcp.json + hooks.json (Layer 2 enforcement) + an
 * always-on rules file. */
export function cursorArtifacts(): Artifact[] {
  return [
    { path: ".cursor/mcp.json", content: "", mode: "json-merge-mcp" },
    { path: ".cursor/hooks.json", content: "", mode: "json-merge-cursor-hooks" },
    {
      path: ".cursor/rules/knitbrain.mdc",
      mode: "write",
      content: `---\ndescription: Knit Brain memory + token optimization\nalwaysApply: true\n---\n\n${NOTATION_GUIDE}\n\n${TERSE_MODE}\n\nAutonomous loop (Cursor has no custom slash commands): run the external runner in your terminal — \`knitbrain loop goal.md --for 1h --agent "claude -p"\` (spawns a fresh worker per \`- [ ]\` task, verify-gated, ticks \`- [x]\` only on green).\n\nGoal orchestration (no slash on Cursor): just state the task — call knitbrain_run first, adopt the returned skill, then drive knitbrain_run_loop to a verify gate in THIS session (same as /goal elsewhere).\n`,
    },
  ];
}

/** Codex CLI: repo `.codex/hooks.json` (Layer 2 enforcement — same event
 * names + schema as Claude Code, see CODEX_HOOKS). MCP config stays a
 * snippet (codexSnippet) since it's global, not project-local. */
export function codexArtifacts(): Artifact[] {
  return [
    { path: ".codex/hooks.json", content: "", mode: "json-merge-hooks", hooksData: CODEX_HOOKS, hooksWrapped: false },
  ];
}

/** Gemini CLI: repo `.gemini/settings.json` — hooks merged non-destructively
 * alongside any user settings (json-merge-hooks, wrapped under "hooks"). */
export function geminiArtifacts(): Artifact[] {
  return [
    { path: ".gemini/settings.json", content: "", mode: "json-merge-hooks", hooksData: GEMINI_HOOKS, hooksWrapped: true },
    {
      path: ".gemini/commands/loop.toml",
      mode: "write",
      content:
        'description = "Launch the autonomous external runner (knitbrain loop) in the background"\n' +
        'prompt = """\n' + loopLaunchInstructions("gemini -p") + '\n"""\n',
    },
    {
      path: ".gemini/commands/goal.toml",
      mode: "write",
      content:
        'description = "Drive a goal to a verify gate WITH YOU in this session (in-chat orchestration)"\n' +
        'prompt = """\n' + goalOrchestrationInstructions() + '\n"""\n',
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
    {
      path: ".github/prompts/loop.prompt.md",
      mode: "write",
      content:
        "---\ndescription: Launch the autonomous external runner (knitbrain loop) in the background\n---\n\n" +
        loopLaunchInstructions("claude -p") + "\n",
    },
    {
      path: ".github/prompts/goal.prompt.md",
      mode: "write",
      content:
        "---\ndescription: Drive a goal to a verify gate WITH YOU in this session (in-chat orchestration)\n---\n\n" +
        goalOrchestrationInstructions() + "\n",
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
    // Layer 2 enforcement: deny-only (exit-2) surface, flat {command} schema
    // shared with Cursor's merge logic (dedupe by command, hooks:{...} wrapper).
    { path: ".windsurf/hooks.json", content: "", mode: "json-merge-cursor-hooks", flatHooksData: WINDSURF_HOOKS },
    {
      path: ".windsurf/workflows/loop.md",
      mode: "write",
      content:
        "---\nname: loop\ndescription: Launch the autonomous external runner (knitbrain loop) in the background\n---\n\n## Steps\n" +
        loopLaunchInstructions("claude -p") + "\n",
    },
    {
      path: ".windsurf/workflows/goal.md",
      mode: "write",
      content:
        "---\nname: goal\ndescription: Drive a goal to a verify gate WITH YOU in this session (in-chat orchestration)\n---\n\n## Steps\n" +
        goalOrchestrationInstructions() + "\n",
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
    "",
    "# Autonomous loop as a /loop slash command (Codex prompts are GLOBAL):",
    "#   create ~/.codex/prompts/loop.md with front-matter + this body, then type /loop:",
    "#   " + loopLaunchInstructions("codex exec").replace(/\n/g, "\n#   "),
    "",
    "# In-session goal orchestration as a /goal slash command (also global):",
    "#   create ~/.codex/prompts/goal.md with front-matter + this body, then type /goal:",
    "#   " + goalOrchestrationInstructions().replace(/\n/g, "\n#   "),
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
      { cmd: "/goal", when: "drive a goal to a verify gate WITH YOU in this session (in-chat orchestration)" },
      { cmd: "/loop", when: "launch the autonomous external runner (knitbrain loop) in the background" },
    ];
  }
  if (platform === "cursor") {
    return [{ cmd: "@knitbrain rules", when: "re-read knitbrain usage rules" }];
  }
  if (platform === "gemini" || platform === "vscode" || platform === "windsurf" || platform === "codex") {
    return [
      { cmd: "/goal", when: "drive a goal to a verify gate WITH YOU in this session (in-chat orchestration)" },
      { cmd: "/loop", when: "launch the autonomous external runner (knitbrain loop) in the background" },
    ];
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
    if (a.mode === "json-merge-mcp" || a.mode === "json-merge-hooks" || a.mode === "json-merge-cursor-hooks") {
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
      } else if (a.mode === "json-merge-hooks") {
        // Merge our hook entries into existing hooks, deduped by command —
        // never clobber the user's own hooks. hooksData defaults to
        // KNITBRAIN_HOOKS/wrapped=true (Claude's settings.json shape) so
        // existing callers are unaffected; Codex/Gemini pass their own map.
        const hookMap = a.hooksData ?? KNITBRAIN_HOOKS;
        const wrapped = a.hooksWrapped ?? true;
        const base: Record<string, unknown[]> = wrapped
          ? { ...((parsed["hooks"] as Record<string, unknown[]>) ?? {}) }
          : { ...(parsed as unknown as Record<string, unknown[]>) };
        for (const [event, entries] of Object.entries(hookMap)) {
          const existing = (base[event] ?? []) as Array<{ hooks?: Array<{ command?: string }> }>;
          const ours = entries.filter(
            (e) => !existing.some((x) => x.hooks?.some((h) => h.command === e.hooks[0]?.command)),
          );
          base[event] = [...existing, ...ours];
        }
        content = wrapped
          ? JSON.stringify({ ...parsed, hooks: base }, null, 2) + "\n"
          : JSON.stringify({ ...parsed, ...base }, null, 2) + "\n";
      } else {
        // Cursor's hooks.json: flat {command} entries (no matcher/type
        // wrapper), dedupe by command string, preserve user's version + entries.
        const flatHookMap = a.flatHooksData ?? CURSOR_HOOKS;
        const hooks: Record<string, Array<{ command: string }>> = {
          ...((parsed["hooks"] as Record<string, Array<{ command: string }>>) ?? {}),
        };
        for (const [event, entries] of Object.entries(flatHookMap)) {
          const existing = hooks[event] ?? [];
          const ours = entries.filter((e) => !existing.some((x) => x.command === e.command));
          hooks[event] = [...existing, ...ours];
        }
        content = JSON.stringify({ version: (parsed["version"] as number | undefined) ?? 1, ...parsed, hooks }, null, 2) + "\n";
      }
    }
    // M8: knitbrain-owned "write" files (goal.md, rules, …) must stay current
    // with the installed version, so we DO overwrite — but back up an existing
    // file whose content differs first, so a user edit is always recoverable
    // from <path>.bak. (write-if-absent files already skipped above.)
    if (a.mode === "write" && existsSync(full)) {
      try {
        if (readFileSync(full, "utf8") !== content) writeAtomic(`${full}.bak`, readFileSync(full, "utf8"));
      } catch {
        /* backup is best-effort — never block the write on it */
      }
    }
    writeAtomic(full, content);
    written.push(a.path);
  }
  return written;
}
