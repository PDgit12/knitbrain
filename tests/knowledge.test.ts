import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKnowledge, type Knowledge } from "../src/engine/knowledge.js";

describe("knowledge graph (rung 10)", () => {
  let root: string;
  let kn: Knowledge;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "knitbrain-kn-"));
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(
      join(root, "src", "a.ts"),
      `export function alpha() { return 1; }\nexport const A = 2;\n`,
    );
    writeFileSync(
      join(root, "src", "b.ts"),
      `import { alpha, A } from "./a.js";\nimport { readFileSync } from "node:fs";\nexport function beta() { return alpha() + A; }\n`,
    );
    kn = createKnowledge(root, join(root, ".cache"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("scans source files", () => {
    expect(kn.scan().files).toBe(2);
  });

  it("parses exports", () => {
    expect(kn.queryExports("src/a.ts")?.sort()).toEqual(["A", "alpha"]);
  });

  it("parses imports with specifiers and names", () => {
    const imports = kn.queryImports("src/b.ts") ?? [];
    const local = imports.find((i) => i.from === "./a.js");
    expect(local).toBeDefined();
    expect(local!.names.sort()).toEqual(["A", "alpha"]);
    expect(imports.some((i) => i.from === "node:fs")).toBe(true);
  });

  it("resolves dependents across the .js→.ts NodeNext convention", () => {
    expect(kn.queryDependents("src/a.ts")).toContain("src/b.ts");
  });

  it("persists the graph to cache across instances", () => {
    kn.scan();
    const reopened = createKnowledge(root, join(root, ".cache"));
    expect(reopened.queryExports("src/a.ts")?.sort()).toEqual(["A", "alpha"]);
  });

  it("reverse index returns ALL distinct importers, deduped (rung 12)", () => {
    // two more files importing a.ts → three dependents total
    writeFileSync(join(root, "src", "c.ts"), `import { alpha } from "./a.js";\nexport const c = alpha();\n`);
    // d imports a.ts twice (two specifiers) — must appear ONCE, not twice
    writeFileSync(
      join(root, "src", "d.ts"),
      `import { alpha } from "./a.js";\nimport { A } from "./a.js";\nexport const d = alpha() + A;\n`,
    );
    kn.scan();
    const deps = kn.queryDependents("src/a.ts").sort();
    expect(deps).toEqual(["src/b.ts", "src/c.ts", "src/d.ts"]);
    // a file nobody imports has no dependents (empty, not error)
    expect(kn.queryDependents("src/d.ts")).toEqual([]);
  });

  it("reverse index survives cache reload (built on load, not just scan)", () => {
    kn.scan();
    const reopened = createKnowledge(root, join(root, ".cache"));
    // no scan() call on the reopened instance — must answer from the cached graph
    expect(reopened.queryDependents("src/a.ts")).toContain("src/b.ts");
  });
});


describe("ghost-prune (deleted files dropped on cache load)", () => {
  it("drops cached nodes whose file no longer exists", () => {
    const r = mkdtempSync(join(tmpdir(), "kb-ghost-"));
    try {
      const cacheDir = join(r, ".cache");
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(join(r, "real.ts"), "export const x = 1;");
      writeFileSync(join(cacheDir, "graph.json"), JSON.stringify([
        { file: "real.ts", imports: [], exports: ["x"] },
        { file: "ghost.ts", imports: [], exports: ["y"] },
      ]));
      const kn = createKnowledge(r, cacheDir);
      expect(kn.queryExports("real.ts")).toEqual(["x"]);
      expect(kn.queryExports("ghost.ts")).toBeNull();
    } finally { rmSync(r, { recursive: true, force: true }); }
  });
});
