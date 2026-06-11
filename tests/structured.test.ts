import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileCCRStore, type CCRStore } from "../src/ccr/store.js";
import {
  isDiff,
  isSearchResults,
  isLogOutput,
  compressDiff,
  compressSearchResults,
  compressLog,
} from "../src/optimizer/structured.js";
import { compress, detect } from "../src/optimizer/router.js";
import { countTokens } from "../src/tokenizer.js";

const GREP_OUT = Array.from({ length: 60 }, (_, i) => {
  const file = `src/module-${Math.floor(i / 6)}.ts`;
  return `${file}:${10 + i}:  const handler = createHandler("${i}", { retries: 3, timeout: 5000 });`;
}).join("\n");

const TEST_LOG = [
  "> knitbrain@0.1.2 test",
  "> vitest run",
  "",
  " RUN  v4.1.8 /Users/dev/project",
  "",
  ...Array.from({ length: 40 }, (_, i) => ` ✓ tests/unit-${i}.test.ts (${3 + (i % 5)} tests) ${12 + i}ms`),
  " ✗ tests/payments.test.ts > charge > declines expired cards",
  "   AssertionError: expected 402 to be 200",
  "   at tests/payments.test.ts:88:21",
  ...Array.from({ length: 30 }, (_, i) => ` ✓ tests/integration-${i}.test.ts (${2 + (i % 3)} tests) ${20 + i}ms`),
  "",
  " Test Files  1 failed | 70 passed (71)",
  "      Tests  1 failed | 312 passed (313)",
  "   Duration  14.21s",
].join("\n");

const GIT_DIFF = [
  "diff --git a/src/server.ts b/src/server.ts",
  "index 3f9a2b1..8c4d7e2 100644",
  "--- a/src/server.ts",
  "+++ b/src/server.ts",
  "@@ -10,30 +10,45 @@ import { createServer } from 'node:http';",
  ...Array.from({ length: 40 }, (_, i) =>
    i % 3 === 0 ? `+  const added${i} = ${i};` : i % 3 === 1 ? `-  const removed${i} = ${i};` : `   const context${i} = ${i};`,
  ),
  "@@ -60,8 +75,9 @@ export function start() {",
  "+  server.listen(port);",
  "-  server.listen(8080);",
  "   return server;",
].join("\n");

describe("structured handlers (search/log/diff)", () => {
  let root: string;
  let ccr: CCRStore;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "knitbrain-structured-"));
    ccr = createFileCCRStore(root);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("detects each shape, and detect() ranks them above code", () => {
    expect(isSearchResults(GREP_OUT)).toBe(true);
    expect(isLogOutput(TEST_LOG)).toBe(true);
    expect(isDiff(GIT_DIFF)).toBe(true);
    expect(detect(GREP_OUT)).toBe("search");
    expect(detect(TEST_LOG)).toBe("log");
    expect(detect(GIT_DIFF)).toBe("diff");
    // plain code is still code
    expect(detect("export function f(): number { return 1; }")).toBe("code");
  });

  it("search: collapses per-file, keeps counts, lossless", () => {
    const r = compressSearchResults(GREP_OUT, ccr);
    expect(countTokens(r.skeleton)).toBeLessThan(countTokens(GREP_OUT) * 0.5);
    expect(r.skeleton).toContain("src/module-0.ts:10");
    expect(r.skeleton).toContain("more matches in this file");
    expect(r.skeleton).toContain("60 matches across 10 files");
    expect(ccr.get(r.handle)).toBe(GREP_OUT);
  });

  it("log: keeps the failure and the summary, collapses passing runs", () => {
    const r = compressLog(TEST_LOG, ccr);
    expect(r.skeleton).toContain("✗ tests/payments.test.ts");
    expect(r.skeleton).toContain("AssertionError: expected 402 to be 200");
    expect(r.skeleton).toContain("Test Files  1 failed | 70 passed (71)");
    expect(r.skeleton).toContain("routine lines");
    expect(countTokens(r.skeleton)).toBeLessThan(countTokens(TEST_LOG) * 0.5);
    expect(ccr.get(r.handle)).toBe(TEST_LOG);
  });

  it("diff: keeps file/hunk headers, elides long hunk bodies with ± counts", () => {
    const r = compressDiff(GIT_DIFF, ccr);
    expect(r.skeleton).toContain("diff --git a/src/server.ts b/src/server.ts");
    expect(r.skeleton).toContain("@@ -10,30 +10,45 @@");
    expect(r.skeleton).toContain("hunk elided: +14/-13 lines, 13 context");
    // short second hunk stays inline
    expect(r.skeleton).toContain("+  server.listen(port);");
    expect(ccr.get(r.handle)).toBe(GIT_DIFF);
  });

  it("router end-to-end: all three shapes compress and recover byte-for-byte", () => {
    for (const sample of [GREP_OUT, TEST_LOG, GIT_DIFF]) {
      const r = compress(sample, ccr);
      expect(r.compressed).toBe(true);
      expect(r.savedPct).toBeGreaterThan(30);
      expect(ccr.get(r.handle)).toBe(sample);
    }
  });

  it("router races log against text-dedup and keeps the smaller", () => {
    // Highly repetitive log: line-dedup should beat head/tail elision.
    const repetitive = Array.from({ length: 200 }, (_, i) => `2026-06-11T10:00:${String(i % 60).padStart(2, "0")}Z INFO request handled in 12ms`).join("\n");
    const r = compress(repetitive, ccr);
    expect(r.compressed).toBe(true);
    expect(r.savedPct).toBeGreaterThan(80);
    expect(ccr.get(r.handle)).toBe(repetitive);
  });
});
