import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKnowledge } from "../src/engine/knowledge.js";
import { createWikiStore } from "../src/engine/wiki.js";
import { createMemory } from "../src/engine/memory.js";
import { projectTranscriptDir } from "../src/engine/usage.js";
import { createSkillsStore } from "../src/engine/skills.js";
import { runOnboard, persistIntent, INTENT_QUESTIONS, computeOnboardGaps, resolveOnboardGap, projectHasTests, goalCheckboxes, parseGoalProgress, detectResumeState, resumeBrief } from "../src/engine/onboard.js";
import { existsSync, readFileSync } from "node:fs";
import { createFileCCRStore } from "../src/ccr/store.js";
import { createFeedback } from "../src/engine/feedback.js";
import { createTeamBoard } from "../src/engine/teams.js";
import { createMeter } from "../src/engine/meter.js";
import { createCalibration } from "../src/engine/calibration.js";
import { TOOLS, type ToolContext } from "../src/mcp/tools.js";
import { workflowPath } from "../src/paths.js";
import { terseStore } from "../src/compress-file.js";

// Phase 2: the onboard import half — scan the repo + ingest this project's PAST
// transcripts into the wiki + mine learnings. Real files on disk, no mocks.
describe("onboard import (runOnboard): present scan + past ingest", () => {
  let root: string; // holds the fake project + fake home
  let proj: string;
  let home: string;

  // A real-shape transcript: user prompt + a failed tool call + a later success.
  const GOOD_TRANSCRIPT = [
    JSON.stringify({ type: "user", message: { content: "fix the failing build in app.ts" } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "node app.ts" } }, { type: "text", text: "running it" }] } }),
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "Error: Cannot find module './app.ts'" }] } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "node app.js" } }] } }),
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2", content: "build ok" }] } }),
  ].join("\n");

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kb-onboard-"));
    proj = join(root, "proj");
    home = join(root, "home");
    mkdirSync(join(proj, "src"), { recursive: true });
    writeFileSync(join(proj, "src", "b.ts"), "export const b = 1;\n");
    writeFileSync(join(proj, "src", "a.ts"), 'import { b } from "./b.js";\nexport const a = b;\n');
    // seed this project's transcript dir under the fake home
    const tdir = projectTranscriptDir(proj, home);
    mkdirSync(tdir, { recursive: true });
    writeFileSync(join(tdir, "good.jsonl"), GOOD_TRANSCRIPT);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

  const deps = () => ({
    knowledge: createKnowledge(proj, join(root, "kb")),
    wiki: createWikiStore(join(root, "wiki")),
    memory: createMemory(join(root, "mem")),
  });

  it("scans the repo (present) and ingests the past transcript into wiki + spine", async () => {
    const d = deps();
    const r = await runOnboard(proj, d, home);
    expect(r.filesScanned).toBeGreaterThanOrEqual(2); // a.ts + b.ts
    expect(r.sessionsIngested).toBe(1);
    expect(r.learningsMined).toBeGreaterThanOrEqual(0); // mining is heuristic
    // wiki gained a session page + a spine log line
    expect(d.wiki.listPages().some((p) => p.kind === "session")).toBe(true);
    expect(d.wiki.recentLog(10).length).toBeGreaterThan(0);
  });

  it("skips a malformed transcript without throwing, still ingests the good one", async () => {
    const tdir = projectTranscriptDir(proj, home);
    writeFileSync(join(tdir, "bad.jsonl"), "this is not json\n{also not valid\n");
    const d = deps();
    const r = await runOnboard(proj, d, home); // must not throw
    expect(r.sessionsIngested).toBe(1); // only the good transcript counted
  });

  it("returns zeroes (no throw) when the project has no transcripts", async () => {
    const empty = join(root, "empty");
    mkdirSync(join(empty, "src"), { recursive: true });
    writeFileSync(join(empty, "src", "x.ts"), "export const x = 1;\n");
    const r = await runOnboard(empty, deps(), home);
    expect(r.sessionsIngested).toBe(0);
    expect(r.filesScanned).toBeGreaterThanOrEqual(1);
  });

  // Phase 3: the intent interview persists a Charter + constraints skill into the brain.
  it("persistIntent writes a Project Charter page, an intent learning, and a constraints skill", () => {
    const d = deps();
    const skills = createSkillsStore(join(root, "skills"));
    expect(INTENT_QUESTIONS.length).toBe(5);
    const answers = ["a token-optimizing brain", "all gates green", "never force-push\nnever publish without OK", "npm test", "ship the onboard arc"];
    const r = persistIntent(answers, { wiki: d.wiki, memory: d.memory, skills });
    // Charter wiki page with claim: lines
    const page = d.wiki.page(r.page);
    expect(page).toContain("claim: project = a token-optimizing brain");
    expect(page).toContain("claim: dod = all gates green");
    expect(page).toContain("claim: goal = ship the onboard arc");
    // intent learning searchable
    expect(d.memory.searchLearnings("token-optimizing brain", 5).some((h) => h.id === r.learningId)).toBe(true);
    // constraints skill carries the Q3 lines as guardrails
    const skill = skills.list().find((s) => s.name === r.skill);
    expect(skill).toBeDefined();
    expect(skill!.constraints).toContain("never force-push");
    expect(skill!.constraints).toContain("never publish without OK");
  });
});

