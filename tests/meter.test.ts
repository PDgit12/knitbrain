import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMeter } from "../src/engine/meter.js";
import { createSkillsStore } from "../src/engine/skills.js";
import { createCalibration } from "../src/engine/calibration.js";
import { createFileCCRStore } from "../src/ccr/store.js";
import { createMemory } from "../src/engine/memory.js";
import { createKnowledge } from "../src/engine/knowledge.js";
import { createFeedback } from "../src/engine/feedback.js";
import { createTeamBoard } from "../src/engine/teams.js";
import { dispatch, type ToolDef, type ToolContext } from "../src/mcp/tools.js";

describe("context meter (rung 15)", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "knitbrain-meter-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("starts healthy and tracks tool output", () => {
    const m = createMeter(join(root, "m"), { windowTokens: 1000 });
    expect(m.read().status).toBe("ok");
    m.onToolOutput(500);
    expect(m.read().usedTokens).toBe(500);
    expect(m.read().usedPct).toBe(50);
  });

  it("proxy turns set the authoritative context size and accumulate savings", () => {
    const m = createMeter(join(root, "m"), { windowTokens: 10000 });
    m.onToolOutput(300); // pre-request tool noise
    m.onRequest(5000, 2000); // optimized request IS the context now
    const r = m.read();
    expect(r.usedTokens).toBe(2000);
    expect(r.savedTokens).toBe(3000);
  });

  it("escalates ok → warn → handoff at thresholds", () => {
    const m = createMeter(join(root, "m"), { windowTokens: 1000, warnAt: 0.7, handoffAt: 0.85 });
    m.onToolOutput(600);
    expect(m.read().status).toBe("ok");
    m.onToolOutput(150); // 75%
    expect(m.read().status).toBe("warn");
    m.onToolOutput(150); // 90%
    const r = m.read();
    expect(r.status).toBe("handoff");
    expect(r.advice).toContain("SAVE A HANDOFF NOW");
  });

  it("reset starts a new window but keeps savings history", () => {
    const m = createMeter(join(root, "m"), { windowTokens: 1000 });
    m.onRequest(800, 300);
    m.reset();
    const r = m.read();
    expect(r.usedTokens).toBe(0);
    expect(r.savedTokens).toBe(500);
  });

  it("dispatch AUTOMATICALLY appends handoff advice to tool output when hot", () => {
    const ccr = createFileCCRStore(join(root, "ccr"));
    const ctx: ToolContext = {
      ccr,
      memory: createMemory(join(root, "mem")),
      knowledge: createKnowledge(root, join(root, "kn")),
      feedback: createFeedback(join(root, "fb")),
      team: createTeamBoard(join(root, "team"), ccr),
      meter: createMeter(join(root, "meter"), { windowTokens: 100, handoffAt: 0.5 }),
      skills: createSkillsStore(join(root, "skills")),
      calibration: createCalibration(join(root, "cal")),
    };
    const tool: ToolDef = {
      name: "demo",
      description: "",
      inputSchema: { type: "object" },
      output: "verbatim",
      run: () => "word ".repeat(80), // pushes usage past 50% of the tiny window
    };
    const out = dispatch(tool, {}, ctx);
    expect(out).toContain("[knitbrain context-meter]");
    expect(out).toContain("SAVE A HANDOFF NOW");
  });
});
