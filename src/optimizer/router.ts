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

/** Anchor fallback applies to outputs at least this many lines long. */
const ANCHOR_MIN_LINES = 40;
/** If structural compression saves less than this %, try the anchor. */
const ANCHOR_TRIGGER_PCT = 35;

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/** Lines worth rescuing from an elided middle (failures live mid-output). */
const IMPORTANT_LINE = /\b(FAIL|FAILED|✗|Error:|error TS\d+|Exception|Traceback|fatal:|panic:)\b/;
const MAX_RESCUED = 12;

/**
 * Anchor elision — the universal fallback for long low-structure output
 * (build logs, test runs, prose, mixed snippets): keep the head (intro/
 * context) and tail (summaries/errors land at the end), rescue failure lines
 * from the middle, elide the rest to a counted marker. Head/tail scale with
 * length. Profiled on 69 real transcripts: these shapes are ~70% of burn.
 * Lossless via CCR; TOIN backs off any shape that gets over-retrieved.
 */
function anchorSkeleton(text: string, handle: string): string {
  const lines = text.split("\n");
  const headN = clamp(Math.round(lines.length * 0.15), 8, 25);
  const tailN = clamp(Math.round(lines.length * 0.12), 6, 18);
  const middle = lines.slice(headN, lines.length - tailN);
  const rescued = middle.filter((l) => IMPORTANT_LINE.test(l)).slice(0, MAX_RESCUED);
  const head = lines.slice(0, headN).join("\n");
  const tail = lines.slice(-tailN).join("\n");
  const rescueBlock = rescued.length > 0 ? `\n${rescued.join("\n")}` : "";
  return `${head}\n⟪… ${middle.length - rescued.length} lines elided · exact original: ⟨ccr:${handle}⟩ …⟫${rescueBlock}\n${tail}`;
}

/** Deterministic content-type detection (no ML). JSON is strict; code is heuristic. */
export function detect(text: string): ContentType {
  if (isJson(text)) return "json";
  if (isCode(text)) return "code";
  return "text";
}

/** Claude-Code Read format: lines prefixed `   123→content`. */
const LINE_NUM_RE = /^\s{0,8}\d+→/;

/**
 * Detect host-Read line numbering (the dominant in-session tool-result shape;
 * the prefixes defeat code parsing if left in). Returns the stripped content
 * when ≥60% of lines carry the prefix, else null.
 */
export function stripLineNumbers(text: string): string | null {
  const lines = text.split("\n");
  if (lines.length < 10) return null;
  let prefixed = 0;
  for (const l of lines) if (LINE_NUM_RE.test(l)) prefixed += 1;
  if (prefixed < lines.length * 0.6) return null;
  return lines.map((l) => l.replace(LINE_NUM_RE, "")).join("\n");
}

/**
 * The unified optimizer entry point: detect → route → compress → measure, and
 * pass the original through unchanged unless compression saves meaningfully.
 * Lossless either way (original is recoverable from CCR when compressed).
 */
export function compress(text: string, ccr: CCRStore): RouteResult {
  // Host-Read line numbering (`  123→…`) defeats structural parsing — strip
  // it, compress the underlying content, but store the TRUE original (with
  // numbers) in CCR and point the skeleton's handle at it. Lossless.
  const stripped = stripLineNumbers(text);
  let contentType: ContentType;
  let skeleton: string;
  let handle: string;
  if (stripped !== null) {
    contentType = detect(stripped);
    const inner =
      contentType === "json"
        ? compressJson(stripped, ccr)
        : contentType === "code"
          ? compressCode(stripped, ccr)
          : compressText(stripped, ccr);
    handle = ccr.put(text);
    skeleton = inner.skeleton.replace(/⟨ccr:[0-9a-f]{64}⟩/g, `⟨ccr:${handle}⟩`);
  } else {
    contentType = detect(text);
    const result =
      contentType === "json"
        ? compressJson(text, ccr)
        : contentType === "code"
          ? compressCode(text, ccr)
          : compressText(text, ccr);
    skeleton = result.skeleton;
    handle = result.handle;
  }

  const originalTokens = countTokens(text);
  let skeletonTokens = countTokens(skeleton);
  let savedPct =
    originalTokens === 0
      ? 0
      : Math.round((1 - skeletonTokens / originalTokens) * 1000) / 10;

  // ANCHOR FALLBACK: long output where structure didn't pay → head+tail keep.
  const lineCount = text.split("\n").length;
  if (savedPct < ANCHOR_TRIGGER_PCT && lineCount >= ANCHOR_MIN_LINES) {
    const anchorHandle = handle || ccr.put(text);
    const anchored = anchorSkeleton(text, anchorHandle);
    const anchoredTokens = countTokens(anchored);
    if (anchoredTokens < skeletonTokens) {
      skeleton = anchored;
      handle = anchorHandle;
      skeletonTokens = anchoredTokens;
      savedPct =
        originalTokens === 0
          ? 0
          : Math.round((1 - skeletonTokens / originalTokens) * 1000) / 10;
    }
  }

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

  return { skeleton, handle, contentType, compressed: true, originalTokens, skeletonTokens, savedPct };
}
