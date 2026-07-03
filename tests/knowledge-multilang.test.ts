import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKnowledge, langOf } from "../src/engine/knowledge.js";
import { chunkSource, searchCode } from "../src/engine/retrieval.js";

/** One polyglot fixture repo: rust workspace + python pkg + go + java + rb + php. */
function writeFixture(root: string): void {
  // Rust: src/scheduler.rs used by src/main.rs (crate::) and src/lib.rs (mod)
  mkdirSync(join(root, "rs", "src"), { recursive: true });
  writeFileSync(
    join(root, "rs", "src", "scheduler.rs"),
    "pub struct Scheduler { queue: Vec<u32> }\npub fn spawn_worker(id: u32) -> u32 { id }\n",
  );
  writeFileSync(
    join(root, "rs", "src", "main.rs"),
    "use crate::scheduler::{Scheduler, spawn_worker};\nmod scheduler;\nfn main() { let _ = spawn_worker(1); }\n",
  );
  // Python: pkg/util.py imported by app.py two ways
  mkdirSync(join(root, "pkg"), { recursive: true });
  writeFileSync(join(root, "pkg", "__init__.py"), "");
  writeFileSync(join(root, "pkg", "util.py"), "def helper(x):\n    return x\n\nclass Config:\n    pass\n");
  writeFileSync(join(root, "app.py"), "from pkg.util import helper, Config\nimport pkg.util\n\ndef run():\n    return helper(1)\n");
  // Go
  mkdirSync(join(root, "gopkg", "store"), { recursive: true });
  writeFileSync(join(root, "gopkg", "store", "store.go"), 'package store\n\nfunc Save(k string) string { return k }\ntype Record struct{}\n');
  writeFileSync(join(root, "gopkg", "main.go"), 'package main\n\nimport "example.com/gopkg/store"\n\nfunc main() { store.Save("x") }\n');
  // Java
  mkdirSync(join(root, "javasrc", "com", "acme"), { recursive: true });
  writeFileSync(join(root, "javasrc", "com", "acme", "Widget.java"), "package com.acme;\npublic class Widget { }\n");
  writeFileSync(join(root, "javasrc", "Main.java"), "import com.acme.Widget;\npublic class Main { }\n");
  // Ruby
  writeFileSync(join(root, "worker.rb"), "class Worker\n  def perform!\n  end\nend\n");
  writeFileSync(join(root, "boot.rb"), "require_relative 'worker'\n");
  // PHP
  writeFileSync(join(root, "Mailer.php"), "<?php\nclass Mailer {\n  function send($to) { }\n}\n");
}

describe("multi-language knowledge graph (phases 1+2)", () => {
  let root: string;
  let cache: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kb-ml-"));
    cache = mkdtempSync(join(tmpdir(), "kb-ml-cache-"));
    writeFixture(root);
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(cache, { recursive: true, force: true });
  });

  it("langOf routes every supported extension", () => {
    expect(langOf("a/b.rs")).toBe("rs");
    expect(langOf("a.py")).toBe("py");
    expect(langOf("a.go")).toBe("go");
    expect(langOf("A.java")).toBe("java");
    expect(langOf("a.rb")).toBe("rb");
    expect(langOf("a.php")).toBe("php");
    expect(langOf("a.tsx")).toBe("js");
  });

  it("scan lists all languages (the orchestra '0 files indexed' bug)", () => {
    const k = createKnowledge(root, cache);
    expect(k.scan().files).toBe(12);
  });

  it("rust: use crate:: names + pub exports + mod/self edges resolve to the file", () => {
    const k = createKnowledge(root, cache);
    k.scan();
    const imports = k.queryImports("rs/src/main.rs")!;
    const useEdge = imports.find((e) => e.from === "crate::scheduler");
    expect(useEdge?.names.sort()).toEqual(["Scheduler", "spawn_worker"]);
    expect(k.queryExports("rs/src/scheduler.rs")!.sort()).toEqual(["Scheduler", "spawn_worker"]);
    expect(k.queryDependents("rs/src/scheduler.rs")).toContain("rs/src/main.rs");
  });

  it("python: from-import names + top-level exports + dotted-module dependents", () => {
    const k = createKnowledge(root, cache);
    k.scan();
    const imports = k.queryImports("app.py")!;
    expect(imports.find((e) => e.from === "pkg.util")?.names).toContain("helper");
    expect(k.queryExports("pkg/util.py")!.sort()).toEqual(["Config", "helper"]);
    expect(k.queryDependents("pkg/util.py")).toContain("app.py");
  });

  it("go: capitalization-exports + package-path dependents", () => {
    const k = createKnowledge(root, cache);
    k.scan();
    expect(k.queryExports("gopkg/store/store.go")!.sort()).toEqual(["Record", "Save"]);
    expect(k.queryDependents("gopkg/store/store.go")).toContain("gopkg/main.go");
  });

  it("java + ruby + php: exports and edges resolve", () => {
    const k = createKnowledge(root, cache);
    k.scan();
    expect(k.queryExports("javasrc/com/acme/Widget.java")).toContain("Widget");
    expect(k.queryDependents("javasrc/com/acme/Widget.java")).toContain("javasrc/Main.java");
    expect(k.queryExports("worker.rb")).toContain("Worker");
    expect(k.queryDependents("worker.rb")).toContain("boot.rb");
    expect(k.queryExports("Mailer.php")).toContain("Mailer");
  });

  it("retrieval chunks + ranks non-JS declarations (search_code alive for rust)", () => {
    const rust = "pub struct Scheduler { queue: Vec<u32> }\npub fn spawn_worker(id: u32) -> u32 { id }\n";
    const chunks = chunkSource("rs/src/scheduler.rs", rust);
    expect(chunks.map((c) => c.name).sort()).toEqual(["Scheduler", "spawn_worker"]);
    const k = createKnowledge(root, cache);
    const hits = searchCode("spawn worker scheduler", { knowledge: k, projectRoot: root });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.file).toBe("rs/src/scheduler.rs");
  });
});
