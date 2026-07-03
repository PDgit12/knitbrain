import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileCCRStore, type CCRStore } from "../src/ccr/store.js";
import { createMemory } from "../src/engine/memory.js";
import { createKnowledge } from "../src/engine/knowledge.js";
import { createFeedback } from "../src/engine/feedback.js";
import { createTeamBoard } from "../src/engine/teams.js";
import { createMeter } from "../src/engine/meter.js";
import { createSkillsStore } from "../src/engine/skills.js";
import { createCalibration } from "../src/engine/calibration.js";
import { TOOLS, dispatch, type ToolDef, type ToolContext } from "../src/mcp/tools.js";
import { countTokens } from "../src/tokenizer.js";

const bigJson = (): string =>
  JSON.stringify(
    { items: Array.from({ length: 40 }, (_, i) => ({ i, blob: "y".repeat(60) })) },
    null,
    2,
  );

describe("MCP dispatch chokepoint (rung 6)", () => {
  let root: string;
  let ctx: ToolContext;
  let ccr: CCRStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "knitbrain-dispatch-"));
    ccr = createFileCCRStore(root);
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

  it("JSON data output passes through PARSEABLE (machine contract — never skeletonized)", () => {
    const payload = bigJson();
    const dataTool: ToolDef = {
      name: "demo_data",
      description: "returns a big JSON payload",
      inputSchema: { type: "object" },
      output: "data",
      run: () => payload,
    };
    const out = dispatch(dataTool, {}, ctx);
    expect(out).toBe(payload); // valid JSON = a contract; elision broke consumers twice
    expect(() => JSON.parse(out)).not.toThrow();
  });

  it("non-JSON DATA output still auto-compresses at the chokepoint", () => {
    const payload = Array.from({ length: 200 }, (_, i) => `2026-01-01 INFO worker ${i % 3} ok`).join("\n");
    const dataTool: ToolDef = {
      name: "demo_log",
      description: "returns a big log payload",
      inputSchema: { type: "object" },
      output: "data",
      run: () => payload,
    };
    const out = dispatch(dataTool, {}, ctx);
    expect(countTokens(out)).toBeLessThan(countTokens(payload));
    expect(out).toContain("⟨recall:");
  });

  it("passes VERBATIM tool output through untouched", () => {
    const govTool: ToolDef = {
      name: "demo_gov",
      description: "governance text",
      inputSchema: { type: "object" },
      output: "verbatim",
      run: () => bigJson(),
    };
    expect(dispatch(govTool, {}, ctx)).toBe(bigJson());
  });

  it("optimize → retrieve is a lossless round-trip through the tools", () => {
    const original = bigJson();
    const optimizeTool = TOOLS.find((t) => t.name === "knitbrain_optimize")!;
    const retrieveTool = TOOLS.find((t) => t.name === "knitbrain_retrieve")!;

    const skeleton = optimizeTool.run({ text: original }, ctx);
    expect(countTokens(skeleton)).toBeLessThan(countTokens(original));

    const handleMatch = skeleton.match(/⟨recall:([0-9a-f]{64})⟩/);
    expect(handleMatch).not.toBeNull();
    const recovered = retrieveTool.run({ handle: handleMatch![1]! }, ctx);
    expect(recovered).toBe(original);
  });

  it("retrieve accepts the full ⟨recall:…⟩ wrapper too", () => {
    const original = bigJson();
    const optimizeTool = TOOLS.find((t) => t.name === "knitbrain_optimize")!;
    const retrieveTool = TOOLS.find((t) => t.name === "knitbrain_retrieve")!;
    const skeleton = optimizeTool.run({ text: original }, ctx);
    const wrapped = skeleton.match(/⟨recall:[0-9a-f]{64}⟩/)![0];
    expect(retrieveTool.run({ handle: wrapped }, ctx)).toBe(original);
  });

  it("ping is verbatim and stable", () => {
    const ping = TOOLS.find((t) => t.name === "knitbrain_ping")!;
    expect(ping.output).toBe("verbatim");
    expect(ping.run({}, ctx)).toContain("pong");
  });
});

describe("cross-process store freshness + input guards (launch checklist)", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "knitbrain-fresh-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("feedback: a long-lived instance sees writes made by ANOTHER instance", () => {
    const a = createFeedback(join(root, "fb"));
    const b = createFeedback(join(root, "fb")); // dashboard-style long-lived reader
    expect(b.stats().find((s) => s.kind === "json")!.compressions).toBe(0);
    a.onCompress("json", "f".repeat(64)); // writer process
    expect(b.stats().find((s) => s.kind === "json")!.compressions).toBe(1);
  });

  it("meter: a long-lived instance sees another instance's request accounting", () => {
    const writer = createMeter(join(root, "meter"));
    const reader = createMeter(join(root, "meter"));
    expect(reader.read().usedTokens).toBe(0);
    writer.onRequest(10_000, 6_000);
    const r = reader.read();
    expect(r.usedTokens).toBe(6_000);
    expect(r.savedTokens).toBe(4_000);
  });

  it("team_post refuses empty content (SDK does not enforce inputSchema)", () => {
    const ccr2 = createFileCCRStore(join(root, "ccr"));
    const ctx2: ToolContext = {
      ccr: ccr2,
      memory: createMemory(join(root, "mem")),
      knowledge: createKnowledge(root, join(root, "kn")),
      feedback: createFeedback(join(root, "fb2")),
      team: createTeamBoard(join(root, "team"), ccr2),
      meter: createMeter(join(root, "meter2")),
      skills: createSkillsStore(join(root, "skills")),
      calibration: createCalibration(join(root, "cal")),
    };
    const post = TOOLS.find((t) => t.name === "knitbrain_team_post")!;
    const out = dispatch(post, { author: "e2e", summary: "wrong param name" }, ctx2);
    expect(out).toContain("refused");
    expect(ctx2.team.board().length).toBe(0); // nothing stored
  });
});
