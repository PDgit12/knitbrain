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
  if (TRIVIAL.test(description) || (fileCount <= 1 && description.length < 60)) {
    return { tier: "trivial", phases: ["EXECUTE"], autoPlanMode: false, reason: "small, low-risk change" };
  }
  return {
    tier: "standard",
    phases: ["RESEARCH", "EXECUTE", "REVIEW", "LEARN"],
    autoPlanMode: false,
    reason: "standard multi-step change",
  };
}
