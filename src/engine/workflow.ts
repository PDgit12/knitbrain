import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { writeAtomic } from "../atomic.js";

export type Tier = "inquiry" | "trivial" | "standard" | "complex";

export interface Classification {
  tier: Tier;
  phases: string[];
  autoPlanMode: boolean;
  reason: string;
}

const COMPLEX = /\b(architect|architecture|refactor|migrat|redesign|rewrite|security|schema|breaking|orchestrat|protocol|concurren)/i;
const TRIVIAL = /\b(typo|rename|comment|bump|format|lint|whitespace|one[- ]?line)\b/i;
const INQUIRY = /^\s*(how|what|why|where|which|who|can|does|do|is|are|should|could|would|when)\b|[?]\s*$/i;
// Mutation verbs — presence means the task WRITES, so plan-mode/complex can apply.
const WRITE_INTENT = /\b(add|build|fix|chang|edit|refactor|implement|creat|compos|generat|delet|remov|updat|writ|renam|migrat|rewrit|replac|introduc|wire|wiring|patch|scaffold|deploy|releas|publish|revert)\b/i;
// Read verbs — a read-only task has these and NO write verb.
const READ_INTENT = /\b(read|look|explain|understand|check|show|inspect|review|summar|trace|map|explor|audit|find|search|list|describ|analy|diagnos|why|how|what|where|which)\b/i;

/**
 * Deterministic tier router (no ML). Mirrors Knit's classifier shape:
 * inquiry → just answer; trivial → execute; standard → light loop;
 * complex → plan-mode + full phases.
 *
 * `scopeAdjust` is the calibration dial from the false-positive loop: positive
 * raises the file-count bar for "complex" (classifier was over-sensitive),
 * negative lowers it. Keyword-triggered complex is exempt unless the bar was
 * raised — explicit risk words stay authoritative until users vote otherwise.
 */
export function classifyTask(description: string, files: string[] = [], scopeAdjust = 0): Classification {
  const fileCount = files.filter((f) => f.trim().length > 0).length;

  if (fileCount === 0 && INQUIRY.test(description) && !COMPLEX.test(description)) {
    return { tier: "inquiry", phases: [], autoPlanMode: false, reason: "question with no files to touch" };
  }
  // Read-only / context task: read intent with NO mutation verb never earns
  // plan-mode, whatever the keywords or file count — plan-mode gates WRITES, and
  // "explain the architecture" / "audit the security flow" write nothing.
  if (READ_INTENT.test(description) && !WRITE_INTENT.test(description)) {
    return { tier: "inquiry", phases: [], autoPlanMode: false, reason: "read-only / context task — no writes" };
  }
  const complexAt = Math.max(2, 4 + scopeAdjust);
  const keywordComplex = COMPLEX.test(description) && scopeAdjust <= 0;
  if (keywordComplex || fileCount >= complexAt) {
    const calNote = scopeAdjust !== 0 ? ` (calibrated: threshold ${complexAt} files)` : "";
    return {
      tier: "complex",
      phases: ["RESEARCH", "PLAN", "EXECUTE", "REVIEW", "LEARN"],
      autoPlanMode: true,
      reason: (keywordComplex ? "high-risk keyword detected" : `${fileCount} files in scope`) + calNote,
    };
  }
  // A trivial keyword ("bump", "rename"…) only wins on a genuinely small ask —
  // "full audit + fix build bug and bump version" is not trivial because it
  // mentions a bump. Long descriptions carry multi-part scope.
  if ((TRIVIAL.test(description) && description.length < 80) || (fileCount <= 1 && description.length < 60)) {
    return { tier: "trivial", phases: ["EXECUTE"], autoPlanMode: false, reason: "small, low-risk change" };
  }
  return {
    tier: "standard",
    phases: ["RESEARCH", "EXECUTE", "REVIEW", "LEARN"],
    autoPlanMode: false,
    reason: "standard multi-step change",
  };
}

/** One part of a multi-part task with its own tier — so the loop can PLAN the
 * complex segments and BUILD the trivial ones instead of one tier for the whole. */
export interface SegmentClassification {
  text: string;
  tier: Tier;
  autoPlanMode: boolean;
}

/** Split a task description into its parts on natural connectors: numbered
 * items, ` and `/`;`/` then `/newlines. Returns the trimmed, non-trivial parts. */
export function splitSegments(description: string): string[] {
  return description
    .split(/\s*(?:;|\n|\bthen\b|\band then\b|,\s*and\b|\band\b|^\s*\d+[.)]\s*)\s*/gim)
    .map((s) => s.trim())
    .filter((s) => s.length >= 6);
}

