import { describe, it, expect, beforeEach, afterEach, beforeAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileCCRStore, type CCRStore } from "../src/ccr/store.js";
import { evalBlock, emptyReport, gate } from "../src/evals.js";
import { ensureAst } from "../src/optimizer/ast.js";

describe("fidelity evals (deterministic judging)", () => {
  let root: string;
  let ccr: CCRStore;
  beforeAll(async () => await ensureAst());
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "knitbrain-evals-"));
    ccr = createFileCCRStore(root);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("error lines and summaries survive log compression (counted preserved)", () => {
    const log = [
      "RUN  v4.1.8 /proj",
      ...Array.from({ length: 50 }, (_, i) => ` ✓ tests/u${i}.test.ts (3 tests) ${i}ms`),
      " ✗ tests/core.test.ts > breaks",
      "   AssertionError: expected 1 to be 2",
      ...Array.from({ length: 30 }, (_, i) => ` ✓ tests/v${i}.test.ts (2 tests) ${i}ms`),
      " Tests  1 failed | 240 passed (241)",
    ].join("\n");
    const rep = emptyReport();
    evalBlock(log, ccr, rep);
    expect(rep.blocks).toBe(1);
    expect(rep.errorLines.total).toBeGreaterThan(0);
    expect(rep.errorLines.preserved).toBe(rep.errorLines.total);
    expect(rep.summaryLines.preserved).toBe(rep.summaryLines.total);
    expect(rep.roundTrip.ok).toBe(rep.roundTrip.total);
  });

  it("top-level identifiers survive code compression", () => {
    const code = [
      'import { x } from "y";',
      "export function alpha(a: number): number {",
      ...Array.from({ length: 10 }, (_, i) => `  const v${i} = a * ${i};`),
      "  return a;",
      "}",
      "export class BetaService {",
      "  run(): void {",
      ...Array.from({ length: 10 }, (_, i) => `    console.log(${i});`),
      "  }",
      "}",
    ].join("\n");
    const rep = emptyReport();
    evalBlock(code, ccr, rep);
    expect(rep.identifiers.total).toBeGreaterThanOrEqual(2); // alpha, BetaService
    expect(rep.identifiers.preserved).toBe(rep.identifiers.total);
  });

  it("gate enforces the published thresholds", () => {
    const rep = emptyReport();
    rep.errorLines = { total: 10, preserved: 10 };
    rep.identifiers = { total: 100, preserved: 99 };
    rep.summaryLines = { total: 20, preserved: 19 };
    rep.roundTrip = { total: 5, ok: 5 };
    rep.neverExpand = { total: 5, ok: 5 };
    expect(gate(rep)).toBe(true);
    rep.errorLines = { total: 10, preserved: 9 }; // one lost error ⇒ FAIL
    expect(gate(rep)).toBe(false);
  });
});
