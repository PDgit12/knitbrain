import { describe, it, expect } from "vitest";
import { classifyTask } from "../src/engine/workflow.js";

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
