import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "../atomic.js";
import type { MeterReading } from "./meter.js";
import type { ActivityEvent } from "./activity.js";

/**
 * G1 session receipt — the honest "what did knitbrain actually do for you this
 * session" report. buildReceipt is pure (no fs) so it's trivially testable and
 * safe to call from any process; the marker/hygiene helpers own the on-disk
 * session.json (one per project root, sibling to activity.jsonl/meter.json).
 */

export interface SessionMark {
  startTs: string;
  savedAtStart: number;
  usedAtStart: number;
  retrievalsAtStart: number;
  /** Output-side: cumulative model output tokens at session start (transcript
   * probe) — lets the receipt PROVE actual output written this session. */
  outputAtStart?: number;
  reads: Record<string, { count: number; mtimeMs: number }>;
  redirects: Record<string, number>;
}

const MAX_TRACKED_READS = 200;

function sessionPath(root: string): string {
  return join(root, "session.json");
}

/** Best-effort guarded read — corrupt/missing JSON never throws. */
function loadMark(root: string): SessionMark | null {
  const path = sessionPath(root);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as SessionMark;
  } catch {
    return null;
  }
}

/** New session: snapshot the meter's cumulative counters as the session's
 *  zero-point so the receipt can report SESSION deltas, not lifetime totals. */
export function markSessionStart(
  root: string,
  snap: { savedTokens: number; usedTokens: number; retrievals: number; outputTokens?: number },
): void {
  mkdirSync(root, { recursive: true });
  const mark: SessionMark = {
    startTs: new Date().toISOString(),
    savedAtStart: snap.savedTokens,
    usedAtStart: snap.usedTokens,
    retrievalsAtStart: snap.retrievals,
    ...(snap.outputTokens !== undefined ? { outputAtStart: snap.outputTokens } : {}),
    reads: {},
    redirects: {},
  };
  writeAtomic(sessionPath(root), JSON.stringify(mark));
}

export function readSessionMark(root: string): SessionMark | null {
  return loadMark(root);
}

/** Bounded read map: drops the lowest-count entries first when over the cap
 *  so a read-heavy session can't grow session.json unbounded. */
function capReads(
  reads: Record<string, { count: number; mtimeMs: number }>,
): Record<string, { count: number; mtimeMs: number }> {
  const entries = Object.entries(reads);
  if (entries.length <= MAX_TRACKED_READS) return reads;
  entries.sort((a, b) => a[1].count - b[1].count);
  const drop = new Set(entries.slice(0, entries.length - MAX_TRACKED_READS).map(([k]) => k));
  const out: Record<string, { count: number; mtimeMs: number }> = {};
  for (const [k, v] of entries) if (!drop.has(k)) out[k] = v;
  return out;
}

/** Merge two read maps per-path by taking the higher count (and the mtimeMs
 *  that travels with it) — used by the CAS retry to re-pick-up a concurrent
 *  writer's increment instead of clobbering it. */
function mergeReads(
  a: Record<string, { count: number; mtimeMs: number }>,
  b: Record<string, { count: number; mtimeMs: number }>,
): Record<string, { count: number; mtimeMs: number }> {
  const out: Record<string, { count: number; mtimeMs: number }> = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[k];
    const y = b[k];
    // Newer mtime wins: an mtime-change RESET (count 1, new mtime) must beat a
    // stale higher count, else the max-count merge silently undoes the reset.
    out[k] = !x ? y! : !y ? x : x.mtimeMs !== y.mtimeMs ? (x.mtimeMs > y.mtimeMs ? x : y) : x.count >= y.count ? x : y;
  }
  return out;
}

/** Merge two redirect count maps per-path by taking the higher count. */
function mergeRedirects(a: Record<string, number>, b: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) out[k] = Math.max(a[k] ?? 0, b[k] ?? 0);
  return out;
}

