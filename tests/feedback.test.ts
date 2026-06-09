import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFeedback, type Feedback } from "../src/engine/feedback.js";

describe("TOIN feedback (rung 12)", () => {
  let root: string;
  let fb: Feedback;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "knitbrain-fb-"));
    fb = createFeedback(join(root, "fb"), { minSamples: 4, maxRate: 0.5 });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("tracks per-kind compressions and retrievals", () => {
    fb.onCompress("json", "h1");
    fb.onCompress("json", "h2");
    fb.onRetrieve("h1");
    const json = fb.stats().find((s) => s.kind === "json")!;
    expect(json.compressions).toBe(2);
    expect(json.retrievals).toBe(1);
    expect(json.rate).toBe(0.5);
  });

  it("backs off (shouldSkip) once a kind is over-retrieved past the sample floor", () => {
    expect(fb.shouldSkip("code")).toBe(false); // no data yet
    for (let i = 0; i < 5; i++) fb.onCompress("code", `c${i}`);
    for (let i = 0; i < 4; i++) fb.onRetrieve(`c${i}`); // rate 0.8 > 0.5, samples 5 >= 4
    expect(fb.shouldSkip("code")).toBe(true);
    expect(fb.stats().find((s) => s.kind === "code")!.skipping).toBe(true);
  });

  it("does not back off below the sample floor even at high rate", () => {
    fb.onCompress("text", "t1");
    fb.onRetrieve("t1"); // rate 1.0 but only 1 sample < 4
    expect(fb.shouldSkip("text")).toBe(false);
  });

  it("persists across instances", () => {
    fb.onCompress("json", "p1");
    const reopened = createFeedback(join(root, "fb"), { minSamples: 4, maxRate: 0.5 });
    expect(reopened.stats().find((s) => s.kind === "json")!.compressions).toBe(1);
  });
});
