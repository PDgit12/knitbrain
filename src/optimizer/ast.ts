import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { CCRStore } from "../ccr/store.js";
import type { CompressResult } from "./types.js";

/**
 * AST code handler — tree-sitter (WASM) body elision.
 *
 * Upgrades the heuristic scanner with real parse trees: exact function/method
 * body ranges for TS/TSX/JS AND indentation languages (Python) the brace
 * scanner can't see. WASM init is async, so this module LAZY-LOADS in the
 * background: until `astReady()`, the router falls back to the scanner —
 * compression never blocks on parser startup, and a failed init degrades
 * gracefully forever.
 */

type TS = typeof import("@vscode/tree-sitter-wasm");
type Parser = import("@vscode/tree-sitter-wasm").Parser;
type Node = import("@vscode/tree-sitter-wasm").Node;

/** Don't elide bodies smaller than this many source characters (matches scanner). */
const MIN_BODY_CHARS = 40;

type AstState = "idle" | "loading" | "ready" | "failed";
let state: AstState = "idle";
const parsers = new Map<string, Parser>();

/** Whether the WASM parsers are loaded and usable right now (sync check). */
export function astReady(): boolean {
  return state === "ready";
}

/** Test seam: reset to cold state (parsers are kept — re-init is cheap). */
export function resetAstForTest(): void {
  if (state === "failed") state = "idle";
}

let loading: Promise<void> | null = null;

/**
 * Kick off (or await) WASM parser initialization. Idempotent; safe to call
 * fire-and-forget from sync code. On any failure the state is "failed" and
 * the scanner fallback serves all code forever — never throws.
 */
export function ensureAst(): Promise<void> {
  if (state === "ready" || state === "failed") return Promise.resolve();
  if (loading) return loading;
  state = "loading";
  loading = (async () => {
    try {
      const require = createRequire(import.meta.url);
      const pkgMain = require.resolve("@vscode/tree-sitter-wasm");
      const wasmDir = dirname(pkgMain);
      const ts = require("@vscode/tree-sitter-wasm") as TS;
      await ts.Parser.init();
      for (const lang of ["typescript", "tsx", "python"]) {
        const language = await ts.Language.load(join(wasmDir, `tree-sitter-${lang}.wasm`));
        const parser = new ts.Parser();
        parser.setLanguage(language);
        parsers.set(lang, parser);
      }
      state = "ready";
    } catch {
      state = "failed"; // degrade to the scanner, permanently and silently
    }
  })();
  return loading;
}

/** Looks like Python (indentation language the brace scanner can't handle). */
function looksPython(text: string): boolean {
  return /^\s*(def \w+.*:|async def \w+.*:|class \w+(\(.*\))?:|from \S+ import )/m.test(text);
}

/** Function-like node types whose `body` field is elidable, per grammar. */
const BODY_OWNERS = new Set([
  // TS / TSX / JS
  "function_declaration",
  "function_expression",
  "generator_function",
  "generator_function_declaration",
  "method_definition",
  "arrow_function",
  // Python
  "function_definition",
]);

/** Comments / docstrings shorter than this stay inline. */
const MIN_COMMENT_CHARS = 120;

interface Elision {
  start: number;
  end: number;
  replacement: string;
}

/**
 * Walk the tree collecting elidable ranges — function/method bodies, long
 * comment blocks, and module docstrings — skipping subtrees already elided.
 */
