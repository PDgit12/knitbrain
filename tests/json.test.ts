import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileCCRStore, type CCRStore } from "../src/ccr/store.js";
import { compressJson, isJson } from "../src/optimizer/json.js";
import { countTokens } from "../src/tokenizer.js";

/** A realistic query_imports-style payload: many homogeneous items + long strings. */
function bigImportsPayload(): string {
  const imports = Array.from({ length: 40 }, (_, i) => ({
    name: `symbol_${i}`,
    from: `../engine/module_${i}`,
    line: i + 1,
    usedBy: [`handler_${i}`, `helper_${i}`],
    doc: "This symbol does something important. ".repeat(5),
  }));
  return JSON.stringify({ file: "src/mcp/handlers.ts", imports }, null, 2);
}

describe("JSON optimizer (rung 2)", () => {
  let root: string;
  let ccr: CCRStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "knitbrain-json-"));
    ccr = createFileCCRStore(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("detects JSON content structurally", () => {
    expect(isJson('{"a":1}')).toBe(true);
    expect(isJson("[1,2,3]")).toBe(true);
    expect(isJson("not json")).toBe(false);
    expect(isJson("function f(){}")).toBe(false);
  });

  it("is LOSSLESS — original recovered byte-for-byte from CCR", () => {
    const original = bigImportsPayload();
    const { handle } = compressJson(original, ccr);
    expect(ccr.get(handle)).toBe(original);
  });

  it("SHRINKS — skeleton has materially fewer tokens than the original", () => {
    const original = bigImportsPayload();
    const { skeleton } = compressJson(original, ccr);
    const before = countTokens(original);
    const after = countTokens(skeleton);
    expect(after).toBeLessThan(before);
    // expect a strong reduction on this redundant payload
    expect(after / before).toBeLessThan(0.5);
  });

  it("preserves the schema (top-level keys survive in the skeleton)", () => {
    const original = bigImportsPayload();
    const { skeleton } = compressJson(original, ccr);
    expect(skeleton).toContain("file");
    expect(skeleton).toContain("imports");
    expect(skeleton).toContain("name"); // shape of items is still visible
    expect(skeleton).toContain("more items"); // array was sampled
  });

  it("embeds a recovery handle in the skeleton", () => {
    const { skeleton, handle } = compressJson(bigImportsPayload(), ccr);
    expect(skeleton).toContain(`⟨ccr:${handle}⟩`);
  });
});
