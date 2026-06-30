import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

// Direct handler coverage for the knowledge-graph tools through the REAL
// dispatch path (no mocks): seed a tiny project where a.ts imports b.ts and
// assert the graph tools return the real edges.
describe("MCP knowledge tools (query_imports/exports/dependents + scan)", () => {
  let root: string;
  let ctx: ToolContext;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kb-tools-knowledge-"));
    writeFileSync(join(root, "b.ts"), "export const foo = 1;\nexport function bar() { return foo; }\n");
    writeFileSync(join(root, "a.ts"), 'import { foo } from "./b.js";\nexport const x = foo;\n');
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

  const call = (name: string, args: Record<string, unknown> = {}): string =>
    dispatch(TOOLS.find((t) => t.name === name)!, args, ctx);

  it("scan reports the seeded files", () => {
    const out = call("knitbrain_scan");
    expect(out).toMatch(/scanned \d+ files/);
    const n = Number(out.match(/scanned (\d+)/)![1]);
    expect(n).toBeGreaterThanOrEqual(2);
  });

  it("query_imports returns a.ts's real import edge to b", () => {
    call("knitbrain_scan");
    const imports = JSON.parse(call("knitbrain_query_imports", { file: "a.ts" })) as Array<{ from: string }>;
    expect(imports.length).toBeGreaterThan(0);
    expect(JSON.stringify(imports)).toContain("b"); // edge resolves to b
  });

  it("query_exports returns b.ts's real exports", () => {
    call("knitbrain_scan");
    const exports = JSON.parse(call("knitbrain_query_exports", { file: "b.ts" })) as string[];
    expect(exports).toContain("foo");
    expect(exports).toContain("bar");
  });

  it("query_dependents reports a.ts as a dependent of b.ts (blast radius)", () => {
    call("knitbrain_scan");
    const deps = JSON.parse(call("knitbrain_query_dependents", { file: "b.ts" })) as string[];
    expect(deps).toContain("a.ts");
  });

  // Gap #5: verify_claim settles a stated codebase fact against the graph.
  it("verify_claim: verified for a true graph fact, contradicted for a false one, unparseable for garbage", () => {
    call("knitbrain_scan");
    const v = (claim: string) => JSON.parse(call("knitbrain_verify_claim", { claim })) as { verdict: string };
    expect(v("a.ts imports b.js").verdict).toBe("verified");
    expect(v("b.ts imports a.js").verdict).toBe("contradicted");
    expect(v("b.ts exports foo").verdict).toBe("verified");
    expect(v("b.ts exports nope").verdict).toBe("contradicted");
    expect(v("a.ts depends on b.ts").verdict).toBe("verified");
    expect(v("the sky is blue").verdict).toBe("unparseable");
  });
});