function collectElisions(root: Node, src: string, isPython: boolean): Elision[] {
  const out: Elision[] = [];
  const lineCount = (start: number, end: number): number => src.slice(start, end).split("\n").length;

  const commentMarker = (start: number, end: number): string => {
    const n = lineCount(start, end);
    return isPython || src.slice(start, start + 1) === "#"
      ? `# …${n}-line comment`
      : `/* …${n}-line comment */`;
  };

  const visit = (node: Node): void => {
    if (BODY_OWNERS.has(node.type)) {
      const body = node.childForFieldName("body");
      if (body !== null) {
        const brace = body.type === "statement_block";
        const isBlock = brace || body.type === "block";
        if (isBlock) {
          const start = brace ? body.startIndex + 1 : body.startIndex;
          const end = brace ? body.endIndex - 1 : body.endIndex;
          if (end - start >= MIN_BODY_CHARS) {
            const n = lineCount(start, end);
            out.push({ start, end, replacement: brace ? ` …${n} lines ` : `…${n} lines` });
            return; // don't descend into an elided body
          }
        }
      }
    }
    // Module docstrings: low-signal in a skeleton, recoverable from CCR.
    const isDocstring =
      isPython && node.type === "expression_statement" && node.namedChild(0)?.type === "string";
    if (isDocstring && node.endIndex - node.startIndex >= MIN_COMMENT_CHARS) {
      out.push({
        start: node.startIndex,
        end: node.endIndex,
        replacement: commentMarker(node.startIndex, node.endIndex),
      });
      return;
    }
    // Children: merge ADJACENT comment runs (consecutive `//` lines are
    // separate nodes individually under the threshold; together they're a
    // block worth eliding). Single long doc comments are a run of one.
    let i = 0;
    while (i < node.namedChildCount) {
      const child = node.namedChild(i)!;
      if (child.type === "comment") {
        let j = i;
        let end = child.endIndex;
        while (j + 1 < node.namedChildCount) {
          const next = node.namedChild(j + 1)!;
          if (next.type !== "comment") break;
          if (/\S/.test(src.slice(end, next.startIndex))) break; // gap has code
          j += 1;
          end = next.endIndex;
        }
        if (end - child.startIndex >= MIN_COMMENT_CHARS) {
          out.push({ start: child.startIndex, end, replacement: commentMarker(child.startIndex, end) });
        }
        i = j + 1;
        continue;
      }
      visit(child);
      i += 1;
    }
  };
  visit(root);
  return out;
}

/**
 * Compress source code via tree-sitter: keep imports, signatures, types,
 * decorators, class headers; elide function/method bodies. Returns null when
 * the parsers aren't loaded or no grammar fits — caller falls back to the
 * scanner. Lossless: pristine original in CCR.
 */
export function compressCodeAst(original: string, ccr: CCRStore): CompressResult | null {
  if (state !== "ready") {
    void ensureAst(); // warm up for the next call
    return null;
  }

  // Real transcript blocks are messy (snippets, prose-wrapped pastes), so a
  // parse-error gate rejects nearly everything. Elision only ever touches
  // well-formed function nodes — error recovery just yields fewer matches —
  // so instead: parse with every grammar and keep whichever elides the most.
  const candidates = looksPython(original)
    ? ["python", "typescript", "tsx"]
    : ["typescript", "tsx", "python"];

  let elisions: Elision[] = [];
  let elidedChars = 0;
  let isPython = false;
  for (const langName of candidates) {
    const parser = parsers.get(langName);
    if (!parser) continue;
    const tree = parser.parse(original);
    if (tree === null) continue;
    const found = collectElisions(tree.rootNode, original, langName === "python");
    const chars = found.reduce((s, e) => s + (e.end - e.start), 0);
    if (chars > elidedChars) {
      elisions = found;
      elidedChars = chars;
      isPython = langName === "python";
    }
  }
  if (elisions.length === 0) return null; // nothing to elide — let the scanner try

  const parts: string[] = [];
  let cursor = 0;
  for (const e of elisions) {
    parts.push(original.slice(cursor, e.start));
    parts.push(e.replacement);
    cursor = e.end;
  }
  parts.push(original.slice(cursor));

  const handle = ccr.put(original);
  const marker = isPython ? `# ⟨ccr:${handle}⟩` : `// ⟨ccr:${handle}⟩`;
  const skeleton = `${parts.join("")}\n${marker}`;
  return { skeleton, handle, contentType: "code" };
}