// Phase 3: storage-side terse REUSES compressProse, gated + claim-safe.
describe("terseStore (brain-write terse, reuse compress-file)", () => {
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env["KNITBRAIN_TERSE_STORE"];
  });
  afterEach(() => {
    if (prev === undefined) delete process.env["KNITBRAIN_TERSE_STORE"];
    else process.env["KNITBRAIN_TERSE_STORE"] = prev;
  });

  it("default ON → terses prose (the caveman-in-brain optimization)", () => {
    delete process.env["KNITBRAIN_TERSE_STORE"];
    const t = "The reason that the component re-renders is basically that you are creating a new object.";
    expect(terseStore(t).length).toBeLessThan(t.length); // filler dropped by default
  });

  it("opt-out KNITBRAIN_TERSE_STORE=0 → byte-identical", () => {
    process.env["KNITBRAIN_TERSE_STORE"] = "0";
    const t = "The reason that the component re-renders is basically that you are creating a new object.";
    expect(terseStore(t)).toBe(t);
  });

  it("ON → shortens prose (fewer chars) but never touches claim: lines or code", () => {
    delete process.env["KNITBRAIN_TERSE_STORE"]; // default ON
    const prose = "The reason that the component re-renders is basically that you are creating a new object on each render.";
    const out = terseStore(prose);
    expect(out.length).toBeLessThan(prose.length); // filler dropped
    // structured text with claim: lines is returned UNCHANGED
    const charter = "- claim: project = the brain\n- claim: verify = npm test";
    expect(terseStore(charter)).toBe(charter);
    // a path/identifier survives
    const withPath = "validation helpers basically live in src/util.ts now";
    expect(terseStore(withPath)).toContain("src/util.ts");
  });
});

describe("onboard adaptive gaps (Gap B): judge what's missing, ask only for gaps", () => {
  const STYLE = { medianBodyLen: 0, terse: false, usesModel: false, usesTriggers: false, headers: [] as string[] };
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "kb-gapb-")); });
  afterEach(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

  it("flags an uncovered domain + a test-runner gap when tests exist but nothing covers them", () => {
    const gaps = computeOnboardGaps(["proxy"], { skills: [], agents: [] }, true);
    expect(gaps.map((g) => g.name)).toEqual(["proxy", "run-tests"]);
    expect(gaps.find((g) => g.name === "run-tests")!.question).toContain("test-runner");
    expect(gaps.find((g) => g.name === "proxy")!.kind).toBe("agent");
  });

  it("asks NOTHING extra when every domain has an agent and a test skill exists", () => {
    const covered = computeOnboardGaps(
      ["proxy"],
      { skills: [{ name: "test-runner", triggers: ["test"] }], agents: [{ name: "proxy" }] },
      true,
    );
    expect(covered).toEqual([]);
  });

  it("no test gap when the project has no tests", () => {
    expect(projectHasTests(["src/a.ts", "tests/a.test.ts"])).toBe(true);
    expect(projectHasTests(["src/a.ts", "README.md"])).toBe(false);
    const gaps = computeOnboardGaps([], { skills: [], agents: [] }, false);
    expect(gaps).toEqual([]);
  });

  it("resolving a skill gap on YES composes + persists a skill", () => {
    const store = createSkillsStore(join(root, "skills-b"));
    const gap = computeOnboardGaps([], { skills: [], agents: [] }, true)[0]!; // run-tests
    const res = resolveOnboardGap(gap, { skills: store, style: STYLE, projectRoot: root });
    expect(res.kind).toBe("skill");
    expect(store.list().some((s) => s.name === res.name)).toBe(true);
  });

  it("resolving an agent gap on YES writes a scoped .claude/agents file", () => {
    const store = createSkillsStore(join(root, "skills-b2"));
    const gap = computeOnboardGaps(["proxy"], { skills: [], agents: [] }, false)[0]!; // proxy agent
    const res = resolveOnboardGap(gap, { skills: store, style: STYLE, projectRoot: root });
    expect(res.kind).toBe("agent");
    expect(existsSync(res.path!)).toBe(true);
  });

  // A2: a gap-filled agent for a domain that HAS code is scoped to that domain's
  // files (src/<domain>/**), not the over-broad "(whole project)" default.
  it("gap-fill agent scope is derived from the domain's real files", () => {
    const store = createSkillsStore(join(root, "skills-scope"));
    const files = ["src/db/pool.ts", "src/db/migrate.ts", "src/db/query.ts"];
    const gap = computeOnboardGaps(["db"], { skills: [], agents: [] }, false)[0]!;
    const res = resolveOnboardGap(gap, { skills: store, style: STYLE, projectRoot: root, files });
    const body = readFileSync(res.path!, "utf8");
    expect(body).toContain("src/db/**");
    expect(body).not.toContain("(whole project)");
  });
});

