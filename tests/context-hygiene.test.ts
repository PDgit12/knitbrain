import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanContextHygiene } from "../src/engine/host-scan.js";
import { runSelfCheck } from "../src/engine/self-check.js";
import { modelWindow } from "../src/engine/meter.js";

describe("scanContextHygiene (win on every machine)", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "kb-hygiene-"));
    mkdirSync(join(home, ".claude", "rules"), { recursive: true });
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("clean host config yields no findings", () => {
    writeFileSync(join(home, ".claude", "CLAUDE.md"), "# small\n");
    writeFileSync(join(home, ".claude", "rules", "style.md"), "short rule\n");
    const r = scanContextHygiene(home);
    expect(r.findings).toEqual([]);
    expect(r.instructionBytes).toBeGreaterThan(0);
  });

  it("flags archive dirs inside the rules load path", () => {
    mkdirSync(join(home, ".claude", "rules", "_archive", "zh"), { recursive: true });
    writeFileSync(join(home, ".claude", "rules", "_archive", "zh", "x.md"), "旧规则\n");
    const r = scanContextHygiene(home);
    expect(r.findings.some((f) => f.includes('"_archive"'))).toBe(true);
  });

  it("flags oversized always-loaded instructions", () => {
    writeFileSync(join(home, ".claude", "rules", "big.md"), "x".repeat(31_000));
    const r = scanContextHygiene(home);
    expect(r.findings.some((f) => f.includes("always-loaded instructions"))).toBe(true);
  });

  it("flags near-duplicate MCP servers (knit-brain vs knitbrain)", () => {
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({ mcpServers: { "knit-brain": {}, knitbrain: {}, pencil: {} } }),
    );
    const r = scanContextHygiene(home);
    expect(r.findings.some((f) => f.includes("near-duplicate MCP servers"))).toBe(true);
    expect(r.findings.some((f) => f.includes("pencil"))).toBe(false);
  });
});

describe("self_check context-hygiene invariant", () => {
  const base = {
    graphFiles: 1,
    wikiContradictionsBefore: 0,
    wikiContradictionsAfter: 0,
    wikiResolvedCount: 0,
    workflowExists: true,
    classified: true,
    learned: false,
    verified: false,
  };

  it("omitted when the scan didn't run; pass/fail follow findings", () => {
    expect(runSelfCheck(base).invariants.some((i) => i.name.startsWith("context-hygiene"))).toBe(false);
    const clean = runSelfCheck({ ...base, hygieneFindings: [] });
    expect(clean.invariants.find((i) => i.name === "context-hygiene:host")!.pass).toBe(true);
    const dirty = runSelfCheck({ ...base, hygieneFindings: ["archive dir clutter"] });
    expect(dirty.invariants.find((i) => i.name === "context-hygiene:host")!.pass).toBe(false);
    expect(dirty.allPass).toBe(false);
    expect(dirty.residualGaps.some((g) => g.includes("archive dir clutter"))).toBe(true);
  });
});

describe("modelWindow (meter model→window map)", () => {
  it("maps known model families and returns null for unknown", () => {
    expect(modelWindow("claude-sonnet-4-5")).toBe(200_000);
    expect(modelWindow("claude-sonnet-4-5[1m]")).toBe(1_000_000);
    expect(modelWindow("gpt-4o-mini")).toBe(128_000);
    expect(modelWindow("gpt-4.1")).toBe(1_000_000);
    expect(modelWindow("gpt-5")).toBe(400_000);
    expect(modelWindow("o3-mini")).toBe(200_000);
    expect(modelWindow("gemini-2.5-pro")).toBe(1_000_000);
    expect(modelWindow("mystery-model")).toBeNull();
  });
});

describe("self_check anti-drift:routing invariant", () => {
  const base = {
    graphFiles: 1,
    wikiContradictionsBefore: 0,
    wikiContradictionsAfter: 0,
    wikiResolvedCount: 0,
    workflowExists: true,
    classified: true,
    learned: false,
    verified: false,
  };

  it("omitted without comparison; pass when covered; fail + residual when stale", () => {
    expect(runSelfCheck(base).invariants.some((i) => i.name === "anti-drift:routing")).toBe(false);
    const ok = runSelfCheck({ ...base, routingStaleDomains: [] });
    expect(ok.invariants.find((i) => i.name === "anti-drift:routing")!.pass).toBe(true);
    const stale = runSelfCheck({ ...base, routingStaleDomains: ["proxy", "scheduler"] });
    const inv = stale.invariants.find((i) => i.name === "anti-drift:routing")!;
    expect(inv.pass).toBe(false);
    expect(inv.detail).toContain("proxy, scheduler");
    expect(stale.residualGaps.some((g) => g.includes("ROUTING is stale"))).toBe(true);
  });
});
