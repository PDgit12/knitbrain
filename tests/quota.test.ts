import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseClaudeUsage, readClaudeToken } from "../src/engine/quota.js";

describe("quota — Claude subscription window parsing", () => {
  it("maps known windows with usedPct, used, limit, and reset minutes", () => {
    const resetsAt = new Date(Date.now() + 90 * 60000).toISOString();
    const windows = parseClaudeUsage({
      five_hour: { used: 30, limit: 100, utilization: 30, resets_at: resetsAt },
      seven_day: { used: 500, limit: 1000, utilization: 50.4 },
      unknown_window: { used: 1, limit: 1, utilization: 99 }, // ignored
    });
    expect(windows.map((w) => w.label)).toEqual(["5-hour", "7-day"]);
    expect(windows[0]).toMatchObject({ usedPct: 30, used: 30, limit: 100 });
    expect(windows[0]!.resetsInMin).toBeGreaterThan(80);
    expect(windows[0]!.resetsInMin).toBeLessThanOrEqual(90);
    expect(windows[1]).toMatchObject({ usedPct: 50.4, resetsInMin: undefined });
  });

  it("returns [] on junk input", () => {
    expect(parseClaudeUsage(null)).toEqual([]);
    expect(parseClaudeUsage("nope")).toEqual([]);
    expect(parseClaudeUsage({})).toEqual([]);
  });
});

describe("quota — token resolution (no network)", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "kb-quota-"));
    delete process.env["CLAUDE_CODE_OAUTH_TOKEN"];
    delete process.env["CLAUDE_CONFIG_DIR"];
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("reads the token from .credentials.json", () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "tok-abc" } }));
    expect(readClaudeToken(home)).toBe("tok-abc");
  });

  it("prefers the env var, and returns null when absent", () => {
    process.env["CLAUDE_CODE_OAUTH_TOKEN"] = "env-tok";
    expect(readClaudeToken(home)).toBe("env-tok");
    delete process.env["CLAUDE_CODE_OAUTH_TOKEN"];
    expect(readClaudeToken(home)).toBeNull();
  });
});
