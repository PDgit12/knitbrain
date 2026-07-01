import type { CCRStore } from "../ccr/store.js";
import { learningHealth, type Memory } from "../engine/memory.js";
import type { Knowledge } from "../engine/knowledge.js";
import type { Feedback } from "../engine/feedback.js";
import type { TeamBoard } from "../engine/teams.js";
import type { Meter } from "../engine/meter.js";
import type { SkillsStore } from "../engine/skills.js";
import { classifyTask, composeWorkflow, saveWorkflow, loadWorkflow, type Tier } from "../engine/workflow.js";
import type { Calibration } from "../engine/calibration.js";
import type { ActivityLog } from "../engine/activity.js";
import { proposeAgents, writeAgent } from "../engine/agents.js";
import { scanHost, composeSkill, scanHostAll, buildHostIndex, saveHostIndex, countBySource } from "../engine/host-scan.js";
import { hostIndexPath, workflowPath, loopStatePath } from "../paths.js";
import type { WikiStore } from "../engine/wiki.js";
import { logSpine } from "../engine/wiki.js";
import { createBrain, type Brain } from "../engine/brain.js";
import { scanAndIngest, persistIntent, INTENT_QUESTIONS, computeOnboardGaps, resolveOnboardGap, detectDomains, projectHasTests } from "../engine/onboard.js";
import { terseStore } from "../compress-file.js";
import { skillHealth } from "../engine/skills.js";
import { loadHubConfig, mirrorToHub } from "../hub/client.js";
import { detectPlatforms } from "../setup.js";
import { slashCommands } from "../platforms.js";
import { existsSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { writeAtomic } from "../atomic.js";
import { runClosedLoop, defaultJudge, makeGrade, makeReview } from "../engine/closed-loop.js";
import { homedir } from "node:os";
import { resolve, isAbsolute, join, dirname } from "node:path";
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
  skills: SkillsStore;
  calibration: Calibration;
  /** Optional live activity log (dashboard CRM feed). */
  activity?: ActivityLog;
  /** Optional wiki-brain (leg 5) — compounding markdown knowledge base. */
  wiki?: WikiStore;
  /** Per-connection agent label for the activity feed. */
  agentId?: string;
}

function str(args: Record<string, unknown>, key: string): string {
  return typeof args[key] === "string" ? (args[key] as string) : "";
}

/**
 * Wiki spine (gap #1): significant capture-tool events drop ONE line into the
 * wiki log so the brain has a unified timeline alongside the typed stores. The
 * typed store stays source of truth; the shared logSpine is best-effort.
 */
function wikiLog(ctx: ToolContext, event: string, title: string): void {
  logSpine(ctx.wiki, event, title);
}

/** Cross-call state for knitbrain_run_loop: which goal, how many cycles so far. */
interface LoopState {
  goal: string;
  iter: number;
}
function loadLoopState(path: string): LoopState | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as LoopState;
  } catch {
    return null;
  }
}
function saveLoopState(path: string, s: LoopState): void {
  mkdirSync(dirname(path), { recursive: true });
  writeAtomic(path, JSON.stringify(s));
}
function clearLoopState(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    /* best-effort */
  }
}

/**
 * The brain facade (gap #8) over this connection's typed stores. Stateless and
 * cheap — built per call from ctx, so no extra construction wiring. Reads fan
 * across stores; writes route + log the spine in one call.
 */
function brainOf(ctx: ToolContext): Brain {
  return createBrain({
    memory: ctx.memory,
    knowledge: ctx.knowledge,
    ...(ctx.wiki ? { wiki: ctx.wiki } : {}),
    skills: ctx.skills,
  });
}

/**
 * Output discipline at the dispatch chokepoint:
 *  - "data"     → auto-compressed (skeleton + ⟨recall:hash⟩), original in CCR.
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

/** Strip a ⟨recall:…⟩ wrapper / prefix so a pasted handle still resolves. */
function normalizeHandle(raw: string): string {
  return raw.replace(/[⟨⟩]/g, "").replace(/^(recall|ccr):/, "").trim(); // accept legacy ccr: too
}

