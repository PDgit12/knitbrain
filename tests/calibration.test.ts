import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCalibration } from "../src/engine/calibration.js";
import { classifyTask } from "../src/engine/workflow.js";

describe("classifier FP loop (calibration)", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "knitbrain-cal-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("3 same-direction FPs shift the threshold, then the counter resets", () => {
    const cal = createCalibration(join(root, "cal"));
    expect(cal.recordFalsePositive("complex", "standard").shifted).toBe(false);
    expect(cal.recordFalsePositive("complex", "standard").shifted).toBe(false);
    const third = cal.recordFalsePositive("complex", "standard");
    expect(third.shifted).toBe(true);
    expect(third.scopeAdjust).toBe(1);
    expect(third.fpDirections["complex-was-standard"]).toBe(0); // reset — next shift needs 3 fresh votes
  });

  it("under-sensitive direction lowers the bar; adjust is clamped to ±2", () => {
    const cal = createCalibration(join(root, "cal"));
    for (let i = 0; i < 12; i += 1) cal.recordFalsePositive("standard", "complex");
    expect(cal.get().scopeAdjust).toBe(-2); // clamped, never runaway
  });

  it("rejects same-tier or invalid input without mutating state", () => {
    const cal = createCalibration(join(root, "cal"));
    cal.recordFalsePositive("complex", "complex");
    expect(cal.get().fpDirections).toEqual({});
  });

  it("classifier consumes the dial: +1 raises the complex file bar 4→5 and demotes keywords", () => {
    const files = ["a.ts", "b.ts", "c.ts", "d.ts"]; // 4 files
    expect(classifyTask("update the helpers", files).tier).toBe("complex"); // default bar 4
    expect(classifyTask("update the helpers", files, 1).tier).toBe("standard"); // bar 5
    expect(classifyTask("update the helpers", [...files, "e.ts"], 1).tier).toBe("complex"); // 5 ≥ 5
    // keyword complex demoted once users voted over-sensitive
    const kw = "refactor the date formatting helpers shared across the module boundary";
    expect(classifyTask(kw, ["a.ts"]).tier).toBe("complex");
    expect(classifyTask(kw, ["a.ts"], 1).tier).toBe("standard");
  });

  it("classifier with -1: complex at 3 files (under-sensitive correction)", () => {
    const files = ["a.ts", "b.ts", "c.ts"];
    expect(classifyTask("update the helpers across modules", files).tier).toBe("standard");
    expect(classifyTask("update the helpers across modules", files, -1).tier).toBe("complex");
  });

  it("cross-process freshness: a second instance sees the first's shift", () => {
    const a = createCalibration(join(root, "cal"));
    const b = createCalibration(join(root, "cal"));
    for (let i = 0; i < 3; i += 1) a.recordFalsePositive("complex", "trivial");
    expect(b.get().scopeAdjust).toBe(1);
  });
});

describe("calibration decay (stale FP votes age out, learned shift persists)", () => {
  it("clears partial fpDirections older than 30d but keeps scopeAdjust", () => {
    const r = mkdtempSync(join(tmpdir(), "kb-decay-"));
    try {
      const old = new Date(Date.now() - 40 * 86400000).toISOString();
      writeFileSync(join(r, "calibration.json"), JSON.stringify({
        fpDirections: { "complex-was-standard": 2 },
        scopeAdjust: 1,
        updatedAt: old,
      }));
      const cal = createCalibration(r);
      const s = cal.get();
      expect(s.fpDirections).toEqual({}); // stale partial votes decayed
      expect(s.scopeAdjust).toBe(1); // learned calibration kept
    } finally { rmSync(r, { recursive: true, force: true }); }
  });
  it("keeps recent fpDirections", () => {
    const r = mkdtempSync(join(tmpdir(), "kb-decay2-"));
    try {
      writeFileSync(join(r, "calibration.json"), JSON.stringify({
        fpDirections: { "complex-was-standard": 2 },
        scopeAdjust: 0,
        updatedAt: new Date().toISOString(),
      }));
      expect(createCalibration(r).get().fpDirections).toEqual({ "complex-was-standard": 2 });
    } finally { rmSync(r, { recursive: true, force: true }); }
  });
});
