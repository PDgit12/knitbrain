import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileCCRStore, type CCRStore } from "../src/ccr/store.js";
import { createMemory } from "../src/engine/memory.js";
import { createKnowledge } from "../src/engine/knowledge.js";
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
    };
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("auto-compresses a DATA tool's output at the chokepoint", () => {
    const payload = bigJson();
    const dataTool: ToolDef = {
      name: "demo_data",
      description: "returns a big payload",
      inputSchema: { type: "object" },
      output: "data",
      run: () => payload,
    };
    const out = dispatch(dataTool, {}, ctx);
    expect(countTokens(out)).toBeLessThan(countTokens(payload));
    expect(out).toContain("⟨ccr:");
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

    const handleMatch = skeleton.match(/⟨ccr:([0-9a-f]{64})⟩/);
    expect(handleMatch).not.toBeNull();
    const recovered = retrieveTool.run({ handle: handleMatch![1]! }, ctx);
    expect(recovered).toBe(original);
  });

  it("retrieve accepts the full ⟨ccr:…⟩ wrapper too", () => {
    const original = bigJson();
    const optimizeTool = TOOLS.find((t) => t.name === "knitbrain_optimize")!;
    const retrieveTool = TOOLS.find((t) => t.name === "knitbrain_retrieve")!;
    const skeleton = optimizeTool.run({ text: original }, ctx);
    const wrapped = skeleton.match(/⟨ccr:[0-9a-f]{64}⟩/)![0];
    expect(retrieveTool.run({ handle: wrapped }, ctx)).toBe(original);
  });

  it("ping is verbatim and stable", () => {
    const ping = TOOLS.find((t) => t.name === "knitbrain_ping")!;
    expect(ping.output).toBe("verbatim");
    expect(ping.run({}, ctx)).toContain("pong");
  });
});
