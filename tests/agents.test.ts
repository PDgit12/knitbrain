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
