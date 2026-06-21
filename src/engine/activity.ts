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
}

export interface ActivityLog {
  /** Record one tool call. Best-effort, never throws (must not break a tool). */
  record(e: { agent: string; tool: string; summary: string }): void;
  /** Most recent events, newest first. */
  recent(n?: number): ActivityEvent[];
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
        const ev: ActivityEvent = { ts: new Date().toISOString(), ...e };
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
  };
}