// ─── PROTECT layer (gap #4/#7) ──────────────────────────────────────────────
// The brain boundary is hard-gated at the ONE chokepoint (dispatch). Adherence:
// close-the-loop WRITES never enter the brain unless the session was classified
// (knitbrain_run / knitbrain_classify_task ran). Reads, loop-entry, and the
// exact-recovery tools are NEVER gated — gating them would break the loop or
// corrupt byte-exact recovery.
type Strictness = "off" | "warn" | "block";
function strictness(): Strictness {
  const v = (process.env["KNITBRAIN_STRICTNESS"] ?? "block").toLowerCase();
  return v === "off" || v === "warn" ? v : "block";
}
/** Writes that must be preceded by classification this session. */
const GATED_WRITES = new Set(["knitbrain_record_learning", "knitbrain_skill_save", "knitbrain_save_handoff"]);
/** Tools that mark the session as classified (loop-entry → opens the gate). */
const CLASSIFIERS = new Set(["knitbrain_classify_task", "knitbrain_run", "knitbrain_onboard"]);
// Per-session state keyed by the connection's ToolContext (one ctx per MCP
// connection = one session; fresh ctx per test → no cross-test leak).
const sessionState = new WeakMap<ToolContext, { classified: boolean }>();
function sessionOf(ctx: ToolContext): { classified: boolean } {
  let s = sessionState.get(ctx);
  if (!s) {
    s = { classified: false };
    sessionState.set(ctx, s);
  }
  return s;
}
interface GateDecision {
  blocked: boolean;
  message: string;
  warn: boolean;
}
/** Adherence pre-gate: decide block / warn / pass for a tool before it runs. */
function protectGate(tool: ToolDef, ctx: ToolContext): GateDecision {
  if (!GATED_WRITES.has(tool.name) || sessionOf(ctx).classified) return { blocked: false, message: "", warn: false };
  const mode = strictness();
  if (mode === "off") return { blocked: false, message: "", warn: false };
  if (mode === "block")
    return {
      blocked: true,
      message:
        "protocol_required: call knitbrain_run or knitbrain_classify_task first. Unclassified close-the-loop writes are blocked so unverified output never enters the brain (KNITBRAIN_STRICTNESS=block, the default). Set KNITBRAIN_STRICTNESS=warn or off to relax.",
      warn: false,
    };
  return { blocked: false, message: "", warn: true };
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
      "Compress a payload (JSON / code / prose) into a token-cheap skeleton. The exact original is stored locally and recoverable via knitbrain_retrieve using the returned ⟨recall:hash⟩. Returns the original unchanged if compression wouldn't help.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "The payload to optimize." } },
      required: ["text"],
      additionalProperties: false,
    },
    output: "verbatim", // already produces the optimized form itself
    run: (args, ctx) => {
      const text = typeof args["text"] === "string" ? args["text"] : "";
      const r = compress(text, ctx.ccr, { allowProse: !ctx.feedback.shouldSkip("prose") });
      if (!r.compressed) return text;
      ctx.feedback.onCompress(r.contentType, r.handle);
      ctx.meter.onSaved(r.originalTokens - r.skeletonTokens);
      return `${r.skeleton}\n\n[optimized: ${r.originalTokens}→${r.skeletonTokens} tokens, saved ${r.savedPct}% · retrieve the ⟨recall:…⟩ handle for the exact original]`;
    },
  },
  {
    name: "knitbrain_retrieve",
    description:
      "Retrieve the exact original bytes for a ⟨recall:hash⟩ handle produced by compression. Use when a skeleton isn't enough and you need the precise content.",
    inputSchema: {
      type: "object",
      properties: { handle: { type: "string", description: "The ⟨recall:hash⟩ or raw hash." } },
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
    name: "knitbrain_read",
    description:
      "Read a project file OPTIMIZED: returns a structure-preserving skeleton (signatures/schema kept, bulk elided) + a ⟨recall:hash⟩ to page in the exact original. Use INSTEAD of the host's raw read for large files — same information shape, ~70-90% fewer tokens. Works on every platform.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "File path — absolute, or relative to the working dir." } },
      required: ["path"],
      additionalProperties: false,
    },
    output: "verbatim", // already produces the optimized form itself
    run: (args, ctx) => {
      // Accept absolute paths (what hosts like Claude Code pass) or paths
      // relative to the working dir. No project-root refusal: the agent already
      // has full file read via the host's raw Read, so scoping here adds no
      // security — it only broke the "use INSTEAD of raw Read" use case.
      const requested = str(args, "path");
      const full = isAbsolute(requested) ? requested : resolve(process.cwd(), requested);
      if (!existsSync(full)) return `no such file: ${requested}`;
      const original = readFileSync(full, "utf8");
      const r = compress(original, ctx.ccr, { allowProse: !ctx.feedback.shouldSkip("prose") });
      if (!r.compressed) return original; // small/incompressible → exact content
      ctx.feedback.onCompress(r.contentType, r.handle);
      ctx.meter.onSaved(r.originalTokens - r.skeletonTokens);
      return `${r.skeleton}\n\n[knitbrain_read: ${requested} · ${r.originalTokens}→${r.skeletonTokens} tokens (saved ${r.savedPct}%) · exact original: knitbrain_retrieve ⟨recall:${r.handle}⟩]`;
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
      // Routed through the brain facade: recordLearning + spine line in one call.
      // Storage-side terse (reuses compressProse; default off → no change).
      const { id, duplicate } = brainOf(ctx).write({ kind: "learning", summary: terseStore(str(args, "summary")), lesson: terseStore(str(args, "lesson")), tags });
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
    name: "knitbrain_learning_outcome",
    description:
      "Close the loop on a recalled learning: report whether it actually HELPED on this task (a concrete outcome, not 'noted'). Useful learnings rise in future recall; ones reported wrong are discredited and sink, and a correction note folds into the lesson so the next recall carries the fix. This is what turns memory from a log into something that compounds.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        helpful: { type: "boolean", description: "Did this learning actually help on the task at hand?" },
        note: { type: "string", description: "If it was wrong: the correction (one line, folds into the lesson)." },
      },
      required: ["id", "helpful"],
      additionalProperties: false,
    },
    output: "verbatim",
    run: (args, ctx) => {
      if (typeof args["helpful"] !== "boolean") return "refused: `helpful` must be true or false.";
      const l = ctx.memory.learningOutcome(str(args, "id"), args["helpful"], typeof args["note"] === "string" ? args["note"] : undefined);
      if (!l) return `no learning found with id ${str(args, "id")}`;
      return `learning "${l.id}": helpful=${l.helpful} unhelpful=${l.unhelpful} → ${learningHealth(l)}`;
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
      wikiLog(ctx, "handoff", "session handoff");
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
      // (Knowledge self-heals lazily: the first graph query in a fresh
      // project triggers a scan automatically — no manual init step.)
      const session = ctx.memory.loadSession();
      // Leg 3: surface recent wiki-log entries so a fresh session inherits
      // what prior sessions did (cross-session context), not just the handoff.
      const wikiRecent = ctx.wiki ? ctx.wiki.recentLog(8) : [];
      // Gap D: re-surface the standing workflow every session (drift-proof) so
      // nothing needs re-explaining. Null until onboard has composed one.
      const workflow = loadWorkflow(workflowPath());
      return JSON.stringify({ ...session, wikiRecent, workflow }, null, 2);
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
    run: (args, ctx) => {
      const files = Array.isArray(args["files"]) ? (args["files"] as string[]) : [];
      const scopeAdjust = ctx.calibration.get().scopeAdjust;
      const cls = classifyTask(str(args, "description"), files, scopeAdjust);
      // The JSON alone is too passive — agents follow imperatives, not flags.
      const directive = cls.autoPlanMode
        ? "ENTER YOUR HOST'S PLAN MODE NOW — before any file edit. Present the plan, get approval, then execute the phases in order. Wrong verdict? knitbrain_record_false_positive."
        : cls.tier === "trivial" || cls.tier === "inquiry"
          ? "Execute directly — no ceremony. Wrong verdict? knitbrain_record_false_positive."
          : "Execute the phases in order (no plan-mode needed). Wrong verdict? knitbrain_record_false_positive.";
      return JSON.stringify({ ...cls, directive }, null, 2);
    },
  },
  {
    name: "knitbrain_record_false_positive",
    description:
      "The classifier got it wrong? Record it: claimed tier vs what the task actually was. After 3 same-direction reports the classifier's threshold self-adjusts (per-project, deterministic, bounded).",
    inputSchema: {
      type: "object",
      properties: {
        claimed_tier: { type: "string", enum: ["inquiry", "trivial", "standard", "complex"], description: "What the classifier said." },
        actual_tier: { type: "string", enum: ["inquiry", "trivial", "standard", "complex"], description: "What it really was." },
        reason: { type: "string", description: "One line: why the verdict was wrong." },
      },
      required: ["claimed_tier", "actual_tier"],
      additionalProperties: false,
    },
    output: "verbatim",
    run: (args, ctx) => {
      const claimed = str(args, "claimed_tier") as Tier;
      const actual = str(args, "actual_tier") as Tier;
      if (claimed === actual || claimed === ("" as Tier) || actual === ("" as Tier)) {
        return "refused: claimed_tier and actual_tier must be valid tiers and differ.";
      }
      const r = ctx.calibration.recordFalsePositive(claimed, actual);
      wikiLog(ctx, "false-positive", `${claimed}→${actual}`);
      const pending = r.fpDirections[`${claimed}-was-${actual}`] ?? 0;
      return r.shifted
        ? `recorded — threshold SHIFTED (scopeAdjust=${r.scopeAdjust}); the classifier now requires ${Math.max(2, 4 + r.scopeAdjust)} files for complex.`
        : `recorded (${pending}/3 toward a shift in direction ${claimed}-was-${actual}; scopeAdjust=${r.scopeAdjust}).`;
    },
  },
  {
    name: "knitbrain_metrics",
    description: "Compression telemetry: recall-store tier counts + per-kind retrieval rates (TOIN self-tuning).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    output: "verbatim",
    run: (_args, ctx) =>
      JSON.stringify({ ccr: ctx.ccr.stats(), feedback: ctx.feedback.stats(), calibration: ctx.calibration.get() }, null, 2),
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
    run: (args, ctx) => {
      // Style-match: generated agents mirror the user's existing .claude/agents.
      const style = scanHost(join(process.cwd(), ".claude")).style;
      const path = writeAgent(
        process.cwd(),
        {
          name: str(args, "name"),
          ...(typeof args["description"] === "string" ? { description: args["description"] } : {}),
          ...(typeof args["scope"] === "string" ? { scope: args["scope"] } : {}),
          ...(Array.isArray(args["tools"]) ? { tools: args["tools"] as string[] } : {}),
          ...(typeof args["reviewGate"] === "boolean" ? { reviewGate: args["reviewGate"] } : {}),
          ...(typeof args["contextBudget"] === "number" ? { contextBudget: args["contextBudget"] } : {}),
        },
        style,
      );
      const ev = ctx.team.post("knitbrain", `agent created: ${str(args, "name")} · scope ${typeof args["scope"] === "string" ? args["scope"] : "(whole project)"}`);
      wikiLog(ctx, "agent", str(args, "name"));
      const hubCfg = loadHubConfig();
      if (hubCfg) mirrorToHub(hubCfg, { author: "knitbrain", summary: ev.summary, original: `agent created at ${path}` });
      return `created agent at ${path}${hubCfg ? " (announced on hub)" : ""}`;
    },
  },
  {
    name: "knitbrain_run",
    description:
      "THE feedback/orchestrator tool — call FIRST when the user states a task. Classifies it (small→big), finds-or-drafts the SKILL for it, proposes guardrailed agents when multi-domain, lists host slash-commands the agent can run itself, and reports the context meter. Follow the returned directive.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "The user's task, verbatim." },
        files: { type: "array", items: { type: "string" }, description: "Files likely touched, if known." },
      },
      required: ["task"],
      additionalProperties: false,
    },
    output: "verbatim", // a directive the agent must read exactly
    run: (args, ctx) => {
      const task = str(args, "task");
      const files = Array.isArray(args["files"]) ? (args["files"] as string[]) : [];
      const cls = classifyTask(task, files, ctx.calibration.get().scopeAdjust);

      // Legs 1+2: see what the user already has, so we dedupe (never re-propose
      // an agent they already wrote) and can compose in their style.
      const host = scanHost(join(process.cwd(), ".claude"));
      const hostAgentNames = new Set(host.agents.map((a) => a.name.toLowerCase()));

      // SKILL: find-or-draft (skills made on-demand, persist, compound).
      const found = ctx.skills.find(task);
      const seed = ctx.memory.searchLearnings(task, 3).map((h) => h.summary);
      const skill = found
        ? {
            status: skillHealth(found) === "needs-revision"
              ? "found but NEEDS REVISION (it keeps failing) — fix the playbook before relying on it, then knitbrain_skill_save"
              : "found",
            name: found.name,
            uses: found.uses,
            health: skillHealth(found),
            constraints: found.constraints,
            body: found.body,
          }
        : { status: "drafted — refine while working, then knitbrain_skill_save", constraints: [] as string[], body: ctx.skills.draft(task, seed) };

      // AGENTS (puppeteer mode): on complex tasks the agent FILES are
      // written, not just proposed — same persistence model as skills.
      // Each .claude/agents/<name>.md carries guardrails + the task's
      // telegraphic skill body as its mission brief, so a cold sub-agent
      // starts optimized: scoped tools, scoped files, compressed context,
      // findings flowing back through the team board.
      const agents =
        cls.tier === "complex"
          ? proposeAgents(ctx.knowledge.listFiles())
              .filter((p) => !hostAgentNames.has(p.name.toLowerCase()))
              .slice(0, 4)
              .map((p) => {
              const file = writeAgent(process.cwd(), {
                name: p.name,
                scope: p.scope,
                tools: p.tools,
                reviewGate: p.reviewGate,
                brief:
                  `task: ${task}\n` +
                  (skill.constraints.length > 0
                    ? `CONSTRAINTS (non-negotiable):\n${skill.constraints.map((c) => `- ${c}`).join("\n")}\n`
                    : "") +
                  skill.body,
              }, host.style);
              // Agent lifecycle is team-visible: the creation event lands on
              // the board (and mirrors to the hub when joined), so individual
              // and team views see which agents exist, for what, and where.
              const ev = ctx.team.post("knitbrain", `agent created: ${p.name} · scope ${p.scope} · task: ${task}`);
              const hub = loadHubConfig();
              if (hub) mirrorToHub(hub, { author: "knitbrain", summary: ev.summary, original: `agent created: ${p.name} · scope ${p.scope} · file ${file} · task: ${task}` });
              return {
                name: p.name,
                scope: p.scope,
                tools: p.tools,
                reviewGate: p.reviewGate,
                file,
                spawn: `agent file WRITTEN — spawn via your host's sub-agent mechanism (Claude Code: Task tool with subagent_type "${p.name}"); it is pre-briefed; findings arrive on knitbrain_team_board`,
              };
            })
          : [];

      // HOST COMMANDS the agent can run itself (autonomous loop).
      const platforms = detectPlatforms({ env: process.env, exists: existsSync, home: homedir() });
      const commands = platforms.flatMap((p) => slashCommands(p));

      return JSON.stringify(
        {
          classification: cls,
          existing: {
            skills: host.skills.length,
            agents: host.agents.length,
            note: `found ${host.skills.length} existing skill(s) + ${host.agents.length} agent(s) in .claude — deduped against proposals; compose project-tailored ones with knitbrain_compose_skill`,
          },
          skill,
          agents,
          host_commands: commands,
          meter: ctx.meter.read(),
          directive:
            cls.tier === "complex"
              ? "ENTER YOUR HOST'S PLAN MODE NOW (before any file edit). Agent files are already written under .claude/agents/ — after the plan is approved, spawn them in parallel; each is pre-briefed and scope-guarded; consolidate via team board; verify; record learning + skill update."
              : "Execute with the skill. Verify before claiming done. Then close the loop: knitbrain_skill_outcome (did it WORK — concrete outcome, not 'done') + record learning if anything non-obvious surfaced.",
        },
        null,
        2,
      );
    },
  },
  {
    name: "knitbrain_compose_skill",
    description:
      "Compose a NEW project-tailored skill for a task in the USER'S OWN composition style (learned from their existing .claude/skills — length, terseness) and persist it. Use when no existing skill fits; refine the body, then knitbrain_skill_save to update.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "The task this skill is for." },
        lessons: { type: "array", items: { type: "string" }, description: "Seed lessons; if omitted, pulled from memory." },
      },
      required: ["task"],
      additionalProperties: false,
    },
    output: "verbatim",
    run: (args, ctx) => {
      const task = str(args, "task");
      const lessons = Array.isArray(args["lessons"])
        ? (args["lessons"] as string[])
        : ctx.memory.searchLearnings(task, 3).map((h) => h.summary);
      const style = scanHost(join(process.cwd(), ".claude")).style;
      const s = composeSkill(task, style, lessons, ctx.skills);
      wikiLog(ctx, "skill", s.name);
      return `composed skill "${s.name}" (${s.body.length} chars${style.terse ? ", style-matched terse" : ""}) — refine the body, then knitbrain_skill_save to update.`;
    },
  },
  {
    name: "knitbrain_skill_save",
    description: "Persist a refined skill playbook (telegraphic). Same name updates the skill — skills compound across tasks. `constraints` are non-negotiable guardrails that propagate into every agent briefed with the skill.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        body: { type: "string" },
        triggers: { type: "array", items: { type: "string" } },
        constraints: { type: "array", items: { type: "string" }, description: "Hard rules, e.g. 'never run migrations directly'." },
      },
      required: ["name", "body"],
      additionalProperties: false,
    },
    output: "verbatim",
    run: (args, ctx) => {
      const triggers = Array.isArray(args["triggers"]) ? (args["triggers"] as string[]) : [];
      const constraints = Array.isArray(args["constraints"]) ? (args["constraints"] as string[]) : [];
      const s = ctx.skills.save({ name: str(args, "name"), body: terseStore(str(args, "body")), triggers, constraints });
      wikiLog(ctx, "skill", s.name);
      return `skill "${s.name}" saved (uses=${s.uses}, wins=${s.wins}/losses=${s.losses}, constraints: ${s.constraints.length}, triggers: ${s.triggers.join(", ")})`;
    },
  },
  {
    name: "knitbrain_skill_outcome",
    description:
      "Close the loop on a skill: report whether it actually WORKED after using it (a test passing, a bug fixed — a concrete outcome, not 'task complete'). Failures with a note fold into the playbook's pitfalls; skills that keep failing get flagged needs-revision instead of being re-served.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        worked: { type: "boolean", description: "Did the skill's approach produce the intended concrete outcome?" },
        note: { type: "string", description: "If it failed: what bit (one line, becomes a pitfall)." },
      },
      required: ["name", "worked"],
      additionalProperties: false,
    },
    output: "verbatim",
    run: (args, ctx) => {
      if (typeof args["worked"] !== "boolean") return "refused: `worked` must be true or false.";
      const s = ctx.skills.outcome(str(args, "name"), args["worked"], typeof args["note"] === "string" ? args["note"] : undefined);
      if (!s) return `no skill named "${str(args, "name")}" — check knitbrain_run output for the active skill name.`;
      return `skill "${s.name}": wins=${s.wins} losses=${s.losses} → ${skillHealth(s)}`;
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
      // The SDK does not enforce inputSchema server-side — validate here, or a
      // mis-named param silently posts an empty finding.
      const content = str(args, "content");
      const author = str(args, "author");
      if (content.trim() === "" || author.trim() === "") {
        return "refused: team_post needs non-empty `author` and `content`.";
      }
      const e = ctx.team.post(author, content);
      wikiLog(ctx, "team", `${author}: ${content.slice(0, 60)}`);
      // Shared sessions: mirror to the team hub when joined — fire-and-forget,
      // a dead hub never blocks local work.
      const hub = loadHubConfig();
      if (hub) mirrorToHub(hub, { author: e.author, summary: e.summary, original: content });
      return `posted ${e.id} by ${e.author}${hub ? " (mirrored to hub)" : ""}`;
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
    description: "Clear the shared team board (recall originals are retained until tiered out).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    output: "verbatim",
    run: (_args, ctx) => {
      ctx.team.clear();
      return "board cleared";
    },
  },
  {
    name: "knitbrain_wiki_ingest",
    description:
      "Ingest a synthesized note into the compounding wiki-brain: writes/updates a terse page, rebuilds the index, appends the log, and stubs any cross-referenced page. Use to compound knowledge across the session (entities, concepts, summaries, session notes) instead of letting it vanish into chat.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        kind: { type: "string", enum: ["session", "entity", "concept", "summary"] },
        content: { type: "string", description: "Terse synthesis (not the raw source). Add `- claim: KEY = VALUE` lines for lint to track." },
        links: { type: "array", items: { type: "string" }, description: "Other page titles this references." },
      },
      required: ["title", "kind", "content"],
      additionalProperties: false,
    },
    output: "verbatim",
    run: (args, ctx) => {
      if (!ctx.wiki) return "wiki unavailable";
      const kind = str(args, "kind");
      const r = ctx.wiki.ingest({
        title: str(args, "title"),
        kind: (["session", "entity", "concept", "summary"].includes(kind) ? kind : "summary") as "session" | "entity" | "concept" | "summary",
        content: str(args, "content"),
        ...(Array.isArray(args["links"]) ? { links: args["links"] as string[] } : {}),
      });
      return `wiki: page "${r.page}" written · touched ${r.touched.join(", ")} · index + log updated`;
    },
  },
  {
    name: "knitbrain_wiki_query",
    description: "Query the wiki-brain: returns the index catalog + recent log so you can drill into the relevant pages (read them with knitbrain_read). File good answers back with knitbrain_wiki_ingest so explorations compound.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    output: "data",
    run: (_args, ctx) => {
      if (!ctx.wiki) return "wiki unavailable";
      return `${ctx.wiki.index()}\n\n## recent log\n${ctx.wiki.recentLog(10).join("\n")}`;
    },
  },
  {
    name: "knitbrain_wiki_lint",
    description: "Health-check the wiki-brain: flags claim contradictions across pages (incl. stale claims superseded over time) and orphan pages nothing links to.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    output: "verbatim",
    run: (_args, ctx) => {
      if (!ctx.wiki) return "wiki unavailable";
      const r = ctx.wiki.lint();
      return JSON.stringify(r, null, 2);
    },
  },
  {
    name: "knitbrain_verify_claim",
    description:
      "Hard claim-check (anti-hallucination): parse a stated codebase fact and check it against the knowledge graph. Supported shapes: \"<A> imports <B>\", \"<A> exports <B>\", \"<A> is a dependent of <B>\" / \"<A> depends on <B>\". Returns verified | contradicted | unparseable so a claim is settled by the graph, not by assertion.",
    inputSchema: {
      type: "object",
      properties: { claim: { type: "string", description: "e.g. 'src/mcp/server.ts imports tools.js'" } },
      required: ["claim"],
      additionalProperties: false,
    },
    output: "verbatim", // a governance check — never skeletonized
    run: (args, ctx) => JSON.stringify(verifyClaim(str(args, "claim"), ctx.knowledge), null, 2),
  },
  {
    name: "knitbrain_brain_search",
    description:
      "Unified brain recall (gap #8): fan a query across ALL typed stores — learnings (BM25), the wiki, and the knowledge graph — and return ranked hits each tagged with the store it came from. One call instead of search_learnings + wiki_query + query_* separately. Drill into a hit with the matching typed tool (knitbrain_get_learning / knitbrain_read / knitbrain_query_*).",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" }, limit: { type: "number" } },
      required: ["query"],
      additionalProperties: false,
    },
    output: "data",
    run: (args, ctx) => {
      const limit = typeof args["limit"] === "number" ? args["limit"] : 8;
      return JSON.stringify(brainOf(ctx).read(str(args, "query"), limit), null, 2);
    },
  },
  {
    name: "knitbrain_onboard",
    description:
      "The front door: onboard a project into the brain. Call with NO args first — it scans the repo + imports this project's past sessions into the wiki, then returns 5 intent questions; ask the user those IN CHAT, then call again with `answers` (array, in order) to write a Project Charter + constraints that shape the loop and re-surface every session. Run once per project after setup.",
    inputSchema: {
      type: "object",
      properties: {
        answers: { type: "array", items: { type: "string" }, description: "The 5 interview answers, in order. Omit on the first call." },
        create: { type: "array", items: { type: "string" }, description: "Gap names the user said YES to — composes a skill / writes a scoped agent for each." },
      },
      additionalProperties: false,
    },
    output: "verbatim",
    run: (args, ctx) => {
      const answers = Array.isArray(args["answers"]) ? (args["answers"] as string[]) : null;
      const create = Array.isArray(args["create"]) ? (args["create"] as string[]) : null;

      // Gap B: act on the user's YES answers — create only what they approved.
      if (create && create.length > 0) {
        const host = scanHostAll(join(process.cwd(), ".claude"), homedir());
        const gaps = computeOnboardGaps(
          detectDomains(ctx.knowledge.listFiles()),
          { skills: host.skills, agents: host.agents },
          projectHasTests(ctx.knowledge.listFiles()),
        );
        const wanted = new Set(create.map((c) => c.toLowerCase()));
        const created = gaps
          .filter((g) => wanted.has(g.name.toLowerCase()))
          .map((g) => resolveOnboardGap(g, { skills: ctx.skills, style: host.style, projectRoot: process.cwd() }));
        return JSON.stringify({ created }, null, 2);
      }

      if (answers && answers.length > 0) {
        if (!ctx.wiki) return "wiki unavailable — cannot persist the Project Charter.";
        const r = persistIntent(answers, { wiki: ctx.wiki, memory: ctx.memory, skills: ctx.skills });
        // Gap D: compose the standing workflow from charter + style + domains and
        // persist it as THE driver load_session re-surfaces every session.
        const host = scanHostAll(join(process.cwd(), ".claude"), homedir());
        const workflow = composeWorkflow({
          ...r.charter,
          domains: detectDomains(ctx.knowledge.listFiles()),
          style: { terse: host.style.terse, usesModel: host.style.usesModel, ...(host.style.model ? { model: host.style.model } : {}) },
        });
        saveWorkflow(workflow, workflowPath());
        return `Onboarding complete — Project Charter ("${r.page}") + constraints skill ("${r.skill}") + workflow written. knitbrain_load_session now surfaces your intent + workflow every session.`;
      }
      if (!ctx.wiki) return "wiki unavailable — onboard needs the wiki store.";
      const imp = scanAndIngest(process.cwd(), { knowledge: ctx.knowledge, wiki: ctx.wiki });
      // Global scan (Gap A): see the user's WHOLE toolkit — project + ~/.claude +
      // plugins — and persist a lightweight index so the brain stays aware of it.
      const host = scanHostAll(join(process.cwd(), ".claude"), homedir());
      saveHostIndex(buildHostIndex(host), hostIndexPath());
      const sk = countBySource(host.skills);
      const ag = countBySource(host.agents);
      // Gap B: judge what's MISSING and ask ONLY for the gaps (empty when covered).
      const gaps = computeOnboardGaps(
        detectDomains(ctx.knowledge.listFiles()),
        { skills: host.skills, agents: host.agents },
        projectHasTests(ctx.knowledge.listFiles()),
      );
      return JSON.stringify(
        {
          greeting:
            `Imported ${imp.sessionsIngested} past session(s), ${imp.filesScanned} file(s) scanned. ` +
            `Toolkit: ${host.skills.length} skill(s) [${sk.project} project · ${sk.global} global · ${sk.plugin} plugin], ` +
            `${host.agents.length} agent(s) [${ag.project} project · ${ag.global} global · ${ag.plugin} plugin].`,
          questions: INTENT_QUESTIONS,
          adaptiveQuestions: gaps.map((g) => g.question),
          gaps: gaps.map((g) => ({ name: g.name, kind: g.kind })),
          directive:
            gaps.length > 0
              ? "Ask the 5 questions, then the adaptiveQuestions. For each gap the user says YES to, call knitbrain_onboard again with `create: [<gap name>, ...]`. Persist intent with `answers`."
              : "Ask the user these 5 questions IN CHAT, then call knitbrain_onboard again with `answers` (an array of their 5 replies, in order) to write the Project Charter + constraints that shape this project's loop.",
        },
        null,
        2,
      );
    },
  },
  {
    name: "knitbrain_run_loop",
    description:
      "Autonomous goal loop (ONE cycle per call). Runs your verify_cmd as the REAL hard gate, tracks iteration across calls, and drives until the goal is met or max_iters. HONEST: the HOST AGENT does the actual work BETWEEN cycles — this tool does NOT edit code. Each call runs the verify gate; if not met it returns a per-cycle directive telling you to make the smallest fix and call again. Stops at grade-pass (met=true) or max_iters (met=false).",
    inputSchema: {
      type: "object",
      properties: {
        goal: { type: "string", description: "What 'done' means — an actionable brief, not a vague wish." },
        verify_cmd: { type: "string", description: "Shell command that is the hard gate — exit 0 = pass (e.g. 'npm test')." },
        rubric: { type: "array", items: { type: "string" }, description: "Advisory checklist you self-verify each cycle; the verify_cmd is the hard gate." },
        max_iters: { type: "number", description: "Cap on cycles across calls (default 6)." },
      },
      required: ["goal", "verify_cmd"],
      additionalProperties: false,
    },
    output: "verbatim",
    run: (args, ctx) => {
      const goal = str(args, "goal");
      const verifyCmd = str(args, "verify_cmd");
      const rubric = Array.isArray(args["rubric"]) ? (args["rubric"] as string[]) : [];
      const maxIters = typeof args["max_iters"] === "number" && args["max_iters"] > 0 ? Math.floor(args["max_iters"]) : 6;
      const statePath = loopStatePath();

      const prev = loadLoopState(statePath);
      const priorIters = prev && prev.goal === goal ? prev.iter : 0;
      if (priorIters >= maxIters) {
        clearLoopState(statePath);
        return JSON.stringify({ met: false, stopped: "max-iters", iters: priorIters, directive: `Loop hit max_iters=${maxIters} for "${goal}" without the verify gate passing (${verifyCmd}). Stop and reassess.` }, null, 2);
      }

      // ONE cycle: the host agent already did this cycle's work; we run the REAL
      // verify gate + review and either report met or hand back the directive.
      // SECURITY: verify_cmd is the user's own project command, run in their cwd.
      const shellRun = (cmd: string): boolean => {
        try {
          execSync(cmd, { stdio: "ignore" });
          return true;
        } catch {
          return false;
        }
      };
      const result = runClosedLoop(
        {
          judge: () => defaultJudge(goal),
          iterate: () => {
            /* host agent works BETWEEN calls, not here — no fake self-editing */
          },
          grade: makeGrade(verifyCmd, shellRun),
          review: makeReview([]), // rubric strings are advisory; verify_cmd is the hard gate
          meter: () => ctx.meter.read().usedTokens,
          onCycle: (rec) => wikiLog(ctx, "loop", `cycle goal="${goal}" met=${rec.met} · ${rec.graded.detail}`),
        },
        1,
      );

      const last = result.cycles[result.cycles.length - 1];
      if (!last) {
        return JSON.stringify({ met: false, stopped: "unclear-goal", reason: result.reason }, null, 2);
      }
      const detail = last.graded.detail;
      if (result.met) {
        clearLoopState(statePath);
        return JSON.stringify({ met: true, iters: priorIters + 1, detail, note: `Goal met — ${verifyCmd} passed.` }, null, 2);
      }
      const iters = priorIters + 1;
      if (iters >= maxIters) {
        clearLoopState(statePath);
        return JSON.stringify({ met: false, stopped: "max-iters", iters, detail }, null, 2);
      }
      saveLoopState(statePath, { goal, iter: iters });
      return JSON.stringify(
        {
          met: false,
          iter: iters,
          max_iters: maxIters,
          detail,
          rubric,
          directive: `Cycle ${iters}/${maxIters}: NOT met — ${detail}. Make the smallest fix toward "${goal}", then call knitbrain_run_loop again with the same goal. Hard gate: ${verifyCmd}.`,
        },
        null,
        2,
      );
    },
  },
];

