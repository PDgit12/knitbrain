import { existsSync, lstatSync, readFileSync } from "node:fs";
import { countTokens } from "./tokenizer.js";
import { writeAtomic } from "./atomic.js";

/**
 * `knitbrain compress <file>` — rewrite a memory file (CLAUDE.md, todos,
 * preferences) into terser prose to cut the INPUT tokens it costs every
 * session, while byte-preserving anything an agent reads literally: fenced and
 * inline code, URLs, and filesystem paths. Reversible — the verbatim original
 * is saved alongside as `<file>.original`.
 */

// Segments protected verbatim (replaced with sentinels, restored after strip).
const PROTECT: RegExp[] = [
  /```[\s\S]*?```/g, // fenced code
  /`[^`\n]+`/g, // inline code
  /\bhttps?:\/\/\S+/gi, // URLs
  /\b[\w.-]*[/\\][\w./\\-]+/g, // filesystem paths (have a / or \)
];

// Dropped from prose only (never inside protected segments).
const PLEASANTRIES =
  /\b(?:please|kindly|thank you|thanks|sure|certainly|of course|happy to|i'?d be happy(?: to)?)\b[,.]?\s*/gi;
const HEDGES =
  /\b(?:perhaps|maybe|possibly|i think|in my opinion|it seems(?: that)?|it appears(?: that)?|kind of|sort of)\b\s*/gi;
const FILLERS = /\b(?:just|really|basically|actually|simply|quite|very|essentially|literally)\b\s*/gi;
const LEADERS = /^(?:i'?ll|i will|i can|you can|we will|we can|let me|let'?s)\s+/gim;
const ARTICLES = /\b(?:a|an|the)\s+(?=[a-z])/gi;

// Sentinel = NUL char; cannot collide with real text (incl. bare numbers).
const SENT = String.fromCharCode(0);

/** Terse-rewrite prose; protected segments survive byte-for-byte. */
export function compressProse(text: string): string {
  const saved: string[] = [];
  let masked = text;
  for (const re of PROTECT) {
    masked = masked.replace(re, (m) => {
      saved.push(m);
      return `${SENT}${saved.length - 1}${SENT}`;
    });
  }
  masked = masked
    .replace(PLEASANTRIES, "")
    .replace(HEDGES, "")
    .replace(FILLERS, "")
    .replace(LEADERS, "")
    .replace(ARTICLES, "")
    .replace(/ +([.,;:!?])/g, "$1") // tidy space left before punctuation
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+$/gm, "");
  return masked.replace(new RegExp(`${SENT}(\\d+)${SENT}`, "g"), (_, i) => saved[Number(i)]!);
}

/**
 * Storage-side terse: the SAME compressProse transform, applied to brain-write
 * prose (learning summaries/lessons, skill bodies, handoffs) to cut what every
 * future recall surfaces. The brain is re-injected each session (handoff + top
 * learnings), so terse storage is a RECURRING token saving — the "caveman in
 * the brain" optimization. Reuses compressProse (no second implementation).
 * Gated:
 *   - default ON; set KNITBRAIN_TERSE_STORE=0 to store verbatim instead;
 *   - structured text with `- claim:` lines (the Project Charter) is NEVER
 *     rewritten — the lint/charter depend on those lines verbatim.
 * Safe: compressProse byte-preserves code, URLs, and filesystem paths, and
 * drops only filler/hedging/articles — technical substance always survives.
 * Output-side terse stays separate (the prompt-level TERSE_MODE in platforms.ts).
 */
export function terseStore(text: string): string {
  if (process.env["KNITBRAIN_TERSE_STORE"] === "0") return text;
  if (/^\s*[-*]\s*claim:/im.test(text)) return text;
  return compressProse(text);
}

/** CLI: compress a file in place, keeping a verbatim `.original` backup. */
export function runCompressFile(args: string[]): number {
  const force = args.includes("--force");
  const file = args.find((a) => !a.startsWith("--"));
  if (!file) {
    console.error("usage: knitbrain compress <file> [--force]");
    return 1;
  }
  if (!existsSync(file)) {
    console.error(`knitbrain compress: no such file: ${file}`);
    return 1;
  }
  if (lstatSync(file).isSymbolicLink()) {
    console.error(`knitbrain compress: ${file} is a symlink — refusing (resolve it first)`);
    return 1;
  }
  const backup = `${file}.original`;
  if (existsSync(backup) && !force) {
    console.error(`${file} already compressed (${backup} exists). Re-run with --force to redo.`);
    return 1;
  }
  const original = readFileSync(file, "utf8");
  const compressed = compressProse(original);
  const before = countTokens(original);
  const after = countTokens(compressed);

  if (!existsSync(backup) || force) writeAtomic(backup, original);
  writeAtomic(file, compressed);

  const pct = before === 0 ? 0 : Math.round((1 - after / before) * 1000) / 10;
  console.log(`compressed ${file}: ${before} -> ${after} tokens (saved ${pct}%)`);
  console.log(`  backup: ${backup}  ·  restore: mv ${backup} ${file}`);
  return 0;
}
