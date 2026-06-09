import type { CCRStore } from "../ccr/store.js";
import type { CompressResult } from "./types.js";

/**
 * Prose/text handler — intentionally light. Structural compression doesn't
 * help unstructured prose much (the real prose win is the proxy's rolling
 * window later). Here we only normalize obvious waste: trailing whitespace
 * and runs of blank lines. The router's never-expand guard ensures this is
 * never a net loss.
 */
export function compressText(original: string, ccr: CCRStore): CompressResult {
  const normalized = original
    .replace(/[ \t]+\n/g, "\n") // trailing whitespace
    .replace(/\n{3,}/g, "\n\n"); // collapse blank-line runs

  const handle = ccr.put(original);
  const skeleton =
    normalized === original ? original : `${normalized}\n⟨ccr:${handle}⟩`;
  return { skeleton, handle, contentType: "text" };
}
