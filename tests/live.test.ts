import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileCCRStore } from "../src/ccr/store.js";
import { createProxyServer } from "../src/proxy/server.js";

/**
 * OPT-IN live-endpoint test. Skipped unless BOTH are set:
 *   KNITBRAIN_LIVE_TEST=1   ANTHROPIC_API_KEY=sk-...
 * Run with:  KNITBRAIN_LIVE_TEST=1 ANTHROPIC_API_KEY=... npm test
 * This is the only honest way to verify the proxy against the real Anthropic
 * API (needs network + a key) — it cannot run in CI without credentials.
 */
const live = Boolean(process.env["KNITBRAIN_LIVE_TEST"]) && Boolean(process.env["ANTHROPIC_API_KEY"]);

describe.skipIf(!live)("proxy ↔ LIVE Anthropic endpoint (opt-in)", () => {
  let root: string;
  let proxy: Server;
  let port: number;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "knitbrain-live-"));
    proxy = createProxyServer({ ccr: createFileCCRStore(root), upstream: "https://api.anthropic.com" });
    port = await new Promise((r) => proxy.listen(0, "127.0.0.1", () => r((proxy.address() as { port: number }).port)));
  });
  afterAll(async () => {
    await new Promise<void>((r) => proxy.close(() => r()));
    rmSync(root, { recursive: true, force: true });
  });

  it("forwards a real request and gets a valid response", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env["ANTHROPIC_API_KEY"]!,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 16,
        messages: [{ role: "user", content: "Reply with the single word: ok" }],
      }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { content?: Array<{ text?: string }> };
    expect(Array.isArray(json.content)).toBe(true);
  }, 30000);
});
