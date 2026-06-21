import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
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
  record(e: { agent: string; tool: string; summary: string; saved?: number }): void;
  /** Most recent events, newest first. */
  recent(n?: number): ActivityEvent[];
  /** Per-agent rollup across the log (universal optimization meter). */
  rollup(): AgentRollup[];
}

/** Keep at most this many events on disk. */
const CAP = 200;

export function createActivityLog(root: string): ActivityLog {
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

  return {
    record(e) {
      try {
        const ev: ActivityEvent = { ts: new Date().toISOString(), saved: 0, ...e };
        appendFileSync(path, JSON.stringify(ev) + "\n", { encoding: "utf8", flag: "a" });
        // Bounded: when the log grows past 2×CAP, rewrite the last CAP.
        const all = readAll();
        if (all.length > CAP * 2) {
          writeAtomic(path, all.slice(-CAP).map((x) => JSON.stringify(x)).join("\n") + "\n");
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
  };
}
