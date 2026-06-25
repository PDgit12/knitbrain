import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSkillsStore } from "../src/engine/skills.js";
import { createFileCCRStore } from "../src/ccr/store.js";
import { createMemory } from "../src/engine/memory.js";
import { createKnowledge } from "../src/engine/knowledge.js";
import { createFeedback } from "../src/engine/feedback.js";
import { createTeamBoard } from "../src/engine/teams.js";
import { createMeter } from "../src/engine/meter.js";
import { createCalibration } from "../src/engine/calibration.js";
import { TOOLS, dispatch, type ToolContext } from "../src/mcp/tools.js";
import {
  parseFrontmatter,
  scanHostSkills,
  scanHostAgents,
  registerHostSkills,
  composeSkill,
  scanHost,
  HOST_IMPORT_MARK,
} from "../src/engine/host-scan.js";

// Real-shaped fixtures (mirror actual ~/.claude/skills/*/SKILL.md and
// .claude/agents/*.md frontmatter). No mocks of the parser — we run it on a
// real .claude tree seeded on disk.
const REAL_SKILL = `---
name: rust-testing
description: Rust testing patterns including unit tests, integration tests, and coverage.
origin: ECC
---

# Rust Testing Patterns

Comprehensive Rust testing patterns.

## When to Use
- writing tests
- adding coverage
`;

const REAL_AGENT = `---
name: architect-reviewer
description: "Use this agent to evaluate system design decisions."
tools: Read, Write, Edit, Bash, Glob, Grep
model: opus
---

You are an architecture reviewer. Evaluate design decisions.

## Process
- map the system
- find the seams
`;

describe("host-scan: parseFrontmatter (real shapes)", () => {
  it("extracts scalar + list frontmatter and the body", () => {
    const { fm, body } = parseFrontmatter(REAL_AGENT);
    expect(fm["name"]).toBe("architect-reviewer");
    expect(fm["description"]).toBe("Use this agent to evaluate system design decisions."); // quotes stripped
    expect(fm["tools"]).toEqual(["Read", "Write", "Edit", "Bash", "Glob", "Grep"]); // comma list → array
    expect(fm["model"]).toBe("opus");
    expect(body).toContain("architecture reviewer");
    expect(body).not.toContain("---"); // frontmatter delimiters removed
  });

  it("handles a file with no frontmatter (whole thing is body)", () => {
    const { fm, body } = parseFrontmatter("just a plain body\nno frontmatter");
    expect(Object.keys(fm)).toHaveLength(0);
    expect(body).toContain("plain body");
  });
});

describe("host-scan: scan + register + compose (e2e on a seeded .claude tree)", () => {
  let root: string;
  let claudeDir: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kb-host-scan-"));
    claudeDir = join(root, ".claude");
    mkdirSync(join(claudeDir, "skills", "rust-testing"), { recursive: true });
    mkdirSync(join(claudeDir, "agents"), { recursive: true });
    writeFileSync(join(claudeDir, "skills", "rust-testing", "SKILL.md"), REAL_SKILL);
    writeFileSync(join(claudeDir, "agents", "architect-reviewer.md"), REAL_AGENT);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("scanHostSkills finds the real seeded skill with its triggers + body", () => {
    const skills = scanHostSkills(claudeDir);
    expect(skills).toHaveLength(1);
    expect(skills[0]!.name).toBe("rust-testing");
    expect(skills[0]!.origin).toBe("ECC");
    expect(skills[0]!.body).toContain("Rust Testing Patterns");
  });

  it("scanHostAgents finds the real seeded agent with its tools + model", () => {
    const agents = scanHostAgents(claudeDir);
    expect(agents).toHaveLength(1);
    expect(agents[0]!.name).toBe("architect-reviewer");
    expect(agents[0]!.tools).toContain("Bash");
    expect(agents[0]!.model).toBe("opus");
  });

  it("returns empty (not throw) when .claude has no skills/agents dirs", () => {
    const empty = mkdtempSync(join(tmpdir(), "kb-empty-"));
    try {
      expect(scanHostSkills(join(empty, ".claude"))).toEqual([]);
      expect(scanHostAgents(join(empty, ".claude"))).toEqual([]);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("inferStyle reports the user's composition shape", () => {
    const { style } = scanHost(claudeDir);
    expect(style.usesModel).toBe(true); // agent had model: opus
    expect(style.medianBodyLen).toBeGreaterThan(0);
    expect(Array.isArray(style.headers)).toBe(true);
  });

  it("registerHostSkills puts host skills into the store and dedupes on re-run", () => {
    const store = createSkillsStore(join(root, "skills-store"));
    const skills = scanHostSkills(claudeDir);

    const first = registerHostSkills(skills, store);
    expect(first.added).toBe(1);
    expect(store.list().some((s) => s.name === "rust-testing")).toBe(true);
    expect(store.list().find((s) => s.name === "rust-testing")!.constraints).toContain(HOST_IMPORT_MARK);

    // re-run setup → no duplicate, no clobber
    const second = registerHostSkills(skills, store);
    expect(second.added).toBe(0);
    expect(second.skipped).toBe(1);
    expect(store.list().filter((s) => s.name === "rust-testing")).toHaveLength(1);
  });

  it("composeSkill produces a persisted skill drafted for the task", () => {
    const store = createSkillsStore(join(root, "skills-store2"));
    const { style } = scanHost(claudeDir);
    const skill = composeSkill("add retry logic to the http client", style, ["use exponential backoff"], store);
    expect(skill.name).toContain("retry");
    expect(skill.body.length).toBeGreaterThan(0);
    expect(store.list().some((s) => s.id === skill.id)).toBe(true);
  });

  it("knitbrain_compose_skill tool persists a composed skill through real dispatch", () => {
    const ccr = createFileCCRStore(join(root, "ccr"));
    const skills = createSkillsStore(join(root, "skills-store3"));
    const ctx: ToolContext = {
      ccr,
      memory: createMemory(join(root, "mem")),
      knowledge: createKnowledge(root, join(root, "kb")),
      feedback: createFeedback(join(root, "fb")),
      team: createTeamBoard(join(root, "team"), ccr),
      meter: createMeter(join(root, "meter")),
      skills,
      calibration: createCalibration(join(root, "cal")),
    };
    const out = dispatch(TOOLS.find((t) => t.name === "knitbrain_compose_skill")!, { task: "add caching to the api layer" }, ctx);
    expect(out).toContain("composed skill");
    expect(skills.list().some((s) => s.name.includes("caching"))).toBe(true);
  });
});
