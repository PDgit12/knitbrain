/**
 * Shape profiler — answers "where does context burn ACTUALLY live?" with data.
 *
 * Scans real host transcripts (Claude Code JSONL), buckets every sizable
 * tool_result by shape, and reports per shape: count, tokens, and what the
 * CURRENT optimizer already saves. The under-served heavy buckets are the
 * next handlers to build — measurement decides, not guesswork.
 *
 * Usage: node scripts/shape-profile.mjs <dir-or-jsonl> [more...]
 *        (defaults to ~/.claude/projects — all projects, all sessions)
 */
import { createReadStream, readdirSync, statSync, mkdtempSync, rmSync } from "node:fs";
import { createInterface } from "node:readline";
import { homedir, tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const d = (p) => pathToFileURL(join(ROOT, "dist", p)).href;
const { createFileCCRStore, sha256 } = await import(d("ccr/store.js"));
const { compress } = await import(d("optimizer/router.js"));
const { countTokens } = await import(d("tokenizer.js"));
const { ensureAst, astReady } = await import(d("optimizer/ast.js"));
await ensureAst();
console.log(`[profile] AST parsers: ${astReady() ? "warm" : "FAILED — scanner fallback"}`);


// ── shape classification (deterministic, order matters) ──
function dupRatio(lines) {
  const uniq = new Set(lines).size;
  return lines.length === 0 ? 0 : 1 - uniq / lines.length;
}
function classifyShape(t) {
  const head = t.slice(0, 200).trimStart();
  const lines = t.split("\n");
  if (head.startsWith("<system-reminder")) return "system-reminder";
  if (head.startsWith("{") || head.startsWith("[")) {
    try { JSON.parse(t); return "json"; } catch { /* fallthrough */ }
  }
  let numbered = 0;
  for (const l of lines) if (/^\s{0,8}\d+→/.test(l)) numbered++;
  if (numbered >= lines.length * 0.6) return "numbered-read";
  if (/^diff --git|^@@ |\n@@ /.test(t) || (/^--- /m.test(t) && /^\+\+\+ /m.test(t))) return "diff";
  if (/\b(\d+ (passing|passed|failed)|Tests:|Test Files|PASS|FAIL|✓|✗)\b/.test(t) && lines.length > 15) return "test-output";
  if (dupRatio(lines) > 0.25 && lines.length >= 20) return "repetitive-log";
  if (/[{};]/.test(t) && /\b(function|const|class|import|export|def|return)\b/.test(t)) return "code";
  if (lines.length > 40) return "long-prose";
  return "short-prose";
}

// ── collect transcripts ──
const args = process.argv.slice(2);
const roots = args.length > 0 ? args : [join(homedir(), ".claude", "projects")];
const files = [];
for (const r of roots) {
  const st = statSync(r);
  if (st.isFile()) { files.push(r); continue; }
  for (const proj of readdirSync(r)) {
    const pd = join(r, proj);
    try {
      if (!statSync(pd).isDirectory()) continue;
      for (const f of readdirSync(pd)) if (f.endsWith(".jsonl")) files.push(join(pd, f));
    } catch { /* skip */ }
  }
}
console.log(`[profile] transcripts: ${files.length}`);

const store = mkdtempSync(join(tmpdir(), "kb-profile-"));
const ccr = createFileCCRStore(store);
const buckets = new Map(); // shape → {n, before, after, sample}

let dedupN = 0;
let dedupSaved = 0;

for (const file of files) {
  // Cross-turn dedup is per session: every request re-sends the history, so a
  // block whose exact text already appeared earlier in this transcript would
  // collapse to a ⟪same as ⟨ccr:hash⟩⟫ marker in the proxy.
  const seen = new Set();
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    const content = msg?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type !== "tool_result") continue;
      const texts = typeof block.content === "string" ? [block.content]
        : Array.isArray(block.content) ? block.content.filter((c) => c?.type === "text").map((c) => c.text) : [];
      for (const t of texts) {
        if (typeof t !== "string" || t.length < 400) continue;
        const shape = classifyShape(t);
        const hash = sha256(t);
        const repeat = seen.has(hash);
        seen.add(hash);
        const r = compress(t, ccr);
        let after = r.skeletonTokens;
        if (repeat) {
          const marker = countTokens(`⟪same as earlier ⟨ccr:${hash}⟩⟫`);
          if (marker < after) {
            dedupN++; dedupSaved += after - marker;
            after = marker;
          }
        }
        const b = buckets.get(shape) ?? { n: 0, before: 0, after: 0 };
        b.n++; b.before += r.originalTokens; b.after += after;
        buckets.set(shape, b);
      }
    }
  }
}
rmSync(store, { recursive: true, force: true });

const rows = [...buckets.entries()].sort((a, b) => b[1].before - a[1].before);
const totB = rows.reduce((s, [, v]) => s + v.before, 0);
const totA = rows.reduce((s, [, v]) => s + v.after, 0);
console.log("\nshape            n      tokens    %of-burn   saved-now");
for (const [shape, v] of rows) {
  const saved = v.before ? Math.round((1 - v.after / v.before) * 1000) / 10 : 0;
  console.log(
    `${shape.padEnd(15)} ${String(v.n).padStart(5)} ${String(v.before).padStart(10)} ${String(Math.round((v.before / totB) * 100)).padStart(8)}% ${String(saved).padStart(9)}%`,
  );
}
console.log(`\ncross-turn dedup: ${dedupN} repeated blocks, ${dedupSaved} extra tokens saved`);
console.log(`\nTOTAL ${totB} → ${totA} tokens  overall saved=${Math.round((1 - totA / totB) * 1000) / 10}%`);
