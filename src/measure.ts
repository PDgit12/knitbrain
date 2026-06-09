import { countTokens } from "./tokenizer.js";

/** Result of measuring a single original→optimized payload pair. */
export interface Measurement {
  /** Human-readable label for the payload. */
  readonly label: string;
  /** Token count of the original (pre-optimization) text. */
  readonly originalTokens: number;
  /** Token count of the optimized (post-optimization) text. */
  readonly optimizedTokens: number;
  /** optimizedTokens / originalTokens (1 = no change, <1 = smaller). */
  readonly ratio: number;
  /** Percentage of tokens saved, rounded to 0.1%. */
  readonly savedPct: number;
}

/**
 * Measure token savings between an original and its optimized form.
 *
 * Rung 1: the harness exists and is exercised with `optimized === original`
 * (no compressor yet → 0% saved). From rung 2 the optimizer feeds real
 * skeletons here and this becomes the compression-ratio gate.
 */
export function measure(
  label: string,
  original: string,
  optimized: string,
): Measurement {
  const originalTokens = countTokens(original);
  const optimizedTokens = countTokens(optimized);
  const ratio = originalTokens === 0 ? 1 : optimizedTokens / originalTokens;
  const savedPct = Math.round((1 - ratio) * 1000) / 10;
  return { label, originalTokens, optimizedTokens, ratio, savedPct };
}

/** Aggregate token totals + overall saved% across many measurements. */
export function summarize(measurements: readonly Measurement[]): {
  totalOriginal: number;
  totalOptimized: number;
  savedPct: number;
} {
  const totalOriginal = measurements.reduce((s, m) => s + m.originalTokens, 0);
  const totalOptimized = measurements.reduce((s, m) => s + m.optimizedTokens, 0);
  const savedPct =
    totalOriginal === 0
      ? 0
      : Math.round((1 - totalOptimized / totalOriginal) * 1000) / 10;
  return { totalOriginal, totalOptimized, savedPct };
}
