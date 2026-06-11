import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOptimizer } from "../src/lib.js";

describe("library API (createOptimizer)", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "knitbrain-lib-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("compresses and retrieves losslessly through the public surface", () => {
    const kb = createOptimizer({ root });
    const original = JSON.stringify(
      { results: Array.from({ length: 80 }, (_, i) => ({ id: i, name: `row-${i}`, ok: true })) },
      null,
      2,
    );
    const r = kb.compress(original);
    expect(r.compressed).toBe(true);
    expect(r.skeletonTokens).toBeLessThan(r.originalTokens);
    expect(kb.has(r.handle)).toBe(true);
    expect(kb.retrieve(r.handle)).toBe(original);
  });

  it("never expands tiny payloads (pass-through)", () => {
    const kb = createOptimizer({ root });
    const r = kb.compress("ok");
    expect(r.compressed).toBe(false);
    expect(r.skeleton).toBe("ok");
    expect(r.handle).toBe("");
  });

  it("ready() resolves (AST warm-up is awaitable)", async () => {
    const kb = createOptimizer({ root });
    await expect(kb.ready()).resolves.toBeUndefined();
  });
});
