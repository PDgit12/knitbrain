import type { CCRStore } from "../ccr/store.js";
import { compress } from "../optimizer/router.js";
import { VERSION } from "../version.js";

/** Runtime context handed to every tool. */
export interface ToolContext {
  ccr: CCRStore;
}

/**
 * Output discipline at the dispatch chokepoint:
 *  - "data"     → auto-compressed (skeleton + ⟨ccr:hash⟩), original in CCR.
 *  - "verbatim" → returned exactly as-is (governance/protocol/control output
 *                 the agent must read literally — NEVER skeletonized).
 */
export type OutputKind = "data" | "verbatim";

export interface ToolDef {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly output: OutputKind;
  run(args: Record<string, unknown>, ctx: ToolContext): string;
}

/** Strip a ⟨ccr:…⟩ wrapper / prefix so a pasted handle still resolves. */
function normalizeHandle(raw: string): string {
  return raw.replace(/[⟨⟩]/g, "").replace(/^ccr:/, "").trim();
}

export const TOOLS: readonly ToolDef[] = [
  {
    name: "knitbrain_ping",
    description: "Health check — returns pong and the server version.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    output: "verbatim",
    run: () => `pong · knitbrain v${VERSION}`,
  },
  {
    name: "knitbrain_optimize",
    description:
      "Compress a payload (JSON / code / prose) into a token-cheap skeleton. The exact original is stored locally and recoverable via knitbrain_retrieve using the returned ⟨ccr:hash⟩. Returns the original unchanged if compression wouldn't help.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "The payload to optimize." } },
      required: ["text"],
      additionalProperties: false,
    },
    output: "verbatim", // already produces the optimized form itself
    run: (args, ctx) => {
      const text = typeof args["text"] === "string" ? args["text"] : "";
      const r = compress(text, ctx.ccr);
      return r.compressed
        ? `${r.skeleton}\n\n[optimized: ${r.originalTokens}→${r.skeletonTokens} tokens, saved ${r.savedPct}% · retrieve the ⟨ccr:…⟩ handle for the exact original]`
        : text;
    },
  },
  {
    name: "knitbrain_retrieve",
    description:
      "Retrieve the exact original bytes for a ⟨ccr:hash⟩ handle produced by compression. Use when a skeleton isn't enough and you need the precise content.",
    inputSchema: {
      type: "object",
      properties: { handle: { type: "string", description: "The ⟨ccr:hash⟩ or raw hash." } },
      required: ["handle"],
      additionalProperties: false,
    },
    output: "verbatim",
    run: (args, ctx) => {
      const raw = typeof args["handle"] === "string" ? args["handle"] : "";
      return ctx.ccr.get(normalizeHandle(raw));
    },
  },
];

/**
 * The ONE chokepoint: run a tool, then apply output discipline. Data outputs
 * are compressed through the optimizer (original preserved in CCR); verbatim
 * outputs pass through untouched.
 */
export function dispatch(
  tool: ToolDef,
  args: Record<string, unknown>,
  ctx: ToolContext,
): string {
  const raw = tool.run(args, ctx);
  if (tool.output === "verbatim") return raw;
  const r = compress(raw, ctx.ccr);
  return r.compressed ? r.skeleton : raw;
}
