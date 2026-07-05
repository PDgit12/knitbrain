import { existsSync, readFileSync } from "node:fs";
import { writeAtomic } from "../atomic.js";

/** Claude Code Stop-hook decision: block continues the session with `reason`. */
export interface StopDecision {
  decision: "block";
  reason: string;
}

/**
 * Gap 6b — ENFORCE the loop, don't just steer it. run_loop clears loop-state.json
 * on met/max-iters/deadline, so its presence means a goal is still UNMET and in
 * progress. Block the FIRST stop and push continuation; mark `stopNudged` so a
 * deliberate second stop is never trapped. Returns null (allow stop) when there's
 * no active loop, it was already nudged, or the file is malformed.
 *
 * Pure but for the loop-state file it reads + marks — path is injected so tests
 * run on a temp file, no host state.
 */
export function decideLoopStop(loopStatePath: string): StopDecision | null {
  if (!existsSync(loopStatePath)) return null;
  let ls: { goal?: string; iter?: number; stopNudged?: boolean };
  try {
    ls = JSON.parse(readFileSync(loopStatePath, "utf8")) as typeof ls;
  } catch {
    return null; // malformed — don't block on a broken file
  }
  if (!ls.goal || ls.stopNudged) return null;
  writeAtomic(loopStatePath, JSON.stringify({ ...ls, stopNudged: true }));
  return {
    decision: "block",
    reason: `Goal "${ls.goal}" is still UNMET (loop iter ${ls.iter ?? 0}, verify gate not passed). The loop isn't finished — make the next smallest fix and call knitbrain_run_loop again, OR if you're deliberately stopping, call knitbrain_save_handoff first so it resumes cleanly. (This block fires once; stop again to end.)`,
  };
}
