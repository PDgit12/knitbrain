import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { writeAtomic } from "../atomic.js";
import { join } from "node:path";
import type { Tier } from "./workflow.js";

/**
 * Classifier calibration — the false-positive self-healing loop.
 *
 * When the tier classifier gets it wrong, the agent records a false positive
 * (claimed tier vs what it actually was). After 3 same-direction FPs the
 * scope threshold shifts by 1 (then the counter resets, so the next shift
 * needs 3 fresh votes). Deterministic and per-project, like TOIN: a wrong
 * verdict becomes a training signal, never a permanent annoyance.
 */

export interface CalibrationState {
  /** "<claimed>-was-<actual>" → count toward the next shift. */
  fpDirections: Record<string, number>;
  /**
   * Shifts the file-count threshold for "complex". Positive = classifier was
   * over-sensitive (called things complex that weren't) → require more files.
   */
  scopeAdjust: number;
  updatedAt: string;
}

export interface Calibration {
  /** Record a wrong classification. Returns the new state (post-shift if tripped). */
  recordFalsePositive(claimed: Tier, actual: Tier): CalibrationState & { shifted: boolean };
  get(): CalibrationState;
  reset(): CalibrationState;
}

/** Same-direction FPs needed before a threshold shift. */
const ADJUSTMENT_THRESHOLD = 3;
/** scopeAdjust is clamped — calibration tunes, it must never disable the classifier. */
const MAX_ADJUST = 2;
/** Partial FP vote runs older than this age out (incomplete signal goes stale);
 *  the learned scopeAdjust persists — decaying it would un-learn calibration. */
const DECAY_DAYS = 30;

const TIERS: ReadonlySet<string> = new Set(["inquiry", "trivial", "standard", "complex"]);

const fresh = (): CalibrationState => ({
  fpDirections: {},
  scopeAdjust: 0,
  updatedAt: new Date(0).toISOString(),
});

export function createCalibration(root: string): Calibration {
  mkdirSync(root, { recursive: true });
  const path = join(root, "calibration.json");

  // Multiple processes may share this store — re-read disk before every
  // public operation (same lesson as feedback/meter: no stale reads).
  const load = (): CalibrationState => {
    if (!existsSync(path)) return fresh();
    try {
      const p = JSON.parse(readFileSync(path, "utf8")) as Partial<CalibrationState>;
      const updatedAt = typeof p.updatedAt === "string" ? p.updatedAt : new Date(0).toISOString();
      // Decay: stale incomplete vote runs age out; keep the learned scopeAdjust.
      const stale = Date.now() - Date.parse(updatedAt) > DECAY_DAYS * 86_400_000;
      return {
        fpDirections: !stale && p.fpDirections && typeof p.fpDirections === "object" ? { ...p.fpDirections } : {},
        scopeAdjust: typeof p.scopeAdjust === "number" ? p.scopeAdjust : 0,
        updatedAt,
      };
    } catch {
      return fresh();
    }
  };
  const save = (state: CalibrationState): void => {
    writeAtomic(path, JSON.stringify(state, null, 2));
  };

  const clamp = (v: number): number => Math.max(-MAX_ADJUST, Math.min(MAX_ADJUST, v));

  return {
    recordFalsePositive(claimed, actual) {
      if (!TIERS.has(claimed) || !TIERS.has(actual) || claimed === actual) {
        return { ...load(), shifted: false };
      }
      const state = load();
      const direction = `${claimed}-was-${actual}`;
      state.fpDirections[direction] = (state.fpDirections[direction] ?? 0) + 1;
      let shifted = false;
      if (state.fpDirections[direction] >= ADJUSTMENT_THRESHOLD) {
        // Over-sensitive: we said complex, it wasn't → raise the bar.
        if (claimed === "complex") state.scopeAdjust = clamp(state.scopeAdjust + 1);
        // Under-sensitive: it WAS complex and we missed it → lower the bar.
        else if (actual === "complex") state.scopeAdjust = clamp(state.scopeAdjust - 1);
        // Other directions are counted but don't shift today.
        state.fpDirections[direction] = 0; // next shift needs 3 fresh votes
        shifted = true;
      }
      state.updatedAt = new Date().toISOString();
      save(state);
      return { ...state, shifted };
    },
    get: load,
    reset() {
      const state = fresh();
      state.updatedAt = new Date().toISOString();
      save(state);
      return state;
    },
  };
}
