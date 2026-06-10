import { createReadStream, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { sha256, createFileCCRStore } from "./ccr/store.js";
import { compress } from "./optimizer/router.js";
import { ensureAst, astReady } from "./optimizer/ast.js";
import { countTokens } from "./tokenizer.js";

/**
 * `knitbrain profile` — measure YOUR savings on YOUR transcripts.
 *
 * Scans real host transcripts (Claude Code JSONL), runs every sizable
 * tool_result through the actual optimizer (plus the proxy's cross-turn dedup
 * simulated per session), and reports per-shape and overall savings. This is
 * the reproducibility answer to unverifiable headline claims: the number it
 * prints is what THIS machine's sessions would have saved.
 */

function dupRatio(lines: string[]): number {
  const uniq = new Set(lines).size;
  return lines.length === 0 ? 0 : 1 - uniq / lines.length;
}

export function classifyShape(t: string): string {
  const head = t.slice(0, 200).trimStart();
  const lines = t.split("\n");
  if (head.startsWith("<system-reminder")) return "system-reminder";
  if (head.startsWith("{") || head.startsWith("[")) {
    try {
      JSON.parse(t);
      return "json";
    } catch {
      /* fallthrough */
    }
  }
  let numbered = 0;
  for (const l of lines) if (/^\s{0,8}\d+→/.test(l)) numbered += 1;
  if (numbered >= lines.length * 0.6) return "numbered-read";
  if (/^diff --git|^@@ |\n@@ /.test(t) || (/^--- /m.test(t) && /^\+\+\+ /m.test(t))) return "diff";
  if (/\b(\d+ (passing|passed|failed)|Tests:|Test Files|PASS|FAIL|✓|✗)\b/.test(t) && lines.length > 15) return "test-output";
  if (dupRatio(lines) > 0.25 && lines.length >= 20) return "repetitive-log";
  if (/[{};]/.test(t) && /\b(function|const|class|import|export|def|return)\b/.test(t)) return "code";
  if (lines.length > 40) return "long-prose";
  return "short-prose";
}

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

interface Bucket {
  n: number;
  before: number;
  after: number;
}

/** Run the profile and print the report. Returns the overall saved percent. */
export async function runProfile(args: string[], log: (line: string) => void = console.log): Promise<number> {
  const roots = args.length > 0 ? args : [join(homedir(), ".claude", "projects")];
  const files = collectTranscripts(roots);
  log(`[profile] transcripts: ${files.length}`);
  if (files.length === 0) {
    log("[profile] nothing to scan — pass a directory or .jsonl path (default: ~/.claude/projects)");
    return 0;
  }
  await ensureAst();
  log(`[profile] AST parsers: ${astReady() ? "warm" : "unavailable — scanner fallback"}`);

  const store = mkdtempSync(join(tmpdir(), "knitbrain-profile-"));
  const ccr = createFileCCRStore(store);
  const buckets = new Map<string, Bucket>();
  let dedupN = 0;
  let dedupSaved = 0;
  // Small outputs (<400 chars) pass through untouched — they still count in
  // the honest denominator. Excluding them would inflate the headline.
  let smallTokens = 0;

  try {
    for (const file of files) {
      const seen = new Set<string>(); // per-session: proxy dedup is per request history
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
          if (block?.type !== "tool_result") continue;
          const texts =
            typeof block.content === "string"
              ? [block.content]
              : Array.isArray(block.content)
                ? (block.content as Array<{ type?: string; text?: unknown }>)
                    .filter((c) => c?.type === "text")
                    .map((c) => c.text)
                : [];
          for (const t of texts) {
            if (typeof t !== "string") continue;
            if (t.length < 400) {
              smallTokens += countTokens(t);
              continue;
            }
            const shape = classifyShape(t);
            const hash = sha256(t);
            const repeat = seen.has(hash);
            seen.add(hash);
            const r = compress(t, ccr);
            let after = r.skeletonTokens;
            if (repeat) {
              const marker = countTokens(`⟪same as earlier ⟨ccr:${hash}⟩⟫`);
              if (marker < after) {
                dedupN += 1;
                dedupSaved += after - marker;
                after = marker;
              }
            }
            const b = buckets.get(shape) ?? { n: 0, before: 0, after: 0 };
            b.n += 1;
            b.before += r.originalTokens;
            b.after += after;
            buckets.set(shape, b);
          }
        }
      }
    }
  } finally {
    rmSync(store, { recursive: true, force: true });
  }

  const rows = [...buckets.entries()].sort((a, b) => b[1].before - a[1].before);
  const totB = rows.reduce((s, [, v]) => s + v.before, 0);
  const totA = rows.reduce((s, [, v]) => s + v.after, 0);
  log("\nshape            n      tokens    %of-burn   saved");
  for (const [shape, v] of rows) {
    const saved = v.before ? Math.round((1 - v.after / v.before) * 1000) / 10 : 0;
    log(
      `${shape.padEnd(15)} ${String(v.n).padStart(5)} ${String(v.before).padStart(10)} ${String(Math.round((v.before / totB) * 100)).padStart(8)}% ${String(saved).padStart(9)}%`,
    );
  }
  log(`\ncross-turn dedup: ${dedupN} repeated blocks, ${dedupSaved} extra tokens saved`);
  const sizable = totB === 0 ? 0 : Math.round((1 - totA / totB) * 1000) / 10;
  log(`\nsizable blocks (≥400 chars): ${totB} → ${totA} tokens  saved=${sizable}%`);
  log(`small outputs passed through untouched: ${smallTokens} tokens (0% saved, counted in the total)`);
  const allB = totB + smallTokens;
  const allA = totA + smallTokens;
  const overall = allB === 0 ? 0 : Math.round((1 - allA / allB) * 1000) / 10;
  log(`\nTOTAL (all tool-result tokens) ${allB} → ${allA}  overall saved=${overall}%`);
  log("(lossless: every elision carries a ⟨ccr:hash⟩ that recovers the exact original)");
  return overall;
}
