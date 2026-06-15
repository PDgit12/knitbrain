import { describe, it, expect } from "vitest";
import { resolveWrap, hasApiKey, DEFAULT_PROXY_PORT } from "../src/wrap.js";

describe("knitbrain wrap — agent resolution", () => {
  it("maps each supported agent to its binary + base-URL env var", () => {
    expect(resolveWrap("claude")).toEqual({
      binary: "claude",
      envVar: "ANTHROPIC_BASE_URL",
      baseUrl: `http://127.0.0.1:${DEFAULT_PROXY_PORT}`,
    });
    expect(resolveWrap("codex")).toEqual({
      binary: "codex",
      envVar: "OPENAI_BASE_URL",
      baseUrl: `http://127.0.0.1:${DEFAULT_PROXY_PORT}/v1`,
    });
    expect(resolveWrap("aider")).toMatchObject({ envVar: "OPENAI_BASE_URL" });
    expect(resolveWrap("copilot")).toMatchObject({ envVar: "OPENAI_BASE_URL" });
  });

  it("honors a custom proxy port", () => {
    const p = resolveWrap("claude", 9999);
    expect(p).toMatchObject({ baseUrl: "http://127.0.0.1:9999" });
  });

  it("rejects unknown agents with a helpful message (no throw)", () => {
    const r = resolveWrap("vim");
    expect("error" in r).toBe(true);
    expect((r as { error: string }).error).toContain("supported: claude, codex, aider, copilot");
  });

  it("detects API-key vs subscription env (drives the proxy-vs-direct path)", () => {
    expect(hasApiKey({ ANTHROPIC_API_KEY: "sk-x" })).toBe(true);
    expect(hasApiKey({ OPENAI_API_KEY: "sk-x" })).toBe(true);
    expect(hasApiKey({})).toBe(false);
  });
});
