#!/usr/bin/env node
import { createProxyServer } from "./server.js";
import { createFileCCRStore } from "../ccr/store.js";
import { createMeter } from "../engine/meter.js";
import { ccrRoot, meterRoot } from "../paths.js";

const port = Number(process.env["KNITBRAIN_PROXY_PORT"] ?? 8788);
// Provider is auto-detected from the request path; upstreams are overridable.
const override = process.env["KNITBRAIN_UPSTREAM"];
const upstreams = {
  ...(process.env["KNITBRAIN_UPSTREAM_ANTHROPIC"]
    ? { anthropic: process.env["KNITBRAIN_UPSTREAM_ANTHROPIC"] }
    : {}),
  ...(process.env["KNITBRAIN_UPSTREAM_OPENAI"]
    ? { openai: process.env["KNITBRAIN_UPSTREAM_OPENAI"] }
    : {}),
};

const meter = createMeter(meterRoot());

const server = createProxyServer({
  ccr: createFileCCRStore(ccrRoot()),
  ...(override ? { upstream: override } : {}),
  upstreams,
  onStats: (s) => {
    // The optimized request size IS the live context window usage.
    meter.onRequest(s.originalTokens, s.optimizedTokens);
    if (s.blocksCompressed > 0) {
      console.error(
        `[knitbrain-proxy] ${s.originalTokens}→${s.optimizedTokens} tok (saved ${s.savedPct}%, ${s.blocksCompressed} blocks)`,
      );
    }
  },
});

// Local-first: bind loopback only.
server.listen(port, "127.0.0.1", () => {
  console.error(
    `[knitbrain-proxy] listening on http://127.0.0.1:${port} — provider auto-detected per request (Anthropic /v1/messages · OpenAI /v1/chat/completions)`,
  );
});
