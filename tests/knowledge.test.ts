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
});
