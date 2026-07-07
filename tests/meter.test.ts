import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMeter, modelWindow, detectBillingMode } from "../src/engine/meter.js";
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

  // Honest window: a large-context model (415k observed) must NOT pin to 100% /
  // handoff on the stale 200k default — auto-heal to the next standard tier (1M).
  it("auto-heals the effective window when observed usage exceeds the configured one", () => {
    const m = createMeter(join(root, "m"), { realUsage: () => 415_000 }); // default 200k window
    const r = m.read();
    expect(r.usedTokens).toBe(415_000);
    expect(r.windowTokens).toBe(1_000_000); // healed to the tier that fits
    expect(r.usedPct).toBe(41.5); // 415k / 1M, not capped 100
    expect(r.status).toBe("ok"); // NOT a false handoff
    expect(r.advice).toContain("healthy");
  });

  it("respects KNITBRAIN_WINDOW_TOKENS env override", () => {
    const prev = process.env["KNITBRAIN_WINDOW_TOKENS"];
    process.env["KNITBRAIN_WINDOW_TOKENS"] = "1000000";
    try {
      const m = createMeter(join(root, "m2"), { realUsage: () => 415_000 });
      const r = m.read();
      expect(r.windowTokens).toBe(1_000_000);
      expect(r.usedPct).toBe(41.5);
      expect(r.status).toBe("ok");
    } finally {
      if (prev === undefined) delete process.env["KNITBRAIN_WINDOW_TOKENS"];
      else process.env["KNITBRAIN_WINDOW_TOKENS"] = prev;
    }
  });

  it("small windows still escalate ok→warn→handoff (no regression)", () => {
    const m = createMeter(join(root, "m3"), { windowTokens: 1000, warnAt: 0.7, handoffAt: 0.85 });
    m.onToolOutput(600);
    expect(m.read().status).toBe("ok");
    expect(m.read().windowTokens).toBe(1000); // not healed — fits
    m.onToolOutput(300); // 90%
    expect(m.read().status).toBe("handoff");
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

describe("meter modelWindow — current-gen Claude is 1M, not stale 200k", () => {
  it("maps frontier Claude (opus-4-8, sonnet-5, fable-5) to 1M", () => {
    expect(modelWindow("claude-opus-4-8")).toBe(1_000_000); // verified live this session
    expect(modelWindow("claude-sonnet-5")).toBe(1_000_000);
    expect(modelWindow("claude-fable-5")).toBe(1_000_000);
    expect(modelWindow("claude-opus-5")).toBe(1_000_000);
  });
  it("keeps legacy/unverified Claude conservative at 200k", () => {
    expect(modelWindow("claude-3-5-sonnet-20241022")).toBe(200_000);
    expect(modelWindow("claude-2.1")).toBe(200_000);
  });
  it("explicit 1M-beta marker still wins", () => {
    expect(modelWindow("claude-sonnet-4-5[1m]")).toBe(1_000_000);
  });
});

describe("meter detectBillingMode — Gap 8 api vs plan optimization", () => {
  it("api: explicit key, proxy base url, or KNITBRAIN_BILLING override", () => {
    expect(detectBillingMode({ ANTHROPIC_API_KEY: "sk-x" } as NodeJS.ProcessEnv)).toBe("api");
    expect(detectBillingMode({ ANTHROPIC_BASE_URL: "http://127.0.0.1:8788" } as NodeJS.ProcessEnv)).toBe("api");
    expect(detectBillingMode({ KNITBRAIN_BILLING: "api" } as NodeJS.ProcessEnv)).toBe("api");
  });
  it("plan: subscription host with no api key", () => {
    expect(detectBillingMode({ CLAUDECODE: "1" } as NodeJS.ProcessEnv)).toBe("plan");
    expect(detectBillingMode({ KNITBRAIN_BILLING: "plan" } as NodeJS.ProcessEnv)).toBe("plan");
  });
  it("unknown when nothing distinguishes", () => {
    expect(detectBillingMode({} as NodeJS.ProcessEnv)).toBe("unknown");
  });
  it("read() carries billingMode; tailored hint only appears under pressure", () => {
    const r = mkdtempSync(join(tmpdir(), "kb-bill-"));
    try {
      process.env["KNITBRAIN_BILLING"] = "api";
      const m = createMeter(join(r, "m"), { windowTokens: 1000, handoffAt: 0.85 });
      m.onToolOutput(100); // 10% → ok, no hint
      const ok = m.read();
      expect(ok.billingMode).toBe("api");
      expect(ok.advice).not.toContain("pay-per-token");
      m.onToolOutput(800); // 90% → handoff, hint appears
      expect(m.read().advice).toContain("pay-per-token");
    } finally {
      delete process.env["KNITBRAIN_BILLING"];
      rmSync(r, { recursive: true, force: true });
    }
  });
});

describe("meter realModel probe — proactive window kills the FALSE 'clear now'", () => {
  it("198k on a probed 1M model reads healthy, NOT a false handoff", () => {
    const r = mkdtempSync(join(tmpdir(), "kb-rmodel-"));
    try {
      // Exactly the episode that exposed the gap: 198k used, default 200k
      // window → WOULD fire handoff. With the transcript model probed as
      // opus-4-8 (1M), it's ~20% — healthy.
      const m = createMeter(join(r, "m"), { realUsage: () => 198_000, realModel: () => "claude-opus-4-8" });
      const reading = m.read();
      expect(reading.windowTokens).toBe(1_000_000);
      expect(reading.usedPct).toBe(19.8);
      expect(reading.status).toBe("ok"); // NO false clear-now
    } finally { rmSync(r, { recursive: true, force: true }); }
  });
  it("198k with NO model probe still fires handoff on the conservative 200k default", () => {
    const r = mkdtempSync(join(tmpdir(), "kb-rmodel2-"));
    try {
      const m = createMeter(join(r, "m"), { realUsage: () => 198_000 });
      expect(m.read().status).toBe("handoff"); // unchanged: honest for a real 200k model
    } finally { rmSync(r, { recursive: true, force: true }); }
  });
  it("unknown probed model → default path unchanged (no false comfort)", () => {
    const r = mkdtempSync(join(tmpdir(), "kb-rmodel3-"));
    try {
      const m = createMeter(join(r, "m"), { realUsage: () => 198_000, realModel: () => "some-unknown-model" });
      expect(m.read().status).toBe("handoff"); // modelWindow null → stays 200k
    } finally { rmSync(r, { recursive: true, force: true }); }
  });
});

describe("meter estimate + cache-cold (MCP-only honesty)", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "kb-meter2-")); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("MCP-only host: baseline added and labeled an estimate", () => {
    const m = createMeter(root, { baselineTokens: 20_000 });
    m.onToolOutput(1_000);
    const r = m.read();
    expect(r.estimated).toBe(true);
    expect(r.usedTokens).toBe(21_000);
    expect(r.advice).toContain("estimate");
  });

  it("no baseline configured or proxy data present: exact, not estimated", () => {
    const bare = createMeter(root, {});
    bare.onToolOutput(500);
    expect(bare.read().estimated).toBe(false);
    expect(bare.read().usedTokens).toBe(500);
    const proxied = createMeter(root, { baselineTokens: 20_000 });
    proxied.onRequest(5_000, 4_000);
    expect(proxied.read().estimated).toBe(false);
    expect(proxied.read().usedTokens).toBe(4_000);
  });

  it("idle past the 5m cache TTL flags cacheCold with cost advice", () => {
    let t = 1_000_000;
    const m = createMeter(root, { now: () => t });
    m.onRequest(40_000, 40_000);
    expect(m.read().cacheCold).toBe(false);
    t += 6 * 60_000;
    const r = m.read();
    expect(r.cacheCold).toBe(true);
    expect(r.advice).toContain("CACHE COLD");
  });

  it("cold cache not flagged on a tiny window", () => {
    let t = 1_000_000;
    const m = createMeter(root, { now: () => t });
    m.onToolOutput(1_000);
    t += 10 * 60_000;
    expect(m.read().cacheCold).toBe(false);
  });
});

describe("G5: model name persistence", () => {
  it("onModel persists the NAME; a fresh instance reads it back; reset keeps it", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { createMeter } = await import("../src/engine/meter.js");
    const root = mkdtempSync(join(tmpdir(), "kb-meter-model-"));
    try {
      createMeter(root).onModel("claude-sonnet-5");
      const m2 = createMeter(root);
      expect(m2.read().model).toBe("claude-sonnet-5");
      m2.reset();
      expect(createMeter(root).read().model).toBe("claude-sonnet-5"); // survives reset like savings
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
