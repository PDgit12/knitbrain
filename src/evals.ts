import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createReadStream, readdirSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { createFileCCRStore } from "./ccr/store.js";
import { ensureAst, astReady } from "./optimizer/ast.js";
import { compress, stripLineNumbers } from "./optimizer/router.js";
import { IMPORTANT_LINE } from "./optimizer/structured.js";

/**
 * `knitbrain evals` — answer-preservation, measured, reproducible.
 *
 * The savings number (knitbrain profile) answers "how many tokens?"; this
 * suite answers "same answers?". On REAL transcript blocks it checks that
 * the facts agents actually act on survive compression — with deterministic
 * judging (string containment), not an LLM judge:
 *
 *   error-fidelity      every error/failure line in a compressed log/text
 *                       block still appears verbatim in the skeleton
 *   identifier-fidelity declared names (function/class/def) in compressed
 *                       code blocks still appear in the skeleton
 *   summary-fidelity    numeric result lines ("3 failed | 12 passed")
 *                       still appear in the skeleton
 *   round-trip          every skeleton's ⟨recall:hash⟩ recovers the original
 *                       byte-for-byte
 *   never-expand        no compressed block has more tokens than it started
 *
 * Targets are gates, not aspirations: error-fidelity and round-trip must be
 * 100%, identifier-fidelity ≥99%, summary-fidelity ≥95%.
 */

export interface EvalReport {
  blocks: number;
  errorLines: { total: number; preserved: number };
  identifiers: { total: number; preserved: number };
  summaryLines: { total: number; preserved: number };
  roundTrip: { total: number; ok: number };
  neverExpand: { total: number; ok: number };
  pass: boolean;
}

/** Result-summary lines: test/build totals as emitted by runners — not any
 * sentence that happens to contain a number. Summaries live at the END of
 * output, so only the last SUMMARY_WINDOW lines of a block are eligible. */
const SUMMARY_LINE =
  /^\s*(Tests?|Test (Suites?|Files)|Suites?|Duration|Time:|Ran \d+|\d+ (passing|failing|pending|tests? (passed|failed)))\b/;
const SUMMARY_WINDOW = 20;

/** TOP-LEVEL declarations (column 0, modifiers allowed). Names nested inside
 * function bodies are elided BY DESIGN (that's what body elision is); the
 * promise is that the names an agent navigates by — the API surface — survive.
 * Kept INDEPENDENT from the optimizer's DECLARATION_LINE on purpose: a test that
 * imports the impl's own regex can't catch the impl drifting from intent. */
const DECLARATION =
  /^(?:export\s+|pub(?:\(crate\))?\s+|public\s+|private\s+|protected\s+|static\s+|abstract\s+|final\s+|async\s+|default\s+)*(?:function|class|def|fn|func|interface|trait|impl|struct|enum)\s+([A-Za-z_$][\w$]*)/gm;

function collectTranscripts(roots: string[]): string[] {
  const files: string[] = [];
  for (const r of roots) {
    let st;
    try {
      st = statSync(r);
    } catch {
      continue;
    }
    if (st.isFile()) {
      files.push(r);
      continue;
    }
    for (const proj of readdirSync(r)) {
      const pd = join(r, proj);
      try {
        if (!statSync(pd).isDirectory()) continue;
        for (const f of readdirSync(pd)) if (f.endsWith(".jsonl")) files.push(join(pd, f));
      } catch {
        /* skip unreadable */
      }
    }
  }
  return files;
}

/** Evaluate one block, accumulating into the report. */
export function evalBlock(
  text: string,
  ccr: ReturnType<typeof createFileCCRStore>,
  rep: EvalReport,
): void {
  const r = compress(text, ccr);
  rep.blocks += 1;

  // never-expand holds for every block, compressed or passed through
  rep.neverExpand.total += 1;
  if (r.skeletonTokens <= r.originalTokens) rep.neverExpand.ok += 1;

  if (!r.compressed) return; // pass-through preserves everything by definition

  // round-trip losslessness
  rep.roundTrip.total += 1;
  try {
    if (ccr.get(r.handle) === text) rep.roundTrip.ok += 1;
  } catch {
    /* counted as failure */
  }

  const kind = r.contentType;
  if (kind === "code") {
    // identifier-fidelity: declared names survive (signatures are kept)
    const names = new Set<string>();
    for (const m of text.matchAll(DECLARATION)) names.add(m[1]!);
    for (const name of names) {
      rep.identifiers.total += 1;
      if (r.skeleton.includes(name)) rep.identifiers.preserved += 1;
    }
    return;
  }

  // error- and summary-fidelity for non-code, non-json shapes (logs, text,
  // prose, …). JSON is excluded: an "Error" string inside a JSON value (a
  // grep pattern, a message field) is data, not a failure event — the JSON
  // handler's own structural guarantees are tested elsewhere. Line-numbered
  // Read output is compared against its stripped content (the skeleton is
  // built from that; the prefixes live in CCR).
  if (kind === "json") return;
  const compareText = stripLineNumbers(text) ?? text;
  const lines = compareText.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const t = line.trim();
    if (t.length === 0) continue;
    if (IMPORTANT_LINE.test(line)) {
      rep.errorLines.total += 1;
      if (r.skeleton.includes(t)) rep.errorLines.preserved += 1;
    } else if (i >= lines.length - SUMMARY_WINDOW && SUMMARY_LINE.test(line)) {
      rep.summaryLines.total += 1;
      if (r.skeleton.includes(t)) rep.summaryLines.preserved += 1;
    }
  }
}

