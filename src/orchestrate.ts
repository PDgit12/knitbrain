import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { runClosedLoop, defaultJudge, makeGrade, makeReview } from "./engine/closed-loop.js";
import { createWikiStore } from "./engine/wiki.js";
import { wikiRoot } from "./paths.js";
import { currentContextTokens } from "./engine/usage.js";

/**
 * `knitbrain orchestrate <goalfile>` — the closed-loop orchestrator (P3).
 * goal → judge → iterate → grade → review → repeat until met (or max cap).
 *
 * Composes the real steps: the agent does the work (iterate), the verify
 * command is the grade (real run, no false green), a rubric is the review, the
 * wiki gets a per-cycle audit trail, and the live token window is metered.
 * Like the outer loop, it NEVER commits/pushes/deploys — the human does that.
 */

interface Opts {
  goalFile?: string;
  max: number;
  agent: string;
  verify: string | null;
}

function parseArgs(args: string[]): Opts {
  const o: Opts = { max: 6, agent: "claude -p", verify: null };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === "--max") o.max = Math.max(1, Number(args[(i += 1)]) || 6);
    else if (a === "--agent") o.agent = args[(i += 1)] ?? o.agent;
    else if (a === "--verify") o.verify = args[(i += 1)] ?? null;
    else if (a && !a.startsWith("--")) o.goalFile = a;
  }
  return o;
}

const run = (cmd: string, input?: string): boolean =>
  spawnSync(cmd, { shell: true, input, stdio: input === undefined ? "inherit" : ["pipe", "inherit", "inherit"] }).status === 0;

function prompt(goalText: string, iter: number): string {
  return [
    `You are cycle ${iter} of an autonomous closed loop. Make progress toward this goal, then stop:`,
    "",
    goalText,
    "",
    "Follow the knitbrain protocol. Do NOT declare the goal met yourself — the loop grades (verify)",
    "and reviews it. Do NOT commit, push, or deploy.",
  ].join("\n");
}

export function runOrchestrate(args: string[]): number {
  const o = parseArgs(args);
  if (!o.goalFile || !existsSync(o.goalFile)) {
    console.error('usage: knitbrain orchestrate <goalfile.md> [--max N=6] [--agent "cmd"] [--verify "cmd"]');
    console.error("  goal → judge → iterate → grade → review → repeat until met. Never commits/pushes/deploys.");
    return 1;
  }
  const goalText = readFileSync(o.goalFile, "utf8");
  const verify = o.verify ?? (existsSync("package.json") ? "npm test" : "");
  const wiki = createWikiStore(wikiRoot());

  console.log(`[orchestrate] goal: ${o.goalFile} · verify: ${verify || "(none)"} · max ${o.max} cycles`);

  const result = runClosedLoop(
    {
      judge: () => defaultJudge(goalText),
      iterate: (iter) => {
        console.log(`[orchestrate] cycle ${iter}: iterate`);
        run(o.agent, prompt(goalText, iter));
      },
      grade: makeGrade(verify, (cmd) => run(cmd)),
      review: makeReview(),
      onCycle: (c) => {
        wiki.log("cycle", `${o.goalFile} · iter ${c.iter} · grade=${c.graded.pass} · met=${c.met} · tokens=${c.tokens ?? "?"}`);
        console.log(`[orchestrate] cycle ${c.iter}: grade=${c.graded.pass} review=${c.reviewed.notes} met=${c.met}${c.tokens != null ? ` · ${c.tokens} ctx tokens` : ""}`);
      },
      meter: () => currentContextTokens() ?? 0,
    },
    o.max,
  );

  // Synthesize the run into the wiki so the orchestration compounds.
  wiki.ingest({
    title: `orchestration ${o.goalFile}`,
    kind: "session",
    content: `Closed loop on ${o.goalFile}.\n- claim: met = ${result.met}\ncycles: ${result.cycles.length} · ${result.reason}`,
  });

  console.log(`[orchestrate] ${result.met ? "MET ✓" : "NOT met ✗"} — ${result.reason}`);
  if (!result.met) console.log("[orchestrate] no false green: goal not marked met. Re-run to continue, or refine the goal.");
  return result.met ? 0 : 1;
}
