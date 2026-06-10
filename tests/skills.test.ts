import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSkillsStore, type SkillsStore } from "../src/engine/skills.js";
import { createCalibration } from "../src/engine/calibration.js";
import { createFileCCRStore, type CCRStore } from "../src/ccr/store.js";
import { createMemory } from "../src/engine/memory.js";
import { createKnowledge } from "../src/engine/knowledge.js";
import { createFeedback } from "../src/engine/feedback.js";
import { createTeamBoard } from "../src/engine/teams.js";
import { createMeter } from "../src/engine/meter.js";
import { TOOLS, type ToolContext } from "../src/mcp/tools.js";

describe("skills engine (rung 19)", () => {
  let root: string;
  let skills: SkillsStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "knitbrain-skills-"));
    skills = createSkillsStore(join(root, "skills"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("find returns null when no skill matches", () => {
    expect(skills.find("migrate the database schema")).toBeNull();
  });

  it("save → find round-trip by triggers; uses count increments", () => {
    skills.save({ name: "proxy debugging", body: "STEPS: check health. check upstream.", triggers: ["proxy", "debug"] });
    const hit = skills.find("debug the proxy connection issue");
    expect(hit?.name).toBe("proxy debugging");
    expect(skills.list()[0]!.uses).toBe(1);
  });

  it("saving the same name UPDATES (skills compound)", () => {
    skills.save({ name: "x", body: "v1", triggers: ["alpha"] });
    skills.save({ name: "x", body: "v2", triggers: ["beta"] });
    const all = skills.list();
    expect(all.length).toBe(1);
    expect(all[0]!.body).toBe("v2");
    expect(all[0]!.triggers).toContain("alpha"); // old triggers kept
    expect(all[0]!.triggers).toContain("beta");
  });

  it("draft is telegraphic and seeds pitfalls from lessons", () => {
    const d = skills.draft("fix flaky meter test", ["meter thresholds are fractions not %"]);
    expect(d).toContain("GOAL:");
    expect(d).toContain("PITFALLS");
    expect(d).toContain("meter thresholds are fractions");
    expect(d).toContain("knitbrain_skill_save");
  });
});

describe("knitbrain_run orchestrator (rung 20)", () => {
  let root: string;
  let ctx: ToolContext;
  let ccr: CCRStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "knitbrain-run-"));
    ccr = createFileCCRStore(join(root, "ccr"));
    ctx = {
      ccr,
      memory: createMemory(join(root, "mem")),
      knowledge: createKnowledge(root, join(root, "kn")),
      feedback: createFeedback(join(root, "fb")),
      team: createTeamBoard(join(root, "team"), ccr),
      meter: createMeter(join(root, "meter")),
      skills: createSkillsStore(join(root, "skills")),
      calibration: createCalibration(join(root, "cal")),
    };
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const run = TOOLS.find((t) => t.name === "knitbrain_run")!;

  it("small task → trivial tier, NO agents, drafted skill, directive present", () => {
    const out = JSON.parse(run.run({ task: "fix typo in README" }, ctx));
    expect(out.classification.tier).toBe("trivial");
    expect(out.agents).toEqual([]);
    expect(out.skill.status).toContain("drafted");
    expect(out.directive).toContain("Execute");
    expect(out.meter.status).toBe("ok");
  });

  it("complex task → agents proposed only then (made at moment of need)", () => {
    const out = JSON.parse(run.run({ task: "refactor the architecture of the data layer" }, ctx));
    expect(out.classification.tier).toBe("complex");
    expect(out.directive).toContain("Plan first");
  });

  it("uses a saved skill when one matches (skills persist + compound)", () => {
    ctx.skills.save({ name: "typo fixing", body: "STEPS: grep. fix. done.", triggers: ["typo", "readme"] });
    const out = JSON.parse(run.run({ task: "fix typo in README" }, ctx));
    expect(out.skill.status).toBe("found");
    expect(out.skill.name).toBe("typo fixing");
  });

  it("run is VERBATIM-protected (directives never skeletonized)", () => {
    expect(run.output).toBe("verbatim");
  });
});
