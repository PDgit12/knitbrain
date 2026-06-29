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

  // Gap #2: optimization as a fraction of the LIVE window: saved / (live + saved).
  it("optimizationPct is the live-window ratio", () => {
    const m = createMeter(join(root, "m"), { windowTokens: 100000 });
    expect(m.read().optimizationPct).toBe(0); // nothing saved yet
    m.onRequest(3000, 1000); // live window = 1000, saved = 2000
    expect(m.read().optimizationPct).toBe(66.7); // 2000 / (1000 + 2000)
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

describe("MCP-side savings accounting (dashboard tokens-saved tile)", () => {
  it("onSaved accumulates and survives a new instance", () => {
    const root = mkdtempSync(join(tmpdir(), "knitbrain-meter-saved-"));
    const a = createMeter(join(root, "m"));
    a.onSaved(1200);
    a.onSaved(800);
    expect(createMeter(join(root, "m")).read().savedTokens).toBe(2000);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("meter realUsage probe — fire on the REAL host window, not just knitbrain's slice", () => {
  it("uses the probe when it exceeds knitbrain's own tracking", () => {
    const r = mkdtempSync(join(tmpdir(), "kb-rm-"));
    try {
      // knitbrain saw almost nothing, but the real window is 90% full
      const m = createMeter(join(r, "m"), { windowTokens: 200000, realUsage: () => 180000 });
      m.onToolOutput(500); // knitbrain's slice = tiny
      const reading = m.read();
      expect(reading.usedTokens).toBe(180000); // real window wins
      expect(reading.status).toBe("handoff"); // fires correctly
    } finally { rmSync(r, { recursive: true, force: true }); }
  });
  it("falls back to its own tracking when the probe returns null (other platforms)", () => {
    const r = mkdtempSync(join(tmpdir(), "kb-rm2-"));
    try {
      const m = createMeter(join(r, "m"), { windowTokens: 200000, realUsage: () => null });
      m.onToolOutput(1000);
      expect(m.read().usedTokens).toBe(1000);
    } finally { rmSync(r, { recursive: true, force: true }); }
  });
});
