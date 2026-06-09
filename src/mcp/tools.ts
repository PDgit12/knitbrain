import type { CCRStore } from "../ccr/store.js";
import type { Memory } from "../engine/memory.js";
import { compress } from "../optimizer/router.js";
import { VERSION } from "../version.js";

/** Runtime context handed to every tool. */
export interface ToolContext {
  ccr: CCRStore;
  memory: Memory;
}

function str(args: Record<string, unknown>, key: string): string {
  return typeof args[key] === "string" ? (args[key] as string) : "";
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
    run: (args, ctx) => ctx.ccr.get(normalizeHandle(str(args, "handle"))),
  },
  {
    name: "knitbrain_record_learning",
    description: "Record a non-obvious project learning (summary + lesson + tags) for future sessions.",
    inputSchema: {
      type: "object",
      properties: {
        summary: { type: "string" },
        lesson: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["summary", "lesson"],
      additionalProperties: false,
    },
    output: "verbatim",
    run: (args, ctx) => {
      const tags = Array.isArray(args["tags"]) ? (args["tags"] as string[]) : [];
      const { id, duplicate } = ctx.memory.recordLearning({
        summary: str(args, "summary"),
        lesson: str(args, "lesson"),
        tags,
      });
      return duplicate ? `duplicate of existing learning ${id}` : `recorded learning ${id}`;
    },
  },
  {
    name: "knitbrain_search_learnings",
    description: "Search project learnings; returns ranked headlines (id + summary). Call knitbrain_get_learning for a full lesson.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" }, limit: { type: "number" } },
      required: ["query"],
      additionalProperties: false,
    },
    output: "data",
    run: (args, ctx) => {
      const limit = typeof args["limit"] === "number" ? args["limit"] : 5;
      return JSON.stringify(ctx.memory.searchLearnings(str(args, "query"), limit), null, 2);
    },
  },
  {
    name: "knitbrain_get_learning",
    description: "Fetch the full lesson for a learning id (from knitbrain_search_learnings).",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
    output: "data",
    run: (args, ctx) => {
      const l = ctx.memory.getLearning(str(args, "id"));
      return l ? JSON.stringify(l, null, 2) : `no learning found with id ${str(args, "id")}`;
    },
  },
  {
    name: "knitbrain_save_handoff",
    description: "Save session handoff state so the next session can resume.",
    inputSchema: {
      type: "object",
      properties: { state: { type: "string" } },
      required: ["state"],
      additionalProperties: false,
    },
    output: "verbatim",
    run: (args, ctx) => {
      ctx.memory.saveHandoff(str(args, "state"));
      return "handoff saved";
    },
  },
  {
    name: "knitbrain_load_session",
    description: "Load the prior handoff + top recent learnings to resume work.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    output: "data",
    run: (_args, ctx) => JSON.stringify(ctx.memory.loadSession(), null, 2),
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
