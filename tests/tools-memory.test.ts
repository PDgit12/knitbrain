import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileCCRStore } from "../src/ccr/store.js";
import { createMemory, type Memory } from "../src/engine/memory.js";
import { createKnowledge } from "../src/engine/knowledge.js";
import { createFeedback } from "../src/engine/feedback.js";
import { createTeamBoard } from "../src/engine/teams.js";
import { createMeter } from "../src/engine/meter.js";
import { createSkillsStore } from "../src/engine/skills.js";
import { createCalibration } from "../src/engine/calibration.js";
import { createWikiStore } from "../src/engine/wiki.js";
import { TOOLS, dispatch, type ToolContext } from "../src/mcp/tools.js";

// Direct handler coverage for the memory tools through real dispatch: seed a
// learning via the store, then assert search returns its headline, get returns
// the full lesson, and save_handoff round-trips through loadSession.
describe("MCP memory tools (search_learnings/get_learning/save_handoff)", () => {
  let root: string;
  let memory: Memory;
  let ctx: ToolContext;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kb-tools-memory-"));
    const ccr = createFileCCRStore(join(root, "ccr"));
    memory = createMemory(join(root, "mem"));
    ctx = {
      ccr,
      memory,
      knowledge: createKnowledge(root, join(root, "kb")),
      feedback: createFeedback(join(root, "fb")),
      team: createTeamBoard(join(root, "team"), ccr),
      meter: createMeter(join(root, "meter")),
      skills: createSkillsStore(join(root, "skills")),
      calibration: createCalibration(join(root, "cal")),
    };
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const call = (name: string, args: Record<string, unknown> = {}): string =>
    dispatch(TOOLS.find((t) => t.name === name)!, args, ctx);

  it("search_learnings returns a headline for a seeded learning, get_learning returns the full lesson", () => {
    const { id } = memory.recordLearning({
      summary: "input validation lives in src/lib.ts",
      lesson: "All boundary validation funnels through validate() in src/lib.ts; never re-implement it per-route.",
      tags: ["validation", "architecture"],
    });

    const hits = JSON.parse(call("knitbrain_search_learnings", { query: "validation" })) as Array<{ id: string; summary: string }>;
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => h.id === id)).toBe(true);
    expect(JSON.stringify(hits)).toContain("validation lives in src/lib.ts");

    const full = JSON.parse(call("knitbrain_get_learning", { id })) as { lesson: string };
    expect(full.lesson).toContain("funnels through validate()");
  });

  it("get_learning on an unknown id returns a clear not-found message", () => {
    expect(call("knitbrain_get_learning", { id: "does-not-exist" })).toContain("no learning found");
  });

  it("save_handoff persists state that loadSession restores", () => {
    expect(call("knitbrain_save_handoff", { state: "goal: ship v1; next: audit the proxy" })).toBe("handoff saved");
    expect(memory.loadSession().handoff).toContain("ship v1");
  });

  // Gap #1: capture tools drop ONE line into the wiki log (unified spine).
  it("record_learning + save_handoff append lines to the wiki spine", () => {
    const wiki = createWikiStore(join(root, "wiki"));
    ctx = { ...ctx, wiki };
    expect(wiki.recentLog(10).length).toBe(0);
    call("knitbrain_record_learning", { summary: "spine entry one", lesson: "x" });
    call("knitbrain_save_handoff", { state: "spine handoff state" });
    const log = wiki.recentLog(10);
    expect(log.length).toBe(2);
    expect(log.some((l) => l.includes("learning") && l.includes("spine entry one"))).toBe(true);
    expect(log.some((l) => l.includes("handoff"))).toBe(true);
  });

  // Best-effort: a missing wiki must never break the capture tool (gap #1).
  it("record_learning succeeds with no wiki in context", () => {
    expect(call("knitbrain_record_learning", { summary: "no wiki here", lesson: "y" })).toContain("recorded learning");
  });
});
