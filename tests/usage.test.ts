import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readUsageFromDir, projectTranscriptDir } from "../src/engine/usage.js";

describe("usage — real platform token meter from transcripts", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kb-usage-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("sums real usage across messages and .jsonl files", () => {
    const line = (i: number, o: number, cr: number, cc: number): string =>
      JSON.stringify({ message: { usage: { input_tokens: i, output_tokens: o, cache_read_input_tokens: cr, cache_creation_input_tokens: cc } } });
    writeFileSync(join(dir, "a.jsonl"), [line(100, 10, 50, 20), "not json", line(200, 20, 0, 0)].join("\n"));
    writeFileSync(join(dir, "b.jsonl"), line(5, 5, 5, 5));
    const u = readUsageFromDir(dir)!;
    expect(u.messages).toBe(3);
    expect(u.inputTokens).toBe(305);
    expect(u.outputTokens).toBe(35);
    expect(u.cacheReadTokens).toBe(55);
    expect(u.cacheCreationTokens).toBe(25);
    expect(u.totalTokens).toBe(305 + 35 + 55 + 25);
  });

  it("returns null when there are no transcripts", () => {
    expect(readUsageFromDir(join(dir, "nope"))).toBeNull();
    mkdirSync(join(dir, "empty"));
    expect(readUsageFromDir(join(dir, "empty"))).toBeNull();
  });

  it("encodes the project path the way Claude Code does (/ and . → -)", () => {
    expect(projectTranscriptDir("/Users/x/my.app", "/home")).toBe("/home/.claude/projects/-Users-x-my-app");
  });
});
