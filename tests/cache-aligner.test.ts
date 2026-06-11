import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileCCRStore, type CCRStore } from "../src/ccr/store.js";
import { alignDynamicContent, prefixHash } from "../src/proxy/cache-aligner.js";
import { optimizeRequest, type RequestBody, type ContentBlock } from "../src/proxy/optimize-request.js";

const SYSTEM = `You are a coding agent.
Today's date is 2026-06-11.
Follow the project conventions.
Use ISO dates like 2024-01-01 in examples.
Be concise.`;

const SYSTEM_NEXT_DAY = SYSTEM.replace("2026-06-11", "2026-06-12");

describe("CacheAligner — dynamic content extraction", () => {
  it("moves volatile lines to the tail so prefixes match across sessions", () => {
    const a = alignDynamicContent(SYSTEM);
    const b = alignDynamicContent(SYSTEM_NEXT_DAY);
    expect(a.moved).toBe(1);
    // content preserved verbatim
    expect(a.text).toContain("Today's date is 2026-06-11.");
    // instruction-embedded date is NOT treated as volatile
    expect(a.text.indexOf("Use ISO dates")).toBeLessThan(a.text.indexOf("Today's date"));
    // the leading bytes are now identical across the two sessions
    const prefixLen = a.text.indexOf("[session context");
    expect(a.text.slice(0, prefixLen)).toBe(b.text.slice(0, prefixLen));
  });

  it("is idempotent — aligning an aligned prompt changes nothing", () => {
    const once = alignDynamicContent(SYSTEM).text;
    const twice = alignDynamicContent(once);
    expect(twice.text).toBe(once);
    expect(twice.moved).toBe(0);
  });

  it("prompts with no volatile lines just get whitespace-normalized", () => {
    const r = alignDynamicContent("Stable prompt.\nNo dates here.");
    expect(r.moved).toBe(0);
    expect(r.text).toBe("Stable prompt.\nNo dates here.");
  });
});

describe("CacheAligner — provider cache strategy (proxy path)", () => {
  let root: string;
  let ccr: CCRStore;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "knitbrain-ca-"));
    ccr = createFileCCRStore(root);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const history = (): RequestBody => ({
    system: SYSTEM,
    messages: [
      { role: "user", content: "first question " + "x".repeat(300) },
      { role: "assistant", content: "first answer " + "y".repeat(300) },
      { role: "user", content: "follow-up" },
      { role: "assistant", content: "short answer" },
      { role: "user", content: "current question" },
    ],
  });

  it("anthropic: inserts cache_control on system + history boundary when client has none", () => {
    const { body, stats } = optimizeRequest(history(), ccr, { provider: "anthropic" });
    expect(stats.cacheBreakpoints).toBe(2);
    expect(stats.dynamicMoved).toBe(1);
    const sys = body.system as ContentBlock[];
    expect(Array.isArray(sys)).toBe(true);
    expect(sys[sys.length - 1]!["cache_control"]).toEqual({ type: "ephemeral" });
    // boundary = last fully-compressed turn (messages.length - keepLastTurns - 1)
    const boundary = body.messages[2]!;
    const blocks = boundary.content as ContentBlock[];
    expect(blocks[blocks.length - 1]!["cache_control"]).toEqual({ type: "ephemeral" });
  });

  it("anthropic: NEVER fights client-set cache_control", () => {
    const req = history();
    req.messages[0] = {
      role: "user",
      content: [{ type: "text", text: "hello " + "x".repeat(300), cache_control: { type: "ephemeral" } }],
    };
    const { body, stats } = optimizeRequest(req, ccr, { provider: "anthropic" });
    expect(stats.cacheBreakpoints).toBe(0);
    expect(typeof body.system === "string" || Array.isArray(body.system)).toBe(true);
    // system stays a string — we did not convert it
    expect(typeof body.system).toBe("string");
  });

  it("openai: aligns the leading system message, no cache_control (automatic prefix caching)", () => {
    const req: RequestBody = {
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: "question" },
      ],
    };
    const { body, stats } = optimizeRequest(req, ccr, { provider: "openai" });
    expect(stats.dynamicMoved).toBe(1);
    expect(stats.cacheBreakpoints).toBe(0);
    expect(body.messages[0]!.content).toContain("[session context");
  });

  it("prefixHash is stable across sessions that differ only in volatile lines", () => {
    const r1 = optimizeRequest(history(), ccr, { provider: "anthropic" });
    const next = history();
    next.system = SYSTEM_NEXT_DAY;
    const r2 = optimizeRequest(next, ccr, { provider: "anthropic" });
    // hashes differ (the moved date differs) but the PREFIX before the marker matches
    const sys1 = (r1.body.system as ContentBlock[]).map((b) => b.text).join("");
    const sys2 = (r2.body.system as ContentBlock[]).map((b) => b.text).join("");
    const cut1 = sys1.indexOf("[session context");
    expect(sys1.slice(0, cut1)).toBe(sys2.slice(0, cut1));
    expect(prefixHash(sys1.slice(0, cut1))).toBe(prefixHash(sys2.slice(0, cut1)));
  });

  it("cacheAlign:false disables everything", () => {
    const { body, stats } = optimizeRequest(history(), ccr, { provider: "anthropic", cacheAlign: false });
    expect(stats.cacheBreakpoints).toBe(0);
    expect(stats.dynamicMoved).toBe(0);
    expect(typeof body.system).toBe("string");
  });
});
