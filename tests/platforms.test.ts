import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateConfig } from "../src/setup.js";
import {
  applyArtifacts,
  claudeArtifacts,
  claudeLoopArtifacts,
  cursorArtifacts,
  codexArtifacts,
  geminiArtifacts,
  vscodeArtifacts,
  windsurfArtifacts,
  codexSnippet,
  loopLaunchInstructions,
  goalOrchestrationInstructions,
  universalArtifacts,
  slashCommands,
  GOAL_LOOP_NUDGE,
  KNITBRAIN_HOOKS,
} from "../src/platforms.js";

const cfg = generateConfig();

describe("platform adapter matrix (rung 16)", () => {
  it("Claude Code gets .mcp.json + slash commands + rules", () => {
    const paths = claudeArtifacts(cfg).map((a) => a.path);
    expect(paths).toContain(".mcp.json");
    expect(paths).toContain(".claude/commands/meter.md");
    expect(paths).toContain(".claude/commands/handoff.md");
    expect(paths).toContain(".claude/commands/goal.md");
    expect(paths).toContain(".claude/rules/knitbrain.md");
  });

  it("/goal orchestrates the full workflow (run -> agents -> loop), not just the thin loop", () => {
    const goal = claudeArtifacts(cfg).find((a) => a.path === ".claude/commands/goal.md")!;
    expect(goal.content).toContain("knitbrain_run"); // orchestrate first (classify + skill + agents)
    expect(goal.content).toContain("knitbrain_run_loop"); // still gated by the verify loop
    expect(goal.content).toContain("proposes agents"); // agent fan-out wording
    expect(goal.content).toContain("--for"); // wall-clock duration flag
    expect(goal.content).toContain("deadline_ms"); // passed through to the loop engine
    expect(goal.content).toMatch(/NEVER fake .*met=true/i); // anti-sycophancy preserved
  });

  it("GOAL_LOOP_NUDGE makes goal->loop the DEFAULT stance (Gap 6, opt-out not opt-in)", () => {
    // one-line steering, injected every turn by the UserPromptSubmit hook.
    expect(GOAL_LOOP_NUDGE).toContain("GOAL");
    expect(GOAL_LOOP_NUDGE).toContain("knitbrain_run_loop"); // close on a checkable gate
    expect(GOAL_LOOP_NUDGE).toMatch(/inquiry|question/i); // pure questions opt out
    expect(GOAL_LOOP_NUDGE.split("\n")).toHaveLength(1); // stays one line — costs tokens every prompt
  });

  it("Cursor gets .cursor/mcp.json + an alwaysApply rules file", () => {
    const arts = cursorArtifacts();
    expect(arts.map((a) => a.path)).toContain(".cursor/mcp.json");
    const rules = arts.find((a) => a.path.endsWith(".mdc"))!;
    expect(rules.content).toContain("alwaysApply: true");
    expect(rules.content).toContain("⟨recall:HASH⟩");
  });

  it("VS Code mcp.json uses the 'servers' key (not mcpServers)", () => {
    const root = mkdtempSync(join(tmpdir(), "knitbrain-plat-"));
    try {
      applyArtifacts(root, vscodeArtifacts(), cfg);
      const parsed = JSON.parse(readFileSync(join(root, ".vscode/mcp.json"), "utf8"));
      expect(parsed.servers.knitbrain).toEqual({ command: "knitbrain" });
      expect(parsed.mcpServers).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("json-merge never clobbers existing servers", () => {
    const root = mkdtempSync(join(tmpdir(), "knitbrain-plat-"));
    try {
      mkdirSync(join(root, ".cursor"), { recursive: true });
      writeFileSync(
        join(root, ".cursor/mcp.json"),
        JSON.stringify({ mcpServers: { other: { command: "x" } } }),
      );
      applyArtifacts(root, cursorArtifacts(), cfg);
      const parsed = JSON.parse(readFileSync(join(root, ".cursor/mcp.json"), "utf8"));
      expect(parsed.mcpServers.other).toEqual({ command: "x" });
      expect(parsed.mcpServers.knitbrain).toEqual({ command: "knitbrain" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("universalArtifacts (AGENTS.md) writes when absent, never clobbers when present", () => {
    const root = mkdtempSync(join(tmpdir(), "knitbrain-agents-"));
    try {
      // absent → written
      expect(applyArtifacts(root, universalArtifacts(), cfg)).toEqual(["AGENTS.md"]);
      expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toContain("Knit Brain");
      // present → skipped, user content preserved
      const mine = "# my own agents file\n";
      writeFileSync(join(root, "AGENTS.md"), mine, "utf8");
      expect(applyArtifacts(root, universalArtifacts(), cfg)).toEqual([]);
      expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toBe(mine);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("applyArtifacts writes every artifact to disk", () => {
    const root = mkdtempSync(join(tmpdir(), "knitbrain-plat-"));
    try {
      const written = applyArtifacts(root, claudeArtifacts(cfg), cfg);
      expect(written.length).toBe(7); // .mcp.json + settings.json(hooks) + 4 commands (meter/handoff/terse/goal) + rules
      for (const p of written) expect(existsSync(join(root, p))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rules artifacts carry TERSE MODE (output-token optimization)", () => {
    const claudeRules = claudeArtifacts(cfg).find((a) => a.path === ".claude/rules/knitbrain.md")!;
    expect(claudeRules.content).toContain("Terse mode");
    expect(claudeRules.content).toContain("Never drop: technical content");
    const cursorRules = cursorArtifacts().find((a) => a.path.endsWith(".mdc"))!;
    expect(cursorRules.content).toContain("Terse mode");
  });

  it("Codex gets a global-config snippet (we never touch ~/.codex)", () => {
    const snip = codexSnippet(cfg);
    expect(snip).toContain("[mcp_servers.knitbrain]");
    expect(snip).toContain("OPENAI_BASE_URL");
  });
});

describe("cross-platform hook config emitters (Tier-1.1 — merge, never clobber, .bak)", () => {
  it("codexArtifacts writes a valid .codex/hooks.json with PreToolUse", () => {
    const root = mkdtempSync(join(tmpdir(), "knitbrain-codex-"));
    try {
      applyArtifacts(root, codexArtifacts(), cfg);
      const parsed = JSON.parse(readFileSync(join(root, ".codex/hooks.json"), "utf8"));
      expect(parsed.PreToolUse[0].hooks[0].command).toBe("knitbrain-hook pretooluse");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("geminiArtifacts writes .gemini/settings.json with hooks nested under 'hooks', preserving a pre-existing user setting", () => {
    const root = mkdtempSync(join(tmpdir(), "knitbrain-gemini-"));
    try {
      mkdirSync(join(root, ".gemini"), { recursive: true });
      writeFileSync(join(root, ".gemini/settings.json"), JSON.stringify({ theme: "dark" }));
      applyArtifacts(root, geminiArtifacts(), cfg);
      const parsed = JSON.parse(readFileSync(join(root, ".gemini/settings.json"), "utf8"));
      expect(parsed.hooks.AfterAgent[0].hooks[0].command).toBe("knitbrain-hook stop");
      expect(parsed.theme).toBe("dark"); // user setting preserved
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("cursorArtifacts writes .cursor/hooks.json; re-apply dedupes by command and preserves a user-added hook entry", () => {
    const root = mkdtempSync(join(tmpdir(), "knitbrain-cursor-hooks-"));
    try {
      applyArtifacts(root, cursorArtifacts(), cfg);
      let parsed = JSON.parse(readFileSync(join(root, ".cursor/hooks.json"), "utf8"));
      expect(parsed.hooks.beforeShellExecution.some((h: { command: string }) => h.command === "knitbrain-hook pretooluse")).toBe(true);
      // user adds their own hook entry to the same event
      parsed.hooks.beforeShellExecution.push({ command: "my-own-hook" });
      writeFileSync(join(root, ".cursor/hooks.json"), JSON.stringify(parsed));
      // re-apply
      applyArtifacts(root, cursorArtifacts(), cfg);
      parsed = JSON.parse(readFileSync(join(root, ".cursor/hooks.json"), "utf8"));
      const commands = parsed.hooks.beforeShellExecution.map((h: { command: string }) => h.command);
      expect(commands.filter((c: string) => c === "knitbrain-hook pretooluse")).toHaveLength(1); // deduped, not doubled
      expect(commands).toContain("my-own-hook"); // user's version + entry preserved
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("claudeLoopArtifacts writes .claude/commands/loop.md, cross-referencing /goal", () => {
    const loop = claudeLoopArtifacts().find((a) => a.path === ".claude/commands/loop.md")!;
    expect(loop).toBeDefined();
    expect(loop.content).toContain("/goal");
  });

  it("goal.md content references /loop (explicit --for/--iters budget escape hatch)", () => {
    const goal = claudeArtifacts(cfg).find((a) => a.path === ".claude/commands/goal.md")!;
    expect(goal.content).toContain("/loop");
  });

  it("slashCommands('claude-code') includes /loop", () => {
    const cmds = slashCommands("claude-code").map((c) => c.cmd);
    expect(cmds).toContain("/loop");
  });

  // Cross-platform /loop: every platform's command LAUNCHES the external runner
  // (knitbrain loop) detached — none runs the loop inline. Verified formats:
  // Gemini .toml, VS Code .prompt.md, Windsurf .windsurf/workflows/*.md.
  it("loopLaunchInstructions LAUNCHES the runner in the background, never ticks boxes itself", () => {
    const body = loopLaunchInstructions("claude -p");
    expect(body).toContain("nohup knitbrain loop");
    expect(body).toContain("BACKGROUND");
    expect(body).toContain('--agent "claude -p"');
    expect(body).toContain("Do NOT tick any box yourself"); // no false green
  });

  it("Gemini emits .gemini/commands/loop.toml (TOML: description + prompt, gemini -p worker)", () => {
    const t = geminiArtifacts().find((a) => a.path === ".gemini/commands/loop.toml")!;
    expect(t).toBeDefined();
    expect(t.content).toContain("description =");
    expect(t.content).toContain('prompt = """');
    expect(t.content).toContain("knitbrain loop");
    expect(t.content).toContain('--agent "gemini -p"');
  });

  it("VS Code emits .github/prompts/loop.prompt.md (YAML frontmatter + body)", () => {
    const p = vscodeArtifacts().find((a) => a.path === ".github/prompts/loop.prompt.md")!;
    expect(p).toBeDefined();
    expect(p.content.startsWith("---\ndescription:")).toBe(true);
    expect(p.content).toContain("nohup knitbrain loop");
  });

  it("Windsurf emits .windsurf/workflows/loop.md (name/description frontmatter + ## Steps)", () => {
    const w = windsurfArtifacts().find((a) => a.path === ".windsurf/workflows/loop.md")!;
    expect(w).toBeDefined();
    expect(w.content).toContain("name: loop");
    expect(w.content).toContain("## Steps");
    expect(w.content).toContain("knitbrain loop");
  });

  it("Cursor rules document the terminal runner (no native slash command)", () => {
    const rules = cursorArtifacts().find((a) => a.path.endsWith(".mdc"))!;
    expect(rules.content).toContain("knitbrain loop goal.md");
  });

  it("Codex snippet documents the global /loop prompt (codex exec worker)", () => {
    const snip = codexSnippet(cfg);
    expect(snip).toContain("~/.codex/prompts/loop.md");
    expect(snip).toContain("codex exec");
  });

  it("slashCommands includes /loop on gemini, vscode, windsurf, codex", () => {
    for (const p of ["gemini", "vscode", "windsurf", "codex"]) {
      expect(slashCommands(p).map((c) => c.cmd)).toContain("/loop");
    }
  });

  // /goal parity: in-session orchestration front door, on every platform /loop
  // reaches (no gaps). Distinct from /loop (external runner) — drives the gate
  // WITH YOU in-session via knitbrain_run + knitbrain_run_loop.
  it("goalOrchestrationInstructions orchestrates in-session and points to /loop for hands-off", () => {
    const body = goalOrchestrationInstructions();
    expect(body).toContain("knitbrain_run");
    expect(body).toContain("knitbrain_run_loop");
    expect(body).toContain("deadline_ms");
    expect(body).toContain("NEVER fake met=true");
    expect(body).toContain("/loop"); // cross-reference to the external runner
  });

  it("every /loop platform also emits a /goal command (no gap)", () => {
    expect(geminiArtifacts().some((a) => a.path === ".gemini/commands/goal.toml")).toBe(true);
    expect(vscodeArtifacts().some((a) => a.path === ".github/prompts/goal.prompt.md")).toBe(true);
    expect(windsurfArtifacts().some((a) => a.path === ".windsurf/workflows/goal.md")).toBe(true);
    expect(codexSnippet(cfg)).toContain("~/.codex/prompts/goal.md");
  });

  it("slashCommands lists /goal AND /loop on claude-code + gemini + vscode + windsurf + codex", () => {
    for (const p of ["claude-code", "gemini", "vscode", "windsurf", "codex"]) {
      const cmds = slashCommands(p).map((c) => c.cmd);
      expect(cmds).toContain("/goal");
      expect(cmds).toContain("/loop");
    }
  });

  it("KNITBRAIN_HOOKS wires SubagentStart + SubagentStop (ambient orchestration + attribution)", () => {
    expect(KNITBRAIN_HOOKS.SubagentStart[0]!.hooks[0]!.command).toBe("knitbrain-hook subagentstart");
    expect(KNITBRAIN_HOOKS.SubagentStop[0]!.hooks[0]!.command).toBe("knitbrain-hook subagentstop");
  });

  it("windsurfArtifacts writes .windsurf/hooks.json (exit-2 deny surface) and dedupes on re-apply", () => {
    const root = mkdtempSync(join(tmpdir(), "knitbrain-windsurf-"));
    try {
      applyArtifacts(root, windsurfArtifacts(), cfg);
      let parsed = JSON.parse(readFileSync(join(root, ".windsurf/hooks.json"), "utf8"));
      expect(parsed.hooks.pre_run_command).toHaveLength(1);
      expect(parsed.hooks.pre_run_command[0].command).toBe("knitbrain-hook pretooluse");
      // re-apply must not double the entry
      applyArtifacts(root, windsurfArtifacts(), cfg);
      parsed = JSON.parse(readFileSync(join(root, ".windsurf/hooks.json"), "utf8"));
      expect(parsed.hooks.pre_run_command).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
