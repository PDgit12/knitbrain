import type { CCRStore } from "../ccr/store.js";
import type { CompressResult } from "./types.js";

/** Strings longer than this are elided to a placeholder. */
const MAX_STRING = 64;
/** Arrays longer than this keep a sample + a count, rest deferred to CCR. */
const MAX_ARRAY = 6;
/** How many leading items to keep as a sample for long arrays. */
const ARRAY_SAMPLE = 1;
/** Objects (maps) with more entries than this keep a sample of keys + a count. */
const MAX_OBJECT_KEYS = 24;
/** How many leading entries to keep as a sample for large objects. */
const OBJECT_SAMPLE = 6;

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
    const entries = Object.entries(value);
    const out: Record<string, unknown> = {};
    if (entries.length > MAX_OBJECT_KEYS) {
      // Large map (e.g. a dependency tree): keep the shape via a key sample.
      for (const [k, v] of entries.slice(0, OBJECT_SAMPLE)) out[k] = skeletonize(v);
      out[`⟨…${entries.length - OBJECT_SAMPLE} more keys⟩`] = null;
      return out;
    }
    for (const [k, v] of entries) out[k] = skeletonize(v);
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(original);
  } catch {
    // Callers should pre-check isJson, but the optimizer must NEVER throw on
    // bad input — degrade to pass-through (never-expand guard handles the rest).
    return { skeleton: original, handle: "", contentType: "json" };
  }
  const skel = skeletonize(parsed);
  const handle = ccr.put(original);
  const skeleton = `${JSON.stringify(skel)} ⟨recall:${handle}⟩`;
  return { skeleton, handle, contentType: "json" };
}
