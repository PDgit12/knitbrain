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
} from "../src/platforms.js";

const cfg = generateConfig();

describe("platform adapter matrix (rung 16)", () => {
  it("Claude Code gets .mcp.json + slash commands + rules", () => {
    const paths = claudeArtifacts(cfg).map((a) => a.path);
    expect(paths).toContain(".mcp.json");
    expect(paths).toContain(".claude/commands/meter.md");
    expect(paths).toContain(".claude/commands/handoff.md");
    expect(paths).toContain(".claude/rules/knitbrain.md");
  });

  it("Cursor gets .cursor/mcp.json + an alwaysApply rules file", () => {
    const arts = cursorArtifacts();
    expect(arts.map((a) => a.path)).toContain(".cursor/mcp.json");
    const rules = arts.find((a) => a.path.endsWith(".mdc"))!;
    expect(rules.content).toContain("alwaysApply: true");
    expect(rules.content).toContain("⟨ccr:HASH⟩");
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

  it("applyArtifacts writes every artifact to disk", () => {
    const root = mkdtempSync(join(tmpdir(), "knitbrain-plat-"));
    try {
      const written = applyArtifacts(root, claudeArtifacts(cfg), cfg);
      expect(written.length).toBe(4);
      for (const p of written) expect(existsSync(join(root, p))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("Codex gets a global-config snippet (we never touch ~/.codex)", () => {
    const snip = codexSnippet(cfg);
    expect(snip).toContain("[mcp_servers.knitbrain]");
    expect(snip).toContain("OPENAI_BASE_URL");
  });
});
