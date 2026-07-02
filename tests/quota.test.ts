import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseClaudeUsage, readClaudeToken, parseCopilotQuota, readGithubToken } from "../src/engine/quota.js";

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
    expect(readClaudeToken(home, () => null)).toBeNull();
  });

  it("falls back to the macOS Keychain when the file is absent", () => {
    const keychain = () => JSON.stringify({ claudeAiOauth: { accessToken: "kc-tok" } });
    expect(readClaudeToken(home, keychain)).toBe("kc-tok");
  });

  it("prefers the credentials file over the Keychain; bad keychain JSON → null", () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "file-tok" } }));
    expect(readClaudeToken(home, () => JSON.stringify({ claudeAiOauth: { accessToken: "kc-tok" } }))).toBe("file-tok");
    rmSync(join(home, ".claude", ".credentials.json"));
    expect(readClaudeToken(home, () => "not-json")).toBeNull();
  });
});

describe("quota — Copilot (GitHub) source", () => {
  it("parses copilot_internal/user snapshots into windows", () => {
    const w = parseCopilotQuota({
      quota_reset_date_utc: new Date(Date.now() + 3 * 86400000).toISOString(),
      quota_snapshots: {
        chat: { entitlement: 300, remaining: 75, percent_remaining: 25 },
        premium_interactions: { unlimited: true },
        completions: { entitlement: 1000, remaining: 1000 },
      },
    });
    const chat = w.find((x) => x.label === "Copilot chat")!;
    expect(chat).toMatchObject({ usedPct: 75, used: 225, limit: 300 });
    expect(w.some((x) => x.label.includes("unlimited"))).toBe(true);
  });
  it("returns [] on junk and reads the github token from env (priority order)", () => {
    expect(parseCopilotQuota(null)).toEqual([]);
    expect(readGithubToken({ GITHUB_TOKEN: "ghx" })).toBe("ghx");
    expect(readGithubToken({ GITHUB_COPILOT_GITHUB_TOKEN: "a", GITHUB_TOKEN: "b" })).toBe("a");
    expect(readGithubToken({})).toBeNull();
  });
});
