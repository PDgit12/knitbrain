import type { CCRStore } from "../ccr/store.js";
import type { Memory } from "../engine/memory.js";
import type { Knowledge } from "../engine/knowledge.js";
import type { Feedback } from "../engine/feedback.js";
import type { TeamBoard } from "../engine/teams.js";
import type { Meter } from "../engine/meter.js";
import { classifyTask } from "../engine/workflow.js";
import { proposeAgents, writeAgent } from "../engine/agents.js";
import { compress, detect } from "../optimizer/router.js";
import { countTokens } from "../tokenizer.js";
import { VERSION } from "../version.js";

/** Runtime context handed to every tool. */
export interface ToolContext {
  ccr: CCRStore;
  memory: Memory;
  knowledge: Knowledge;
  feedback: Feedback;
  team: TeamBoard;
  meter: Meter;
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
      if (!r.compressed) return text;
      ctx.feedback.onCompress(r.contentType, r.handle);
      return `${r.skeleton}\n\n[optimized: ${r.originalTokens}→${r.skeletonTokens} tokens, saved ${r.savedPct}% · retrieve the ⟨ccr:…⟩ handle for the exact original]`;
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
      const handle = normalizeHandle(str(args, "handle"));
      const original = ctx.ccr.get(handle);
      ctx.feedback.onRetrieve(handle); // a vote that the skeleton wasn't enough
      return original;
    },
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
    description: "Load the prior handoff + top recent learnings to resume work. Resets the context meter for the new session.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    output: "data",
    run: (_args, ctx) => {
      ctx.meter.reset(); // new session starts a fresh window
      return JSON.stringify(ctx.memory.loadSession(), null, 2);
    },
  },
  {
    name: "knitbrain_context_meter",
    description: "Token-window meter: how full the context is, tokens saved by optimization, and whether it's time to save a handoff and clear the session.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    output: "verbatim",
    run: (_args, ctx) => JSON.stringify(ctx.meter.read(), null, 2),
  },
  {
    name: "knitbrain_scan",
    description: "Scan the project and (re)build the import/export knowledge graph.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    output: "verbatim",
    run: (_args, ctx) => `scanned ${ctx.knowledge.scan().files} files`,
  },
  {
    name: "knitbrain_query_imports",
    description: "What a file imports (module specifiers + names).",
    inputSchema: {
      type: "object",
      properties: { file: { type: "string" } },
      required: ["file"],
      additionalProperties: false,
    },
    output: "data",
    run: (args, ctx) => JSON.stringify(ctx.knowledge.queryImports(str(args, "file")) ?? [], null, 2),
  },
  {
    name: "knitbrain_query_exports",
    description: "What a file exports.",
    inputSchema: {
      type: "object",
      properties: { file: { type: "string" } },
      required: ["file"],
      additionalProperties: false,
    },
    output: "data",
    run: (args, ctx) => JSON.stringify(ctx.knowledge.queryExports(str(args, "file")) ?? [], null, 2),
  },
  {
    name: "knitbrain_query_dependents",
    description: "Which files import the given file (blast radius before editing).",
    inputSchema: {
      type: "object",
      properties: { file: { type: "string" } },
      required: ["file"],
      additionalProperties: false,
    },
    output: "data",
    run: (args, ctx) => JSON.stringify(ctx.knowledge.queryDependents(str(args, "file")), null, 2),
  },
  {
    name: "knitbrain_classify_task",
    description: "Classify a task into a tier (inquiry/trivial/standard/complex) with phases + plan-mode signal. Follow the returned plan.",
    inputSchema: {
      type: "object",
      properties: {
        description: { type: "string" },
        files: { type: "array", items: { type: "string" } },
      },
      required: ["description"],
      additionalProperties: false,
    },
    output: "verbatim",
    run: (args) => {
      const files = Array.isArray(args["files"]) ? (args["files"] as string[]) : [];
      return JSON.stringify(classifyTask(str(args, "description"), files), null, 2);
    },
  },
  {
    name: "knitbrain_metrics",
    description: "Compression telemetry: CCR tier counts + per-kind retrieval rates (TOIN self-tuning).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    output: "verbatim",
    run: (_args, ctx) =>
      JSON.stringify({ ccr: ctx.ccr.stats(), feedback: ctx.feedback.stats() }, null, 2),
  },
  {
    name: "knitbrain_propose_agents",
    description: "Auto-detect project-specific agent proposals from the knowledge graph (domains + guardrails). Review/edit, then create with knitbrain_create_agent.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    output: "data",
    run: (_args, ctx) => JSON.stringify(proposeAgents(ctx.knowledge.listFiles()), null, 2),
  },
  {
    name: "knitbrain_create_agent",
    description: "Generate a project-specific subagent (.claude/agents/<name>.md) with 4 guardrails: file scope, allowed-tools, optional review gate, context budget.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        description: { type: "string" },
        scope: { type: "string" },
        tools: { type: "array", items: { type: "string" } },
        reviewGate: { type: "boolean" },
        contextBudget: { type: "number" },
      },
      required: ["name"],
      additionalProperties: false,
    },
    output: "verbatim",
    run: (args) => {
      const path = writeAgent(process.cwd(), {
        name: str(args, "name"),
        ...(typeof args["description"] === "string" ? { description: args["description"] } : {}),
        ...(typeof args["scope"] === "string" ? { scope: args["scope"] } : {}),
        ...(Array.isArray(args["tools"]) ? { tools: args["tools"] as string[] } : {}),
        ...(typeof args["reviewGate"] === "boolean" ? { reviewGate: args["reviewGate"] } : {}),
        ...(typeof args["contextBudget"] === "number" ? { contextBudget: args["contextBudget"] } : {}),
      });
      return `created agent at ${path}`;
    },
  },
  {
    name: "knitbrain_team_post",
    description: "Post a finding to the shared team board (stored compressed; full original recoverable).",
    inputSchema: {
      type: "object",
      properties: { author: { type: "string" }, content: { type: "string" } },
      required: ["author", "content"],
      additionalProperties: false,
    },
    output: "verbatim",
    run: (args, ctx) => {
      const e = ctx.team.post(str(args, "author"), str(args, "content"));
      return `posted ${e.id} by ${e.author}`;
    },
  },
  {
    name: "knitbrain_team_board",
    description: "Read the shared team board — compressed skeletons of every posting (cheap to scan; fetch full with knitbrain_team_get).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    output: "data",
    run: (_args, ctx) => JSON.stringify(ctx.team.board(), null, 2),
  },
  {
    name: "knitbrain_team_get",
    description: "Fetch the full original of a board posting by id.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
    output: "verbatim",
    run: (args, ctx) => ctx.team.get(str(args, "id")) ?? `no board entry with id ${str(args, "id")}`,
  },
  {
    name: "knitbrain_team_clear",
    description: "Clear the shared team board (CCR originals are retained until tiered out).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    output: "verbatim",
    run: (_args, ctx) => {
      ctx.team.clear();
      return "board cleared";
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
  let out = raw;
  if (tool.output === "data") {
    // TOIN self-tuning: if this kind gets over-retrieved, stop compressing it.
    if (!ctx.feedback.shouldSkip(detect(raw))) {
      const r = compress(raw, ctx.ccr);
      if (r.compressed) {
        ctx.feedback.onCompress(r.contentType, r.handle);
        out = r.skeleton;
      }
    }
  }
  // Context meter: account what we emit; when the window runs hot, tell the
  // agent to save a handoff and clear — automatically, on any tool response.
  ctx.meter.onToolOutput(countTokens(out));
  const reading = ctx.meter.read();
  if (reading.status !== "ok" && tool.name !== "knitbrain_context_meter") {
    out += `\n\n[knitbrain context-meter] ${reading.advice}`;
  }
  return out;
}
