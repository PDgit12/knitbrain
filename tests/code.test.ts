import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileCCRStore, type CCRStore } from "../src/ccr/store.js";
import { compressCode, isCode } from "../src/optimizer/code.js";
import { countTokens } from "../src/tokenizer.js";

const SAMPLE = `import { Brain } from "./brain";
import type { Params } from "./types";

// a decorated class with methods
export class Handlers {
  async loadSession(p: Params): Promise<string> {
    const prior = await this.brain.latest();
    const learnings = await this.brain.top(5);
    const marker = COMPUTE_INSIDE_BODY_MARKER;
    if (prior) {
      return JSON.stringify({ prior, learnings, marker });
    }
    return "none";
  }

  tiny(): number { return 1; }
}

export function helper(a: number, b: number): number {
  const sum = a + b;
  const doubled = sum * 2;
  return doubled - 1 + ANOTHER_BODY_MARKER;
}

for (const x of items) {
  process(x);
  KEEP_CONTROL_BLOCK_VISIBLE();
}
`;

describe("code optimizer (rung 3)", () => {
  let root: string;
  let ccr: CCRStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "knitbrain-code-"));
    ccr = createFileCCRStore(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("detects code structurally", () => {
    expect(isCode(SAMPLE)).toBe(true);
    expect(isCode("just some prose with no code at all")).toBe(false);
  });

  it("is LOSSLESS — original recovered byte-for-byte from CCR", () => {
    const { handle } = compressCode(SAMPLE, ccr);
    expect(ccr.get(handle)).toBe(SAMPLE);
  });

  it("keeps imports, signatures, types and class headers", () => {
    const { skeleton } = compressCode(SAMPLE, ccr);
    expect(skeleton).toContain('import { Brain } from "./brain";');
    expect(skeleton).toContain("export class Handlers");
    expect(skeleton).toContain("async loadSession(p: Params): Promise<string>");
    expect(skeleton).toContain("export function helper(a: number, b: number): number");
  });

  it("elides function/method body interiors", () => {
    const { skeleton } = compressCode(SAMPLE, ccr);
    expect(skeleton).not.toContain("COMPUTE_INSIDE_BODY_MARKER");
    expect(skeleton).not.toContain("ANOTHER_BODY_MARKER");
    expect(skeleton).toMatch(/…\d+ lines/);
  });

  it("keeps tiny bodies inline", () => {
    const { skeleton } = compressCode(SAMPLE, ccr);
    expect(skeleton).toContain("tiny(): number { return 1; }");
  });

  it("does NOT elide control blocks (if/for stay visible)", () => {
    const { skeleton } = compressCode(SAMPLE, ccr);
    expect(skeleton).toContain("KEEP_CONTROL_BLOCK_VISIBLE");
  });

  it("SHRINKS a body-heavy file", () => {
    const big = SAMPLE.replace(
      "const sum = a + b;",
      "const sum = a + b;\n" + "  const noise = compute();\n".repeat(30),
    );
    const { skeleton } = compressCode(big, ccr);
    expect(countTokens(skeleton)).toBeLessThan(countTokens(big));
  });

  it("appends a recovery handle", () => {
    const { skeleton, handle } = compressCode(SAMPLE, ccr);
    expect(skeleton).toContain(`⟨recall:${handle}⟩`);
  });
});
