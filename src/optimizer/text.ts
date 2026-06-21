import type { CCRStore } from "../ccr/store.js";
import type { CompressResult } from "./types.js";
import { IMPORTANT_LINE, RESULT_LINE } from "./structured.js";
import { PARAMS } from "./params.js";

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
    let uniq = 0;
    for (const line of lines) {
      // Error lines never collapse into a ×N template: assertion failures
      // differ exactly in the bits the normalizer erases (the values).
      const key = IMPORTANT_LINE.test(line) ? `!imp${(uniq += 1)}` : normalize(line);
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
    normalized === original ? original : `${normalized}\n⟨recall:${handle}⟩`;
  return { skeleton, handle, contentType: "text" };
}

/** Sentence boundary: terminator, whitespace, then a plausible sentence opener. */
const SENTENCE_SPLIT = /(?<=[.!?:])\s+(?=[A-Z0-9⟪`"'*-])/;
/** Sentence-anchor needs at least this many sentences to be worth it.
 * The inline 64-hex handle costs ~45 tokens, so the kept set must stay small
 * for the elision to clear the never-expand guard on typical short blocks. */

const HEAD_SENTENCES = 2;
const TAIL_SENTENCES = 1;

/**
 * Short-prose sentence anchor — for prose too short for the line-based anchor
 * (under ~40 lines) but still sentence-rich: keep the opening (topic/intent)
 * and closing (conclusion) sentences, elide the middle to a counted marker.
 * Prose is information-dense, so callers gate this behind TOIN ("prose" kind):
 * if agents keep paging the originals back, it backs off automatically.
 * Returns null when there aren't enough sentences to anchor.
 *
 * MEASURED (real corpus): ~71% of short prose passes the router's never-expand
 * guard uncompressed — the ~45-token ⟨recall:hash⟩ handle exceeds what eliding a
 * few dense sentences saves. The resulting ~18% overall is the SAFE floor, not
 * a defect: pushing it would mean eliding dense prose (risking answer-fidelity)
 * or shortening the content-addressed handle (risking the lossless guarantee).
 * Deliberately not chased — prose is the lowest-value shape, guarantees first.
 */
export function compressShortProse(original: string, ccr: CCRStore): CompressResult | null {
  // Find sentence boundaries by OFFSET so head/tail keep the original bytes
  // verbatim (joining split sentences with " " used to break mid-line after
  // colons, splitting error lines across the elision boundary).
  const re = new RegExp(SENTENCE_SPLIT.source, "g");
  const bounds: Array<{ end: number; next: number }> = [];
  for (let m = re.exec(original); m !== null; m = re.exec(original)) {
    bounds.push({ end: m.index, next: m.index + m[0].length });
  }
  if (bounds.length + 1 < PARAMS.minSentences) return null;

  // Snap both boundaries to LINE breaks: a sentence boundary can land
  // mid-line (": 1"), and splitting a line across the elision turns one
  // error line into two fragments. Lines are the unit of fidelity.
  const tailBound = bounds[bounds.length - TAIL_SENTENCES]!;
  let headEnd = original.indexOf("\n", bounds[HEAD_SENTENCES - 1]!.end);
  if (headEnd === -1) headEnd = bounds[HEAD_SENTENCES - 1]!.end;
  let tailStart = original.lastIndexOf("\n", tailBound.next) + 1;
  if (tailStart <= headEnd) {
    // Single-line prose (no newline between the anchors): line snapping is
    // moot — cut at the sentence boundaries directly.
    headEnd = bounds[HEAD_SENTENCES - 1]!.end;
    tailStart = tailBound.next;
  }
  const head = original.slice(0, headEnd);
  const tail = original.slice(tailStart);
  const middle = original.slice(headEnd, tailStart);
  // Error/failure and result-summary LINES are never elided — same invariant
  // as every other handler (a skeleton that loses the error is worse than no
  // skeleton). Whole lines, so the exact original text survives.
  const rescued = middle.split("\n").filter((l) => IMPORTANT_LINE.test(l) || RESULT_LINE.test(l));
  const elided = bounds.length + 1 - HEAD_SENTENCES - TAIL_SENTENCES;
  const handle = ccr.put(original);
  const rescueBlock = rescued.length > 0 ? `\n${rescued.join("\n")}` : "";
  const skeleton = `${head}\n⟪… ${elided} sentences elided · exact original: ⟨recall:${handle}⟩ …⟫${rescueBlock}\n${tail}`;
  return { skeleton, handle, contentType: "prose" };
}
