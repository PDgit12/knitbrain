import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileCCRStore, type CCRStore } from "../src/ccr/store.js";
import { compressText, compressShortProse } from "../src/optimizer/text.js";
import { PARAMS, setParams } from "../src/optimizer/params.js";

describe("optimizer/text — prose compression (direct coverage)", () => {
  let root: string;
  let ccr: CCRStore;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kb-text-"));
    ccr = createFileCCRStore(root);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("compresses long text losslessly and never expands", () => {
    const text = Array.from({ length: 80 }, (_, i) => `Paragraph ${i}: the quick brown fox jumps over the lazy dog, again and again.`).join("\n");
    const r = compressText(text, ccr);
    expect(r.handle).toBeTruthy();
    expect(ccr.get(r.handle)).toBe(text); // byte-for-byte recoverable
    expect(r.skeleton.length).toBeLessThanOrEqual(text.length); // never larger
  });

  it("compressShortProse returns null when there's nothing to anchor", () => {
    expect(compressShortProse("x", ccr)).toBeNull();
  });

  it("does not crash when minSentences is swept below the structural floor", () => {
    // The research harness can set minSentences low via KNITBRAIN_MIN_SENTENCES.
    // Two sentences is below HEAD(2)+TAIL(1)=3 boundaries, so the anchor reads
    // would go out of bounds without the structural guard — must return null,
    // never throw.
    const prior = PARAMS.minSentences;
    setParams({ minSentences: 1 });
    try {
      // No sentence boundaries → without the structural guard, the tail/head
      // anchor reads index past the empty bounds array and throw.
      expect(() => compressShortProse("a short line with no sentence split", ccr)).not.toThrow();
      expect(compressShortProse("a short line with no sentence split", ccr)).toBeNull();
    } finally {
      setParams({ minSentences: prior });
    }
  });
});
