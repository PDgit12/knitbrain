/**
 * bench:tokens — the compression-ratio + accuracy gate.
 *
 * Rung 2: compresses real payloads through the JSON optimizer, reports the
 * compression ratio, and ASSERTS byte-for-byte CCR recovery. Fails the build
 * if anything doesn't round-trip, or if a payload fails to shrink.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeTokenizerName } from "../src/tokenizer.js";
import { measure, summarize, type Measurement } from "../src/measure.js";
import { createFileCCRStore } from "../src/ccr/store.js";
import { compressJson } from "../src/optimizer/json.js";

function importsPayload(n: number): string {
  const imports = Array.from({ length: n }, (_, i) => ({
    name: `symbol_${i}`,
    from: `../engine/module_${i}`,
    line: i + 1,
    usedBy: [`handler_${i}`, `helper_${i}`],
    doc: "This symbol does something important. ".repeat(5),
  }));
  return JSON.stringify({ file: "src/mcp/handlers.ts", imports }, null, 2);
}

const PAYLOADS: ReadonlyArray<{ label: string; json: string }> = [
  { label: "imports-40", json: importsPayload(40) },
  { label: "imports-120", json: importsPayload(120) },
  {
    label: "config",
    json: JSON.stringify(
      { id: 42, name: "knitbrain", tags: ["a", "b", "c"], blob: "x".repeat(800) },
      null,
      2,
    ),
  },
];

const root = mkdtempSync(join(tmpdir(), "knitbrain-bench-"));
const ccr = createFileCCRStore(root);

let ok = true;
const results: Measurement[] = [];

console.log(`[bench] tokenizer = ${activeTokenizerName()}`);
try {
  for (const p of PAYLOADS) {
    const { skeleton, handle } = compressJson(p.json, ccr);

    // ACCURACY GATE: the original must come back byte-for-byte.
    const recovered = ccr.get(handle);
    const lossless = recovered === p.json;
    if (!lossless) {
      console.error(`[bench] FAIL — ${p.label} did not round-trip losslessly`);
      ok = false;
    }

    const m = measure(p.label, p.json, skeleton);
    results.push(m);

    // RATIO GATE: redundant payloads must actually shrink.
    if (m.savedPct <= 0) {
      console.error(`[bench] FAIL — ${p.label} did not shrink (${m.savedPct}%)`);
      ok = false;
    }

    console.log(
      `[bench] ${p.label.padEnd(11)} ${String(m.originalTokens).padStart(5)} → ${String(
        m.optimizedTokens,
      ).padStart(4)} tokens  saved=${m.savedPct}%  lossless=${lossless ? "✓" : "✗"}`,
    );
  }

  const total = summarize(results);
  console.log(
    `[bench] TOTAL ${total.totalOriginal} → ${total.totalOptimized} tokens  saved=${total.savedPct}%`,
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(
  ok
    ? "[bench] PASS — payloads shrink AND recover byte-for-byte"
    : "[bench] FAIL",
);
process.exit(ok ? 0 : 1);
