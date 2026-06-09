import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileCCRStore, type CCRStore } from "../src/ccr/store.js";
import { optimizeRequest } from "../src/proxy/optimize-request.js";
import { normalizePrefix, prefixHash } from "../src/proxy/cache-aligner.js";
import { createProxyServer, detectProvider } from "../src/proxy/server.js";

const bigJson = (seed: string): string =>
  JSON.stringify({ items: Array.from({ length: 40 }, (_, i) => ({ i, seed, blob: "x".repeat(50) })) }, null, 2);

const listen = (s: Server): Promise<number> =>
  new Promise((r) => s.listen(0, "127.0.0.1", () => r((s.address() as { port: number }).port)));
const close = (s: Server): Promise<void> => new Promise((r) => s.close(() => r()));

describe("CacheAligner (rung 7)", () => {
  it("normalizes whitespace meaning-preservingly", () => {
    expect(normalizePrefix("a  \nb\n\n\n\nc")).toBe("a\nb\n\nc");
  });
  it("prefix hash is stable across whitespace variants", () => {
    expect(prefixHash("sys   \nrules")).toBe(prefixHash("sys\nrules"));
  });
});

describe("detectProvider (rung 7)", () => {
  it("routes by endpoint", () => {
    expect(detectProvider("/v1/messages")).toBe("anthropic");
    expect(detectProvider("/v1/chat/completions")).toBe("openai");
    expect(detectProvider("/v1/messages?beta=1")).toBe("anthropic");
  });
});

describe("optimizeRequest (rung 7)", () => {
  let root: string;
  let ccr: CCRStore;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "knitbrain-opt-"));
    ccr = createFileCCRStore(root);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("protects recent turns + current intent, compresses old data (lossless)", () => {
    const oldData = bigJson("old");
    const body = {
      system: "system rules",
      messages: [
        { role: "user", content: oldData },
        { role: "assistant", content: "ok" },
        { role: "user", content: "now do X" },
      ],
    };
    const { body: out, stats } = optimizeRequest(body, ccr, { keepLastTurns: 2 });
    const msgs = out.messages;
    expect(typeof msgs[0]!.content).toBe("string");
    expect(msgs[0]!.content).toContain("⟨ccr:"); // old block compressed
    expect(msgs[2]!.content).toBe("now do X"); // intent protected
    expect(stats.savedPct).toBeGreaterThan(0);
    expect(stats.blocksCompressed).toBe(1);
    // lossless: the stored original recovers byte-for-byte
    expect(ccr.get(stats.handles[0]!)).toBe(oldData);
  });

  it("never compresses an unstructured final turn", () => {
    const body = { messages: [{ role: "user", content: bigJson("a") }] };
    const { body: out } = optimizeRequest(body, ccr, { keepLastTurns: 2 });
    expect(out.messages[0]!.content).toBe(bigJson("a")); // no fenced bulk → untouched
  });

  it("intent-vs-payload split: keeps directive verbatim, compresses fenced bulk", () => {
    const instruction = "Please fix the flaky test below and explain why:";
    const closing = "Thanks — keep the public API stable.";
    const fenced = "```json\n" + bigJson("paste") + "\n```";
    const body = { messages: [{ role: "user", content: `${instruction}\n${fenced}\n${closing}` }] };
    const { body: out, stats } = optimizeRequest(body, ccr, { keepLastTurns: 1 });
    const content = out.messages[0]!.content as string;
    expect(content).toContain(instruction); // directive kept verbatim
    expect(content).toContain(closing); // closing kept verbatim
    expect(content).toContain("⟨ccr:"); // embedded bulk compressed
    expect(stats.blocksCompressed).toBe(1);
    expect(content.length).toBeLessThan(`${instruction}\n${fenced}\n${closing}`.length);
  });

  it("compresses large text blocks inside content arrays", () => {
    const body = {
      messages: [
        { role: "user", content: [{ type: "text", text: bigJson("blk") }] },
        { role: "user", content: "current" },
        { role: "assistant", content: "x" },
      ],
    };
    const { body: out } = optimizeRequest(body, ccr, { keepLastTurns: 2 });
    const blocks = out.messages[0]!.content as Array<{ type: string; text: string }>;
    expect(blocks[0]!.text).toContain("⟨ccr:");
  });
});

describe("proxy server integration (rung 7)", () => {
  let root: string;
  let ccr: CCRStore;
  let upstream: Server;
  let proxy: Server;
  let received: string[];

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "knitbrain-proxy-"));
    ccr = createFileCCRStore(root);
    received = [];
    upstream = createServer((req, res) => {
      let d = "";
      req.on("data", (c) => (d += c));
      req.on("end", () => {
        received.push(d);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    const upstreamPort = await listen(upstream);
    proxy = createProxyServer({ ccr, upstream: `http://127.0.0.1:${upstreamPort}` });
  });

  afterEach(async () => {
    await close(proxy);
    await close(upstream);
    rmSync(root, { recursive: true, force: true });
  });

  it("/health returns healthy", async () => {
    const port = await listen(proxy);
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status?: string }).status).toBe("healthy");
  });

  it("compresses the request before forwarding upstream, returns upstream response", async () => {
    const port = await listen(proxy);
    const oldData = bigJson("wire");
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        system: "rules",
        messages: [
          { role: "user", content: oldData },
          { role: "assistant", content: "ok" },
          { role: "user", content: "do it" },
        ],
      }),
    });
    expect(((await res.json()) as { ok?: boolean }).ok).toBe(true); // upstream response passed through
    const forwarded = JSON.parse(received[0]!);
    expect(forwarded.messages[0].content).toContain("⟨ccr:"); // old block compressed on the wire
    expect(forwarded.messages[2].content).toBe("do it"); // intent intact
  });
});

describe("proxy SSE streaming passthrough (rung 9)", () => {
  let root: string;
  let ccr: CCRStore;
  let upstream: Server;
  let proxy: Server;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "knitbrain-sse-"));
    ccr = createFileCCRStore(root);
    upstream = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('event: message\ndata: {"delta":"hello"}\n\n');
      res.write("event: done\ndata: [DONE]\n\n");
      res.end();
    });
    const upstreamPort = await listen(upstream);
    proxy = createProxyServer({ ccr, upstream: `http://127.0.0.1:${upstreamPort}` });
  });
  afterEach(async () => {
    await close(proxy);
    await close(upstream);
    rmSync(root, { recursive: true, force: true });
  });

  it("streams an SSE response through unchanged", async () => {
    const port = await listen(proxy);
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stream: true, messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const body = await res.text();
    expect(body).toContain("hello");
    expect(body).toContain("[DONE]");
  });
});
