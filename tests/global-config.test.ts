import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeGlobalConfig, applyGlobalConfig, applyProjectCodexConfig, GLOBAL_CONFIG_PATHS } from "../src/global-config.js";

describe("global-config merge (pure, non-clobbering)", () => {
  it("codex TOML: appends the table block, preserves existing config", () => {
    const existing = '[model]\nname = "gpt-5"\n';
    const { content, changed } = mergeGlobalConfig("codex", existing);
    expect(changed).toBe(true);
    expect(content).toContain('name = "gpt-5"'); // existing preserved
    expect(content).toContain("[mcp_servers.knitbrain]");
    expect(content).toContain('command = "knitbrain"');
  });

  it("codex TOML: idempotent when knitbrain already present", () => {
    const withKnit = '[mcp_servers.knitbrain]\ncommand = "knitbrain"\n';
    expect(mergeGlobalConfig("codex", withKnit).changed).toBe(false);
  });

  it("Codex updates only managed project root and preserves existing fields/env", () => {
    const existing = '[mcp_servers.knitbrain]\ncommand = "knitbrain"\nargs = ["--keep"]\nenv = { KEEP = "yes", KNITBRAIN_PROJECT_DIR = "/old" }\n';
    const config = { mcpServers: { knitbrain: { command: "knitbrain", env: { KNITBRAIN_PROJECT_DIR: "/new" } } }, proxyEnv: {}, proxyPort: 8788 };
    const merged = mergeGlobalConfig("codex", existing, config);
    expect(merged.changed).toBe(true);
    expect(merged.content).toContain('args = ["--keep"]');
    expect(merged.content).toContain('KEEP = "yes"');
    expect(merged.content).toContain('KNITBRAIN_PROJECT_DIR = "/new"');
  });

  it("Codex updates a nested env table without creating a duplicate env key", () => {
    const existing = '[mcp_servers.knitbrain]\ncommand = "knitbrain"\n[mcp_servers.knitbrain.env]\nKEEP = "yes"\nKNITBRAIN_PROJECT_DIR = "/old"\n';
    const config = { mcpServers: { knitbrain: { command: "knitbrain", env: { KNITBRAIN_PROJECT_DIR: "/new" } } }, proxyEnv: {}, proxyPort: 8788 };
    const merged = mergeGlobalConfig("codex", existing, config);
    expect(merged.content).toContain('KNITBRAIN_PROJECT_DIR = "/new"');
    expect(merged.content.match(/KNITBRAIN_PROJECT_DIR\s*=/g)).toHaveLength(1);
    expect(merged.content).not.toContain("env = {");
  });

  it("windsurf/copilot JSON: merges into mcpServers without dropping others", () => {
    const existing = JSON.stringify({ mcpServers: { other: { command: "x" } } });
    const w = mergeGlobalConfig("windsurf", existing);
    const parsed = JSON.parse(w.content);
    expect(parsed.mcpServers.other).toEqual({ command: "x" }); // preserved
    expect(parsed.mcpServers.knitbrain).toEqual({ command: "knitbrain" });
    const c = mergeGlobalConfig("copilot-cli", existing);
    expect(JSON.parse(c.content).mcpServers.knitbrain).toEqual({ type: "local", command: "knitbrain", tools: ["*"] });
  });

  it("zed JSON: uses context_servers key, preserves other settings", () => {
    const existing = JSON.stringify({ theme: "dark", context_servers: { other: {} } });
    const { content } = mergeGlobalConfig("zed", existing);
    const parsed = JSON.parse(content);
    expect(parsed.theme).toBe("dark");
    expect(parsed.context_servers.knitbrain).toEqual({ command: { path: "knitbrain" } });
  });

  it("malformed JSON is treated as empty (and the original is backed up by apply)", () => {
    const { content, changed } = mergeGlobalConfig("windsurf", "{ not json");
    expect(changed).toBe(true);
    expect(JSON.parse(content).mcpServers.knitbrain).toBeDefined();
  });

  it("absent file (null) creates fresh valid config", () => {
    expect(JSON.parse(mergeGlobalConfig("windsurf", null).content).mcpServers.knitbrain).toBeDefined();
    expect(mergeGlobalConfig("codex", null).content).toContain("[mcp_servers.knitbrain]");
  });
});

describe("applyGlobalConfig (IO, backup)", () => {
  let home: string;
  beforeEach(() => (home = mkdtempSync(join(tmpdir(), "kb-global-"))));
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("creates the config when absent (status=created, no backup)", () => {
    const { path, status } = applyGlobalConfig("windsurf", home);
    expect(status).toBe("created");
    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8")).mcpServers.knitbrain).toBeDefined();
  });

  it("backs up the original before writing (status=written)", () => {
    const dir = join(home, ".codex");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(home, ...GLOBAL_CONFIG_PATHS.codex), '[model]\nname = "x"\n');
    const { status } = applyGlobalConfig("codex", home);
    expect(status).toBe("written");
    const backups = readdirSync(dir).filter((f) => f.includes(".bak-"));
    expect(backups.length).toBe(1); // original preserved
    expect(readFileSync(join(dir, "config.toml"), "utf8")).toContain("[mcp_servers.knitbrain]");
  });

  it("is idempotent — second apply is a no-op (status=present)", () => {
    applyGlobalConfig("zed", home);
    expect(applyGlobalConfig("zed", home).status).toBe("present");
  });

  it("honors CODEX_HOME as the config directory", () => {
    const codexHome = join(home, "alternate-codex");
    const config = { mcpServers: { knitbrain: { command: "knitbrain", env: { KNITBRAIN_PROJECT_DIR: home } } }, proxyEnv: {}, proxyPort: 8788 };
    const result = applyGlobalConfig("codex", home, undefined, { codexHome, config });
    expect(result.path).toBe(join(codexHome, "config.toml"));
    expect(readFileSync(result.path, "utf8")).toContain(`KNITBRAIN_PROJECT_DIR = "${home}"`);
  });

  it("writes project-specific root binding to project Codex config", () => {
    const config = { mcpServers: { knitbrain: { command: "knitbrain", env: { KNITBRAIN_PROJECT_DIR: home } } }, proxyEnv: {}, proxyPort: 8788 };
    const result = applyProjectCodexConfig(home, config);
    expect(result.path).toBe(join(home, ".codex", "config.toml"));
    expect(readFileSync(result.path, "utf8")).toContain(`KNITBRAIN_PROJECT_DIR = "${home}"`);
  });
});
