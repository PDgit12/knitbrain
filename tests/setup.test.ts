import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectPlatforms, generateConfig, mergeMcpJson, runSetup } from "../src/setup.js";

describe("setup — platform detection (rung 9)", () => {
  const home = "/home/u";
  const none = () => false;

  it("detects Claude Code via env", () => {
    expect(detectPlatforms({ env: { CLAUDECODE: "1" }, exists: none, home })).toContain("claude-code");
  });

  it("detects Windsurf, Zed, and Copilot CLI via home dirs", () => {
    const exists = (p: string) =>
      p.endsWith("windsurf") || p.endsWith("zed") || p.endsWith(".copilot");
    const got = detectPlatforms({ env: {}, exists, home });
    expect(got).toContain("windsurf");
    expect(got).toContain("zed");
    expect(got).toContain("copilot-cli");
  });

  it("detects Cursor and Codex via home dirs", () => {
    const exists = (p: string) => p.endsWith(".cursor") || p.endsWith(".codex");
    const got = detectPlatforms({ env: {}, exists, home });
    expect(got).toContain("cursor");
    expect(got).toContain("codex");
  });

  it("detects active Codex, Claude, and Cursor from their runtime/config-dir envs", () => {
    expect(detectPlatforms({ env: { CODEX_HOME: "/alternate/codex" }, exists: none, home })).toContain("codex");
    expect(detectPlatforms({ env: { CLAUDE_CONFIG_DIR: "/alternate/claude" }, exists: none, home })).toContain("claude-code");
    expect(detectPlatforms({ env: { CURSOR_TRACE_ID: "trace-1" }, exists: none, home })).toContain("cursor");
  });

  it("detects project-local Cursor and Codex config folders", () => {
    const cwd = "/repo";
    const exists = (p: string) => p === join(cwd, ".cursor") || p === join(cwd, ".codex");
    const got = detectPlatforms({ env: {}, exists, home, cwd });
    expect(got).toContain("cursor");
    expect(got).toContain("codex");
  });

  it("falls back to unknown when nothing detected", () => {
    expect(detectPlatforms({ env: {}, exists: none, home })).toEqual(["unknown"]);
  });
});

describe("setup — config generation (rung 9)", () => {
  it("wires the MCP server + provider base URLs", () => {
    const cfg = generateConfig({ proxyPort: 9000 });
    expect(cfg.mcpServers["knitbrain"]).toEqual({ command: "knitbrain" });
    expect(cfg.proxyEnv["ANTHROPIC_BASE_URL"]).toBe("http://127.0.0.1:9000");
    expect(cfg.proxyEnv["OPENAI_BASE_URL"]).toBe("http://127.0.0.1:9000/v1");
  });

  it("binds generated MCP config to the requested project directory", () => {
    expect(generateConfig({ projectDir: "/tmp/project" }).mcpServers.knitbrain?.env?.KNITBRAIN_PROJECT_DIR)
      .toBe("/tmp/project");
  });

  it("merges into existing .mcp.json without clobbering other servers", () => {
    const existing = JSON.stringify({ mcpServers: { other: { command: "x" } } });
    const merged = JSON.parse(mergeMcpJson(existing, generateConfig()));
    expect(merged.mcpServers.other).toEqual({ command: "x" });
    expect(merged.mcpServers.knitbrain).toEqual({ command: "knitbrain" });
  });

  it("preserves server metadata and existing env while updating the managed root", () => {
    const existing = JSON.stringify({ mcpServers: { knitbrain: {
      command: "old", args: ["--keep"], custom: true,
      env: { KEEP: "yes", KNITBRAIN_PROJECT_DIR: "/old" },
    } } });
    const merged = JSON.parse(mergeMcpJson(existing, generateConfig({ projectDir: "/new" })));
    expect(merged.mcpServers.knitbrain).toEqual({
      command: "knitbrain", args: ["--keep"], custom: true,
      env: { KEEP: "yes", KNITBRAIN_PROJECT_DIR: "/new" },
    });
  });

  it("tolerates a corrupt existing .mcp.json", () => {
    const merged = JSON.parse(mergeMcpJson("{ not json", generateConfig()));
    expect(merged.mcpServers.knitbrain).toEqual({ command: "knitbrain" });
  });

  it("detects the target project's Cursor config even when setup runs elsewhere", () => {
    const root = mkdtempSync(join(tmpdir(), "knitbrain-setup-target-"));
    mkdirSync(join(root, ".cursor"));
    const logs: string[] = [];
    const log = console.log;
    console.log = (value?: unknown) => { logs.push(String(value ?? "")); };
    try {
      expect(runSetup(root, [])).toBe(0);
    } finally {
      console.log = log;
      rmSync(root, { recursive: true, force: true });
    }
    expect(logs.join("\n")).toContain("detected platform(s):");
    expect(logs.join("\n")).toContain("cursor");
    expect(logs.join("\n")).toContain(".cursor/mcp.json");
  });
});
