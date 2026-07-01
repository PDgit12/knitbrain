import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
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
  scanHostAll,
  buildHostIndex,
  saveHostIndex,
  countBySource,
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

describe("host-scan: scanHostAll — whole-user surface (project + global + plugins)", () => {
  let home: string;
  let projectClaudeDir: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "kb-home-"));
    // GLOBAL ~/.claude: one skill + one agent, plus a skill that COLLIDES with the project.
    mkdirSync(join(home, ".claude", "skills", "rust-testing"), { recursive: true });
    mkdirSync(join(home, ".claude", "skills", "shared-name"), { recursive: true });
    mkdirSync(join(home, ".claude", "agents"), { recursive: true });
    writeFileSync(join(home, ".claude", "skills", "rust-testing", "SKILL.md"), REAL_SKILL);
    writeFileSync(join(home, ".claude", "skills", "shared-name", "SKILL.md"),
      `---\nname: shared-name\ndescription: GLOBAL version\n---\nglobal body\n`);
    writeFileSync(join(home, ".claude", "agents", "architect-reviewer.md"), REAL_AGENT);
    // PLUGIN under ~/.claude/plugins/<mp>/<plugin>/{skills,agents} (nested).
    const plugin = join(home, ".claude", "plugins", "marketplaces", "acme", "cool-plugin");
    mkdirSync(join(plugin, "skills", "plugin-skill"), { recursive: true });
    mkdirSync(join(plugin, "agents"), { recursive: true });
    writeFileSync(join(plugin, "skills", "plugin-skill", "SKILL.md"),
      `---\nname: plugin-skill\ndescription: from a plugin\n---\nplugin body\n`);
    writeFileSync(join(plugin, "agents", "plugin-agent.md"),
      `---\nname: plugin-agent\ndescription: plugin agent\ntools: Read\n---\nbody\n`);
    // PROJECT .claude: its own shared-name skill (must WIN the dedup).
    projectClaudeDir = join(home, "proj", ".claude");
    mkdirSync(join(projectClaudeDir, "skills", "shared-name"), { recursive: true });
    writeFileSync(join(projectClaudeDir, "skills", "shared-name", "SKILL.md"),
      `---\nname: shared-name\ndescription: PROJECT version\n---\nproject body\n`);
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("scans all roots, tags each by source, and dedupes name (project wins)", () => {
    const { skills, agents } = scanHostAll(projectClaudeDir, home);
    const byName = new Map(skills.map((s) => [s.name, s]));
    // shared-name collides across project+global → appears ONCE, project version.
    expect(skills.filter((s) => s.name === "shared-name")).toHaveLength(1);
    expect(byName.get("shared-name")!.source).toBe("project");
    expect(byName.get("shared-name")!.description).toBe("PROJECT version");
    // global-only + plugin skills present, correctly tagged.
    expect(byName.get("rust-testing")!.source).toBe("global");
    expect(byName.get("plugin-skill")!.source).toBe("plugin");
    // agents: global + plugin both found and tagged.
    const agentByName = new Map(agents.map((a) => [a.name, a]));
    expect(agentByName.get("architect-reviewer")!.source).toBe("global");
    expect(agentByName.get("plugin-agent")!.source).toBe("plugin");
  });

  it("buildHostIndex + saveHostIndex persist a lightweight, deduped index", () => {
    const scan = scanHostAll(projectClaudeDir, home);
    const idxPath = join(home, "host-index.json");
    saveHostIndex(buildHostIndex(scan), idxPath);
    const idx = JSON.parse(readFileSync(idxPath, "utf8")) as ReturnType<typeof buildHostIndex>;
    // index carries name/description/source but NOT full bodies.
    expect(idx.skills.every((s) => "source" in s && !("body" in s))).toBe(true);
    expect(idx.agents.some((a) => a.name === "plugin-agent" && a.source === "plugin")).toBe(true);
    const sk = countBySource(scan.skills);
    expect(sk.project).toBe(1);
    expect(sk.global).toBe(1); // rust-testing (shared-name dedup'd to project)
    expect(sk.plugin).toBe(1);
  });
});
