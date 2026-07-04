import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
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
    // Cross-platform plan gate: forceful STOP + plan-mode imperative (works on any host)
    expect(out.directive).toContain("STOP");
    expect(out.directive).toContain("plan mode");
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
    expect(out.directive).toContain("STOP");
    expect(out.directive).toContain("plan mode");
  });

  it("knitbrain_run: complex task MATERIALIZES agent .md files (puppeteer mode)", () => {
    // knowledge graph needs ≥2 files per directory for a domain proposal
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), 'import { b } from "./b.js"; export const a = b;');
    writeFileSync(join(root, "src", "b.ts"), "export const b = 1;");
    ctx.knowledge.scan();
    const prevCwd = process.cwd();
    process.chdir(root); // writeAgent targets cwd
    try {
      const out = JSON.parse(
        call("knitbrain_run", {
          task: "refactor the storage architecture end to end",
          files: ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"],
        }),
      ) as { agents: Array<{ file: string; spawn: string }> };
      expect(out.agents.length).toBeGreaterThan(0);
      for (const a of out.agents) {
        expect(existsSync(a.file)).toBe(true);
        const body = readFileSync(a.file, "utf8");
        expect(body).toContain("Mission brief");
        expect(body).toContain("knitbrain_team_post");
        expect(a.spawn).toContain("WRITTEN");
      }
    } finally {
      process.chdir(prevCwd);
    }
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
      "knitbrain_learning_outcome",
    ]) {
      expect(INSTRUCTIONS).toContain(must);
    }
  });

  it("handshake protocol forbids yes-man behavior (anti-sycophancy)", () => {
    expect(INSTRUCTIONS).toContain("no yes-man");
    // the rule must tie sycophancy to signal corruption, not just be a platitude
    expect(INSTRUCTIONS.toLowerCase()).toContain("sycophantic");
    expect(INSTRUCTIONS).toMatch(/back with output|tests run|exit codes/);
  });
});

// Gap #4: the HARD adherence gate at the brain boundary (dispatch). Drives
// KNITBRAIN_STRICTNESS explicitly per case and restores it (the unit suite
// defaults it to "off"; the product default is "block").
describe("adherence gate (gap #4): close-the-loop writes need classification", () => {
  let root: string;
  let ctx: ToolContext;
  let priorStrictness: string | undefined;
  beforeEach(() => {
    priorStrictness = process.env["KNITBRAIN_STRICTNESS"];
    root = mkdtempSync(join(tmpdir(), "knitbrain-gate-"));
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
  afterEach(() => {
    if (priorStrictness === undefined) delete process.env["KNITBRAIN_STRICTNESS"];
    else process.env["KNITBRAIN_STRICTNESS"] = priorStrictness;
    rmSync(root, { recursive: true, force: true });
  });
  const call = (name: string, args: Record<string, unknown> = {}): string =>
    dispatch(TOOLS.find((t) => t.name === name)!, args, ctx);

  it("block + no classify → record_learning is blocked (protocol_required), tool did NOT run", () => {
    process.env["KNITBRAIN_STRICTNESS"] = "block";
    const out = call("knitbrain_record_learning", { summary: "ungated", lesson: "x" });
    expect(out).toContain("protocol_required");
    // proof the write never landed: nothing to search
    expect(ctx.memory.searchLearnings("ungated", 5).length).toBe(0);
  });

  it("block + classify first → record_learning succeeds", () => {
    process.env["KNITBRAIN_STRICTNESS"] = "block";
    call("knitbrain_classify_task", { description: "fix a thing" });
    const out = call("knitbrain_record_learning", { summary: "gated ok", lesson: "x" });
    expect(out).toContain("recorded learning");
    expect(ctx.memory.searchLearnings("gated ok", 5).length).toBeGreaterThan(0);
  });

  it("block + knitbrain_run first → save_handoff and skill_save succeed", () => {
    process.env["KNITBRAIN_STRICTNESS"] = "block";
    call("knitbrain_run", { task: "do work" });
    expect(call("knitbrain_save_handoff", { state: "s" })).toBe("handoff saved");
    expect(call("knitbrain_skill_save", { name: "k", body: "b" })).toContain("saved");
  });

  it("warn + no classify → write runs but a nudge is appended", () => {
    process.env["KNITBRAIN_STRICTNESS"] = "warn";
    const out = call("knitbrain_record_learning", { summary: "warned", lesson: "x" });
    expect(out).toContain("recorded learning");
    expect(out).toContain("protocol nudge");
    expect(ctx.memory.searchLearnings("warned", 5).length).toBeGreaterThan(0);
  });

  it("off → no gate, no nudge", () => {
    process.env["KNITBRAIN_STRICTNESS"] = "off";
    const out = call("knitbrain_record_learning", { summary: "free", lesson: "x" });
    expect(out).toContain("recorded learning");
    expect(out).not.toContain("protocol nudge");
  });

  it("under block, loop-entry + reads are NEVER gated and retrieve stays byte-exact", () => {
    process.env["KNITBRAIN_STRICTNESS"] = "block";
    expect(call("knitbrain_ping")).toContain("pong");
    expect(call("knitbrain_load_session")).not.toContain("protocol_required");
    // retrieve a real handle byte-for-byte even with no classification
    const big = JSON.stringify({ rows: Array.from({ length: 80 }, (_, i) => ({ i, name: `r${i}` })) }, null, 2);
    const opt = call("knitbrain_optimize", { text: big });
    const handle = /⟨recall:([0-9a-f]{64})⟩/.exec(opt)?.[1] ?? "";
    expect(handle).toHaveLength(64);
    expect(call("knitbrain_retrieve", { handle })).toBe(big); // exact, no advisory, no gate
  });
});
