import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyTask, composeWorkflow, saveWorkflow, loadWorkflow, type WorkflowDoc } from "../src/engine/workflow.js";

describe("workflow classifier (rung 10)", () => {
  it("inquiry: a question with no files just answers", () => {
    const c = classifyTask("How does the dispatch chokepoint work?");
    expect(c.tier).toBe("inquiry");
    expect(c.autoPlanMode).toBe(false);
    expect(c.phases).toEqual([]);
  });

  it("complex: high-risk keyword → plan mode + full phases", () => {
    const c = classifyTask("refactor the architecture of the proxy");
    expect(c.tier).toBe("complex");
    expect(c.autoPlanMode).toBe(true);
    expect(c.phases).toContain("PLAN");
  });

  it("complex: many files in scope", () => {
    const c = classifyTask("update a thing", ["a.ts", "b.ts", "c.ts", "d.ts"]);
    expect(c.tier).toBe("complex");
  });

  it("trivial: small low-risk change", () => {
    const c = classifyTask("fix typo in README");
    expect(c.tier).toBe("trivial");
    expect(c.phases).toEqual(["EXECUTE"]);
  });

  it("standard: a normal multi-step change", () => {
    const c = classifyTask(
      "add a new field to the learnings store and surface it in search results",
      ["memory.ts"],
    );
    expect(c.tier).toBe("standard");
    expect(c.autoPlanMode).toBe(false);
  });
});

describe("workflow classifier: read-only intent guard (Gap G)", () => {
  it("read-only context task with files + COMPLEX keyword → inquiry, no plan-mode", () => {
    const c = classifyTask(
      "read the auth and security architecture and explain how it works",
      ["src/auth.ts", "src/security.ts"],
    );
    expect(c.tier).toBe("inquiry");
    expect(c.autoPlanMode).toBe(false);
    expect(c.phases).toEqual([]);
    expect(c.reason).toContain("read-only");
  });

  it("audit/review-only tasks are inquiry even though they name many files", () => {
    for (const desc of ["audit the security flow", "map the proxy protocol", "inspect the schema"]) {
      const c = classifyTask(desc, ["a.ts", "b.ts", "c.ts"]);
      expect(c.tier).toBe("inquiry");
      expect(c.autoPlanMode).toBe(false);
    }
  });

  it("a real WRITE with a risk keyword still gets complex + plan-mode", () => {
    const c = classifyTask("refactor the auth module", ["src/auth.ts"]);
    expect(c.tier).toBe("complex");
    expect(c.autoPlanMode).toBe(true);
  });

  it("mixed read+write ('review and fix') is NOT downgraded to inquiry", () => {
    const c = classifyTask("review the diff and fix the security bug", ["src/a.ts", "src/b.ts"]);
    expect(c.tier).not.toBe("inquiry");
    expect(c.tier).toBe("complex"); // 2 files + write intent
    expect(c.autoPlanMode).toBe(true);
  });
});

describe("workflow driver: compose + persist + load (Gap D)", () => {
  const DOC: WorkflowDoc = {
    project: "knit-brain — a memory + workflow MCP",
    dod: "all 4 gates green with pasted evidence",
    constraints: "never force-push; never publish without OK",
    verify: "npm test",
    goal: "ship the vision gaps A–F",
    domains: ["engine", "mcp", "optimizer"],
    style: { terse: true, usesModel: false },
  };
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "kb-wf-")); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("composeWorkflow is deterministic (no timestamps) and carries charter + domains", () => {
    const a = composeWorkflow(DOC);
    const b = composeWorkflow(DOC);
    expect(a).toBe(b); // byte-identical across calls → never drifts
    expect(a).toContain("GOAL: ship the vision gaps A–F");
    expect(a).toContain("VERIFY: npm test");
    expect(a).toContain("CONSTRAINTS: never force-push; never publish without OK");
    expect(a).toContain("DOMAINS: engine, mcp, optimizer");
    expect(a).toContain("STYLE: terse");
  });

  it("save then load is byte-for-byte identical; missing file → null", () => {
    const text = composeWorkflow(DOC);
    const p = join(root, "workflow.md");
    saveWorkflow(text, p);
    expect(loadWorkflow(p)).toBe(text); // verbatim round-trip
    expect(loadWorkflow(join(root, "nope.md"))).toBeNull();
  });
});
