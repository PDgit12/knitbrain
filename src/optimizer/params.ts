/**
 * Tunable compression heuristics — the knobs that were hand-tuned and are now
 * sweepable by the research harness (scripts/research.mjs) against real
 * transcripts. Defaults equal the original hand-picked constants, so behavior
 * is identical until something deliberately overrides them.
 *
 * Override at startup via env (KNITBRAIN_*), or mutate live via setParams()
 * for in-process parameter sweeps. The fidelity gates (knitbrain evals) are
 * the hard constraint on any value the harness tries — a setting that saves
 * more but breaks an answer is rejected, exactly like a crashed experiment.
 */
export interface OptimizerParams {
  /** Never-expand floor: below this saved %, pass the original through. */
  minSavingPct: number;
  /** Anchor fallback only applies to outputs at least this many lines. */
  anchorMinLines: number;
  /** If structural compression saves less than this %, try the anchor. */
  anchorTriggerPct: number;
  /** Short-prose anchor needs at least this many sentences to fire. */
  minSentences: number;
}

const envNum = (key: string, dflt: number): number => {
  const raw = process.env[key];
  if (raw === undefined) return dflt;
  const n = Number(raw);
  return Number.isFinite(n) ? n : dflt;
};

export const PARAMS: OptimizerParams = {
  minSavingPct: envNum("KNITBRAIN_MIN_SAVING_PCT", 5),
  anchorMinLines: envNum("KNITBRAIN_ANCHOR_MIN_LINES", 40),
  anchorTriggerPct: envNum("KNITBRAIN_ANCHOR_TRIGGER_PCT", 35),
  minSentences: envNum("KNITBRAIN_MIN_SENTENCES", 8),
};

/** Mutate the live params (used by the research harness between experiments). */
export function setParams(p: Partial<OptimizerParams>): void {
  Object.assign(PARAMS, p);
}
