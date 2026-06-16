import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import { Readable } from "node:stream";
import type { CCRStore } from "../ccr/store.js";
import type { Feedback } from "../engine/feedback.js";
import { optimizeRequest, type OptimizeOptions, type ProxyStats, type RequestBody } from "./optimize-request.js";

/** LLM API protocol, detected from the request path (platform-agnostic). */
export type Provider = "anthropic" | "openai";

export const DEFAULT_UPSTREAMS: Record<Provider, string> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com",
};

/**
 * Detect the provider from the endpoint, so the proxy works no matter which
 * coding platform points at it (Claude Code / Cursor / Codex all speak one of
 * these two protocols). The path is the robust signal.
 */
export function detectProvider(url: string): Provider {
  if (url.startsWith("/v1/chat/completions") || url.startsWith("/v1/completions")) {
    return "openai";
  }
  return "anthropic"; // /v1/messages
}

export interface ProxyConfig {
  ccr: CCRStore;
  /** Force one upstream for every provider (overrides detection). */
  upstream?: string;
  /** Per-provider upstream base URLs (defaults: Anthropic + OpenAI). */
  upstreams?: Partial<Record<Provider, string>>;
  options?: OptimizeOptions;
  /** TOIN feedback store: gates short-prose anchoring per request and records compressions. */
  feedback?: Pick<Feedback, "shouldSkip" | "onCompress">;
  /** Observe optimization stats per request (telemetry hook). */
  onStats?: (stats: ProxyStats) => void;
  /** Abort if the upstream sends no response headers within this many ms
   * (bounds dead/hung endpoints; never cuts an in-flight stream). Default 30s. */
  connectTimeoutMs?: number;
}

/** Resolve the upstream base URL for a request, honoring overrides. */
function resolveUpstream(cfg: ProxyConfig, provider: Provider): string {
  return cfg.upstream ?? cfg.upstreams?.[provider] ?? DEFAULT_UPSTREAMS[provider];
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

// Hop-by-hop / connection-specific headers we must NOT forward: host and
// content-length are recomputed by fetch from the new (compressed) body;
// accept-encoding is dropped so the upstream returns uncompressed SSE we can
// pipe verbatim (forwarding it risks a decompression mismatch on streams).
const STRIP_HEADERS = new Set([
  "host",
  "content-length",
  "connection",
  "transfer-encoding",
  "accept-encoding",
]);

/**
 * Forward the client's headers to the upstream, byte-identical, minus the
 * hop-by-hop ones. We pass EVERYTHING else through — including User-Agent and
 * provider beta/app headers — because OAuth/subscription acceptance depends on
 * them (an allowlist of just auth headers gets subscription requests
 * rejected). Auth is forwarded unchanged, never re-signed, and (per the proxy
 * contract) never logged or persisted — see the token-leak test.
 */
function forwardHeaders(h: IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    if (STRIP_HEADERS.has(k.toLowerCase())) continue;
    if (typeof v === "string") out[k] = v;
    else if (Array.isArray(v)) out[k] = v.join(", ");
  }
  if (!out["content-type"]) out["content-type"] = "application/json";
  return out;
}

/**
 * Build the Lever-B proxy: a loopback HTTP server that compresses the full LLM
 * request (rolling window + structure-preserve + CacheAligner, originals in
 * CCR) and forwards it upstream, streaming the response straight back.
 */
export function createProxyServer(cfg: ProxyConfig): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res, cfg).catch(() => {
      // Fail closed: generic body only. Never echo the error detail — it must
      // be impossible for a forwarded auth token or request content to surface
      // in an error response.
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "knitbrain proxy: upstream request failed" }));
    });
  });
}

async function handle(req: IncomingMessage, res: ServerResponse, cfg: ProxyConfig): Promise<void> {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "healthy", server: "knitbrain-proxy" }));
    return;
  }

  if (req.method === "POST" && req.url && /^\/v1\/(messages|chat\/completions)/.test(req.url)) {
    const raw = await readBody(req);
    let parsed: RequestBody;
    try {
      parsed = JSON.parse(raw) as RequestBody;
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "invalid JSON body" }));
      return;
    }

    const provider = detectProvider(req.url);
    const options: OptimizeOptions = { provider, ...cfg.options };
    if (cfg.feedback && options.allowProse === undefined) {
      options.allowProse = !cfg.feedback.shouldSkip("prose");
    }
    const { body, stats } = optimizeRequest(parsed, cfg.ccr, options);
    if (cfg.feedback) {
      for (const [handle, kind] of Object.entries(stats.kinds)) cfg.feedback.onCompress(kind, handle);
    }
    cfg.onStats?.(stats);

    const url = resolveUpstream(cfg, provider).replace(/\/+$/, "") + req.url;
    // Bound time-to-first-byte only: abort if the upstream never starts
    // responding (dead/hung endpoint), but clear the timer the moment headers
    // arrive so a legitimately long streaming completion is never cut off.
    const ttfb = new AbortController();
    const ttfbTimer = setTimeout(() => ttfb.abort(), cfg.connectTimeoutMs ?? 30_000);
    let upstream: Response;
    try {
      upstream = await fetch(url, {
        method: "POST",
        headers: forwardHeaders(req.headers),
        body: JSON.stringify(body),
        signal: ttfb.signal,
      });
    } finally {
      clearTimeout(ttfbTimer);
    }

    const headersOut: Record<string, string> = {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
    };
    res.writeHead(upstream.status, headersOut);
    if (upstream.body) {
      Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]).pipe(res);
    } else {
      res.end();
    }
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
}
