/**
 * bench:tokens — the compression-ratio + accuracy gate.
 *
 * Rung 1: proves the tokenizer + measurement harness can count real payloads
 * honestly. optimized === original here (no compressor yet → 0% saved). From
 * rung 2 this asserts compression ratio AND byte-for-byte CCR recovery, and
 * fails the build on regression.
 */
import { countTokens, activeTokenizerName } from "../src/tokenizer.js";
import { measure, summarize, type Measurement } from "../src/measure.js";

const SAMPLES: ReadonlyArray<{ label: string; text: string }> = [
  { label: "empty", text: "" },
  { label: "prose", text: "The quick brown fox jumps over the lazy dog. ".repeat(20) },
  {
    label: "json",
    text: JSON.stringify(
      { id: 42, name: "knitbrain", tags: ["a", "b", "c"], blob: "x".repeat(500) },
      null,
      2,
    ),
  },
  {
    label: "code",
    text: `export function add(a: number, b: number): number {\n  return a + b;\n}\n`.repeat(10),
  },
];

let ok = true;
const results: Measurement[] = [];

console.log(`[bench] tokenizer = ${activeTokenizerName()}`);
for (const s of SAMPLES) {
  const tokens = countTokens(s.text);
  if (s.text.length > 0 && tokens <= 0) {
    console.error(`[bench] FAIL — non-empty payload "${s.label}" counted 0 tokens`);
    ok = false;
  }
  // Rung 1: no optimizer yet → optimized === original.
  const m = measure(s.label, s.text, s.text);
  results.push(m);
  console.log(
    `[bench] ${s.label.padEnd(6)} tokens=${String(m.originalTokens).padStart(4)} saved=${m.savedPct}%`,
  );
}

const total = summarize(results);
console.log(
  `[bench] TOTAL original=${total.totalOriginal} optimized=${total.totalOptimized} saved=${total.savedPct}%`,
);
console.log(ok ? "[bench] PASS — tokenizer measures payloads honestly" : "[bench] FAIL");
process.exit(ok ? 0 : 1);