const pct = (p: number, t: number): string => (t === 0 ? "n/a" : `${((p / t) * 100).toFixed(1)}%`);

/** Gate thresholds — published in the README, enforced here. */
export function gate(rep: EvalReport): boolean {
  const ratio = (p: number, t: number): number => (t === 0 ? 1 : p / t);
  return (
    ratio(rep.errorLines.preserved, rep.errorLines.total) === 1 &&
    ratio(rep.roundTrip.ok, rep.roundTrip.total) === 1 &&
    ratio(rep.neverExpand.ok, rep.neverExpand.total) === 1 &&
    ratio(rep.identifiers.preserved, rep.identifiers.total) >= 0.99 &&
    ratio(rep.summaryLines.preserved, rep.summaryLines.total) >= 0.95
  );
}

export function emptyReport(): EvalReport {
  return {
    blocks: 0,
    errorLines: { total: 0, preserved: 0 },
    identifiers: { total: 0, preserved: 0 },
    summaryLines: { total: 0, preserved: 0 },
    roundTrip: { total: 0, ok: 0 },
    neverExpand: { total: 0, ok: 0 },
    pass: false,
  };
}

/** Run the suite on real transcripts. Returns the report (pass set). */
export async function runEvals(args: string[], log: (line: string) => void = console.log): Promise<EvalReport> {
  const roots = args.filter((a) => !a.startsWith("--"));
  const files = collectTranscripts(roots.length > 0 ? roots : [join(homedir(), ".claude", "projects")]);
  log(`[evals] transcripts: ${files.length}`);
  const rep = emptyReport();
  if (files.length === 0) {
    log("[evals] nothing to scan — pass a directory or .jsonl path (default: ~/.claude/projects)");
    rep.pass = true; // nothing to judge is not a failure (don't break CI on an empty corpus)
    return rep;
  }
  await ensureAst();
  log(`[evals] AST parsers: ${astReady() ? "warm" : "unavailable — scanner fallback"}`);

  const store = mkdtempSync(join(tmpdir(), "knitbrain-evals-"));
  const ccr = createFileCCRStore(store);
  try {
    for (const file of files) {
      const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
      for await (const line of rl) {
        let msg: unknown;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        const content = (msg as { message?: { content?: unknown } })?.message?.content;
        if (!Array.isArray(content)) continue;
        for (const block of content as Array<{ type?: string; content?: unknown }>) {
          if (block.type !== "tool_result") continue;
          const raw = block.content;
          const text =
            typeof raw === "string"
              ? raw
              : Array.isArray(raw)
                ? (raw as Array<{ type?: string; text?: string }>)
                    .filter((b) => b.type === "text")
                    .map((b) => b.text ?? "")
                    .join("\n")
                : "";
          if (text.length < 400) continue;
          evalBlock(text, ccr, rep);
        }
      }
    }
  } finally {
    rmSync(store, { recursive: true, force: true });
  }

  rep.pass = gate(rep);
  log(`[evals] blocks evaluated: ${rep.blocks} (real tool outputs, no synthetic fixtures)`);
  log(`  error-fidelity       ${rep.errorLines.preserved}/${rep.errorLines.total}  ${pct(rep.errorLines.preserved, rep.errorLines.total)}  (gate: 100%)`);
  log(`  identifier-fidelity  ${rep.identifiers.preserved}/${rep.identifiers.total}  ${pct(rep.identifiers.preserved, rep.identifiers.total)}  (gate: ≥99%)`);
  log(`  summary-fidelity     ${rep.summaryLines.preserved}/${rep.summaryLines.total}  ${pct(rep.summaryLines.preserved, rep.summaryLines.total)}  (gate: ≥95%)`);
  log(`  round-trip lossless  ${rep.roundTrip.ok}/${rep.roundTrip.total}  ${pct(rep.roundTrip.ok, rep.roundTrip.total)}  (gate: 100%)`);
  log(`  never-expand         ${rep.neverExpand.ok}/${rep.neverExpand.total}  ${pct(rep.neverExpand.ok, rep.neverExpand.total)}  (gate: 100%)`);
  log(`[evals] ${rep.pass ? "PASS" : "FAIL"}`);
  return rep;
}
