import type { CCRStore } from "../ccr/store.js";
import type { CompressResult } from "./types.js";

/**
 * Structured-output handlers — search results, build/test logs, unified
 * diffs. These shapes dominated the misrouted residue of the code bucket
 * (markdown reports, grep dumps, test runs tripping the loose isCode
 * heuristic), so their detectors run BEFORE isCode in the router.
 *
 * Shared invariant: failure/error lines are NEVER elided — a compressed log
 * that loses the FATAL line is worse than no compression at all.
 */

/** Lines that must survive any elision (failures live mid-output). */
export const IMPORTANT_LINE =
  /\b(FAIL(ED|URE)?|FATAL|ERROR|Error:|error(\s+TS\d+|\[E\d+\])?:|✗|✘|✖|npm ERR!|Exception|Traceback|AssertionError|fatal:|panic:|Segmentation fault|undefined reference)\b|^\s*(✗|✘|✖)/m;

/** Result-summary lines (test/build totals) — the other thing an agent always
 * needs from a run. Rescued alongside errors by every elision path. */
export const RESULT_LINE =
  /^\s*(Tests?|Test (Suites?|Files)|Suites?|Duration|Time:|Ran \d+|\d+ (passing|failing|pending|tests? (passed|failed)))\b/m;

/** Top-level declaration lines — the API surface an agent navigates by. Kept
 * by every elision path (anchor AND diff hunks) so a compressed view never
 * loses what functions/classes/types exist or changed. Shared single source. */
export const DECLARATION_LINE =
  /^(?:export\s+|pub(?:\(crate\))?\s+|public\s+|private\s+|protected\s+|static\s+|abstract\s+|final\s+|async\s+|default\s+)*(?:function|class|def|fn|func|interface|trait|impl|type|struct|enum)\s+[A-Za-z_$]/;

// ---------------------------------------------------------------------------
// Search results (grep -n / ripgrep / eslint style: path:line[:col]: content)
// ---------------------------------------------------------------------------

const SEARCH_LINE = /^(\S[^:\n]*):(\d+)(?::\d+)?[:-]/;
const MIN_SEARCH_LINES = 10;
/** Matches kept per file before the rest collapse to a count. */
const KEEP_PER_FILE = 2;

/** ≥50% of non-empty lines look like `path:line:` matches (and enough of them). */
export function isSearchResults(text: string): boolean {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length < MIN_SEARCH_LINES) return false;
  let hits = 0;
  for (const l of lines) if (SEARCH_LINE.test(l)) hits += 1;
  return hits >= lines.length * 0.5 && hits >= MIN_SEARCH_LINES;
}

/**
 * Collapse search output by file: keep the first matches per file (the
 * locations), count the rest. Agents almost always act on file+line, not on
 * the repeated match text — and the full set is one retrieve away.
 */
export function compressSearchResults(original: string, ccr: CCRStore): CompressResult {
  const lines = original.split("\n");
  const out: string[] = [];
  let currentFile = "";
  let keptInFile = 0;
  let droppedInFile = 0;
  let files = 0;
  let matches = 0;

  const flushDrops = (): void => {
    if (droppedInFile > 0) out.push(`  ⟪… +${droppedInFile} more matches in this file⟫`);
    droppedInFile = 0;
  };

  for (const line of lines) {
    const m = SEARCH_LINE.exec(line);
    if (m === null) {
      flushDrops();
      currentFile = "";
      if (line.trim().length > 0) out.push(line);
      continue;
    }
    matches += 1;
    if (m[1] !== currentFile) {
      flushDrops();
      currentFile = m[1]!;
      keptInFile = 0;
      files += 1;
    }
    if (keptInFile < KEEP_PER_FILE || IMPORTANT_LINE.test(line)) {
      out.push(line);
      keptInFile += 1;
    } else {
      droppedInFile += 1;
    }
  }
  flushDrops();

  const handle = ccr.put(original);
  out.push(`⟪${matches} matches across ${files} files · exact original: ⟨ccr:${handle}⟩⟫`);
  return { skeleton: out.join("\n"), handle, contentType: "search" };
}

// ---------------------------------------------------------------------------
// Build / test logs
// ---------------------------------------------------------------------------

