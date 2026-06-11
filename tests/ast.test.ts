import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileCCRStore, type CCRStore } from "../src/ccr/store.js";
import { astReady, ensureAst, compressCodeAst, grammarCandidates } from "../src/optimizer/ast.js";
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

  const GO_SRC = `package main

import (
	"fmt"
	"os"
)

func loadConfig(path string) (map[string]string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", path, err)
	}
	out := make(map[string]string)
	for _, line := range splitLines(string(data)) {
		k, v, ok := parseLine(line)
		if ok {
			out[k] = v
		}
	}
	return out, nil
}

func (s *Server) Handle(req Request) Response {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.count += 1
	if s.count > s.limit {
		return Response{Code: 429}
	}
	return Response{Code: 200, Body: process(req)}
}
`;

  const RUST_SRC = `use std::collections::HashMap;

pub fn tokenize(input: &str) -> Vec<Token> {
    let mut out = Vec::new();
    let mut chars = input.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '(' => out.push(Token::Open),
            ')' => out.push(Token::Close),
            _ => out.push(Token::Char(c)),
        }
    }
    out
}

impl Parser {
    pub fn parse(&mut self, tokens: &[Token]) -> Result<Ast, ParseError> {
        let mut stack = Vec::new();
        for tok in tokens {
            self.position += 1;
            stack.push(self.consume(tok)?);
        }
        Ok(Ast::from(stack))
    }
}
`;

  const JAVA_SRC = `package com.example.app;

import java.util.List;
import java.util.ArrayList;

public class OrderService {
    private final List<Order> orders = new ArrayList<>();

    public Order place(String sku, int quantity) {
        if (quantity <= 0) {
            throw new IllegalArgumentException("quantity must be positive");
        }
        Order order = new Order(sku, quantity);
        orders.add(order);
        notifyListeners(order);
        return order;
    }

    @Override
    public String toString() {
        StringBuilder sb = new StringBuilder("OrderService[");
        for (Order o : orders) {
            sb.append(o.getSku()).append(",");
        }
        return sb.append("]").toString();
    }
}
`;

  const RUBY_SRC = `require "json"

class Importer
  def initialize(path)
    @path = path
    @records = []
    @errors = []
    @seen = {}
  end

  def run
    File.readlines(@path).each do |line|
      record = JSON.parse(line)
      next if @seen[record["id"]]
      @seen[record["id"]] = true
      @records << record
    end
    @records.length
  end
end
`;

  it("grammarCandidates hints the right grammar first", () => {
    expect(grammarCandidates(GO_SRC)[0]).toBe("go");
    expect(grammarCandidates(RUST_SRC)[0]).toBe("rust");
    expect(grammarCandidates(JAVA_SRC)[0]).toBe("java");
    expect(grammarCandidates(PY_SRC)[0]).toBe("python");
    expect(grammarCandidates(TS_SRC)).toContain("typescript");
    expect(grammarCandidates(GO_SRC).length).toBeLessThanOrEqual(4);
  });

  it("elides Go function and method bodies, keeps signatures (lossless)", () => {
    expect(isCode(GO_SRC)).toBe(true);
    const r = compressCodeAst(GO_SRC, ccr)!;
    expect(r).not.toBeNull();
    expect(r.skeleton).toContain("package main");
    expect(r.skeleton).toContain("func loadConfig(path string) (map[string]string, error) {");
    expect(r.skeleton).toContain("func (s *Server) Handle(req Request) Response {");
    expect(r.skeleton).not.toContain("os.ReadFile(path)");
    expect(r.skeleton).not.toContain("s.mu.Lock()");
    expect(ccr.get(r.handle)).toBe(GO_SRC);
    expect(countTokens(r.skeleton)).toBeLessThan(countTokens(GO_SRC));
  });

  it("elides Rust fn and impl-method bodies (lossless)", () => {
    expect(isCode(RUST_SRC)).toBe(true);
    const r = compressCodeAst(RUST_SRC, ccr)!;
    expect(r).not.toBeNull();
    expect(r.skeleton).toContain("pub fn tokenize(input: &str) -> Vec<Token> {");
    expect(r.skeleton).toContain("impl Parser {");
    expect(r.skeleton).not.toContain("chars.peekable()");
    expect(r.skeleton).not.toContain("self.position += 1");
    expect(ccr.get(r.handle)).toBe(RUST_SRC);
  });

  it("elides Java method bodies, keeps class structure (lossless)", () => {
    expect(isCode(JAVA_SRC)).toBe(true);
    const r = compressCodeAst(JAVA_SRC, ccr)!;
    expect(r).not.toBeNull();
    expect(r.skeleton).toContain("public class OrderService {");
    expect(r.skeleton).toContain("public Order place(String sku, int quantity) {");
    expect(r.skeleton).toContain("@Override");
    expect(r.skeleton).not.toContain("IllegalArgumentException");
    expect(ccr.get(r.handle)).toBe(JAVA_SRC);
  });

  it("elides Ruby def…end bodies — end-delimited, scanner-invisible (lossless)", () => {
    const r = compressCodeAst(RUBY_SRC, ccr)!;
    expect(r).not.toBeNull();
    expect(r.skeleton).toContain("class Importer");
    expect(r.skeleton).toContain("def run");
    expect(r.skeleton).not.toContain('JSON.parse(line)');
    expect(r.skeleton).toContain("# ⟨ccr:"); // hash comment marker
    expect(ccr.get(r.handle)).toBe(RUBY_SRC);
  });
});
