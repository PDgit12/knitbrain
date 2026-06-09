import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileCCRStore, CCRMissingError, type CCRStore } from "../src/ccr/store.js";

const big = (seed: string): string =>
  JSON.stringify({ seed, blob: (seed + " ").repeat(200) });

describe("CCR tiering (rung 5)", () => {
  let root: string;
  let ccr: CCRStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "knitbrain-tier-"));
    ccr = createFileCCRStore(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("new entries start HOT", () => {
    const h = ccr.put(big("a"));
    expect(ccr.tierOf(h)).toBe("hot");
  });

  it("demote moves HOT → COLD but stays losslessly retrievable", () => {
    const original = big("b");
    const h = ccr.put(original);
    ccr.demote(h);
    expect(ccr.tierOf(h)).toBe("cold");
    expect(ccr.get(h)).toBe(original); // recovered from gzip, byte-for-byte
  });

  it("promote re-warms COLD → HOT", () => {
    const h = ccr.put(big("c"));
    ccr.demote(h);
    ccr.promote(h);
    expect(ccr.tierOf(h)).toBe("hot");
  });

  it("maintain demotes least-recently-used beyond hotMaxEntries (nothing lost)", () => {
    const hs = ["x", "y", "z"].map((s) => ccr.put(big(s)));
    // touch the last one so it's most-recently-used
    ccr.get(hs[2]!);
    const { demoted } = ccr.maintain({ hotMaxEntries: 1 });
    expect(demoted).toBe(2);
    expect(ccr.stats().hot).toBe(1);
    expect(ccr.stats().cold).toBe(2);
    // every original is still recoverable from cold
    for (const h of hs) expect(ccr.has(h)).toBe(true);
  });

  it("maintain purges cold beyond coldMaxEntries (last resort)", () => {
    const hs = ["p", "q", "r"].map((s) => ccr.put(big(s)));
    for (const h of hs) ccr.demote(h);
    const { purged } = ccr.maintain({ coldMaxEntries: 1 });
    expect(purged).toBe(2);
    expect(ccr.stats().cold).toBe(1);
  });

  it("a purged handle reports absent and throws on get", () => {
    const h = ccr.put(big("gone"));
    ccr.demote(h);
    ccr.maintain({ coldMaxEntries: 0 });
    expect(ccr.tierOf(h)).toBe("absent");
    expect(() => ccr.get(h)).toThrow(CCRMissingError);
  });

  it("tiering state survives a fresh store instance (manifest persists)", () => {
    const original = big("persist");
    const h = ccr.put(original);
    ccr.demote(h);
    const reopened = createFileCCRStore(root);
    expect(reopened.tierOf(h)).toBe("cold");
    expect(reopened.get(h)).toBe(original);
  });
});
