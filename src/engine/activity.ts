import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "../atomic.js";

/**
 * Live agent-activity log — the "CRM for AI agents" feed. Every MCP tool call
 * is one event; the dashboard reads recent events + a per-agent rollup so you
 * can watch your agents work in real time. Append-only JSONL (cheap, race-safe
 * across the multiple knitbrain processes each editor connection spawns),
 * bounded so it never grows without limit.
 */
export interface ActivityEvent {
  ts: string;
  agent: string;
  tool: string;
  summary: string;
  /** Tokens knitbrain saved on this call (0 if not compressed). Universal —
   *  measured by knitbrain itself, so it works for every platform/plan. */
  saved: number;
  /** Where the event came from. Absent = legacy = "mcp" (pre-G1 JSONL lines
   *  still parse — every new field here is optional). */
  source?: "mcp" | "hook" | "proxy";
  /** File path the event concerns (read/redirect/optimize target). */
  file?: string;
  /** Original payload size before compression, for sink reporting. */
  rawTokens?: number;
  /** Size after compression. */
  storedTokens?: number;
  /** G1 receipt classification: an optimize (compress) or a redirect
   *  (oversized raw read steered to knitbrain_read). */
  kind?: "optimize" | "redirect";
}

/** Per-agent optimization rollup — works for ANY MCP agent (Cursor, VS Code,
 *  Codex, Copilot, Claude, …) because it's knitbrain's own measurement. */
export interface AgentRollup {
  agent: string;
  calls: number;
  saved: number;
  lastTs: string;
}

export interface ActivityLog {
  /** Record one tool call. Best-effort, never throws (must not break a tool). */
  record(
    e: {
      agent: string;
      tool: string;
      summary: string;
      saved?: number;
    } & Partial<Pick<ActivityEvent, "source" | "file" | "rawTokens" | "storedTokens" | "kind">>,
  ): void;
  /** Most recent events, newest first. */
  recent(n?: number): ActivityEvent[];
  /** Per-agent rollup across the log (universal optimization meter). */
  rollup(): AgentRollup[];
  /** Events at/after `ts` (ISO, string-compare) — for a receipt scoped to a
   *  session marker. `trimmed` warns the caller the log rotated past the
   *  session start (totals should fall back to exact meter numbers). */
  since(ts: string): { events: ActivityEvent[]; trimmed: boolean };
}

/** Keep at most this many events on disk. */
const CAP = 1000;
/** Cheap guard so appends stay O(1): only pay for the full readAll+trim
 *  pass once the file is actually large enough to matter. */
const TRIM_CHECK_BYTES = 300_000;
/** Protection ceiling: even a session-protected trim can't grow the file past
 *  this many lines — a never-ending session can't defeat bounding entirely. */
const PROTECTION_CEILING = 5000;

export interface ActivityLogOptions {
  /** Returns the current session's start ts (ISO), or null if none/unknown.
   *  When set, a due trim keeps the UNION of (last CAP lines) and (all lines
   *  with ts >= protectSince()) instead of a flat last-CAP cut — so a long
   *  session's early events survive until its receipt has read them. Errors
   *  are treated as null (fail-open to the plain CAP trim). */
  protectSince?: () => string | null;
}

export function createActivityLog(root: string, opts: ActivityLogOptions = {}): ActivityLog {
  mkdirSync(root, { recursive: true });
  const path = join(root, "activity.jsonl");

  const readAll = (): ActivityEvent[] => {
    if (!existsSync(path)) return [];
    const out: ActivityEvent[] = [];
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      try {
        out.push(JSON.parse(line) as ActivityEvent);
      } catch {
        /* skip a corrupt line */
      }
    }
    return out;
  };

  // Events are append-only so `all` is ts-ascending — both "last CAP" and
  // "ts >= protectSince()" are therefore contiguous SUFFIXES of the array, and
  // their union is just the suffix starting at the smaller of the two indices.
  const trimKeep = (all: ActivityEvent[]): ActivityEvent[] => {
    const tailStart = Math.max(0, all.length - CAP);
    let protectTs: string | null = null;
    try {
      protectTs = opts.protectSince?.() ?? null;
    } catch {
      protectTs = null; // fail-open to the plain CAP trim
    }
    if (!protectTs) return all.slice(tailStart);
    const protectStart = all.findIndex((x) => x.ts >= protectTs!);
    const start = protectStart === -1 ? tailStart : Math.min(tailStart, protectStart);
    const kept = all.slice(start);
    // Ceiling: a never-ending session can't grow the file unbounded — past
    // it, drop the oldest PROTECTED events first (keep the tail, since that's
    // what recent()/rollup() serve).
    return kept.length > PROTECTION_CEILING ? kept.slice(-PROTECTION_CEILING) : kept;
  };

  return {
    record(e) {
      try {
        const ev: ActivityEvent = { ts: new Date().toISOString(), saved: 0, ...e };
        appendFileSync(path, JSON.stringify(ev) + "\n", { encoding: "utf8", flag: "a" });
        // Bounded: when the log grows past 2×CAP, rewrite the kept set. The
        // statSync guard keeps appends O(1) until the file is actually big
        // enough that a trim could be due — avoids a readAll() every call.
        const size = existsSync(path) ? statSync(path).size : 0;
        if (size > TRIM_CHECK_BYTES) {
          const all = readAll();
          if (all.length > CAP * 2) {
            writeAtomic(path, trimKeep(all).map((x) => JSON.stringify(x)).join("\n") + "\n");
          }
        }
      } catch {
        /* activity is observability — never break a tool call over it */
      }
    },
    recent(n = 50) {
      return readAll().slice(-n).reverse();
    },
    rollup() {
      const by = new Map<string, AgentRollup>();
      for (const e of readAll()) {
        const r = by.get(e.agent) ?? { agent: e.agent, calls: 0, saved: 0, lastTs: e.ts };
        r.calls += 1;
        r.saved += e.saved ?? 0;
        r.lastTs = e.ts;
        by.set(e.agent, r);
      }
      return [...by.values()].sort((a, b) => b.saved - a.saved);
    },
    since(ts) {
      const all = readAll();
      if (all.length === 0) return { events: [], trimmed: false };
      // Only claim rotation when a trim could actually have happened (log at
      // CAP scale) — the oldest event being newer than the session start is
      // otherwise the NORMAL case (session mark precedes its first event).
      const trimmed = all.length >= CAP && all[0]!.ts > ts;
      return { events: all.filter((e) => e.ts >= ts), trimmed };
    },
  };
}
