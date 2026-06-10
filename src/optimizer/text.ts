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

  let body: string;
  if (lines.length >= MIN_LINES_FOR_DEDUP) {
    const counts = new Map<string, number>();
    const order: string[] = [];
    for (const line of lines) {
      const seen = counts.get(line);
      if (seen === undefined) {
        counts.set(line, 1);
        order.push(line);
      } else {
        counts.set(line, seen + 1);
      }
    }
    // Only restructure when repetition is substantial (≥25% duplicate lines).
    if (order.length <= lines.length * 0.75) {
      body = order
        .map((line) => {
          const n = counts.get(line)!;
          return n > 1 && line.trim().length > 0 ? `${line}  ⟪×${n}⟫` : line;
        })
        .join("\n");
      body += `\n⟪${lines.length} lines → ${order.length} unique · exact original: ccr⟫`;
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
