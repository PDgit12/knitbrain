import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileCCRStore } from "../src/ccr/store.js";
import { createMemory } from "../src/engine/memory.js";
import { createKnowledge } from "../src/engine/knowledge.js";
import { createFeedback } from "../src/engine/feedback.js";
import { createTeamBoard } from "../src/engine/teams.js";
import { createMeter } from "../src/engine/meter.js";
import { createSkillsStore, type SkillsStore } from "../src/engine/skills.js";
import { createCalibration } from "../src/engine/calibration.js";
import { TOOLS, dispatch, type ToolContext } from "../src/mcp/tools.js";

// Direct handler coverage for the meta tools through real dispatch: metrics
// returns the rollup shape; skill_outcome records an outcome the store reflects.
describe("MCP meta tools (metrics/skill_outcome)", () => {
  let root: string;
  let skills: SkillsStore;
  let ctx: ToolContext;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kb-tools-meta-"));
    const ccr = createFileCCRStore(join(root, "ccr"));
    skills = createSkillsStore(join(root, "skills"));
    ctx = {
      ccr,
      memory: createMemory(join(root, "mem")),
      knowledge: createKnowledge(root, join(root, "kb")),
      feedback: createFeedback(join(root, "fb")),
      team: createTeamBoard(join(root, "team"), ccr),
      meter: createMeter(join(root, "meter")),
      skills,
      calibration: createCalibration(join(root, "cal")),
    };
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const call = (name: string, args: Record<string, unknown> = {}): string =>
    dispatch(TOOLS.find((t) => t.name === name)!, args, ctx);

  it("metrics returns the ccr + feedback + calibration rollup", () => {
    const m = JSON.parse(call("knitbrain_metrics")) as Record<string, unknown>;
    expect(m).toHaveProperty("ccr");
    expect(m).toHaveProperty("feedback");
    expect(m).toHaveProperty("calibration");
  });

  it("skill_outcome records a win the skills store reflects", () => {
    call("knitbrain_skill_save", { name: "ship-flow", body: "run gates, then commit, then PR" });
    const out = call("knitbrain_skill_outcome", { name: "ship-flow", worked: true });
    expect(out).toContain("ship-flow");
    expect(out).toContain("wins=1");
    expect(skills.list().find((s) => s.name === "ship-flow")?.wins).toBe(1);
  });

  it("skill_outcome on an unknown skill returns a clear message", () => {
    expect(call("knitbrain_skill_outcome", { name: "no-such-skill", worked: false })).toContain("no skill named");
  });
});
