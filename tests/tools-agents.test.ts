import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
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

// Direct handler coverage for the agent tools through real dispatch.
// create_agent writes under process.cwd(), so we chdir into a temp dir and
// restore it in afterEach (chdir is process-wide).
describe("MCP agent tools (propose_agents/create_agent)", () => {
  let root: string;
  let priorCwd: string;
  let ctx: ToolContext;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kb-tools-agents-"));
    // Seed a few files so the knowledge graph has something to propose from.
    writeFileSync(join(root, "b.ts"), "export const foo = 1;\n");
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
    ctx.knowledge.scan();
    priorCwd = process.cwd();
    process.chdir(root);
  });
  afterEach(() => {
    process.chdir(priorCwd); // restore BEFORE rm (chdir is process-wide)
    rmSync(root, { recursive: true, force: true });
  });

  const call = (name: string, args: Record<string, unknown> = {}): string =>
    dispatch(TOOLS.find((t) => t.name === name)!, args, ctx);

  it("propose_agents returns a JSON array of domain proposals", () => {
    // propose_agents is a `data` output: when large enough, dispatch compresses
    // it and appends a ⟨recall:HASH⟩ marker, so the inline text is a skeleton.
    // Strip any marker before parsing so the test is robust to the seed size.
    const raw = call("knitbrain_propose_agents").replace(/\n*\[?⟨recall:[a-f0-9]+⟩.*$/s, "").trim();
    const proposals = JSON.parse(raw);
    expect(Array.isArray(proposals)).toBe(true);
  });

  it("create_agent writes a pre-briefed agent file under .claude/agents/", () => {
    const out = call("knitbrain_create_agent", { name: "scope-guard", scope: "src/engine", reviewGate: true });
    expect(out).toContain("created agent at");
    const path = join(root, ".claude", "agents", "scope-guard.md");
    expect(existsSync(path)).toBe(true);
    const body = readFileSync(path, "utf8");
    expect(body).toContain("scope-guard");
    expect(body).toContain("src/engine"); // the scope guardrail is briefed in
  });
});
