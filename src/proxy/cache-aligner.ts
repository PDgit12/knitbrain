import { sha256 } from "../ccr/store.js";

/**
 * CacheAligner — stabilize the request's stable prefix (the system prompt) so
 * the provider's KV-cache hits across turns. We only do meaning-preserving
 * whitespace normalization (collapse trailing whitespace + blank-line runs);
 * the instruction text itself is never altered.
 */
export function normalizePrefix(prefix: string): string {
  return prefix.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
}

/** Stable content hash of the normalized prefix — for cache-hit metrics. */
export function prefixHash(prefix: string): string {
  return sha256(normalizePrefix(prefix));
}
