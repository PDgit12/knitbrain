import { describe, it, expect } from "vitest";
import { detectPlatforms, generateConfig, mergeMcpJson } from "../src/setup.js";

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

  it("merges into existing .mcp.json without clobbering other servers", () => {
    const existing = JSON.stringify({ mcpServers: { other: { command: "x" } } });
    const merged = JSON.parse(mergeMcpJson(existing, generateConfig()));
    expect(merged.mcpServers.other).toEqual({ command: "x" });
    expect(merged.mcpServers.knitbrain).toEqual({ command: "knitbrain" });
  });

  it("tolerates a corrupt existing .mcp.json", () => {
    const merged = JSON.parse(mergeMcpJson("{ not json", generateConfig()));
    expect(merged.mcpServers.knitbrain).toEqual({ command: "knitbrain" });
  });
});
