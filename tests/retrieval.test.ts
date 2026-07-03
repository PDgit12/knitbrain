import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chunkSource, scoreChunk, searchCode } from "../src/engine/retrieval.js";
import { createKnowledge } from "../src/engine/knowledge.js";

const METER = `/** The context meter. */
export function createMeter(root: string): number {
  const windowTokens = 200_000;
  return windowTokens;
}

export interface MeterReading {
  usedTokens: number;
}

const CACHE_TTL_MS = 5 * 60_000;
`;

const QUOTA = `import { createMeter } from "./meter.js";
export function fetchQuota(): number {
  return createMeter("x");
}
`;

describe("chunkSource (function-level chunking)", () => {
  it("splits top-level declarations with signature + line", () => {
    const chunks = chunkSource("src/meter.ts", METER);
    const names = chunks.map((c) => c.name);
    expect(names).toContain("createMeter");
    expect(names).toContain("MeterReading");
    expect(names).toContain("CACHE_TTL_MS");
    const fn = chunks.find((c) => c.name === "createMeter")!;
    expect(fn.kind).toBe("function");
    expect(fn.signature).toContain("export function createMeter");
    expect(fn.startLine).toBe(2);
    expect(fn.text).toContain("windowTokens");
    expect(fn.text).not.toContain("MeterReading"); // next chunk's territory
  });
});

describe("scoreChunk (name > signature > body, coverage-weighted)", () => {
  const chunks = chunkSource("src/meter.ts", METER);
  const fn = chunks.find((c) => c.name === "createMeter")!;
  const iface = chunks.find((c) => c.name === "MeterReading")!;

  it("camelCase sub-tokens hit the name boost; exact name beats body mention", () => {
    const byName = scoreChunk(["meter"], fn, 0);
    expect(byName).toBeGreaterThan(0);
    expect(scoreChunk(["createmeter"], fn, 0)).toBeGreaterThan(scoreChunk(["createmeter"], iface, 0));
  });

  it("no term match → 0 (never serves noise)", () => {
    expect(scoreChunk(["zebra", "quantum"], fn, 0)).toBe(0);
  });
});

describe("searchCode (rank + gate + graph expansion)", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kb-retrieval-"));
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "meter.ts"), METER);
    writeFileSync(join(root, "src", "quota.ts"), QUOTA);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const deps = () => ({ knowledge: createKnowledge(root, join(root, ".kb-cache")), projectRoot: root });

  it("finds the right chunk, returns signature not body, and related graph files", () => {
    const hits = searchCode("createMeter context window", deps());
    expect(hits.length).toBeGreaterThan(0);
    const top = hits[0]!;
    expect(top.name).toBe("createMeter");
    expect(top.file).toBe("src/meter.ts");
    expect(top.signature).toContain("export function createMeter");
    // graph expansion: quota.ts imports meter.ts → shows up as related
    expect(top.related.some((r) => r.includes("quota"))).toBe(true);
  });

  it("irrelevant query → empty (score gate: no bad context)", () => {
    expect(searchCode("blockchain kubernetes deployment", deps())).toEqual([]);
    expect(searchCode("", deps())).toEqual([]);
  });
});
