import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProfile, classifyShape } from "../src/profile.js";

const bigJson = (): string =>
  JSON.stringify({ rows: Array.from({ length: 50 }, (_, i) => ({ i, pad: "z".repeat(40) })) }, null, 2);

const transcriptLine = (text: string): string =>
  JSON.stringify({ message: { content: [{ type: "tool_result", content: [{ type: "text", text }] }] } });

describe("knitbrain profile (launch funnel)", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "knitbrain-profile-test-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("classifies shapes deterministically", () => {
    expect(classifyShape(bigJson())).toBe("json");
    expect(classifyShape("export function f() { return 1; }")).toBe("code");
  });

  it("profiles a real transcript file on disk and reports overall savings", async () => {
    const proj = join(root, "-Users-someone-proj");
    mkdirSync(proj, { recursive: true });
    const lines = [
      transcriptLine(bigJson()),
      transcriptLine(bigJson()), // exact repeat → cross-turn dedup
      "not json — must be skipped, not crash",
    ];
    writeFileSync(join(proj, "session.jsonl"), lines.join("\n"));

    const out: string[] = [];
    const overall = await runProfile([root], (l) => out.push(l));
    expect(overall).toBeGreaterThan(50); // compressible JSON + a deduped repeat
    const report = out.join("\n");
    expect(report).toContain("transcripts: 1");
    expect(report).toContain("json");
    expect(report).toContain("cross-turn dedup: 1 repeated blocks");
    expect(report).toContain("lossless");
  });

  it("handles an empty target without crashing", async () => {
    const overall = await runProfile([join(root, "nope")], () => {});
    expect(overall).toBe(0);
  });
});
