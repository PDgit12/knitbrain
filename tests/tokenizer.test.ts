import { describe, it, expect } from "vitest";
import { countTokens, activeTokenizerName } from "../src/tokenizer.js";
import { measure, summarize } from "../src/measure.js";

describe("tokenizer (rung 1)", () => {
  it("counts empty string as 0 tokens", () => {
    expect(countTokens("")).toBe(0);
  });

  it("counts a non-empty string as > 0 tokens", () => {
    expect(countTokens("hello world")).toBeGreaterThan(0);
  });

  it("is deterministic — same input, same count", () => {
    const a = countTokens("export const x = 1;");
    const b = countTokens("export const x = 1;");
    expect(a).toBe(b);
  });

  it("uses the o200k_base encoding", () => {
    expect(activeTokenizerName()).toBe("o200k_base");
  });

  it("bounds enormous low-entropy payloads (no BPE stall)", () => {
    // A multi-MB single-char run stalls the raw BPE tokenizer for minutes.
    // The guard must estimate above the cap and return promptly (~chars/4).
    const huge = "x".repeat(9_000_000);
    const t0 = Date.now();
    const n = countTokens(huge);
    expect(Date.now() - t0).toBeLessThan(1000); // returns fast, no stall
    expect(n).toBe(Math.ceil(huge.length / 4)); // char-based estimate above cap
  });
});

describe("measurement harness (rung 1)", () => {
  it("reports 0% saved when optimized === original", () => {
    const m = measure("noop", "the quick brown fox", "the quick brown fox");
    expect(m.savedPct).toBe(0);
    expect(m.ratio).toBe(1);
  });

  it("reports positive savings when optimized is smaller", () => {
    const original = "x".repeat(1000) + " word ".repeat(100);
    const optimized = "x word";
    const m = measure("shrunk", original, optimized);
    expect(m.optimizedTokens).toBeLessThan(m.originalTokens);
    expect(m.savedPct).toBeGreaterThan(0);
  });

  it("summarize aggregates totals and overall saved%", () => {
    const m1 = measure("a", "aaaa bbbb cccc", "aaaa");
    const m2 = measure("b", "dddd eeee ffff", "dddd");
    const s = summarize([m1, m2]);
    expect(s.totalOriginal).toBe(m1.originalTokens + m2.originalTokens);
    expect(s.totalOptimized).toBe(m1.optimizedTokens + m2.optimizedTokens);
    expect(s.savedPct).toBeGreaterThan(0);
  });
});