describe("onboard → load_session workflow driver (Gap D, tool-level)", () => {
  let root: string;
  let prevHome: string | undefined;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kb-wf-tool-"));
    prevHome = process.env["KNITBRAIN_HOME"];
    process.env["KNITBRAIN_HOME"] = join(root, "home");
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env["KNITBRAIN_HOME"];
    else process.env["KNITBRAIN_HOME"] = prevHome;
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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

  it("onboard writes the workflow; a fresh load_session returns it verbatim", () => {
    const ctx = mkCtx();
    const onboardTool = TOOLS.find((t) => t.name === "knitbrain_onboard")!;
    const loadTool = TOOLS.find((t) => t.name === "knitbrain_load_session")!;
    const answers = ["knit-brain memory MCP", "gates green", "never force-push", "npm test", "ship the vision gaps"];

    // The answers path writes goal.md into cwd, and workflowPath() keys off
    // cwd — run the WHOLE flow chdir'd into the temp root (no repo pollution).
    const prevCwd = process.cwd();
    process.chdir(root);
    try {
      const out = onboardTool.run({ answers }, ctx) as string;
      expect(out).toContain("workflow written");

      // A FRESH load_session returns the SAME workflow, byte-for-byte. Call run()
      // directly (dispatch optimizes "data" outputs with a recall marker).
      const loaded = JSON.parse(loadTool.run({}, ctx)) as { workflow: string };
      const onDisk = readFileSync(workflowPath(), "utf8");
      expect(loaded.workflow).toBe(onDisk); // verbatim
      expect(loaded.workflow).toContain("# Workflow — knit-brain memory MCP");
      expect(loaded.workflow).toContain("GOAL: ship the vision gaps");
      expect(loaded.workflow).toContain("CONSTRAINTS: never force-push");
      const goalMd = readFileSync(join(root, "goal.md"), "utf8");
      expect(goalMd).toContain("# Goal — ship the vision gaps");
      // Gap 2: checkbox is the actual goal, NOT the vague boilerplate.
      expect(goalMd).toContain("- [ ] ship the vision gaps");
      expect(goalMd).not.toContain("design + implement + verify against the charter");
      // Gap 3: goal.md carries a VERIFY line the loop honors.
      expect(goalMd).toContain("VERIFY: npm test");
    } finally {
      process.chdir(prevCwd);
    }
  });
});

describe("goalCheckboxes (Gap 2): actionable tasks, never boilerplate", () => {
  it("no parts → the goal itself is ONE checkbox (holistic gate, no stall)", () => {
    expect(goalCheckboxes("Add tax to cart totals", [])).toEqual(["- [ ] Add tax to cart totals"]);
    // A compound goal is NOT split — sub-clauses would stall the one verify gate.
    expect(goalCheckboxes("build the parser and wire the CLI", [])).toEqual([
      "- [ ] build the parser and wire the CLI",
    ]);
  });
  it("parts present but goal has no per-domain clauses → ONE checkbox + coverage note (never N duplicates)", () => {
    expect(goalCheckboxes("ship v1", ["api", "worker"])).toEqual([
      "- [ ] ship v1",
      "(covers domains: api, worker — decompose into per-domain boxes as you go)",
    ]);
  });
  it("empty goal degrades gracefully", () => {
    expect(goalCheckboxes("", [])).toEqual(["- [ ] the current goal"]);
  });

  it("multi-clause goal that names ≥2 domains → distinct per-domain checkboxes, no duplicates", () => {
    const boxes = goalCheckboxes("build the api and the worker", ["api", "worker"]);
    expect(boxes).toEqual(["- [ ] api: build the api", "- [ ] worker: the worker"]);
    expect(new Set(boxes).size).toBe(boxes.length); // no duplicate checkbox text
  });

  it("unmatchable goal (no domain name appears in any clause) → ONE checkbox + a covers-domains note", () => {
    const boxes = goalCheckboxes("ship v1", ["api", "worker"]);
    const checkboxLines = boxes.filter((b) => b.startsWith("- [ ]"));
    expect(checkboxLines.length).toBe(1);
    expect(checkboxLines[0]).toBe("- [ ] ship v1");
    expect(boxes.some((b) => b.startsWith("(covers domains:") && b.includes("api") && b.includes("worker"))).toBe(true);
  });
});

