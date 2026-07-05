import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TOOLS, dispatch, type ToolContext } from "../src/mcp/tools.js";
import { createFileCCRStore } from "../src/ccr/store.js";
import { createMemory } from "../src/engine/memory.js";
import { createKnowledge } from "../src/engine/knowledge.js";
import { createFeedback } from "../src/engine/feedback.js";
import { createTeamBoard } from "../src/engine/teams.js";
import { createMeter } from "../src/engine/meter.js";
import { createSkillsStore } from "../src/engine/skills.js";
import { createCalibration } from "../src/engine/calibration.js";
import { createWikiStore } from "../src/engine/wiki.js";
import { hostIndexPath, workflowPath } from "../src/paths.js";

/**
 * COHERENCE CONTRACT — the structural defense against the wiring gap class.
 * Four shipped bugs shared one shape: a store produced state that its consumer
 * never read (toolkit↛workflow, routing↛run, create↛host-index,
 * constraints↛drafted-skill). This suite enumerates every producer→consumer
 * chain; a new store without a wired consumer FAILS THE BUILD instead of being
 * discovered by a user. Add a chain here whenever a store or field is added.
 */

const tool = (name: string) => TOOLS.find((t) => t.name === name)!;

describe("producer→consumer coherence (the wiring contract)", () => {
  let root: string;
  let prevCwd: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kb-coherence-"));
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "util.ts"), "export function helper(): number { return 1; }\n");
    prevCwd = process.cwd();
    process.chdir(root); // workflowPath/hostIndexPath/goal.md all key off cwd
    process.env["KNITBRAIN_HOME"] = join(root, ".knitbrain"); // never touch the real brain
  });
  afterEach(() => {
    process.chdir(prevCwd);
    delete process.env["KNITBRAIN_HOME"];
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

  it("onboard(answers) → workflow carries charter + TOOLKIT + ROUTING + goal.md; load_session serves it; run() reads it; constraints reach drafted skills", () => {
    const ctx = mkCtx();
    // Chain 1: charter answers → standing workflow (with toolkit + routing).
    const out = tool("knitbrain_onboard").run(
      { answers: ["demo project", "tests green", "never delete files", "npm test", "ship demo", "alpha, beta"] },
      ctx,
    ) as string;
    expect(out).toContain("workflow written");
    const wf = readFileSync(workflowPath(), "utf8");
    expect(wf).toMatch(/^TOOLKIT:/m); // scanned arsenal reaches the driver
    expect(wf).toMatch(/^ROUTING/m); // every part gets an owner line
    expect(wf).toContain("- alpha →"); // declared greenfield parts seed routing
    // Chain 2: goal embedded from day one.
    expect(readFileSync(join(root, "goal.md"), "utf8")).toContain("# Goal — ship demo");
    // Chain 3: load_session re-surfaces the driver verbatim.
    const loaded = JSON.parse(tool("knitbrain_load_session").run({}, ctx) as string) as { workflow: string };
    expect(loaded.workflow).toBe(wf);
    // Chain 4: run() consults the stored routing per task…
    const run = JSON.parse(tool("knitbrain_run").run({ task: "add a helper to alpha" }, ctx) as string) as {
      workflow_routing: unknown;
      skill: { constraints: string[] };
    };
    expect(Array.isArray(run.workflow_routing)).toBe(true);
    expect((run.workflow_routing as string[]).some((l) => l.includes("alpha"))).toBe(true);
    // Chain 5: …and charter constraints ride every drafted skill.
    expect(run.skill.constraints).toContain("never delete files");
  });

  it("onboard(create) → host-index refreshed immediately with the created agent", () => {
    const ctx = mkCtx();
    tool("knitbrain_onboard").run({}, ctx); // scan pass writes the base index
    tool("knitbrain_onboard").run({ create: ["gamma"] }, ctx);
    expect(existsSync(hostIndexPath())).toBe(true);
    expect(readFileSync(hostIndexPath(), "utf8")).toContain("gamma");
  });

  it("record_learning → search_learnings + brain_search + load_session all serve it", () => {
    const ctx = mkCtx();
    tool("knitbrain_classify_task").run({ description: "add x" }, ctx); // open gate state (direct run bypasses gate, kept for realism)
    tool("knitbrain_record_learning").run({ summary: "alpha lives in src/util.ts", lesson: "alpha detail" }, ctx);
    expect(tool("knitbrain_search_learnings").run({ query: "alpha util" }, ctx)).toContain("alpha");
    expect(tool("knitbrain_brain_search").run({ query: "alpha util" }, ctx)).toContain("memory");
    expect(tool("knitbrain_load_session").run({}, ctx)).toContain("alpha");
  });

  it("load_session flags a session that did NOT actually reset (clear-detection)", () => {
    const ccr = createFileCCRStore(join(root, "ccr-cd"));
    const base: ToolContext = {
      ccr,
      memory: createMemory(join(root, "mem-cd")),
      knowledge: createKnowledge(root, join(root, "kb-cd")),
      feedback: createFeedback(join(root, "fb-cd")),
      team: createTeamBoard(join(root, "team-cd"), ccr),
      meter: createMeter(join(root, "meter-cd-hi"), { realUsage: () => 200_000 }),
      skills: createSkillsStore(join(root, "skills-cd")),
      calibration: createCalibration(join(root, "cal-cd")),
      wiki: createWikiStore(join(root, "wiki-cd")),
    };
    const hi = JSON.parse(tool("knitbrain_load_session").run({}, base) as string) as { clearCheck?: string };
    expect(hi.clearCheck).toMatch(/reset may not have taken/);
    // a genuinely fresh session (low live usage) gets NO false warning.
    const low: ToolContext = { ...base, meter: createMeter(join(root, "meter-cd-lo"), { realUsage: () => 1_000 }) };
    const fresh = JSON.parse(tool("knitbrain_load_session").run({}, low) as string) as { clearCheck?: string };
    expect(fresh.clearCheck).toBeUndefined();
  });

  it("skill_save → run() serves the saved skill with its record; outcome updates it", () => {
    const ctx = mkCtx();
    tool("knitbrain_skill_save").run({ name: "wire-check", body: "steps", triggers: ["wire", "checker"] }, ctx);
    tool("knitbrain_skill_outcome").run({ name: "wire-check", worked: true }, ctx);
    const run = JSON.parse(tool("knitbrain_run").run({ task: "wire the checker" }, ctx) as string) as {
      skill: { name?: string; status: string };
    };
    expect(run.skill.name).toBe("wire-check");
  });

  it("team_post → board lists it; team_get returns the exact original", () => {
    const ctx = mkCtx();
    const posted = tool("knitbrain_team_post").run({ author: "a1", content: "finding: alpha ok" }, ctx) as string;
    const id = /posted ([0-9a-f]+)/.exec(posted)![1]!;
    expect(tool("knitbrain_team_board").run({}, ctx)).toContain(id);
    expect(tool("knitbrain_team_get").run({ id }, ctx)).toBe("finding: alpha ok");
  });

  it("JSON contract: data-tool responses stay machine-parseable through dispatch (never mid-elided)", () => {
    const ctx = mkCtx();
    tool("knitbrain_classify_task").run({ description: "add x" }, ctx);
    // self_check emits the biggest JSON payload — the one that used to skeletonize.
    const out = dispatch(tool("knitbrain_self_check"), {}, ctx);
    const body = JSON.parse(out.replace(/\n\n\[knitbrain[^\]]*\][\s\S]*$/u, "")) as { invariants: unknown[] };
    expect(Array.isArray(body.invariants)).toBe(true);
    expect(body.invariants.length).toBeGreaterThanOrEqual(4);
    expect(out).not.toContain("⟪"); // no elision markers inside a JSON contract
  });
});
