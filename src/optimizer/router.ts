import type { CCRStore } from "../ccr/store.js";
import type { ContentType } from "./types.js";
import { PARAMS } from "./params.js";
import { isJson, compressJson } from "./json.js";
import { isCode, compressCode } from "./code.js";
import { compressCodeAst } from "./ast.js";
import { compressText, compressShortProse } from "./text.js";
import {
  isDiff,
  isSearchResults,
  isLogOutput,
  compressDiff,
  compressSearchResults,
  compressLog,
  IMPORTANT_LINE,
  RESULT_LINE,
  DECLARATION_LINE,
} from "./structured.js";
import type { CompressResult } from "./types.js";
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


const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/** Max failure lines rescued from an elided middle (shared IMPORTANT_LINE).
 * Error lines are the highest-value content in any output — the cap exists
 * only to bound pathological blocks, not to trim ordinary failures. */
const MAX_RESCUED = 32;


/**
 * Anchor elision — the universal fallback for long low-structure output
 * (build logs, test runs, prose, mixed snippets): keep the head (intro/
 * context) and tail (summaries/errors land at the end), rescue failure lines
 * from the middle, elide the rest to a counted marker. Head/tail scale with
 * length. Profiled on 69 real transcripts: these shapes are ~70% of burn.
 * Lossless via CCR; TOIN backs off any shape that gets over-retrieved.
 */
function anchorSkeleton(text: string, handle: string, isCodeShape: boolean): string {
  const lines = text.split("\n");
  const headN = clamp(Math.round(lines.length * 0.15), 8, 25);
  const tailN = clamp(Math.round(lines.length * 0.12), 6, 18);
  const middle = lines.slice(headN, lines.length - tailN);
  // Top-level declarations are the API surface an agent navigates by and are
  // bounded by file structure, so rescue them UNCAPPED. The MAX_RESCUED cap
  // only bounds error/summary spam (which can be unbounded in a noisy log),
  // and declarations must not compete with it for slots. Original order kept.
  let importantBudget = MAX_RESCUED;
  const rescued = middle.filter((l) => {
    if (isCodeShape && DECLARATION_LINE.test(l)) return true;
    if ((IMPORTANT_LINE.test(l) || RESULT_LINE.test(l)) && importantBudget > 0) {
      importantBudget -= 1;
      return true;
    }
    return false;
  });
  const head = lines.slice(0, headN).join("\n");
  const tail = lines.slice(-tailN).join("\n");
  const rescueBlock = rescued.length > 0 ? `\n${rescued.join("\n")}` : "";
  return `${head}\n⟪… ${middle.length - rescued.length} lines elided · exact original: ⟨recall:${handle}⟩ …⟫${rescueBlock}\n${tail}`;
}

/**
 * Re-surface any top-level declaration that body-elision dropped from a code
 * skeleton. Concatenated multi-file dumps can let one function body's brace
 * range over-run and swallow later signatures (AST, heuristic, and anchor
 * paths all hit this) — the API surface an agent navigates by must never
 * vanish from the skeleton. Lossless either way; this just keeps it inline.
 */
function rescueDecls(original: string, skeleton: string): string {
  const missing: string[] = [];
  for (const line of original.split("\n")) {
    const m = DECLARATION_LINE.exec(line);
    if (m && !skeleton.includes(m[1]!)) missing.push(line.trim());
  }
  return missing.length > 0 ? `${skeleton}\n⟪decls: ${missing.join(" · ")}⟫` : skeleton;
}

/** Deterministic content-type detection (no ML). JSON is strict; the
 * structured shapes (diff/search/log) outrank the looser code heuristic —
 * grep dumps and test logs used to trip isCode and compress poorly. */
export function detect(text: string): ContentType {
  if (isJson(text)) return "json";
  if (isDiff(text)) return "diff";
  if (isSearchResults(text)) return "search";
  if (isLogOutput(text)) return "log";
  if (isCode(text)) return "code";
  return "text";
}

/** Claude-Code Read format: lines prefixed `   123→content`. */
/** Host-Read line numbering: the `123→` arrow form AND the `123⇥` tab form
 * (cat -n / some Read tools). Both prefixes defeat code parsing and bury
 * declarations if left in — strip either. */
const LINE_NUM_RE = /^\s{0,8}\d+(?:→|\t)/;

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
export interface CompressOptions {
  /**
   * Whether short-prose sentence anchoring may apply. Callers with a TOIN
   * feedback store pass `!feedback.shouldSkip("prose")` so over-retrieval
   * backs the lever off; defaults to true for gate-less contexts (lossless
   * either way).
   */
  allowProse?: boolean;
}

export function compress(text: string, ccr: CCRStore, options: CompressOptions = {}): RouteResult {
  // Host-Read line numbering (`  123→…`) defeats structural parsing — strip
  // it, compress the underlying content, but store the TRUE original (with
  // numbers) in CCR and point the skeleton's handle at it. Lossless.
  const stripped = stripLineNumbers(text);
  // Code routes through the tree-sitter AST handler when its WASM parsers are
  // warm (lazy background init), else the heuristic brace scanner.
  const allowProse = options.allowProse ?? true;
  const byType = (t: string, type: ContentType): CompressResult => {
    if (type === "json") return compressJson(t, ccr);
    if (type === "diff") return compressDiff(t, ccr);
    if (type === "search") return compressSearchResults(t, ccr);
    if (type === "log") {
      // Race the log skeleton against generic text (line-dedup wins on highly
      // repetitive logs); keep whichever is smaller. Both are CCR-lossless.
      const log = compressLog(t, ccr);
      const text = compressText(t, ccr);
      return text.skeleton.length < log.skeleton.length ? text : log;
    }
    if (type === "code") return compressCodeAst(t, ccr) ?? compressCode(t, ccr);
    // Short prose (too few lines for the anchor fallback): try the TOIN-gated
    // sentence anchor; longer or sentence-poor text takes the line handler.
    if (allowProse && t.split("\n").length < PARAMS.anchorMinLines) {
      const prose = compressShortProse(t, ccr);
      if (prose !== null) return prose;
    }
    return compressText(t, ccr);
  };

  let contentType: ContentType;
  let skeleton: string;
  let handle: string;
  if (stripped !== null) {
    const inner = byType(stripped, detect(stripped));
    contentType = inner.contentType; // handler may refine (e.g., text → prose)
    handle = ccr.put(text);
    skeleton = inner.skeleton.replace(/⟨recall:[0-9a-f]{64}⟩/g, `⟨recall:${handle}⟩`);
  } else {
    const result = byType(text, detect(text));
    contentType = result.contentType;
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
  if (savedPct < PARAMS.anchorTriggerPct && lineCount >= PARAMS.anchorMinLines) {
    const anchorHandle = handle || ccr.put(text);
    const anchored = anchorSkeleton(text, anchorHandle, contentType === "code");
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

  // DECLARATION RESCUE: re-append any top-level signature elision dropped
  // (code only — that's where declarations live; diffs self-rescue).
  if (contentType === "code") {
    const rescued = rescueDecls(text, skeleton);
    if (rescued !== skeleton) {
      skeleton = rescued;
      skeletonTokens = countTokens(skeleton);
      savedPct =
        originalTokens === 0 ? 0 : Math.round((1 - skeletonTokens / originalTokens) * 1000) / 10;
    }
  }

  // NEVER-EXPAND GUARD: if compression isn't meaningfully smaller, pass through.
  if (savedPct < PARAMS.minSavingPct) {
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
