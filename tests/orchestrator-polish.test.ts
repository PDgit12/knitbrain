import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateAgentMarkdown } from "../src/engine/agents.js";
import type { StyleProfile } from "../src/engine/host-scan.js";
import { buildCyclePlan } from "../src/orchestrate.js";
import { createSkillsStore } from "../src/engine/skills.js";
import { createKnowledge } from "../src/engine/knowledge.js";
import { createFileCCRStore } from "../src/ccr/store.js";
import { createMemory } from "../src/engine/memory.js";
import { createFeedback } from "../src/engine/feedback.js";
import { createTeamBoard } from "../src/engine/teams.js";
import { createMeter } from "../src/engine/meter.js";
import { createCalibration } from "../src/engine/calibration.js";
import { TOOLS, dispatch, type ToolContext } from "../src/mcp/tools.js";

const style = (over: Partial<StyleProfile>): StyleProfile => ({ medianBodyLen: 200, terse: false, usesModel: false, usesTriggers: false, headers: [], ...over });

// ── (A) agent-frontmatter style-match ──
describe("agent style-match — generateAgentMarkdown honors the StyleProfile", () => {
  it("emits `model:` only when the style uses it (with the user's dominant model)", () => {
    const withModel = generateAgentMarkdown({ name: "scope-guard", scope: "src/engine" }, style({ usesModel: true, model: "opus" }));
    expect(withModel).toMatch(/^model: opus$/m);

    const noModel = generateAgentMarkdown({ name: "scope-guard", scope: "src/engine" }, style({ usesModel: false }));
    expect(noModel).not.toMatch(/^model:/m);

    // no style at all → no model line (back-compat)
    expect(generateAgentMarkdown({ name: "x" })).not.toMatch(/^model:/m);
  });

  it("emits `triggers:` only when the style uses it", () => {
    const withTriggers = generateAgentMarkdown({ name: "x", triggers: ["alpha", "beta"] }, style({ usesTriggers: true }));
    expect(withTriggers).toMatch(/^triggers: alpha, beta$/m);
    expect(generateAgentMarkdown({ name: "x" }, style({ usesTriggers: false }))).not.toMatch(/^triggers:/m);
  });
});

describe("agent style-match — create_agent through real dispatch mirrors the user's agents", () => {
  let root: string;
  let prior: string;
  let ctx: ToolContext;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kb-agentstyle-"));
    // a REAL-shaped existing agent that carries model:
    mkdirSync(join(root, ".claude", "agents"), { recursive: true });
    writeFileSync(join(root, ".claude", "agents", "reviewer.md"), "---\nname: reviewer\ndescription: reviews code\ntools: Read, Grep\nmodel: opus\n---\n\nYou review.\n");
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
    prior = process.cwd();
    process.chdir(root);
  });
  afterEach(() => {
    process.chdir(prior);
    rmSync(root, { recursive: true, force: true });
  });

  it("generated agent carries `model:` because the user's existing agents do", () => {
    const out = dispatch(TOOLS.find((t) => t.name === "knitbrain_create_agent")!, { name: "new-agent", scope: "src" }, ctx);
    expect(out).toContain("created agent at");
    const body = readFileSync(join(root, ".claude", "agents", "new-agent.md"), "utf8");
    expect(body).toMatch(/^model: opus$/m); // style-matched to the seeded reviewer.md
  });
});

// ── (B) intensity-based skill/agent selection ──
describe("orchestrate intensity — buildCyclePlan scales with project intensity", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kb-cycleplan-"));
    writeFileSync(join(root, "b.ts"), "export const foo = 1;\n");
    writeFileSync(join(root, "a.ts"), 'import { foo } from "./b.js";\nexport const x = foo;\n');
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "p.ts"), 'export const p = 1;\n');
    writeFileSync(join(root, "src", "q.ts"), 'import { p } from "./p.js";\nexport const q = p;\n');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("SIMPLE goal → matched skill in the prompt, NO proposed agents", () => {
    const skills = createSkillsStore(join(root, "skills"));
    skills.save({ name: "fix-typo", body: "find the typo, fix it, re-read", triggers: ["typo", "readme"] });
    const knowledge = createKnowledge(root, join(root, "kb"));
    knowledge.scan();

    const plan = buildCyclePlan("fix the typo in the readme", skills, knowledge);
    expect(plan.tier).toBe("trivial");
    expect(plan.skillName).toBe("fix-typo");
    expect(plan.prompt).toContain("SKILL — fix-typo");
    expect(plan.agentNames).toHaveLength(0);
    expect(plan.prompt).not.toContain("AGENTS to orchestrate");
  });

  it("COMPLEX goal → proposed agents + guardrails AND the skill in the prompt", () => {
    const skills = createSkillsStore(join(root, "skills"));
    skills.save({ name: "refactor-playbook", body: "map deps, smallest change, verify", triggers: ["refactor", "architecture"] });
    const knowledge = createKnowledge(root, join(root, "kb"));
    knowledge.scan();

    const plan = buildCyclePlan("refactor the authentication architecture and migrate the database schema", skills, knowledge);
    expect(plan.tier).toBe("complex");
    expect(plan.agentNames.length).toBeGreaterThan(0); // proposed from the seeded src/ dir
    expect(plan.prompt).toContain("AGENTS to orchestrate");
    expect(plan.prompt).toMatch(/scope `.*\*\*`/); // a guardrail (scope glob) is briefed in
    expect(plan.prompt).toContain("SKILL — refactor-playbook"); // skill still injected
  });
});
