import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Knowledge } from "./knowledge.js";

/**
 * Retrieval layer — input SELECTION, the lever compression can't reach.
 * Compression shrinks what flows; retrieval stops the irrelevant 90% from
 * flowing at all: query → function-level chunks → keyword+structure ranking →
 * graph expansion → score gate ("no bad context" — an empty answer beats a
 * confidently wrong one).
 *
 * Deliberately simple (the CCE lesson: a 0.4ms formula beat model-judged
 * relevance): BM25-ish term saturation + name/signature boosts + a recency
 * nudge. No embeddings — keyword search misses some synonyms, and the graph
 * expansion (dependents/imports of a hit) recovers the related-code slice a
 * meaning-search would have found.
 * ponytail: index rebuilt per call (~130-file repos ≪ 100ms); add an mtime
 * cache if profiling ever shows it matters.
 */

export interface CodeChunk {
  file: string;
  /** Declared symbol name ("createMeter", "QuotaWindow"…). */
  name: string;
  kind: string;
  /** Full chunk text (scored against; never returned whole). */
  text: string;
  /** First line of the declaration — the token-cheap thing we DO return. */
  signature: string;
  startLine: number;
}

export interface CodeHit {
  file: string;
  name: string;
  kind: string;
  signature: string;
  startLine: number;
  score: number;
  /** Graph neighbors of the hit's file (dependents + imports) — the "everything
   * connected to it" slice, capped. */
  related: string[];
}

const DECL_RE = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(function|class|interface|type|enum|const|let)\s+([A-Za-z0-9_$]+)/;
const MAX_CHUNK_LINES = 80;
const MAX_FILE_BYTES = 400_000;

/** Split a source file into top-level declaration chunks (decl line → next
 * decl or a line cap). Regex over AST on purpose: language-agnostic-ish,
 * zero parse cost, and the graph covers what a parser would add. */
export function chunkSource(file: string, src: string): CodeChunk[] {
  const lines = src.split("\n");
  const marks: Array<{ line: number; kind: string; name: string }> = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = DECL_RE.exec(lines[i]!);
    if (m) marks.push({ line: i, kind: m[1]!, name: m[2]! });
  }
  return marks.map((mark, idx) => {
    const end = Math.min(idx + 1 < marks.length ? marks[idx + 1]!.line : lines.length, mark.line + MAX_CHUNK_LINES);
    return {
      file,
      name: mark.name,
      kind: mark.kind,
      text: lines.slice(mark.line, end).join("\n"),
      signature: lines[mark.line]!.trim(),
      startLine: mark.line + 1,
    };
  });
}

const tokenize = (s: string): string[] =>
  s
    .toLowerCase()
    .split(/[^a-z0-9_$]+/)
    .filter((t) => t.length > 1);

/** camelCase / snake_case aware: "createMeter" also indexes "create","meter". */
const subTokens = (name: string): string[] => {
  const parts = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
  return [name.toLowerCase(), ...parts];
};

export function scoreChunk(terms: string[], chunk: CodeChunk, recencyBoost: number): number {
  if (terms.length === 0) return 0;
  const nameSet = new Set(subTokens(chunk.name));
  const sigSet = new Set(tokenize(chunk.signature));
  const bodyCounts = new Map<string, number>();
  for (const t of tokenize(chunk.text)) bodyCounts.set(t, (bodyCounts.get(t) ?? 0) + 1);

  let score = 0;
  let matched = 0;
  for (const t of terms) {
    let s = 0;
    if (nameSet.has(t)) s += 3;
    if (sigSet.has(t)) s += 2;
    const tf = bodyCounts.get(t) ?? 0;
    if (tf > 0) s += tf / (tf + 1.2); // BM25-style saturation — 50 repeats ≉ 50× relevance
    if (s > 0) matched += 1;
    score += s;
  }
  if (matched === 0) return 0;
  // Coverage matters more than volume: all terms matching a little beats one
  // term matching a lot (the CCE "short query scores low" trap).
  return score * (matched / terms.length) + recencyBoost;
}

export interface SearchCodeOptions {
  k?: number;
  /** Injected for tests. */
  now?: () => number;
}

export function searchCode(
  query: string,
  deps: { knowledge: Knowledge; projectRoot: string },
  opts: SearchCodeOptions = {},
): CodeHit[] {
  const k = opts.k ?? 8;
  const terms = [...new Set(tokenize(query))];
  if (terms.length === 0) return [];
  deps.knowledge.scan(); // self-heal: never search a stale graph's file list
  const files = deps.knowledge.listFiles();
  const nowMs = (opts.now ?? Date.now)();

  const scored: Array<{ chunk: CodeChunk; score: number }> = [];
  for (const f of files) {
    const abs = join(deps.projectRoot, f);
    let src: string;
    let mtime: number;
    try {
      const st = statSync(abs);
      if (st.size > MAX_FILE_BYTES) continue;
      mtime = st.mtimeMs;
      src = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    // Recency nudge (CCE's 20%): edited this week ⇒ small, bounded boost.
    const ageDays = Math.max(0, (nowMs - mtime) / 86_400_000);
    const recencyBoost = ageDays < 7 ? 0.5 * (1 - ageDays / 7) : 0;
    for (const chunk of chunkSource(f, src)) {
      const s = scoreChunk(terms, chunk, recencyBoost);
      if (s > 0) scored.push({ chunk, score: s });
    }
  }
  if (scored.length === 0) return [];
  scored.sort((a, b) => b.score - a.score);

  // Adaptive gate: results must hold their own against the best hit — absolute
  // floors punish short queries (the trap the talk called out).
  const floor = Math.max(scored[0]!.score * 0.35, 0.75);
  const top = scored.filter((x) => x.score >= floor).slice(0, k);

  return top.map(({ chunk, score }) => {
    const related = [
      ...deps.knowledge.queryDependents(chunk.file),
      ...(deps.knowledge.queryImports(chunk.file) ?? []).map((e) => e.from),
    ].slice(0, 4);
    return {
      file: chunk.file,
      name: chunk.name,
      kind: chunk.kind,
      signature: chunk.signature,
      startLine: chunk.startLine,
      score: Math.round(score * 100) / 100,
      related,
    };
  });
}
