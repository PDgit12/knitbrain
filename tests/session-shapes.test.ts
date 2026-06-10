import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileCCRStore, type CCRStore } from "../src/ccr/store.js";
import { compress, stripLineNumbers } from "../src/optimizer/router.js";
import { countTokens } from "../src/tokenizer.js";

/** A Read-style tool result: line-numbered body-heavy code. */
function lineNumberedRead(): string {
  const code = [
    `import { x } from "./x.js";`,
    `export function handler(a: number): number {`,
    ...Array.from({ length: 40 }, (_, i) => `  const v${i} = compute(${i});`),
    `  return a;`,
    `}`,
  ];
  return code.map((l, i) => `${String(i + 1).padStart(6)}→${l}`).join("\n");
}

/** A log-style tool result: heavy line repetition. */
function repetitiveLog(): string {
  const lines: string[] = [];
  for (let i = 0; i < 30; i++) {
    lines.push("warning: deprecated API used in module core");
    lines.push(`request ${i % 3} handled`);
  }
  return lines.join("\n");
}

describe("real session shapes (the 16.9% fix)", () => {
  let root: string;
  let ccr: CCRStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "knitbrain-shapes-"));
    ccr = createFileCCRStore(root);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("detects and strips host-Read line numbering", () => {
    const stripped = stripLineNumbers(lineNumberedRead());
    expect(stripped).not.toBeNull();
    expect(stripped!).toContain("export function handler");
    expect(stripped!).not.toMatch(/^\s*\d+→/m);
    expect(stripLineNumbers("plain prose\nwith lines\n".repeat(10))).toBeNull();
  });

  it("line-numbered Read output now compresses like code AND recovers the exact numbered original", () => {
    const original = lineNumberedRead();
    const r = compress(original, ccr);
    expect(r.compressed).toBe(true);
    expect(r.savedPct).toBeGreaterThan(40); // was ~0-16% before the fix
    expect(ccr.get(r.handle)).toBe(original); // TRUE original, numbers included
  });

  it("repetitive logs now dedup with ×N counts AND recover exactly", () => {
    const original = repetitiveLog();
    const r = compress(original, ccr);
    expect(r.compressed).toBe(true);
    expect(r.skeleton).toContain("⟪×"); // dedup markers
    expect(r.savedPct).toBeGreaterThan(50); // was 0% before the fix
    expect(ccr.get(r.handle)).toBe(original);
  });

  it("non-repetitive prose still passes through (never-expand)", () => {
    const prose = Array.from({ length: 40 }, (_, i) => `unique narrative line number ${i} with different words ${i * 7}`).join("\n");
    const r = compress(prose, ccr);
    expect(countTokens(r.skeleton)).toBeLessThanOrEqual(countTokens(prose));
  });
});
