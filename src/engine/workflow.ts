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
const WRITE_INTENT = /\b(add|fix|chang|edit|refactor|implement|creat|delet|remov|updat|writ|renam|migrat|rewrit|replac|introduc|wire|wiring|patch|scaffold|deploy|releas|publish|revert)\b/i;
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

/** The intent + shape a per-user workflow is composed from (Gap D). */
export interface WorkflowDoc {
  project: string;
  dod: string;
  constraints: string;
  verify: string;
  goal: string;
  domains: string[];
  style: { terse: boolean; usesModel: boolean; model?: string };
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
  return [
    `# Workflow — ${w.project}`,
    "",
    `GOAL: ${w.goal}`,
    `DONE: ${w.dod}`,
    `VERIFY: ${w.verify}`,
    `CONSTRAINTS: ${w.constraints}`,
    `DOMAINS: ${domains}`,
    `STYLE: ${style}`,
    "",
    "LOOP (every task): classify → plan if complex → work in the owning domain →",
    `verify (run: ${w.verify}) → record learning → close the loop signals.`,
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
