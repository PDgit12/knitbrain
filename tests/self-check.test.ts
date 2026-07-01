import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSelfCheck, type SelfCheckInput } from "../src/engine/self-check.js";
import { createWikiStore } from "../src/engine/wiki.js";
import { createFileCCRStore } from "../src/ccr/store.js";
import { createMemory } from "../src/engine/memory.js";
import { createKnowledge } from "../src/engine/knowledge.js";
import { createFeedback } from "../src/engine/feedback.js";
import { createTeamBoard } from "../src/engine/teams.js";
import { createMeter } from "../src/engine/meter.js";
import { createSkillsStore } from "../src/engine/skills.js";
import { createCalibration } from "../src/engine/calibration.js";
import { TOOLS, type ToolContext } from "../src/mcp/tools.js";

// A healthy baseline: every invariant green.
const healthy: SelfCheckInput = {
  graphFiles: 42,
  wikiContradictionsBefore: 0,
  wikiContradictionsAfter: 0,
  wikiResolvedCount: 0,
  workflowExists: true,
  classified: true,
  learned: true,
  verified: true,
};
const inv = (r: ReturnType<typeof runSelfCheck>, name: string) => r.invariants.find((i) => i.name === name)!;

describe("runSelfCheck (Gap F) — pure invariant composition", () => {
  it("all-green baseline passes with the graph re-scan counted as a fix", () => {
    const r = runSelfCheck(healthy);
    expect(r.allPass).toBe(true);
    expect(r.residualGaps).toEqual([]);
    expect(inv(r, "anti-stale:graph").fixed).toBe(true); // re-scan IS the heal
    expect(r.fixesApplied.some((f) => f.includes("42 files"))).toBe(true);
  });

  it("anti-stale:wiki — contradictions that resolve are reported as an auto-fix", () => {
    const r = runSelfCheck({ ...healthy, wikiContradictionsBefore: 3, wikiContradictionsAfter: 0, wikiResolvedCount: 3 });
    const w = inv(r, "anti-stale:wiki");
    expect(w.pass).toBe(true);
    expect(w.fixed).toBe(true);
    expect(r.fixesApplied.some((f) => f.includes("superseded 3"))).toBe(true);
  });

  it("anti-stale:wiki — contradictions that survive resolve are a residual FAIL", () => {
    const r = runSelfCheck({ ...healthy, wikiContradictionsBefore: 2, wikiContradictionsAfter: 2, wikiResolvedCount: 0 });
    expect(inv(r, "anti-stale:wiki").pass).toBe(false);
    expect(r.allPass).toBe(false);
    expect(r.residualGaps.some((g) => g.includes("wiki contradictions"))).toBe(true);
  });

  it("anti-drift:workflow — absent workflow is a residual gap, not silently healed", () => {
    const r = runSelfCheck({ ...healthy, workflowExists: false });
    expect(inv(r, "anti-drift:workflow").pass).toBe(false);
    expect(inv(r, "anti-drift:workflow").fixed).toBeUndefined();
    expect(r.residualGaps.some((g) => g.includes("anti-drift"))).toBe(true);
  });

  it("anti-sycophancy:verified — a learning with NO verify_claim behind it FAILS", () => {
    const r = runSelfCheck({ ...healthy, learned: true, verified: false });
    expect(inv(r, "anti-sycophancy:verified").pass).toBe(false);
    expect(r.residualGaps.some((g) => g.includes("verify_claim"))).toBe(true);
  });

  it("anti-sycophancy:verified — no learning recorded → nothing to verify, passes", () => {
    const r = runSelfCheck({ ...healthy, learned: false, verified: false });
    expect(inv(r, "anti-sycophancy:verified").pass).toBe(true);
  });

  it("adherence:classified — no classifier this session FAILS the write gate", () => {
    const r = runSelfCheck({ ...healthy, classified: false });
    expect(inv(r, "adherence:classified").pass).toBe(false);
    expect(r.residualGaps.some((g) => g.includes("adherence"))).toBe(true);
  });
});

describe("knitbrain_self_check tool — live, with a REAL induced wiki failure caught + fixed", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kb-selfcheck-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("injects an on-disk wiki contradiction → self_check catches it and auto-heals (newest wins, value recoverable)", () => {
    const wikiRoot = join(root, "wiki");
    const pages = join(wikiRoot, "pages");
    mkdirSync(pages, { recursive: true });
    // Two pages assert conflicting values for the SAME claim key, written straight
    // to disk (bypassing ingest's auto-heal) to seed a genuine broken invariant.
    writeFileSync(join(pages, "old-decision.md"), "# Old\n\n- claim: db = postgres\n");
    writeFileSync(join(pages, "new-decision.md"), "# New\n\n- claim: db = mysql\n");
    // Make new-decision unambiguously the newest so resolve() supersedes postgres.
    const t = Date.now() / 1000;
    utimesSync(join(pages, "old-decision.md"), t - 100, t - 100);
    utimesSync(join(pages, "new-decision.md"), t, t);

    const wiki = createWikiStore(wikiRoot);
    expect(wiki.lint().contradictions.length).toBe(1); // the induced failure is real

    const ccr = createFileCCRStore(join(root, "ccr"));
    const ctx: ToolContext = {
      ccr,
      memory: createMemory(join(root, "mem")),
      knowledge: createKnowledge(root, join(root, "kb")),
      feedback: createFeedback(join(root, "fb")),
      team: createTeamBoard(join(root, "team"), ccr),
      meter: createMeter(join(root, "meter")),
      skills: createSkillsStore(join(root, "skills")),
      calibration: createCalibration(join(root, "cal")),
      wiki,
    };

    // Call the tool's run() directly (dispatch would append a recall marker to "data").
    const tool = TOOLS.find((t) => t.name === "knitbrain_self_check")!;
    const report = JSON.parse(tool.run({}, ctx)) as {
      invariants: { name: string; pass: boolean; fixed?: boolean }[];
      fixesApplied: string[];
    };
    const wikiInv = report.invariants.find((i) => i.name === "anti-stale:wiki")!;
    expect(wikiInv.pass).toBe(true); // healed
    expect(wikiInv.fixed).toBe(true); // and reported as an auto-fix
    expect(report.fixesApplied.some((f) => /superseded 1/.test(f))).toBe(true);
    // wiki is clean afterwards, and the superseded value is still recoverable.
    expect(wiki.lint().contradictions).toEqual([]);
    expect(readFileSync(join(pages, "old-decision.md"), "utf8")).toContain("was: claim db = postgres");
  });
});
