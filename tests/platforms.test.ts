import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateConfig } from "../src/setup.js";
import {
  applyArtifacts,
  claudeArtifacts,
  cursorArtifacts,
  vscodeArtifacts,
  codexSnippet,
  universalArtifacts,
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
