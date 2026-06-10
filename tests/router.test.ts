import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileCCRStore, type CCRStore } from "../src/ccr/store.js";
import { compress, detect } from "../src/optimizer/router.js";
import { countTokens } from "../src/tokenizer.js";

describe("ContentRouter (rung 4)", () => {
  let root: string;
  let ccr: CCRStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "knitbrain-router-"));
    ccr = createFileCCRStore(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("detects content types deterministically", () => {
    expect(detect('{"a":1,"b":2}')).toBe("json");
    expect(detect("export function f(x: number): number { return x + 1; }")).toBe("code");
    expect(detect("Just a paragraph of ordinary prose, nothing structured here.")).toBe("text");
  });

  it("NEVER expands — declaration-only code passes through unchanged", () => {
    // The exact shape that regressed in the e2e (interfaces, no fn bodies).
    const decls = `export interface A { id: number; name: string; }
export interface B { a: A; tags: string[]; }
export type C = A | B;
`;
    const r = compress(decls, ccr);
    expect(r.compressed).toBe(false);
    expect(r.skeleton).toBe(decls); // byte-identical passthrough
    expect(r.skeletonTokens).toBeLessThanOrEqual(r.originalTokens);
    expect(r.savedPct).toBe(0);
  });

  it("compresses and is LOSSLESS when it helps (redundant JSON)", () => {
    const json = JSON.stringify(
      { items: Array.from({ length: 30 }, (_, i) => ({ i, blob: "x".repeat(50) })) },
      null,
      2,
    );
    const r = compress(json, ccr);
    expect(r.compressed).toBe(true);
    expect(r.contentType).toBe("json");
    expect(r.skeletonTokens).toBeLessThan(r.originalTokens);
    expect(ccr.get(r.handle)).toBe(json); // byte-for-byte recovery
  });

  it("compresses body-heavy code and recovers the original", () => {
    const code = `export function run(): number {
${"  const noise = compute();\n".repeat(40)}  return 0;
}
`;
    const r = compress(code, ccr);
    expect(r.compressed).toBe(true);
    expect(r.contentType).toBe("code");
    expect(ccr.get(r.handle)).toBe(code);
  });

  it("short-prose sentence anchor: keeps opening + closing sentences, elides middle (lossless)", () => {
    const prose = [
      "The deployment failed on the third attempt because the registry rejected the manifest.",
      "We traced the rejection to a stale digest cached by the CI runner from a previous build.",
      "Clearing the runner cache and re-tagging the image resolved the immediate failure mode.",
      "The pipeline then progressed to the integration stage without further registry errors.",
      "However, two integration tests began flaking under the new image due to timezone drift.",
      "Pinning the container timezone to UTC eliminated the flakes in twenty consecutive runs.",
      "We also added a digest freshness check to the pre-push hook to prevent recurrence.",
      "Overall the incident cost roughly four engineer-hours and produced three durable fixes.",
      "Recommended follow-up: alert on registry rejections so stale digests surface immediately.",
    ].join(" ");
    const r = compress(prose, ccr);
    expect(r.compressed).toBe(true);
    expect(r.contentType).toBe("prose");
    expect(r.skeleton).toContain("The deployment failed"); // head kept
    expect(r.skeleton).toContain("Recommended follow-up"); // tail kept
    expect(r.skeleton).toContain("sentences elided");
    expect(r.skeleton).not.toContain("timezone drift"); // middle elided
    expect(ccr.get(r.handle)).toBe(prose); // byte-for-byte recovery
  });

  it("allowProse:false (TOIN back-off) disables the sentence anchor", () => {
    const prose = Array.from({ length: 12 }, (_, i) =>
      `Sentence number ${i} carries some distinct content about the system under test.`,
    ).join(" ");
    const r = compress(prose, ccr, { allowProse: false });
    expect(r.contentType).not.toBe("prose");
  });

  it("output tokens are always <= input tokens (the core invariant)", () => {
    const inputs = [
      "tiny",
      '{"x":1}',
      "export const y = 2;",
      "Ordinary prose with no structure to exploit at all here.",
    ];
    for (const text of inputs) {
      const r = compress(text, ccr);
      expect(countTokens(r.skeleton)).toBeLessThanOrEqual(countTokens(text));
    }
  });
});
