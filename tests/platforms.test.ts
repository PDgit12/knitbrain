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
  codexSnippet,
  universalArtifacts,
  slashCommands,
  GOAL_LOOP_NUDGE,
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
});
