import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compressProse, runCompressFile } from "../src/compress-file.js";

describe("compressProse — protect code/URLs/paths, strip prose", () => {
  it("byte-preserves fenced code, inline code, URLs, and paths", () => {
    const fenced = "```ts\nconst the = a || an;\n```";
    const text = `Please just use the helper at \`doThing()\` really.\nSee https://example.com/the/a/an and src/foo/bar.ts for the details.\n${fenced}`;
    const out = compressProse(text);
    expect(out).toContain(fenced); // fenced code untouched (incl. its articles)
    expect(out).toContain("`doThing()`");
    expect(out).toContain("https://example.com/the/a/an");
    expect(out).toContain("src/foo/bar.ts");
  });

  it("drops fillers, pleasantries, and leading articles in prose", () => {
    const out = compressProse("Please just fix the bug really.");
    expect(out).not.toMatch(/\bplease\b/i);
    expect(out).not.toMatch(/\bjust\b/i);
    expect(out).not.toMatch(/\breally\b/i);
    expect(out).toContain("fix"); // substance kept
    expect(out).toContain("bug");
  });

  it("does not corrupt bare numbers in prose", () => {
    expect(compressProse("bump to version 3 then 12 later")).toContain("version 3 then 12");
  });
});

describe("runCompressFile — reversible, non-clobbering", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kb-compress-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes a verbatim .original backup and refuses a second run without --force", () => {
    const f = join(dir, "CLAUDE.md");
    const original = "Please just read the docs at src/x.ts really carefully.\n";
    writeFileSync(f, original, "utf8");

    expect(runCompressFile([f])).toBe(0);
    expect(existsSync(`${f}.original`)).toBe(true);
    expect(readFileSync(`${f}.original`, "utf8")).toBe(original); // exact backup
    expect(readFileSync(f, "utf8").length).toBeLessThan(original.length); // shrank

    expect(runCompressFile([f])).toBe(1); // refuses — backup exists
    expect(runCompressFile([f, "--force"])).toBe(0); // --force overrides
  });
});
