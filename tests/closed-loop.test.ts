import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, appendFileSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runClosedLoop, defaultJudge, makeGrade, makeReview, type ClosedLoopSteps } from "../src/engine/closed-loop.js";
import { createWikiStore } from "../src/engine/wiki.js";
import { countTokens } from "../src/tokenizer.js";

// Minimal injectable steps for the controller invariants.
const steps = (over: Partial<ClosedLoopSteps>): ClosedLoopSteps => ({
  judge: () => ({ clear: true, reason: "ok" }),
  iterate: () => {},
  grade: () => ({ pass: true, detail: "" }),
  review: (g) => ({ score: g ? 1 : 0, met: g, notes: "" }),
  ...over,
});

describe("closed-loop controller — invariants", () => {
  it("stops on met (one cycle when grade passes + review met)", () => {
    const r = runClosedLoop(steps({}), 6);
    expect(r.met).toBe(true);
    expect(r.cycles).toHaveLength(1);
  });

  it("stops on max-iterations without meeting (grade always fails)", () => {
    let calls = 0;
    const r = runClosedLoop(steps({ iterate: () => (calls += 1), grade: () => ({ pass: false, detail: "fail" }) }), 4);
    expect(r.met).toBe(false);
    expect(r.cycles).toHaveLength(4);
    expect(calls).toBe(4);
    expect(r.reason).toContain("max 4");
  });

  it("NEVER false-green: a met review on a FAILING grade is not accepted", () => {
    const r = runClosedLoop(steps({ grade: () => ({ pass: false, detail: "fail" }), review: () => ({ score: 1, met: true, notes: "looks done" }) }), 2);
    expect(r.met).toBe(false);
    expect(r.cycles.every((c) => c.met === false)).toBe(true);
  });

  it("does not start cycles when the goal is judged unclear", () => {
    let iterated = false;
    const r = runClosedLoop(steps({ judge: () => ({ clear: false, reason: "vague" }), iterate: () => (iterated = true) }), 5);
    expect(r.met).toBe(false);
    expect(r.cycles).toHaveLength(0);
    expect(iterated).toBe(false);
    expect(r.reason).toContain("unclear");
  });
});

describe("closed-loop default steps", () => {
  it("defaultJudge: empty unclear, actionable brief clear", () => {
    expect(defaultJudge("").clear).toBe(false);
    expect(defaultJudge("add input validation to the parser").clear).toBe(true);
    expect(defaultJudge("- [ ] do the thing").clear).toBe(true);
  });

  it("makeGrade: empty verify vacuously passes; run result drives pass", () => {
    expect(makeGrade("", () => false)().pass).toBe(true);
    expect(makeGrade("x", () => true)().pass).toBe(true);
    expect(makeGrade("x", () => false)().pass).toBe(false);
  });

  it("makeReview: met requires grade pass AND every rubric check", () => {
    const allPass = makeReview([{ name: "a", check: () => true }]);
    expect(allPass(true).met).toBe(true);
    expect(allPass(false).met).toBe(false); // grade failed
    const oneFails = makeReview([{ name: "a", check: () => false }]);
    expect(oneFails(true).met).toBe(false); // rubric failed
  });
});

describe("closed-loop e2e — real goal driven to met (real verify, ≥2 cycles, wiki audit, live tokens)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kb-loop-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("drives a real goal to met in 2 cycles, no false green, full wiki trail + token readings", () => {
    const out = join(dir, "out.txt");
    writeFileSync(join(dir, "goal.md"), "- [ ] accumulate two lines of output\n");
    const wiki = createWikiStore(join(dir, "wiki"));
    const run = (cmd: string): boolean => spawnSync(cmd, { shell: true, cwd: dir, stdio: "ignore" }).status === 0;

    const result = runClosedLoop(
      {
        judge: () => defaultJudge(readFileSync(join(dir, "goal.md"), "utf8")),
        // the "agent" does real work: appends one line per pass
        iterate: () => appendFileSync(out, "work\n"),
        // REAL verify via the shell: needs >= 2 lines
        grade: makeGrade(`test "$(wc -l < out.txt 2>/dev/null || echo 0)" -ge 2`, run),
        review: makeReview(), // met == grade pass
        // audit trail → wiki log (P2)
        onCycle: (c) => wiki.log("cycle", `iter ${c.iter} · grade=${c.graded.pass} · met=${c.met}`),
        // live token reading off the real artifact (current-window probe analog)
        meter: () => (existsSync(out) ? countTokens(readFileSync(out, "utf8")) : 0),
      },
      6,
    );

    expect(result.met).toBe(true);
    expect(result.cycles).toHaveLength(2); // cycle1: 1 line (fail), cycle2: 2 lines (pass)
    expect(result.cycles[0]!.met).toBe(false); // no false green on the first, under-done pass
    expect(result.cycles[1]!.met).toBe(true);
    // live token readings captured per cycle, and grew as work accumulated
    expect(result.cycles[0]!.tokens).not.toBeNull();
    expect(result.cycles[1]!.tokens!).toBeGreaterThan(result.cycles[0]!.tokens!);
    // full audit trail in the wiki
    const log = wiki.recentLog(5);
    expect(log.filter((l) => l.includes("cycle |")).length).toBe(2);
    expect(log.some((l) => l.includes("met=true"))).toBe(true);
  });
});
