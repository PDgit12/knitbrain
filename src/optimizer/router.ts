import type { CCRStore } from "../ccr/store.js";
import type { ContentType } from "./types.js";
import { isJson, compressJson } from "./json.js";
import { isCode, compressCode } from "./code.js";
import { compressText } from "./text.js";
import { countTokens } from "../tokenizer.js";

/** Result of routing + compressing a payload, with measurement + a safety flag. */
export interface RouteResult {
  /** The payload to hand the agent: a skeleton if compressed, else the original. */
  readonly skeleton: string;
  /** CCR handle for recovery, or "" when passed through uncompressed. */
  readonly handle: string;
  /** Detected content type. */
  readonly contentType: ContentType;
  /** False = passed through unchanged (compression wasn't worth it). */
  readonly compressed: boolean;
  readonly originalTokens: number;
  readonly skeletonTokens: number;
  readonly savedPct: number;
}

/**
 * Minimum token saving (%) for compression to be kept. Below this we pass the
 * original through unchanged — the optimizer must NEVER make a payload larger.
 */
const MIN_SAVING_PCT = 5;

/** Deterministic content-type detection (no ML). JSON is strict; code is heuristic. */
export function detect(text: string): ContentType {
  if (isJson(text)) return "json";
  if (isCode(text)) return "code";
  return "text";
}

/**
 * The unified optimizer entry point: detect → route → compress → measure, and
 * pass the original through unchanged unless compression saves meaningfully.
 * Lossless either way (original is recoverable from CCR when compressed).
 */
export function compress(text: string, ccr: CCRStore): RouteResult {
  const contentType = detect(text);
  const result =
    contentType === "json"
      ? compressJson(text, ccr)
      : contentType === "code"
        ? compressCode(text, ccr)
        : compressText(text, ccr);

  const originalTokens = countTokens(text);
  const skeletonTokens = countTokens(result.skeleton);
  const savedPct =
    originalTokens === 0
      ? 0
      : Math.round((1 - skeletonTokens / originalTokens) * 1000) / 10;

  // NEVER-EXPAND GUARD: if compression isn't meaningfully smaller, pass through.
  if (savedPct < MIN_SAVING_PCT) {
    return {
      skeleton: text,
      handle: "",
      contentType,
      compressed: false,
      originalTokens,
      skeletonTokens: originalTokens,
      savedPct: 0,
    };
  }

  return {
    skeleton: result.skeleton,
    handle: result.handle,
    contentType,
    compressed: true,
    originalTokens,
    skeletonTokens,
    savedPct,
  };
}
