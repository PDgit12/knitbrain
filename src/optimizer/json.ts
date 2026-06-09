import type { CCRStore } from "../ccr/store.js";
import type { CompressResult } from "./types.js";

/** Strings longer than this are elided to a placeholder. */
const MAX_STRING = 80;
/** Arrays longer than this keep a sample + a count, rest deferred to CCR. */
const MAX_ARRAY = 8;
/** How many leading items to keep as a sample for long arrays. */
const ARRAY_SAMPLE = 2;

/** Structural test: does this text parse as a JSON object/array? */
export function isJson(text: string): boolean {
  const t = text.trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return false;
  try {
    JSON.parse(t);
    return true;
  } catch {
    return false;
  }
}

/**
 * Produce a structure-preserving skeleton: keep keys/structure/short scalars
 * (the navigation), elide long strings and long arrays (the payload). The full
 * original is recoverable from CCR — this view is intentionally lossy.
 */
function skeletonize(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > MAX_STRING ? `⟨str:${value.length}c⟩` : value;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY) {
      const sample = value.slice(0, ARRAY_SAMPLE).map(skeletonize);
      return [...sample, `⟨…${value.length - ARRAY_SAMPLE} more items⟩`];
    }
    return value.map(skeletonize);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = skeletonize(v);
    }
    return out;
  }
  // number | boolean | null — kept verbatim (short, structural)
  return value;
}

/**
 * Compress a JSON payload: store the pristine original in CCR, return a
 * structure-preserving skeleton tagged with the recovery handle.
 */
export function compressJson(original: string, ccr: CCRStore): CompressResult {
  const parsed: unknown = JSON.parse(original);
  const skel = skeletonize(parsed);
  const handle = ccr.put(original);
  const skeleton = `${JSON.stringify(skel)} ⟨ccr:${handle}⟩`;
  return { skeleton, handle, contentType: "json" };
}