describe("onboard greenfield gating (Gap 1): 'no code yet' only when truly empty", () => {
  let root: string;
  let prevHome: string | undefined;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kb-green-"));
    prevHome = process.env["KNITBRAIN_HOME"];
    process.env["KNITBRAIN_HOME"] = join(root, "home");
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env["KNITBRAIN_HOME"];
    else process.env["KNITBRAIN_HOME"] = prevHome;
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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
  const firstCall = (ctx: ToolContext): { questions: string[] } => {
    const tool = TOOLS.find((t) => t.name === "knitbrain_onboard")!;
    const prev = process.cwd();
    process.chdir(root);
    try {
      return JSON.parse(tool.run({}, ctx)) as { questions: string[] };
    } finally {
      process.chdir(prev);
    }
  };

  it("a repo with even ONE source file is NOT greenfield → 5 questions", () => {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "cart.js"), "export function total(x){return x;}\n");
    const { questions } = firstCall(mkCtx());
    expect(questions.length).toBe(INTENT_QUESTIONS.length); // 5, no "no code yet"
    expect(questions.some((q) => /no code yet/i.test(q))).toBe(false);
  });

  it("a truly empty repo IS greenfield → 6 questions incl. the parts prompt", () => {
    const { questions } = firstCall(mkCtx());
    expect(questions.length).toBe(INTENT_QUESTIONS.length + 1); // 6
    expect(questions.some((q) => /no code yet/i.test(q))).toBe(true);
  });
});

describe("Gap 5 — resume detection (continue, don't re-ask)", () => {
  it("parseGoalProgress splits [x] done from [ ] todo", () => {
    const md = `# Goal\n- [x] scan plugins\n- [X] wrap prompts\n- [ ] caveman storage\n* [ ] ship\nnot a box`;
    const { done, todo } = parseGoalProgress(md);
    expect(done).toEqual(["scan plugins", "wrap prompts"]);
    expect(todo).toEqual(["caveman storage", "ship"]);
  });

  it("detectResumeState combines injected git + goal.md into a brief", () => {
    const cwd = mkdtempSync(join(tmpdir(), "kb-resume-"));
    try {
      writeFileSync(join(cwd, "goal.md"), `- [x] gap2\n- [ ] gap5\n- [ ] gap4`);
      // Fake git runner — deterministic, no real repo needed.
      const git = (args: string): string => {
        if (args.startsWith("rev-parse")) return "feat/goal-orchestrate";
        if (args.startsWith("merge-base HEAD main")) return "abc123";
        if (args.startsWith("log")) return "d4c8dc0 feat(host-scan): commands+hooks\n2366d6e feat(hooks): goal-loop default";
        if (args.startsWith("status")) return " M src/mcp/tools.ts\n?? scratch.txt";
        return "";
      };
      const s = detectResumeState(cwd, undefined, { git });
      expect(s.branch).toBe("feat/goal-orchestrate");
      expect(s.shipped).toEqual(["feat(host-scan): commands+hooks", "feat(hooks): goal-loop default"]);
      expect(s.inFlight).toEqual(["src/mcp/tools.ts", "scratch.txt"]);
      expect(s.goalDone).toEqual(["gap2"]);
      expect(s.goalTodo).toEqual(["gap5", "gap4"]);
      const brief = resumeBrief(s);
      expect(brief).toContain("CONTINUE from here");
      expect(brief).toContain("do NOT ask what to do");
      expect(brief).toContain("feat/goal-orchestrate");
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  it("no work anywhere → empty brief (fresh repo falls back to the interview)", () => {
    const cwd = mkdtempSync(join(tmpdir(), "kb-resume2-"));
    try {
      const git = (): string => ""; // not a git repo / nothing shipped
      const s = detectResumeState(cwd, undefined, { git });
      expect(resumeBrief(s)).toBe("");
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  it("real git path (no injection) on a temp dir degrades gracefully — never throws", () => {
    const cwd = mkdtempSync(join(tmpdir(), "kb-resume3-"));
    try {
      // Not a git repo → makeGit's execSync fails on every call → empty, no throw.
      // (Assert only the resilience contract; the result depends on whether the
      // temp dir happens to sit under a repo, so don't pin it.)
      expect(() => resumeBrief(detectResumeState(cwd))).not.toThrow();
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
});