const LOG_SIGNATURE =
  /^\[?\d{4}-\d{2}-\d{2}[T ]|^\d{2}:\d{2}:\d{2}|\b(INFO|DEBUG|WARN(ING)?|ERROR|TRACE)\b|^\s*(PASS|FAIL|ok|not ok)\b|^\s*[✓✔✗✘✖·❯]|\b(PASSED|FAILED|SKIPPED)\b|^={5,}|^-{5,}|^⎯{5,}|^\s*> Task |^npm (warn|notice|http|error)|^\s*at .+\(?.+:\d+:\d+\)?$|^\s*\d+\||^\s*(Test Files|Tests|Duration|Start at)\s|^\s*RUN\s+v\d|^>\s\S+@\d/;
const MIN_LOG_LINES = 20;

/** ≥30% of lines carry a log/test signature (timestamps, levels, test
 * markers, vitest/jest code frames `123|`, stack frames, run summaries). */
export function isLogOutput(text: string): boolean {
  const lines = text.split("\n");
  if (lines.length < MIN_LOG_LINES) return false;
  let hits = 0;
  for (const l of lines) if (LOG_SIGNATURE.test(l)) hits += 1;
  return hits >= lines.length * 0.3;
}

const LOG_HEAD = 5;
const LOG_TAIL = 10;
/** Runs of routine lines shorter than this stay inline. */
const MIN_RUN = 4;

/**
 * Log skeleton: keep the head (what ran), the tail (summaries land at the
 * end), and EVERY error/failure line; collapse runs of routine lines to
 * counted markers. The router still race-checks this against the generic
 * text handler and keeps whichever is smaller.
 */
export function compressLog(original: string, ccr: CCRStore): CompressResult {
  const lines = original.split("\n");
  const keep = new Array<boolean>(lines.length).fill(false);
  for (let i = 0; i < lines.length; i += 1) {
    if (i < LOG_HEAD || i >= lines.length - LOG_TAIL) keep[i] = true;
    else if (IMPORTANT_LINE.test(lines[i]!) || RESULT_LINE.test(lines[i]!)) keep[i] = true;
  }

  const out: string[] = [];
  let run: string[] = [];
  const flushRun = (): void => {
    if (run.length === 0) return;
    // Tiny gaps stay inline — the elision marker would cost more than it saves.
    if (run.length < MIN_RUN) out.push(...run);
    else out.push(`⟪… ${run.length} routine lines⟫`);
    run = [];
  };
  for (let i = 0; i < lines.length; i += 1) {
    if (keep[i]) {
      flushRun();
      out.push(lines[i]!);
    } else {
      run.push(lines[i]!);
    }
  }
  flushRun();

  const handle = ccr.put(original);
  out.push(`⟪exact original: ⟨ccr:${handle}⟩⟫`);
  return { skeleton: out.join("\n"), handle, contentType: "log" };
}

// ---------------------------------------------------------------------------
// Unified diffs
// ---------------------------------------------------------------------------

const DIFF_FILE_HEADER = /^(diff --git |index [0-9a-f]+\.\.|--- |\+\+\+ )/;
const HUNK_HEADER = /^@@ -\d+(,\d+)? \+\d+(,\d+)? @@/;

/** Unified diff: a `diff --git` header, or ---/+++ pair plus a hunk header. */
export function isDiff(text: string): boolean {
  const head = text.slice(0, 4000);
  if (/^diff --git /m.test(head)) return true;
  return /^--- /m.test(head) && /^\+\+\+ /m.test(head) && HUNK_HEADER.test(text.split("\n").find((l) => l.startsWith("@@")) ?? "");
}

/** Hunk bodies longer than this elide to a ±count marker. */
const MAX_INLINE_HUNK = 14;

/**
 * Diff skeleton: keep file headers and hunk headers (the WHERE), keep error
 * lines, elide long hunk bodies to `⟪… +a/-b/~c lines⟫` (the churn size).
 * Reviewers and agents mostly need which files/regions changed and how much;
 * the full patch is one retrieve away.
 */
export function compressDiff(original: string, ccr: CCRStore): CompressResult {
  const lines = original.split("\n");
  const out: string[] = [];
  let body: string[] = [];

  const flushBody = (): void => {
    if (body.length === 0) return;
    if (body.length <= MAX_INLINE_HUNK) {
      out.push(...body);
    } else {
      const adds = body.filter((l) => l.startsWith("+")).length;
      const dels = body.filter((l) => l.startsWith("-")).length;
      const ctx = body.length - adds - dels;
      // Rescue error lines AND top-level declarations (strip the +/-/space
      // diff marker before the decl test) — a compressed diff must never hide
      // which functions/classes/types were added or removed.
      const rescued = body.filter(
        (l) => IMPORTANT_LINE.test(l) || DECLARATION_LINE.test(l.replace(/^[+\- ]/, "")),
      );
      out.push(`⟪… hunk elided: +${adds}/-${dels} lines, ${ctx} context⟫`);
      out.push(...rescued);
    }
    body = [];
  };

  for (const line of lines) {
    if (DIFF_FILE_HEADER.test(line) || HUNK_HEADER.test(line)) {
      flushBody();
      out.push(line);
    } else {
      body.push(line);
    }
  }
  flushBody();

  const handle = ccr.put(original);
  out.push(`⟪exact diff: ⟨ccr:${handle}⟩⟫`);
  return { skeleton: out.join("\n"), handle, contentType: "diff" };
}
