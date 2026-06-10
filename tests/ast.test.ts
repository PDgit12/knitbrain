import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileCCRStore, type CCRStore } from "../src/ccr/store.js";
import { astReady, ensureAst, compressCodeAst } from "../src/optimizer/ast.js";
import { compress } from "../src/optimizer/router.js";
import { isCode } from "../src/optimizer/code.js";
import { countTokens } from "../src/tokenizer.js";

const TS_SRC = `import { readFileSync } from "node:fs";

export interface Config { name: string; retries: number; }

export function loadConfig(path: string): Config {
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed.name) throw new Error("missing name");
  if (typeof parsed.retries !== "number") throw new Error("missing retries");
  return { name: parsed.name, retries: parsed.retries };
}

export class Runner {
  private attempts = 0;
  run(cfg: Config): boolean {
    for (let i = 0; i < cfg.retries; i += 1) {
      this.attempts += 1;
      if (this.attempts > 10) return false;
      if (i === cfg.retries - 1) return true;
    }
    return false;
  }
}
`;

const PY_SRC = `import os
import sys

class Loader:
    def __init__(self, path):
        self.path = path
        self.cache = {}
        self.hits = 0
        self.misses = 0

    def load(self, key):
        if key in self.cache:
            self.hits += 1
            return self.cache[key]
        self.misses += 1
        value = self._read(key)
        self.cache[key] = value
        return value

def main():
    loader = Loader(sys.argv[1])
    for key in sys.argv[2:]:
        print(loader.load(key))
    return 0
`;

describe("AST code handler (tree-sitter WASM)", () => {
  let root: string;
  let ccr: CCRStore;
  beforeAll(async () => {
    await ensureAst();
    expect(astReady()).toBe(true);
  });
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "knitbrain-ast-"));
    ccr = createFileCCRStore(root);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("elides TS function and method bodies, keeps imports/signatures/types (lossless)", () => {
    const r = compressCodeAst(TS_SRC, ccr)!;
    expect(r).not.toBeNull();
    expect(r.skeleton).toContain('import { readFileSync } from "node:fs"');
    expect(r.skeleton).toContain("export interface Config");
    expect(r.skeleton).toContain("export function loadConfig(path: string): Config");
    expect(r.skeleton).toContain("run(cfg: Config): boolean");
    expect(r.skeleton).toContain("lines"); // bodies elided
    expect(r.skeleton).not.toContain("JSON.parse(raw)");
    expect(r.skeleton).not.toContain("this.attempts += 1");
    expect(ccr.get(r.handle)).toBe(TS_SRC); // byte-for-byte recovery
    expect(countTokens(r.skeleton)).toBeLessThan(countTokens(TS_SRC));
  });

  it("elides Python def bodies — the brace scanner cannot", () => {
    expect(isCode(PY_SRC)).toBe(true); // routed as code at all
    const r = compressCodeAst(PY_SRC, ccr)!;
    expect(r).not.toBeNull();
    expect(r.skeleton).toContain("import os");
    expect(r.skeleton).toContain("class Loader:");
    expect(r.skeleton).toContain("def load(self, key):");
    expect(r.skeleton).not.toContain("self.misses += 1");
    expect(r.skeleton).toContain("# ⟨ccr:"); // python comment marker
    expect(ccr.get(r.handle)).toBe(PY_SRC);
  });

  it("returns null on non-code garbage (router falls back, never throws)", () => {
    const garbage = ")))((( not parseable @@@@ ".repeat(50);
    expect(compressCodeAst(garbage, ccr)).toBeNull();
  });

  it("router integration: code routes through AST when warm and stays lossless", () => {
    const r = compress(TS_SRC, ccr);
    expect(r.contentType).toBe("code");
    expect(r.compressed).toBe(true);
    expect(r.savedPct).toBeGreaterThan(30);
    expect(ccr.get(r.handle)).toBe(TS_SRC);
  });

  it("router integration: python content compresses meaningfully end-to-end", () => {
    const r = compress(PY_SRC, ccr);
    expect(r.contentType).toBe("code");
    expect(r.compressed).toBe(true);
    expect(ccr.get(r.handle)).toBe(PY_SRC);
  });
});