/**
 * Parse + check a codebase claim against the import/export knowledge graph
 * (gap #5). A read query auto-heals a stale/empty index (lazy scan), so the
 * graph is current. Conservative parser: only the three unambiguous shapes —
 * anything else is `unparseable` (honest > a forced false verdict).
 */
export function verifyClaim(claim: string, knowledge: Knowledge): { verdict: "verified" | "contradicted" | "unparseable"; claim: string; detail: string } {
  const c = claim.trim();
  const mention = (s: string): string => s.trim().replace(/^[`'"]+|[`'".,]+$/g, ""); // keep dots inside filenames
  const hit = (hay: string, needle: string): boolean => {
    const n = needle.toLowerCase();
    const base = n.replace(/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/, "");
    const h = hay.toLowerCase();
    return h.includes(n) || h.includes(base);
  };

  let m = /^(.+?)\s+imports\s+(.+)$/i.exec(c);
  if (m) {
    const a = mention(m[1]!), b = mention(m[2]!);
    const edges = knowledge.queryImports(a);
    if (edges === null) return { verdict: "unparseable", claim, detail: `no graph node for "${a}" (not a scanned file)` };
    const found = edges.some((e) => hit(e.from, b) || e.names.some((n) => hit(n, b)));
    return { verdict: found ? "verified" : "contradicted", claim, detail: found ? `${a} imports ${b}` : `${a} does not import ${b} (imports: ${edges.map((e) => e.from).join(", ") || "none"})` };
  }

  m = /^(.+?)\s+exports\s+(.+)$/i.exec(c);
  if (m) {
    const a = mention(m[1]!), b = mention(m[2]!);
    const exports = knowledge.queryExports(a);
    if (exports === null) return { verdict: "unparseable", claim, detail: `no graph node for "${a}" (not a scanned file)` };
    const found = exports.some((e) => hit(e, b));
    return { verdict: found ? "verified" : "contradicted", claim, detail: found ? `${a} exports ${b}` : `${a} does not export ${b} (exports: ${exports.join(", ") || "none"})` };
  }

  // "<A> is a dependent of <B>" / "<A> depends on <B>" → A imports B (A in deps(B)).
  m = /^(.+?)\s+(?:is\s+a\s+dependent\s+of|depends\s+on)\s+(.+)$/i.exec(c);
  if (m) {
    const a = mention(m[1]!), b = mention(m[2]!);
    const deps = knowledge.queryDependents(b);
    const found = deps.some((d) => hit(d, a));
    return { verdict: found ? "verified" : "contradicted", claim, detail: found ? `${a} depends on ${b}` : `${a} is not a dependent of ${b} (dependents: ${deps.join(", ") || "none"})` };
  }

  return { verdict: "unparseable", claim, detail: "expected '<A> imports <B>', '<A> exports <B>', or '<A> depends on <B>'" };
}

/**
 * CAPTURE layer (gap #6): the ONE sink for every tool result. Compresses data
 * outputs through the optimizer (original preserved in CCR) and accounts the
 * emitted tokens on the meter. Verbatim outputs pass through uncompressed. The
 * other capture entry points (UserPromptSubmit prompt-log, PostToolUse, the
 * wiki spine) all land in the same wiki.log / CCR stores — this is the in-server
 * leg of that one path.
 */
function capture(tool: ToolDef, raw: string, ctx: ToolContext): { out: string; saved: number } {
  let out = raw;
  let saved = 0;
  if (tool.output === "data" && !ctx.feedback.shouldSkip(detect(raw))) {
    // TOIN self-tuning: if this kind gets over-retrieved, stop compressing it.
    const r = compress(raw, ctx.ccr, { allowProse: !ctx.feedback.shouldSkip("prose") });
    if (r.compressed) {
      ctx.feedback.onCompress(r.contentType, r.handle);
      saved = r.originalTokens - r.skeletonTokens;
      ctx.meter.onSaved(saved);
      out = r.skeleton;
    }
  }
  ctx.meter.onToolOutput(countTokens(out));
  return { out, saved };
}

/**
 * The ONE chokepoint. Both brain-boundary layers pass through here:
 *   PROTECT — the adherence pre-gate (close-the-loop writes need classification)
 *   CAPTURE — compress + meter + activity on every result
 * Reads, loop-entry, and the exact-recovery tools (retrieve/team_get) are never
 * gated and never get an advisory appended — their contract is byte-exact.
 */
export function dispatch(
  tool: ToolDef,
  args: Record<string, unknown>,
  ctx: ToolContext,
): string {
  // PROTECT: hard-gate the brain boundary before the tool runs.
  const gate = protectGate(tool, ctx);
  if (gate.blocked) return gate.message;

  const raw = tool.run(args, ctx);
  if (CLASSIFIERS.has(tool.name)) sessionOf(ctx).classified = true;

  // CAPTURE: compress + account.
  const { out: captured, saved } = capture(tool, raw, ctx);
  let out = captured;

  // Context meter advisory — except the exact-recovery tools, whose whole
  // contract is losslessness, and the meter tool itself.
  const reading = ctx.meter.read();
  const EXACT_OUTPUT = tool.name === "knitbrain_retrieve" || tool.name === "knitbrain_team_get";
  if (reading.status !== "ok" && tool.name !== "knitbrain_context_meter" && !EXACT_OUTPUT) {
    out += `\n\n[knitbrain context-meter] ${reading.advice}`;
  }
  if (gate.warn) {
    out += `\n\n[knitbrain] protocol nudge: classify_task/run wasn't called this session — run it so writes are classified (KNITBRAIN_STRICTNESS=warn).`;
  }

  // Live activity feed (best-effort; record() already swallows its own errors).
  ctx.activity?.record({
    agent: ctx.agentId ?? "agent",
    tool: tool.name,
    summary: raw.replace(/\s+/g, " ").trim().slice(0, 80),
    saved,
  });
  return out;
}