/**
 * Gap 7 — per-segment tiers. A single tier for "refactor auth AND fix a typo"
 * is wrong: one segment wants plan-mode, the other is trivial. Split the task
 * and classify each part so the loop mixes plan/build per segment. Returns []
 * for a single-part task (the top-level Classification already covers it).
 * Segments are classified on their TEXT intent (no per-segment file list).
 */
export function classifySegments(description: string, scopeAdjust = 0): SegmentClassification[] {
  const parts = splitSegments(description);
  if (parts.length <= 1) return [];
  return parts.map((text) => {
    const c = classifyTask(text, [], scopeAdjust);
    return { text, tier: c.tier, autoPlanMode: c.autoPlanMode };
  });
}

/** The intent + shape a per-user workflow is composed from (Gap D). */
export interface WorkflowDoc {
  project: string;
  dod: string;
  constraints: string;
  verify: string;
  goal: string;
  domains: string[];
  style: { terse: boolean; usesModel: boolean; model?: string };
  /** The user's scanned toolkit (skills + agents across project/global/plugin) —
   * baked into the standing workflow so the loop starts every session knowing
   * its arsenal instead of rediscovering it per task. */
  toolkit?: { skillCount: number; agentCount: number; agentNames: string[]; skillNames: string[] };
  /** Per-domain routing: every detected part of the project mapped to its
   * owning agent + matching skill (or marked uncovered) — the closed loop
   * follows this instead of guessing ownership per task. */
  routing?: Array<{ domain: string; agent?: string; skill?: string }>;
}

/**
 * Compose the project's driving workflow from its charter + inferred style +
 * detected domains. ONE plain-markdown format, no template engine (ponytail).
 * Deterministic — no timestamps — so load_session returns it byte-for-byte and
 * it never drifts. This is the standing directive re-surfaced every session.
 */
export function composeWorkflow(w: WorkflowDoc): string {
  const domains = w.domains.length ? w.domains.join(", ") : "(none detected)";
  const model = w.style.usesModel && w.style.model ? ` · model=${w.style.model}` : "";
  const style = `${w.style.terse ? "terse" : "standard"}${model}`;
  // Toolkit block: cap the name lists so the workflow stays a driver, not an
  // inventory dump — the full index lives in host-index.json; run() routes per task.
  const toolkit = w.toolkit
    ? [
        `TOOLKIT: ${w.toolkit.skillCount} skill(s) · ${w.toolkit.agentCount} agent(s) (full index: host-index.json · knitbrain_run routes per task)`,
        w.toolkit.agentNames.length ? `AGENTS: ${w.toolkit.agentNames.slice(0, 8).join(", ")}${w.toolkit.agentNames.length > 8 ? ", …" : ""}` : "",
        w.toolkit.skillNames.length ? `SKILLS: ${w.toolkit.skillNames.slice(0, 10).join(", ")}${w.toolkit.skillNames.length > 10 ? ", …" : ""}` : "",
      ].filter((l) => l !== "")
    : [];
  const routing = w.routing?.length
    ? [
        "ROUTING (each part of the project → its owner):",
        ...w.routing.map((r) => {
          const agent = r.agent ? `agent:${r.agent}` : "NO AGENT — create via knitbrain_onboard create:[…]";
          const skill = r.skill ? ` · skill:${r.skill}` : "";
          return `- ${r.domain} → ${agent}${skill}`;
        }),
      ]
    : [];
  return [
    `# Workflow — ${w.project}`,
    "",
    `GOAL: ${w.goal}`,
    `DONE: ${w.dod}`,
    `VERIFY: ${w.verify}`,
    `CONSTRAINTS: ${w.constraints}`,
    `DOMAINS: ${domains}`,
    `STYLE: ${style}`,
    ...toolkit,
    ...routing,
    "",
    "LOOP (every task): classify → search_code before reading (selection beats",
    "compression; knitbrain_read only the hits) → plan if complex → work in the owning domain →",
    `verify (run: ${w.verify}) → record learning → close the loop signals.`,
    "Use the TOOLKIT: prefer an existing skill/agent over composing a new one; for",
    "complex goals spawn the scoped agents and drive knitbrain_run_loop until met=true.",
    "Read-only tasks stay inquiry (no plan-mode). Never violate CONSTRAINTS without",
    "the user's explicit OK. No yes-man — claims backed by run output, facts from the brain.",
  ].join("\n");
}

/** Persist the composed workflow (the standing driver). Creates its parent dir. */
export function saveWorkflow(text: string, path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeAtomic(path, text);
}

/** Read the stored workflow, or null if none written yet. */
export function loadWorkflow(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}
