/**
 * knitbrain research — an autoresearch-style autonomous tuning loop for
 * knitbrain's OWN compression heuristics (inspired by karpathy/autoresearch).
 *
 * The product optimizes the user's agent loop; this optimizes the product.
 * Hand-tuned constants (anchor trigger, min-sentences, never-expand floor …)
 * are swept against REAL transcripts. The objective is the same hard number a
 * user sees — overall savings % from `profile` — under a HARD CONSTRAINT: the
 * fidelity gates (`evals`) must still pass. A setting that saves more but
 * breaks an answer is auto-discarded, exactly like a crashed experiment in
 * autoresearch. No mocks: every measurement runs on your own ~/.claude
 * transcripts.
 *
 * Coordinate descent: from the current defaults, sweep each knob, adopt the
 * value that maximizes savings while keeping every gate green, move on. Every
 * experiment is logged to experiments.tsv (keep/discard/crash), and the report
 * flags slop — a default that's beatable, or a knob with zero effect (dead
 * complexity worth deleting).
 *
 * Run after `npm run build`:  node scripts/research.mjs [corpusDir]
 * This CHANGES NOTHING on disk except the ledger — it reports winners for you
 * to review and apply (the program.md model: the human owns the decision).
 */
import { appendFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const corpus = process.argv[2] ? [process.argv[2]] : [];
const ledger = join(ROOT, "experiments.tsv");
const WORKER = join(ROOT, "scripts", "research-measure.mjs");
writeFileSync(ledger, "knob\tvalue\tsavings\tgates\tstatus\tnote\n");

// param name → the env var src/optimizer/params.ts reads.
const ENV_OF = {
  anchorTriggerPct: "KNITBRAIN_ANCHOR_TRIGGER_PCT",
  minSentences: "KNITBRAIN_MIN_SENTENCES",
  anchorMinLines: "KNITBRAIN_ANCHOR_MIN_LINES",
  minSavingPct: "KNITBRAIN_MIN_SAVING_PCT",
};
const PARAMS = { anchorTriggerPct: 35, minSentences: 8, anchorMinLines: 40, minSavingPct: 5 };

/**
 * One real measurement, in a FRESH child process (zero WASM accumulation
 * across experiments). `params` overrides ride the KNITBRAIN_* env vars.
 */
function measure(params = {}) {
  const env = { ...process.env };
  for (const [k, v] of Object.entries(params)) env[ENV_OF[k]] = String(v);
  const r = spawnSync(process.execPath, [WORKER, ...(corpus[0] ? [corpus[0]] : [])], {
    env,
    encoding: "utf8",
    maxBuffer: 128 << 20,
  });
  const line = (r.stdout || "").trim().split("\n").filter(Boolean).pop();
  if (!line) throw new Error(`worker produced no output${r.status ? ` (exit ${r.status})` : ""}`);
  return JSON.parse(line);
}

const log = (knob, value, savings, pass, status, note) => {
  const line = `${knob}\t${value}\t${savings.toFixed(2)}\t${pass ? "PASS" : "FAIL"}\t${status}\t${note}`;
  console.log(`  ${status.padEnd(8)} ${knob}=${value}  savings=${savings.toFixed(2)}%  gates=${pass ? "green" : "RED"}  ${note}`);
  appendFileSync(ledger, line + "\n");
};

// The knobs and the grid to sweep each over (defaults included so the baseline
// is always represented; small grids keep the loop to ~minutes).
const KNOBS = [
  { name: "anchorTriggerPct", grid: [25, 30, 35, 40, 45] },
  { name: "minSentences", grid: [6, 7, 8, 10, 12] },
  { name: "anchorMinLines", grid: [30, 40, 50] },
  { name: "minSavingPct", grid: [3, 5, 8] },
];

console.log(`[research] corpus: ${corpus[0] ?? "~/.claude/projects (default)"}`);
console.log("[research] baseline (current hand-tuned defaults)…");
const baseline = measure();
console.log(`[research] baseline: savings=${baseline.savings.toFixed(2)}%  gates=${baseline.pass ? "green" : "RED"}  blocks=${baseline.blocks}`);
if (!baseline.pass) {
  console.error("[research] baseline gates are RED — fix fidelity before tuning. Aborting.");
  process.exit(1);
}

let bestOverall = baseline.savings;
const adopted = {};
const slop = [];

for (const knob of KNOBS) {
  const original = PARAMS[knob.name];
  console.log(`\n[research] sweeping ${knob.name} (default ${original})…`);
  let bestVal = original;
  let bestSavings = bestOverall;
  const effects = new Set();
  for (const value of knob.grid) {
    let m;
    try {
      // Carry adopted winners forward (coordinate descent), each run isolated.
      m = measure({ ...adopted, [knob.name]: value });
    } catch (err) {
      log(knob.name, value, 0, false, "crash", String(err).slice(0, 60));
      continue;
    }
    effects.add(m.savings.toFixed(2));
    // KEEP only if it beats the running best AND keeps every gate green.
    const better = m.pass && m.savings > bestSavings + 0.01;
    log(knob.name, value, m.savings, m.pass, better ? "keep" : "discard", value === original ? "(default)" : !m.pass ? "gate broke" : better ? "improves" : "no gain");
    if (better) {
      bestSavings = m.savings;
      bestVal = value;
    }
  }
  // Adopt the winner for this knob (coordinate descent), carry it forward.
  adopted[knob.name] = bestVal;
  bestOverall = bestSavings;
  // SLOP FLAG: a knob whose every grid value produced the SAME savings has no
  // effect on this corpus — it's dead complexity worth questioning.
  if (effects.size === 1) slop.push(`${knob.name}: no measurable effect across ${knob.grid.join("/")} — candidate for removal`);
  if (bestVal !== original) slop.push(`${knob.name}: default ${original} beaten by ${bestVal} (+${(bestSavings - baseline.savings).toFixed(2)}pp)`);
}

console.log("\n[research] ── RESULT ──");
console.log(`baseline savings: ${baseline.savings.toFixed(2)}%`);
console.log(`best found:       ${bestOverall.toFixed(2)}%  (+${(bestOverall - baseline.savings).toFixed(2)}pp)`);
console.log(`adopted knobs:    ${JSON.stringify(adopted)}`);
if (slop.length === 0) {
  console.log("verdict: hand-tuned defaults are already optimal on this corpus (no slop, nothing to change).");
} else {
  console.log("findings (review, then apply by editing src/optimizer/params.ts defaults):");
  for (const s of slop) console.log(`  • ${s}`);
}
console.log(`ledger: ${ledger}`);
// This tool reports only — it never writes source. Apply a winner by editing
// the default in src/optimizer/params.ts, then re-run the gates.
