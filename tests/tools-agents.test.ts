import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
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
import type { DomainProposal } from "../src/engine/agents.js";

const writeSrc = (root: string, rel: string, body: string): void => {
  const full = join(root, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, body, "utf8");
};

/** Run `fn` with cwd set to a fresh temp dir, restoring cwd + cleaning up after.
 * create_agent writes under process.cwd(), so each test needs its own sandbox. */
const inTempCwd = (fn: (cwd: string) => void): void => {
  const cwd = mkdtempSync(join(tmpdir(), "knitbrain-agentcwd-"));
  const prevCwd = process.cwd();
  process.chdir(cwd);
  try {
    fn(cwd);
  } finally {
    process.chdir(prevCwd);
    rmSync(cwd, { recursive: true, force: true });
  }
};

describe("AGENT tools: propose_agents + create_agent (real dispatch)", () => {
  let root: string;
  let ctx: ToolContext;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "knitbrain-agents-"));
    // Seed a real source tree the knowledge graph will scan: two multi-file
    // directories (one sensitive: auth) plus a lone root file (excluded).
    writeSrc(root, "src/auth/login.ts", "export function login() {}\n");
    writeSrc(root, "src/auth/token.ts", "export function mint() {}\n");
    writeSrc(root, "src/util/text.ts", "export function slug() {}\n");
    writeSrc(root, "src/util/math.ts", "export function clamp() {}\n");
    writeSrc(root, "src/lonely.ts", "export const x = 1;\n");

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

  it("propose_agents derives guardrailed domain proposals from the knowledge graph", () => {
    // DATA tool: dispatch routes the output through the CCR chokepoint, which
    // appends a ⟨recall:HASH⟩ handle. Strip it to read the inline JSON, and
    // assert the handle round-trips back to the exact same payload.
    const out = call("knitbrain_propose_agents", {});
    const recall = out.match(/⟨recall:([0-9a-f]{64})⟩/);
    expect(recall).not.toBeNull();
    const jsonText = out.replace(/\s*⟨recall:[0-9a-f]{64}⟩\s*$/, "");
    const proposals = JSON.parse(jsonText) as DomainProposal[];

    // The recall handle restores the exact original tool output (pretty-printed),
    // which parses to the identical proposal set as the inline skeleton.
    const retrieve = TOOLS.find((t) => t.name === "knitbrain_retrieve")!;
    const restored = JSON.parse(retrieve.run({ handle: recall![1]! }, ctx)) as DomainProposal[];
    expect(restored).toEqual(proposals);

    // Only directories with >=2 files become proposals; src/lonely.ts (1 file) is excluded.
    const names = proposals.map((p) => p.name).sort();
    expect(names).toEqual(["auth", "util"]);

    const auth = proposals.find((p) => p.name === "auth")!;
    expect(auth.scope).toBe("src/auth/**");
    expect(auth.files.sort()).toEqual(["src/auth/login.ts", "src/auth/token.ts"]);
    // Sensitive domain → review gate on, tools narrowed to read-only (no Edit/Write).
    expect(auth.reviewGate).toBe(true);
    expect(auth.tools).toEqual(["Read", "Grep", "Glob"]);
    expect(auth.contextBudget).toBe(8000);

    const util = proposals.find((p) => p.name === "util")!;
    expect(util.reviewGate).toBe(false);
    // Non-sensitive domain gets the full default toolset including Edit/Write.
    expect(util.tools).toContain("Edit");
    expect(util.tools).toContain("Write");
  });

  it("create_agent writes a guardrailed agent file under .claude/agents/", () => {
    inTempCwd((cwd) => {
      const out = call("knitbrain_create_agent", {
        name: "Proxy Guard",
        description: "Owns the proxy layer.",
        scope: "src/proxy/**",
        tools: ["Read", "Edit"],
        reviewGate: true,
        contextBudget: 5000,
      });

      // Verdict reports the real on-disk path (name slugified).
      const expectedPath = join(cwd, ".claude", "agents", "proxy-guard.md");
      expect(out).toContain("created agent at");
      expect(out).toContain(expectedPath);
      expect(existsSync(expectedPath)).toBe(true);

      const md = readFileSync(expectedPath, "utf8");
      // Front-matter reflects the slugified name + provided tools/description.
      expect(md).toContain("name: proxy-guard");
      expect(md).toContain("description: Owns the proxy layer.");
      expect(md).toContain("tools: Read, Edit");
      // All four guardrails baked in.
      expect(md).toContain("`src/proxy/**`"); // scope
      expect(md).toContain("Allowed tools:** Read, Edit");
      expect(md).toContain("Review gate:**"); // sensitive → gate present
      expect(md).toContain("~5000 tokens"); // context budget

      // Side effect: creation is announced on the team board.
      const board = ctx.team.board();
      expect(board.some((e) => e.summary.includes("agent created: Proxy Guard"))).toBe(true);
    });
  });

  it("create_agent omits the review gate for non-sensitive agents", () => {
    inTempCwd((cwd) => {
      call("knitbrain_create_agent", { name: "docs", scope: "docs/**", reviewGate: false });
      const md = readFileSync(join(cwd, ".claude", "agents", "docs.md"), "utf8");
      expect(md).not.toContain("Review gate:**");
      expect(md).toContain("`docs/**`");
    });
  });
});
