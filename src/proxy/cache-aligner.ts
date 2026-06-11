import { sha256 } from "../ccr/store.js";

/**
 * CacheAligner — make the request's stable prefix actually stable, so the
 * provider's KV-cache hits across turns.
 *
 * Three meaning-preserving levers:
 *  1. whitespace normalization (collapse trailing whitespace + blank runs);
 *  2. dynamic-content extraction — lines like "Today's date is 2026-06-11"
 *     change every session and sit near the TOP of system prompts, breaking
 *     byte-identity for everything after them. They move to a marked section
 *     at the END of the prompt (content kept verbatim, position changes);
 *  3. Anthropic cache_control breakpoints — inserted only when the client
 *     didn't set its own (never fight the host's caching strategy).
 *
 * Compression upstream is deterministic (same text → same skeleton), so
 * optimized history prefixes stay byte-stable turn over turn.
 */
export function normalizePrefix(prefix: string): string {
  return prefix.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
}

/** Stable content hash of the normalized prefix — for cache-hit metrics. */
export function prefixHash(prefix: string): string {
  return sha256(normalizePrefix(prefix));
}

/**
 * Strong volatile-line signals only: explicit "today/current date/time"
 * phrasing, or a line that is mostly a timestamp/UUID. A date appearing
 * inside instructions ("use ISO dates like 2024-01-01") stays put unless the
 * phrasing marks it as session state.
 */
const DYNAMIC_LINE =
  /\b(today'?s? (date )?is|the current (date|time|month) is|current (date|time):|as of (today|now)[,:]|session id[:=]|generated at[:=]?)\b/i;
const MOSTLY_TIMESTAMP =
  /^\s*[\d:T Z.+-]{8,40}\s*$|^\s*[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\s*$/i;

export interface AlignResult {
  text: string;
  /** Number of volatile lines moved to the tail section. */
  moved: number;
}

const MARKER = "[session context — moved here so the prompt prefix stays cache-stable]";

/**
 * Move volatile lines out of the prefix to a marked tail section. Content is
 * preserved verbatim — only position changes — and the result is idempotent
 * (already-aligned prompts pass through unchanged).
 */
export function alignDynamicContent(text: string): AlignResult {
  if (text.includes(MARKER)) return { text, moved: 0 }; // already aligned (idempotent)

  const lines = text.split("\n");
  const stable: string[] = [];
  const movedLines: string[] = [];
  for (const line of lines) {
    if (DYNAMIC_LINE.test(line) || MOSTLY_TIMESTAMP.test(line)) movedLines.push(line);
    else stable.push(line);
  }
  if (movedLines.length === 0) return { text: normalizePrefix(text), moved: 0 };

  const aligned = `${normalizePrefix(stable.join("\n")).replace(/\n+$/, "")}\n\n${MARKER}\n${movedLines.join("\n")}`;
  return { text: aligned, moved: movedLines.length };
}
