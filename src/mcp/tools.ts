import type { CCRStore } from "../ccr/store.js";
import { learningHealth, type Memory } from "../engine/memory.js";
import type { Knowledge } from "../engine/knowledge.js";
import type { Feedback } from "../engine/feedback.js";
import type { TeamBoard } from "../engine/teams.js";
import type { Meter } from "../engine/meter.js";
import type { SkillsStore } from "../engine/skills.js";
import { classifyTask, type Tier } from "../engine/workflow.js";
import type { Calibration } from "../engine/calibration.js";
import type { ActivityLog } from "../engine/activity.js";
import { proposeAgents, writeAgent } from "../engine/agents.js";
import { scanHost, composeSkill } from "../engine/host-scan.js";
import { skillHealth } from "../engine/skills.js";
import { loadHubConfig, mirrorToHub } from "../hub/client.js";
import { detectPlatforms } from "../setup.js";
import { slashCommands } from "../platforms.js";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, isAbsolute, join } from "node:path";
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
  /** Per-connection agent label for the activity feed. */
  agentId?: string;
}

function str(args: Record<string, unknown>, key: string): string {
  return typeof args[key] === "string" ? (args[key] as string) : "";
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
      const path = writeAgent(process.cwd(), {
        name: str(args, "name"),
        ...(typeof args["description"] === "string" ? { description: args["description"] } : {}),
        ...(typeof args["scope"] === "string" ? { scope: args["scope"] } : {}),
        ...(Array.isArray(args["tools"]) ? { tools: args["tools"] as string[] } : {}),
        ...(typeof args["reviewGate"] === "boolean" ? { reviewGate: args["reviewGate"] } : {}),
        ...(typeof args["contextBudget"] === "number" ? { contextBudget: args["contextBudget"] } : {}),
      });
      const ev = ctx.team.post("knitbrain", `agent created: ${str(args, "name")} · scope ${typeof args["scope"] === "string" ? args["scope"] : "(whole project)"}`);
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
              });
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
      const s = ctx.skills.save({ name: str(args, "name"), body: str(args, "body"), triggers, constraints });
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
  let savedThisCall = 0;
  if (tool.output === "data") {
    // TOIN self-tuning: if this kind gets over-retrieved, stop compressing it.
    if (!ctx.feedback.shouldSkip(detect(raw))) {
      const r = compress(raw, ctx.ccr, { allowProse: !ctx.feedback.shouldSkip("prose") });
      if (r.compressed) {
        ctx.feedback.onCompress(r.contentType, r.handle);
        savedThisCall = r.originalTokens - r.skeletonTokens;
        ctx.meter.onSaved(savedThisCall);
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
  // Live activity feed (best-effort; record() already swallows its own errors).
  ctx.activity?.record({
    agent: ctx.agentId ?? "agent",
    tool: tool.name,
    summary: raw.replace(/\s+/g, " ").trim().slice(0, 80),
    saved: savedThisCall,
  });
  return out;
}
