import { describe, it, expect } from "vitest";
import { detectBilling, normalizeHost, agentLabel } from "../src/mcp/host.js";

describe("host auto-detection (zero setup)", () => {
  it("detects billing from env API keys", () => {
    expect(detectBilling({ ANTHROPIC_API_KEY: "sk-x" })).toBe("api");
    expect(detectBilling({ OPENAI_API_KEY: "sk-x" })).toBe("api");
    expect(detectBilling({})).toBe("subscription");
  });
  it("normalizes the MCP client name, falls back to env, then 'agent'", () => {
    expect(normalizeHost("Claude Code", {})).toBe("claude-code");
    expect(normalizeHost("Cursor", {})).toBe("cursor");
    expect(normalizeHost(undefined, { TERM_PROGRAM: "vscode" })).toBe("vscode");
    expect(normalizeHost(undefined, {})).toBe("agent");
  });
  it("builds the platform+plan label", () => {
    expect(agentLabel("Codex", { OPENAI_API_KEY: "k" })).toBe("codex (api)");
    expect(agentLabel("claude-code", {})).toBe("claude-code (subscription)");
  });
});
