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
import { createSkillsStore } from "../src/engine/skills.js";
import { createCalibration } from "../src/engine/calibration.js";
import { TOOLS, dispatch, type ToolContext } from "../src/mcp/tools.js";
import { INSTRUCTIONS } from "../src/mcp/instructions.js";

describe("adherence: plan-mode directive + handshake protocol", () => {
  let root: string;
  let ctx: ToolContext;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "knitbrain-adh-"));
    const ccr = createFileCCRStore(join(root, "ccr"));
    ctx = {
      ccr,
      memory: createMemory(join(root, "mem")),
      knowledge: createKnowledge(root, join(root, "kb")),
      feedback: createFeedback(join(root, "fb")),
      team: createTeamBoard(join(root, "team"), ccr),
      meter: createMeter(join(root, "meter")),
      skills: createSkillsStore(join(root, "skills")),
      calibration: createCalibration(join(root, "cal")),
    };
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const call = (name: string, args: Record<string, unknown>): string => {
    const tool = TOOLS.find((t) => t.name === name)!;
    return dispatch(tool, args, ctx);
  };

  it("classify_task: complex verdict carries the ENTER PLAN MODE imperative", () => {
    const out = JSON.parse(
      call("knitbrain_classify_task", {
        description: "refactor the persistence architecture",
        files: ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"],
      }),
    ) as { autoPlanMode: boolean; directive: string };
    expect(out.autoPlanMode).toBe(true);
    expect(out.directive).toContain("ENTER YOUR HOST'S PLAN MODE NOW");
    expect(out.directive).toContain("knitbrain_record_false_positive"); // FP loop advertised at the decision point
  });

  it("classify_task: trivial verdict says execute directly", () => {
    const out = JSON.parse(call("knitbrain_classify_task", { description: "fix typo in README" })) as {
      autoPlanMode: boolean;
      directive: string;
    };
    expect(out.autoPlanMode).toBe(false);
    expect(out.directive).toContain("Execute directly");
  });

  it("knitbrain_run: complex directive demands plan mode before any edit", () => {
    const out = JSON.parse(
      call("knitbrain_run", {
        task: "migrate the storage schema across services",
        files: ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"],
      }),
    ) as { directive: string };
    expect(out.directive).toContain("ENTER YOUR HOST'S PLAN MODE NOW");
  });

  it("handshake instructions cover the full closed loop", () => {
    for (const must of [
      "knitbrain_load_session",
      "ENTER YOUR HOST'S PLAN MODE",
      "knitbrain_record_false_positive",
      "knitbrain_skill_save",
      "knitbrain_team_post",
      "knitbrain_read",
      "knitbrain_optimize",
      "knitbrain_retrieve",
      "knitbrain_context_meter",
      "knitbrain_record_learning",
    ]) {
      expect(INSTRUCTIONS).toContain(must);
    }
  });
});
