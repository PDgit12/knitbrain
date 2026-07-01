import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, appendFileSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runClosedLoop, defaultJudge, makeGrade, makeReview, type ClosedLoopSteps } from "../src/engine/closed-loop.js";
import { createWikiStore } from "../src/engine/wiki.js";
import { countTokens } from "../src/tokenizer.js";
import { createFileCCRStore } from "../src/ccr/store.js";
import { createMemory } from "../src/engine/memory.js";
import { createKnowledge } from "../src/engine/knowledge.js";
import { createFeedback } from "../src/engine/feedback.js";
import { createTeamBoard } from "../src/engine/teams.js";
import { createMeter } from "../src/engine/meter.js";
import { createSkillsStore } from "../src/engine/skills.js";
import { createCalibration } from "../src/engine/calibration.js";
import { TOOLS, type ToolContext } from "../src/mcp/tools.js";

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
    // Cross-platform real verify (node exists everywhere; no unix `wc`/`test`):
    // exits 0 only when out.txt has >= 2 non-empty lines.
    writeFileSync(
      join(dir, "check.js"),
      "try{const n=require('fs').readFileSync('out.txt','utf8').split('\\n').filter(Boolean).length;process.exit(n>=2?0:1)}catch{process.exit(1)}",
    );
    const wiki = createWikiStore(join(dir, "wiki"));
    const run = (cmd: string): boolean => spawnSync(cmd, { shell: true, cwd: dir, stdio: "ignore" }).status === 0;

    const result = runClosedLoop(
      {
        judge: () => defaultJudge(readFileSync(join(dir, "goal.md"), "utf8")),
        // the "agent" does real work: appends one line per pass
        iterate: () => appendFileSync(out, "work\n"),
        // REAL verify (cross-platform): needs >= 2 lines
        grade: makeGrade("node check.js", run),
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

describe("knitbrain_run_loop tool (Gap C): drives the loop until met or max-iter", () => {
  let root: string;
  let prevHome: string | undefined;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kb-loop-tool-"));
    prevHome = process.env["KNITBRAIN_HOME"];
    process.env["KNITBRAIN_HOME"] = join(root, "home");
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env["KNITBRAIN_HOME"];
    else process.env["KNITBRAIN_HOME"] = prevHome;
    rmSync(root, { recursive: true, force: true });
  });

  const mkCtx = (): ToolContext => {
    const ccr = createFileCCRStore(join(root, "ccr"));
    return {
      ccr,
      memory: createMemory(join(root, "mem")),
      knowledge: createKnowledge(root, join(root, "kb")),
      feedback: createFeedback(join(root, "fb")),
      team: createTeamBoard(join(root, "team"), ccr),
      meter: createMeter(join(root, "meter")),
      skills: createSkillsStore(join(root, "skills")),
      calibration: createCalibration(join(root, "cal")),
      wiki: createWikiStore(join(root, "wiki")),
    };
  };
  const loopTool = () => TOOLS.find((t) => t.name === "knitbrain_run_loop")!;

  it("stops at grade-pass: verify_cmd exit 0 → met=true in one cycle", () => {
    const out = JSON.parse(loopTool().run({ goal: "make the check pass now", verify_cmd: "true" }, mkCtx()));
    expect(out.met).toBe(true);
    expect(out.iters).toBe(1);
  });

  it("stops at max-iter: failing verify across max_iters calls → met=false, stopped max-iters", () => {
    const ctx = mkCtx();
    const t = loopTool();
    const c1 = JSON.parse(t.run({ goal: "fix the failing thing here", verify_cmd: "false", max_iters: 2 }, ctx));
    expect(c1.met).toBe(false);
    expect(c1.iter).toBe(1);
    expect(c1.directive).toContain("Cycle 1/2");
    const c2 = JSON.parse(t.run({ goal: "fix the failing thing here", verify_cmd: "false", max_iters: 2 }, ctx));
    expect(c2.met).toBe(false);
    expect(c2.stopped).toBe("max-iters");
    expect(c2.iters).toBe(2);
  });

  it("logs each cycle to the wiki spine", () => {
    const ctx = mkCtx();
    loopTool().run({ goal: "make the check pass now", verify_cmd: "true" }, ctx);
    expect(ctx.wiki!.recentLog(5).some((l) => l.includes("loop"))).toBe(true);
  });

  it("rejects a vague goal (judge gate) without running verify", () => {
    const out = JSON.parse(loopTool().run({ goal: "x", verify_cmd: "true" }, mkCtx()));
    expect(out.met).toBe(false);
    expect(out.stopped).toBe("unclear-goal");
  });
});