function mtimeOf(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Track a raw file read for repeat-read hygiene reporting. Same mtime as last
 * time → bump the count (an unchanged re-read, likely wasted context); a new
 * mtime → the file changed, restart the count at 1. No-op without a session
 * (nothing to attribute the read to).
 *
 * session.json is shared by every hook process a host spawns, so a plain
 * read-modify-write silently drops a concurrent increment. Bounded-CAS
 * (mirrors teams.ts board().post — M6): compute our desired increment,
 * reload+merge (max count wins) on each retry so a rival writer's update is
 * re-picked-up instead of clobbered, and only give up after 5 attempts —
 * narrowing the loss window to the atomic write itself.
 */
export function recordRead(root: string, path: string, mtimeMs: number): void {
  const sPath = sessionPath(root);
  const initial = loadMark(root);
  if (!initial) return;
  const applyIncrement = (
    reads: Record<string, { count: number; mtimeMs: number }>,
  ): Record<string, { count: number; mtimeMs: number }> => {
    const prev = reads[path];
    const next = prev && prev.mtimeMs === mtimeMs ? { count: prev.count + 1, mtimeMs } : { count: 1, mtimeMs };
    return capReads({ ...reads, [path]: next });
  };
  let desired = applyIncrement(initial.reads);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const before = mtimeOf(sPath);
    const current = loadMark(root);
    if (!current) return;
    const merged = mergeReads(desired, current.reads);
    writeAtomic(sPath, JSON.stringify({ ...current, reads: merged } satisfies SessionMark));
    desired = merged;
    if (mtimeOf(sPath) === before) break;
  }
}

/**
 * Track an oversized raw read that got redirected to knitbrain_read. No-op
 * without a session. Same bounded-CAS pattern as recordRead.
 */
export function recordRedirect(root: string, path: string): void {
  const sPath = sessionPath(root);
  const initial = loadMark(root);
  if (!initial) return;
  let desired = { ...initial.redirects, [path]: (initial.redirects[path] ?? 0) + 1 };
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const before = mtimeOf(sPath);
    const current = loadMark(root);
    if (!current) return;
    const merged = mergeRedirects(desired, current.redirects);
    writeAtomic(sPath, JSON.stringify({ ...current, redirects: merged } satisfies SessionMark));
    desired = merged;
    if (mtimeOf(sPath) === before) break;
  }
}

/** G5: input-token $ per MTok — static, DATED; update alongside provider
 * price changes. Used ONLY for api-billing sessions (plan cost is quota, not $). */
const RATES_AS_OF = "2026-07";
const RATE_PER_MTOK: Array<{ match: RegExp; usd: number }> = [
  { match: /fable|opus/i, usd: 15 },
  { match: /sonnet/i, usd: 3 },
  { match: /haiku/i, usd: 1 },
  { match: /gpt-5/i, usd: 10 },
  { match: /gpt-4o|gpt-4\.1/i, usd: 5 },
  { match: /gemini/i, usd: 2.5 },
];

export interface ReceiptInput {
  meter: MeterReading;
  mark: SessionMark | null;
  /** Pre-filtered by the caller via activity.since(mark.startTs). */
  events: ActivityEvent[];
  eventsTrimmed: boolean;
  /** Lifetime TOIN retrieval count (caller sums feedback stats). */
  retrievalsTotal: number;
  /** Output-side: cumulative model output tokens NOW (transcript probe). */
  outputTokensNow?: number;
  /** Whether a terse/caveman output mode is detectably active. */
  terseActive?: boolean;
  /** Injected clock for tests. */
  now?: () => number;
}

/** Compact token count: 12.3k / 1.2M — matches the statusline's fmtTokens. */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

