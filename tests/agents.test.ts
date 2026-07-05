import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { proposeAgents, generateAgentMarkdown, writeAgent } from "../src/engine/agents.js";

describe("create_agent (rung 11)", () => {
  it("proposes one agent per multi-file domain", () => {
    const files = [
      "src/proxy/server.ts",
      "src/proxy/optimize-request.ts",
      "src/optimizer/json.ts",
      "src/optimizer/code.ts",
      "src/lonely.ts", // single file at root → no proposal
    ];
    const proposals = proposeAgents(files);
    const names = proposals.map((p) => p.name);
    expect(names).toContain("proxy");
    expect(names).toContain("optimizer");
    expect(names).not.toContain("src"); // lonely single file excluded
  });

  it("flags sensitive domains with a review gate + read-only tools", () => {
    const proposals = proposeAgents(["src/auth/login.ts", "src/auth/session.ts"]);
    const auth = proposals.find((p) => p.name === "auth")!;
    expect(auth.reviewGate).toBe(true);
    expect(auth.tools).not.toContain("Write");
  });

  it("generates an agent with all four guardrails", () => {
    const md = generateAgentMarkdown({
      name: "payments",
      scope: "src/payments/**",
      tools: ["Read", "Grep"],
      reviewGate: true,
      contextBudget: 6000,
    });
    expect(md).toContain("name: payments");
    expect(md).toContain("tools: Read, Grep"); // allowlist
    expect(md).toContain("src/payments/**"); // scope
    expect(md).toContain("Review gate"); // review gate
    expect(md).toContain("6000 tokens"); // context budget
  });

  it("replicates the user's frontmatter scheme + order (Gap 3 fidelity)", () => {
    // User's agents put description first, then model, then name, then tools —
    // and use triggers. A generated agent must follow THAT order/set.
    const md = generateAgentMarkdown(
      { name: "engine", scope: "src/engine/**", tools: ["Read", "Edit"] },
      {
        medianBodyLen: 200,
        terse: true,
        usesModel: true,
        model: "opus",
        usesTriggers: true,
        headers: [],
        agentFrontmatterKeys: ["description", "model", "name", "tools", "triggers"],
      },
    );
    const fm = md.split("---")[1]!;
    const lines = fm.trim().split("\n").map((l) => l.split(":")[0]);
    expect(lines).toEqual(["description", "model", "name", "tools", "triggers"]);
    expect(fm).toContain("model: opus");
  });

  it("omits a scheme key it cannot fill honestly (e.g. no triggers when unused)", () => {
    const md = generateAgentMarkdown(
      { name: "x", tools: ["Read"] },
      { medianBodyLen: 100, terse: false, usesModel: false, usesTriggers: false, headers: [], agentFrontmatterKeys: ["name", "description", "tools", "model"] },
    );
    expect(md).not.toContain("model:"); // usesModel false → skipped
    expect(md).not.toContain("triggers:");
  });

  it("writes the agent file to .claude/agents", () => {
    const root = mkdtempSync(join(tmpdir(), "knitbrain-agent-"));
    try {
      const path = writeAgent(root, { name: "engine", scope: "src/engine/**" });
      expect(path).toContain(join(".claude", "agents", "engine.md"));
      expect(readFileSync(path, "utf8")).toContain("name: engine");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
