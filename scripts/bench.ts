/**
 * bench — the compression regression gate, two suites:
 *
 *  1. REAL-SHAPE SUITE (the one that matters): fixtures statistically shaped
 *     like the profiled distribution of 3.3M real tool-result tokens (code
 *     47%, repetitive logs 17%, short prose 16%, long prose 7%, test output
 *     6%, JSON 5%, diffs 1%), run through the FULL router. Per-shape floors
 *     sit a safety margin BELOW the measured real-corpus numbers — a change
 *     that regresses any real shape fails the build. Fidelity is asserted
 *     too: error lines and result summaries must survive, byte-for-byte
 *     round-trip always.
 *
 *  2. BEST-CASE SUITE: the original synthetic upper-bound fixtures (import
 *     graphs, body-heavy code). These numbers are NOT real-world savings and
 *     are never quoted as such — they only catch regressions in the
 *     individual handlers' ceilings.
 *
 * The honest real-world numbers come from `knitbrain profile` / `knitbrain
 * evals` on actual transcripts.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeTokenizerName } from "../src/tokenizer.js";
import { measure, summarize, type Measurement } from "./measure.js";
import { createFileCCRStore } from "../src/ccr/store.js";
import { compressJson } from "../src/optimizer/json.js";
import { compressCode } from "../src/optimizer/code.js";
import { compress } from "../src/optimizer/router.js";
import { ensureAst } from "../src/optimizer/ast.js";
import { IMPORTANT_LINE } from "../src/optimizer/structured.js";

// ─────────────────────── real-shape fixtures ───────────────────────

function codeShape(): string {
  const fn = (i: number): string => `
/** Handles the ${i}-th request phase, validating and persisting state. */
export async function handlePhase${i}(input: PhaseInput): Promise<PhaseResult> {
  const session = await store.loadSession(input.sessionId);
  if (!session) {
    throw new Error("session not found: " + input.sessionId);
  }
  const validated = validatePhase(input, session.constraints);
  const merged = { ...session.state, phase: ${i}, payload: validated.payload };
  await store.persist(input.sessionId, merged);
  metrics.increment("phase_${i}_handled");
  return { ok: true, next: ${i + 1}, state: merged };
}`;
  return (
    `import { store } from "./store.js";\nimport { metrics } from "./metrics.js";\nimport type { PhaseInput, PhaseResult } from "./types.js";\n\nexport interface PhaseState { phase: number; payload: unknown; }\n` +
    Array.from({ length: 10 }, (_, i) => fn(i)).join("\n")
  );
}

function repetitiveLogShape(): string {
  const templates = [
    (i: number) => `2026-06-11T10:${String(i % 60).padStart(2, "0")}:01Z INFO request handled route=/api/items status=200 dur=${10 + (i % 7)}ms`,
    (i: number) => `2026-06-11T10:${String(i % 60).padStart(2, "0")}:02Z DEBUG cache hit key=item:${i}`,
    (i: number) => `2026-06-11T10:${String(i % 60).padStart(2, "0")}:03Z INFO worker ${i % 4} heartbeat ok`,
  ];
  return Array.from({ length: 210 }, (_, i) => templates[i % 3]!(i)).join("\n");
}

function shortProseShape(): string {
  return [
    "The migration completed in three stages. First, the schema was duplicated into the shadow table.",
    "Second, writes were mirrored for six hours to validate parity. No divergence was observed during this window.",
    "Third, reads were cut over behind the feature flag. Latency held at the p50 baseline throughout.",
    "One anomaly appeared in the consumer group offsets. It resolved after the rebalance finished.",
    "The cleanup job removed the shadow table after the verification queries passed. Total downtime was zero.",
    "Future migrations should reuse this mirror-then-cutover pattern. The flag-based rollback was never needed.",
  ].join(" ");
}

function longProseShape(): string {
  const para = (i: number): string =>
    `Section ${i}: The subsystem boundary here follows the dependency direction established earlier. Components in this layer consume the store interface and never reach into persistence directly. When a consumer needs derived state, it computes it locally rather than asking the store to special-case it. This keeps the interface narrow and the blast radius of storage changes small. Review focus for this section should be on whether any import crosses the boundary in the wrong direction.`;
  return Array.from({ length: 14 }, (_, i) => para(i)).join("\n\n");
}

function testOutputShape(): string {
  return [
    "> app@2.1.0 test",
    "> vitest run",
    "",
    " RUN  v4.1.8 /work/app",
    "",
    ...Array.from({ length: 55 }, (_, i) => ` ✓ tests/unit-${i}.test.ts (${2 + (i % 4)} tests) ${8 + i}ms`),
    " ✗ tests/billing.test.ts > invoice > rounds totals",
    "   AssertionError: expected 10.01 to be 10.00",
    "   at tests/billing.test.ts:41:19",
    ...Array.from({ length: 25 }, (_, i) => ` ✓ tests/int-${i}.test.ts (${1 + (i % 3)} tests) ${15 + i}ms`),
    "",
    " Test Files  1 failed | 80 passed (81)",
    "      Tests  1 failed | 264 passed (265)",
    "   Duration  9.42s",
  ].join("\n");
}

function jsonShape(): string {
  return JSON.stringify(
    {
      items: Array.from({ length: 60 }, (_, i) => ({
        id: `itm_${i}`,
        sku: `SKU-${1000 + i}`,
        quantity: (i % 9) + 1,
        status: i % 5 === 0 ? "backordered" : "in_stock",
        warehouse: `wh-${i % 3}`,
        updatedAt: "2026-06-11T10:00:00Z",
      })),
      page: 1,
      total: 60,
    },
    null,
    2,
  );
}

function diffShape(): string {
  return [
    "diff --git a/src/router.ts b/src/router.ts",
    "index 1a2b3c4..5d6e7f8 100644",
    "--- a/src/router.ts",
    "+++ b/src/router.ts",
    "@@ -20,40 +20,52 @@ export function route(req: Request) {",
    ...Array.from({ length: 44 }, (_, i) =>
      i % 3 === 0 ? `+  const added${i} = normalize(${i});` : i % 3 === 1 ? `-  const removed${i} = legacy(${i});` : `   const kept${i} = ${i};`,
    ),
  ].join("\n");
}

interface Shape {
  label: string;
  text: string;
  /** Share of real burn (from knitbrain profile on 3.3M tokens). */
  weight: number;
  /** Minimum savedPct — a safety margin below the measured real number. */
  floor: number;
}

const SHAPES: Shape[] = [
  { label: "code", text: codeShape(), weight: 0.47, floor: 50 },
  { label: "repetitive-log", text: repetitiveLogShape(), weight: 0.17, floor: 60 },
  { label: "short-prose", text: shortProseShape(), weight: 0.16, floor: 8 },
  { label: "long-prose", text: longProseShape(), weight: 0.07, floor: 40 },
  { label: "test-output", text: testOutputShape(), weight: 0.06, floor: 35 },
  { label: "json", text: jsonShape(), weight: 0.05, floor: 55 },
  { label: "diff", text: diffShape(), weight: 0.01, floor: 40 },
];

// ───────────────────────────── run ─────────────────────────────

const root = mkdtempSync(join(tmpdir(), "knitbrain-bench-"));
const ccr = createFileCCRStore(root);
let ok = true;

console.log(`[bench] tokenizer = ${activeTokenizerName()}`);
await ensureAst();

try {
  console.log("[bench] ── real-shape suite (mix mirrors the profiled distribution; floors below measured real numbers) ──");
  let weightedSaved = 0;
  for (const s of SHAPES) {
    const r = compress(s.text, ccr);
    const lossless = r.compressed ? ccr.get(r.handle) === s.text : true;
    if (!lossless) {
      console.error(`[bench] FAIL — ${s.label} did not round-trip losslessly`);
      ok = false;
    }
    if (r.savedPct < s.floor) {
      console.error(`[bench] FAIL — ${s.label} saved ${r.savedPct}% (floor ${s.floor}%)`);
      ok = false;
    }
    // FIDELITY: error lines must survive in the skeleton for log-like shapes.
    if (s.label === "test-output") {
      for (const line of s.text.split("\n")) {
        if (IMPORTANT_LINE.test(line) && !r.skeleton.includes(line.trim())) {
          console.error(`[bench] FAIL — ${s.label} lost an error line: ${line.trim()}`);
          ok = false;
        }
      }
    }
    weightedSaved += s.weight * r.savedPct;
    console.log(
      `[bench] ${s.label.padEnd(15)} ${String(r.originalTokens).padStart(5)} → ${String(r.skeletonTokens).padStart(4)} tokens  saved=${r.savedPct}%  (floor ${s.floor}%)  lossless=${lossless ? "✓" : "✗"}`,
    );
  }
  console.log(`[bench] WEIGHTED (real-burn mix) saved=${weightedSaved.toFixed(1)}%  (gate ≥45%)`);
  if (weightedSaved < 45) {
    console.error("[bench] FAIL — weighted real-shape savings under 45%");
    ok = false;
  }

  console.log("[bench] ── best-case suite (synthetic upper bounds — NOT real-world numbers) ──");
  const importsPayload = (n: number): string =>
    JSON.stringify(
      {
        file: "src/mcp/handlers.ts",
        imports: Array.from({ length: n }, (_, i) => ({
          name: `symbol_${i}`,
          from: `../engine/module_${i}`,
          line: i + 1,
          usedBy: [`handler_${i}`, `helper_${i}`],
          doc: "This symbol does something important. ".repeat(5),
        })),
      },
      null,
      2,
    );
  const results: Measurement[] = [];
  for (const p of [
    { label: "imports-120", json: importsPayload(120) },
    { label: "config", json: JSON.stringify({ id: 42, name: "knitbrain", tags: ["a", "b", "c"], blob: "x".repeat(800) }, null, 2) },
  ]) {
    const { skeleton, handle } = compressJson(p.json, ccr);
    const lossless = ccr.get(handle) === p.json;
    if (!lossless || measure(p.label, p.json, skeleton).savedPct <= 0) {
      console.error(`[bench] FAIL — ${p.label}`);
      ok = false;
    }
    const m = measure(p.label, p.json, skeleton);
    results.push(m);
    console.log(`[bench] ${p.label.padEnd(15)} ${String(m.originalTokens).padStart(5)} → ${String(m.optimizedTokens).padStart(4)} tokens  saved=${m.savedPct}%  lossless=${lossless ? "✓" : "✗"}`);
  }
  const codeFn = `export async function handle_NN(p: Params): Promise<Result> {
  const prior = await brain.latest();
  const learnings = await brain.top(5);
  const merged = { ...prior, learnings };
  const validated = validate(merged);
  if (!validated.ok) throw new Error("bad state");
  return finalize(validated, p);
}
`;
  const src =
    `import { Brain } from "./brain";\nimport type { Params, Result } from "./types";\n\n` +
    Array.from({ length: 20 }, (_, i) => codeFn.replace(/_NN/g, `_${i}`)).join("\n");
  const { skeleton, handle } = compressCode(src, ccr);
  const lossless = ccr.get(handle) === src;
  const m = measure("code-20fns", src, skeleton);
  results.push(m);
  if (!lossless || m.savedPct <= 0) {
    console.error("[bench] FAIL — code-20fns");
    ok = false;
  }
  console.log(`[bench] ${"code-20fns".padEnd(15)} ${String(m.originalTokens).padStart(5)} → ${String(m.optimizedTokens).padStart(4)} tokens  saved=${m.savedPct}%  lossless=${lossless ? "✓" : "✗"}`);
  const total = summarize(results);
  console.log(`[bench] best-case TOTAL ${total.totalOriginal} → ${total.totalOptimized} tokens  saved=${total.savedPct}% (upper bound, never quoted as real-world)`);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(ok ? "[bench] PASS — real-shape floors held, fidelity held, byte-for-byte recovery" : "[bench] FAIL");
process.exit(ok ? 0 : 1);