export function buildReceipt(i: ReceiptInput): string {
  const now = i.now ?? Date.now;
  const { meter, mark, events, eventsTrimmed, retrievalsTotal } = i;
  const lines: string[] = [];

  const sessionSaved = mark ? Math.max(0, meter.savedTokens - mark.savedAtStart) : meter.savedTokens;
  const retrievalsDelta = mark ? Math.max(0, retrievalsTotal - mark.retrievalsAtStart) : retrievalsTotal;
  const reads = mark?.reads ?? {};
  const redirects = mark?.redirects ?? {};
  const repeatReads = Object.entries(reads).filter(([, r]) => r.count > 1);
  const redirectCount = Object.values(redirects).reduce((a, b) => a + b, 0);

  // Honest zero: nothing to claim this session — no sinks, no forecast, just
  // the plain fact plus the lifetime line so the user still sees the totals.
  if (sessionSaved === 0 && repeatReads.length === 0 && redirectCount === 0) {
    lines.push("No optimization events this session — nothing was replaced or redirected, so nothing is claimed.");
    lines.push(`lifetime: ${fmtTokens(meter.savedTokens)} tok saved · ${retrievalsTotal} exact recalls`);
    return lines.join("\n");
  }

  lines.push(mark ? "— knitbrain session receipt —" : "— knitbrain receipt (lifetime — no session marker) —");

  const avoided = sessionSaved;
  const consumed = mark ? Math.max(0, meter.usedTokens - mark.usedAtStart) : meter.usedTokens;
  const denom = consumed + avoided;
  const pct = denom > 0 ? Math.round((avoided / denom) * 100) : 0;
  lines.push(`consumed ~${fmtTokens(consumed)} tok · avoided ${fmtTokens(avoided)} tok (${pct}% of what would have been)`);

  const sinks = events
    .filter((e) => typeof e.rawTokens === "number")
    .sort((a, b) => (b.rawTokens ?? 0) - (a.rawTokens ?? 0))
    .slice(0, 5);
  if (sinks.length > 0) {
    lines.push("top sinks:");
    for (const s of sinks) {
      const label = s.file ?? s.tool;
      const raw = s.rawTokens ?? 0;
      const stored = s.storedTokens ?? 0;
      lines.push(`  ${label}: ${fmtTokens(raw)} → ${fmtTokens(stored)} tok (saved ${fmtTokens(Math.max(0, raw - stored))})`);
    }
  }

  if (repeatReads.length > 0 || redirectCount > 0) {
    lines.push("hygiene:");
    const topRepeats = [...repeatReads].sort((a, b) => b[1].count - a[1].count).slice(0, 3);
    for (const [path, r] of topRepeats) {
      lines.push(`  re-read unchanged ×${r.count - 1}: ${path}`);
    }
    if (redirectCount > 0) {
      lines.push(`  ${redirectCount} oversized raw read(s) redirected to knitbrain_read`);
    }
  }

  lines.push(`${retrievalsDelta} exact recall(s) served byte-for-byte this session`);

  // G6 forecast: only when it's a plan-billed session, we have a marker, the
  // session has run long enough to trust a burn rate, and there's something
  // to project (avoided > 0) — otherwise it's noise or a divide-by-garbage.
  // Output side: we can PROVE what was written and that terse was on — but a
  // verbose counterfactual is unknowable, so nothing here enters 'avoided'.
  if (mark?.outputAtStart !== undefined && i.outputTokensNow !== undefined) {
    const written = Math.max(0, i.outputTokensNow - mark.outputAtStart);
    if (written > 0) {
      lines.push(
        `output written: ~${fmtTokens(written)} tok${i.terseActive ? " with terse mode ON (real output-side savings; no provable counterfactual — not counted in avoided)" : ""}`,
      );
    }
  }

  // G5 dollars: api-billing only — plan users' cost is quota, never shown $.
  if (meter.billingMode === "api" && avoided > 0 && meter.model) {
    const rate = RATE_PER_MTOK.find((r) => r.match.test(meter.model!));
    if (rate) {
      lines.push(
        `≈ $${((avoided / 1_000_000) * rate.usd).toFixed(2)} avoided at ${meter.model} input rates (as of ${RATES_AS_OF}, estimate)`,
      );
    }
  }

  if (meter.billingMode === "plan" && mark && avoided > 0) {
    const sessionMs = now() - Date.parse(mark.startTs);
    const hours = sessionMs / 3_600_000;
    if (hours >= 10 / 60) {
      const burn = meter.usedTokens / hours;
      if (burn > 0) {
        const optimisticHours = (meter.windowTokens - meter.usedTokens) / burn;
        const unoptimizedBurn = (meter.usedTokens + avoided) / hours;
        if (unoptimizedBurn > 0) {
          const wasHours = (meter.windowTokens - meter.usedTokens) / unoptimizedBurn;
          lines.push(
            `at this pace the window lasts ~${optimisticHours.toFixed(1)}h (was ~${wasHours.toFixed(1)}h unoptimized) — estimate`,
          );
        }
      }
    }
  }

  // G3 cold-restart waste: the sink optimization can't touch. The provider's
  // prompt cache expires after ~5min idle — every gap >5min in the session's
  // event stream means the NEXT turn re-read the whole context uncached.
  // Estimated from event timestamps (labeled estimate; skipped when unknowable).
  if (mark && events.length >= 2) {
    const CACHE_TTL_MS = 5 * 60_000;
    const ts = events.map((e) => Date.parse(e.ts)).filter((t) => Number.isFinite(t)).sort((a, b) => a - b);
    let coldGaps = 0;
    for (let j = 1; j < ts.length; j += 1) if (ts[j]! - ts[j - 1]! > CACHE_TTL_MS) coldGaps += 1;
    if (coldGaps > 0 && meter.usedTokens > 0) {
      lines.push(
        `${coldGaps} idle gap(s) >5min — each next turn re-read ~${fmtTokens(meter.usedTokens)} tok uncached (estimate); a handoff + fresh session is cheaper than a cold return`,
      );
    }
  }

  lines.push(`lifetime: ${fmtTokens(meter.savedTokens)} tok saved · ${retrievalsTotal} exact recalls`);

  if (eventsTrimmed) {
    lines.push("(earliest events rotated out; totals above come from the meter and are exact)");
  }

  return lines.join("\n");
}
