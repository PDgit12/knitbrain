import type { CCRStore } from "../ccr/store.js";
import type { CompressResult } from "./types.js";

/** Below this many lines, line-dedup isn't worth attempting. */
const MIN_LINES_FOR_DEDUP = 20;

/**
 * Text/log handler. Two passes:
 *  1. line dedup — logs and command output repeat heavily; identical lines
 *     collapse to one occurrence with a ×N count (order of first appearance
 *     kept, so the narrative still reads).
 *  2. whitespace normalize — trailing spaces + blank-line runs.
 * The router's never-expand guard ensures this is never a net loss, and the
 * pristine original is always in CCR.
 */
export function compressText(original: string, ccr: CCRStore): CompressResult {
  const handle = ccr.put(original);
  const lines = original.split("\n");

  // Near-duplicate grouping: logs repeat the same TEMPLATE with volatile
  // bits (timestamps, counters, ids, hashes). Normalize those away for
  // grouping; the kept representative is the first real occurrence.
  const normalize = (l: string): string =>
    l
      .replace(/\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?/g, "⟪ts⟫")
      .replace(/\b[0-9a-f]{7,64}\b/g, "⟪hex⟫")
      .replace(/\d+/g, "⟪n⟫");

  let body: string;
  if (lines.length >= MIN_LINES_FOR_DEDUP) {
    const counts = new Map<string, number>();
    const firstSeen = new Map<string, string>();
    const order: string[] = [];
    for (const line of lines) {
      const key = normalize(line);
      const seen = counts.get(key);
      if (seen === undefined) {
        counts.set(key, 1);
        firstSeen.set(key, line);
        order.push(key);
      } else {
        counts.set(key, seen + 1);
      }
    }
    // Only restructure when repetition is substantial (≥25% duplicate templates).
    if (order.length <= lines.length * 0.75) {
      body = order
        .map((key) => {
          const n = counts.get(key)!;
          const line = firstSeen.get(key)!;
          return n > 1 && line.trim().length > 0 ? `${line}  ⟪×${n} similar⟫` : line;
        })
        .join("\n");
      body += `\n⟪${lines.length} lines → ${order.length} unique templates · exact original: ccr⟫`;
    } else {
      body = original;
    }
  } else {
    body = original;
  }

  const normalized = body.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
  const skeleton =
    normalized === original ? original : `${normalized}\n⟨ccr:${handle}⟩`;
  return { skeleton, handle, contentType: "text" };
}

/** Sentence boundary: terminator, whitespace, then a plausible sentence opener. */
const SENTENCE_SPLIT = /(?<=[.!?:])\s+(?=[A-Z0-9⟪`"'*-])/;
/** Sentence-anchor needs at least this many sentences to be worth it.
 * The inline 64-hex handle costs ~45 tokens, so the kept set must stay small
 * for the elision to clear the never-expand guard on typical short blocks. */
const MIN_SENTENCES = 8;
const HEAD_SENTENCES = 2;
const TAIL_SENTENCES = 1;

/**
 * Short-prose sentence anchor — for prose too short for the line-based anchor
 * (under ~40 lines) but still sentence-rich: keep the opening (topic/intent)
 * and closing (conclusion) sentences, elide the middle to a counted marker.
 * Prose is information-dense, so callers gate this behind TOIN ("prose" kind):
 * if agents keep paging the originals back, it backs off automatically.
 * Returns null when there aren't enough sentences to anchor.
 */
export function compressShortProse(original: string, ccr: CCRStore): CompressResult | null {
  const sentences = original.split(SENTENCE_SPLIT);
  if (sentences.length < MIN_SENTENCES) return null;
  const head = sentences.slice(0, HEAD_SENTENCES).join(" ");
  const tail = sentences.slice(-TAIL_SENTENCES).join(" ");
  const elided = sentences.length - HEAD_SENTENCES - TAIL_SENTENCES;
  const handle = ccr.put(original);
  const skeleton = `${head}\n⟪… ${elided} sentences elided · exact original: ⟨ccr:${handle}⟩ …⟫\n${tail}`;
  return { skeleton, handle, contentType: "prose" };
}
