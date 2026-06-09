import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFileCCRStore,
  sha256,
  CCRMissingError,
  CCRIntegrityError,
  type CCRStore,
} from "../src/ccr/store.js";

describe("CCR store (rung 2)", () => {
  let root: string;
  let ccr: CCRStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "knitbrain-ccr-"));
    ccr = createFileCCRStore(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("round-trips an original byte-for-byte", () => {
    const original = JSON.stringify({ a: 1, b: "x".repeat(500), c: [1, 2, 3] });
    const handle = ccr.put(original);
    expect(ccr.get(handle)).toBe(original);
  });

  it("is content-addressed (same content → same handle, dedup)", () => {
    const text = "the same bytes";
    expect(ccr.put(text)).toBe(ccr.put(text));
    expect(ccr.put(text)).toBe(sha256(text));
  });

  it("preserves unicode and whitespace exactly", () => {
    const original = "  ⟨str⟩ café\n\ttabs and 日本語 \r\n trailing  ";
    const handle = ccr.put(original);
    expect(ccr.get(handle)).toBe(original);
  });

  it("throws CCRMissingError for an unknown handle", () => {
    expect(() => ccr.get("deadbeef")).toThrow(CCRMissingError);
  });

  it("detects corruption via integrity check", () => {
    const original = "trust but verify";
    const handle = ccr.put(original);
    // Corrupt the stored file under its handle name.
    writeFileSync(join(root, handle), "tampered", "utf8");
    expect(() => ccr.get(handle)).toThrow(CCRIntegrityError);
  });
});
