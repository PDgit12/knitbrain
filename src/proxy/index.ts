#!/usr/bin/env node
import { createProxyServer } from "./server.js";
import { createFileCCRStore } from "../ccr/store.js";
import { createActivityLog } from "../engine/activity.js";
import { createFeedback } from "../engine/feedback.js";
import { createMeter } from "../engine/meter.js";
import { readSessionMark } from "../engine/receipt.js";
import { activityRoot, ccrRoot, feedbackRoot, meterRoot } from "../paths.js";

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

// Project roots resolve from cwd — or KNITBRAIN_PROJECT_DIR when the proxy is
// launched outside the project dir, so receipt attribution lands in the right
// project ledger (risk cleared: proxy cwd ≠ project).
const meter = createMeter(meterRoot());
const activity = createActivityLog(activityRoot(), {
  protectSince: () => readSessionMark(meterRoot())?.startTs ?? null,
});

// Output-side lever: KNITBRAIN_TERSE=1 appends a compact terse directive to
// every request's system tail. Off by default — the proxy never alters the
// user's prompt without an explicit opt-in.
const TERSE_DIRECTIVE =
  'OUTPUT BUDGET: answer terse — same facts, fewer words. Drop filler, pleasantries, and hedging; prefer tables/bullets over prose and code over description. NEVER drop technical content, numbers, file paths, or decision-changing caveats. If the user asks for "verbose" / "explain fully", answer that reply in full prose.';
const terseEnv = (process.env["KNITBRAIN_TERSE"] ?? "").toLowerCase();
const terseOn = terseEnv !== "" && terseEnv !== "0" && terseEnv !== "off" && terseEnv !== "false";

const server = createProxyServer({
  ccr: createFileCCRStore(ccrRoot()),
  // Shared TOIN store: retrievals voted via MCP back off proxy prose anchoring too.
  feedback: createFeedback(feedbackRoot()),
  ...(override ? { upstream: override } : {}),
  ...(terseOn ? { options: { terseDirective: TERSE_DIRECTIVE } } : {}),
  upstreams,
  onModel: (m) => meter.onModel(m),
  onStats: (s) => {
    // The optimized request size IS the live context window usage.
    meter.onRequest(s.originalTokens, s.optimizedTokens);
    // G1 attribution: proxy savings land in the same session ledger as MCP/hook
    // savings, so the receipt can name Door 3's contribution.
    if (s.originalTokens > s.optimizedTokens) {
      activity.record({
        agent: "proxy",
        tool: "request",
        summary: `optimized api request (${s.blocksCompressed} blocks)`,
        saved: s.originalTokens - s.optimizedTokens,
        source: "proxy",
        rawTokens: s.originalTokens,
        storedTokens: s.optimizedTokens,
      });
    }
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
