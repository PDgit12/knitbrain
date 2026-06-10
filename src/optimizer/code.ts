import type { CCRStore } from "../ccr/store.js";
import type { CompressResult } from "./types.js";

/** Control keywords whose `(...) {` is a control block, NOT a function body. */
const CONTROL_KEYWORDS = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "with",
]);

/** Don't elide bodies smaller than this many source characters. */
const MIN_BODY_CHARS = 40;

/** Cheap structural test: looks like source code (braces + a code keyword), or an indentation language (Python). */
export function isCode(text: string): boolean {
  if (
    /[{};]/.test(text) &&
    /\b(function|const|let|var|class|import|export|def|fn|public|private|interface|type)\b/.test(
      text,
    )
  ) {
    return true;
  }
  return /^(def \w+.*:|class \w+(\(.*\))?:|from \S+ import |import \S+$|async def \w+)/m.test(text);
}

/**
 * Replace the *contents* of strings, template literals, and comments with
 * spaces (preserving length and newlines) so brace/paren matching never trips
 * on punctuation inside them. Returns a same-length masked copy.
 */
function maskStringsAndComments(src: string): string {
  const out = src.split("");
  const n = src.length;
  let i = 0;
  type Mode = "code" | "line" | "block" | "sq" | "dq" | "tpl";
  let mode: Mode = "code";

  const blank = (idx: number): void => {
    if (src[idx] !== "\n") out[idx] = " ";
  };

  while (i < n) {
    const c = src[i]!;
    const c2 = i + 1 < n ? src[i + 1]! : "";
    if (mode === "code") {
      if (c === "/" && c2 === "/") {
        mode = "line";
        i += 2;
      } else if (c === "/" && c2 === "*") {
        out[i] = " ";
        out[i + 1] = " ";
        mode = "block";
        i += 2;
      } else if (c === "'") {
        mode = "sq";
        i += 1;
      } else if (c === '"') {
        mode = "dq";
        i += 1;
      } else if (c === "`") {
        mode = "tpl";
        i += 1;
      } else {
        i += 1;
      }
      continue;
    }
    if (mode === "line") {
      if (c === "\n") mode = "code";
      else blank(i);
      i += 1;
      continue;
    }
    if (mode === "block") {
      if (c === "*" && c2 === "/") {
        out[i] = " ";
        out[i + 1] = " ";
        mode = "code";
        i += 2;
      } else {
        blank(i);
        i += 1;
      }
      continue;
    }
    // string / template
    const quote = mode === "sq" ? "'" : mode === "dq" ? '"' : "`";
    if (c === "\\") {
      blank(i);
      if (i + 1 < n) blank(i + 1);
      i += 2;
      continue;
    }
    if (c === quote) {
      mode = "code";
      i += 1;
      continue;
    }
    blank(i);
    i += 1;
  }
  return out.join("");
}

/** Last non-whitespace index at or before `from` in `s`, else -1. */
function prevNonWs(s: string, from: number): number {
  let i = from;
  while (i >= 0 && /\s/.test(s[i]!)) i -= 1;
  return i;
}

/** Match the `(` that pairs with the `)` at `closeParen` (masked input). */
function matchOpenParen(masked: string, closeParen: number): number {
  let depth = 0;
  for (let i = closeParen; i >= 0; i -= 1) {
    const c = masked[i]!;
    if (c === ")") depth += 1;
    else if (c === "(") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** The identifier token ending just before index `before` (skipping ws). */
function tokenBefore(masked: string, before: number): string {
  const end = prevNonWs(masked, before - 1);
  if (end < 0) return "";
  let start = end;
  while (start >= 0 && /[A-Za-z0-9_$]/.test(masked[start]!)) start -= 1;
  return masked.slice(start + 1, end + 1);
}

/** Characters allowed in a return-type annotation between `)` and `{`. */
const RETURN_TYPE_CHARS = /[A-Za-z0-9_$<>,.[\]|:?&]/;

/**
 * Is the `{` at `brace` (masked) the start of a function/method body?
 *
 * Handles: arrow bodies (`=> {`), bare `(...) {`, and TS return-typed
 * signatures (`(...): Promise<string> {`) by skipping the return-type
 * expression back to its `)`. Control blocks (`if/for/while (...) {`) and
 * object/class bodies are deliberately NOT treated as function bodies.
 */
function isFunctionBody(masked: string, brace: number): boolean {
  const p = prevNonWs(masked, brace - 1);
  if (p < 0) return false;

  // Arrow function: `=> {`
  if (masked[p] === ">" && p >= 1 && masked[p - 1] === "=") return true;

  // Skip a possible return-type expression backwards to find the `)`.
  let j = p;
  while (j >= 0 && RETURN_TYPE_CHARS.test(masked[j]!)) {
    j = prevNonWs(masked, j - 1);
  }
  if (j < 0 || masked[j] !== ")") return false;

  const open = matchOpenParen(masked, j);
  if (open < 0) return false;
  const tok = tokenBefore(masked, open);
  if (tok === "") return true; // anonymous `function (...) {`
  return !CONTROL_KEYWORDS.has(tok);
}

/** Match the `}` that pairs with the `{` at `open` (masked input). */
function matchCloseBrace(masked: string, open: number): number {
  let depth = 0;
  for (let i = open; i < masked.length; i += 1) {
    const c = masked[i]!;
    if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Compress source code: keep imports, signatures, types, decorators, class
 * headers; elide function/method bodies to `{ …N lines }`. The pristine
 * original is stored in CCR and recoverable byte-for-byte.
 */
export function compressCode(original: string, ccr: CCRStore): CompressResult {
  const masked = maskStringsAndComments(original);

  // Find non-nested function-body brace ranges, left to right.
  const ranges: Array<{ open: number; close: number }> = [];
  let scanFrom = 0;
  for (let i = 0; i < masked.length; i += 1) {
    if (i < scanFrom) continue;
    if (masked[i] !== "{") continue;
    if (!isFunctionBody(masked, i)) continue;
    const close = matchCloseBrace(masked, i);
    if (close < 0) continue;
    ranges.push({ open: i, close });
    scanFrom = close + 1; // skip anything nested inside this body
  }

  let skeleton: string;
  if (ranges.length === 0) {
    skeleton = original;
  } else {
    const parts: string[] = [];
    let cursor = 0;
    for (const { open, close } of ranges) {
      const inner = original.slice(open + 1, close);
      if (inner.length < MIN_BODY_CHARS) continue; // keep tiny bodies inline
      parts.push(original.slice(cursor, open + 1));
      const lines = inner.split("\n").length;
      parts.push(` …${lines} lines `);
      cursor = close;
    }
    parts.push(original.slice(cursor));
    skeleton = parts.join("");
  }

  const handle = ccr.put(original);
  // Handle emitted once (token-cheap) — bodies reference the same original.
  skeleton = `${skeleton}\n// ⟨ccr:${handle}⟩`;
  return { skeleton, handle, contentType: "code" };
}
