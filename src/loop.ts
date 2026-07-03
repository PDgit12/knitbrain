import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";

/**
 * `knitbrain loop <goalfile>` — the autonomous OUTER loop ("loop engineering").
 *
 * The inner agent loop (load→classify→build→verify→record) already ships in the
 * MCP. This drives it across FRESH contexts until a goal is done: pick the next
 * `- [ ]` task, spawn the agent headless on just that task (small context every
 * time — the whole point), verify, mark done, repeat. Ralph's shape, but native
 * + memory-backed (progress sidecar) + token-optimized (each call is fresh).
 *
 * Safety, deliberately: a hard iteration cap (no runaway spend), verify must be
 * green before a task is marked done (no false "done" — no yes-man), and it
 * NEVER commits/pushes/deploys (irreversible — the human does that).
 */

const TASK_RE = /^- \[ \] (.+)$/m;

interface LoopOpts {
  goalFile?: string;
  max: number;
  agent: string;
  verify: string | null;
  interactive: boolean;
}

function parseArgs(args: string[]): LoopOpts {
  const o: LoopOpts = { max: 10, agent: "claude -p", verify: null, interactive: false };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === "--max") o.max = Math.max(1, Number(args[(i += 1)]) || 10);
    else if (a === "--agent") o.agent = args[(i += 1)] ?? o.agent;
    else if (a === "--verify") o.verify = args[(i += 1)] ?? null;
    else if (a === "--interactive") o.interactive = true;
    else if (a && !a.startsWith("--")) o.goalFile = a;
  }
  return o;
}

/**
 * Fallback verify gate from the goal file's `VERIFY:` line — onboarding writes
 * it (`VERIFY: cargo test`, `pytest`, …), so a Rust/Python/etc. project's loop
 * uses the RIGHT gate without the user re-passing --verify. Precedence:
 * explicit --verify  >  goal.md VERIFY:  >  `npm test` if package.json exists.
 */
export function goalVerify(goalFile: string): string {
  try {
    const m = /^VERIFY:\s*(.+)$/im.exec(readFileSync(goalFile, "utf8"));
    const v = m ? m[1]!.trim() : "";
    return v && v !== "(unspecified)" ? v : "";
  } catch {
    return "";
  }
}

function buildPrompt(task: string, progress: string, lastFail: string): string {
  return [
    "You are ONE iteration of an autonomous build loop. Do EXACTLY this one task, then stop:",
    "",
    task,
    "",
    "Follow the knitbrain protocol (knitbrain_load_session, classify, verify). Do NOT mark the",
    "task complete yourself — the loop verifies and marks it. Do NOT commit, push, or deploy.",
    ...(lastFail
      ? ["", "The verify gate is NOT green yet — your last attempt failed with:", lastFail, "Fix the cause; do not repeat what didn't work."]
      : []),
    "",
    "Progress so far:",
    progress || "(none yet)",
  ].join("\n");
}

/** Run a shell command, inheriting stdio; return true on exit 0. */
function run(cmd: string, input?: string): boolean {
  const r = spawnSync(cmd, {
    shell: true,
    input,
    stdio: input === undefined ? "inherit" : ["pipe", "inherit", "inherit"],
  });
  return r.status === 0;
}

export async function runLoop(args: string[]): Promise<number> {
  const o = parseArgs(args);
  if (!o.goalFile || !existsSync(o.goalFile)) {
    console.error("usage: knitbrain loop <goalfile.md> [--max N=10] [--agent \"cmd\"] [--verify \"cmd\"] [--interactive]");
    console.error("  goalfile: markdown with `- [ ] task` checkboxes; the loop ticks them as it goes.");
    console.error("  verify gate: --verify wins; else the goalfile's `VERIFY: <cmd>` line; else `npm test` if package.json exists.");
    return 1;
  }
  const verify = o.verify ?? (goalVerify(o.goalFile) || (existsSync("package.json") ? "npm test" : ""));
  const progressFile = `${o.goalFile}.progress`;
  const rl = o.interactive ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  let done = 0;
  // Until-met loop: a task that fails the gate is re-attempted on the NEXT cycle
  // (with the failure fed back), not abandoned — one command drives the goal to
  // green or the hard cap. `lastFail` non-empty at exhaustion ⇒ genuinely stuck.
  let lastFail = "";

  try {
    for (let iter = 1; iter <= o.max; iter += 1) {
      const text = readFileSync(o.goalFile, "utf8");
      const m = TASK_RE.exec(text);
      if (!m) {
        console.log(`[loop] all tasks complete (${done} done this run)`);
        return 0;
      }
      const task = m[1]!;
      if (rl) {
        const ans = await rl.question(`[loop] iteration ${iter}: "${task}" — run? [y/N] `);
        if (!/^y/i.test(ans.trim())) {
          console.log("[loop] stopped by user");
          return 0;
        }
      }
      console.log(`[loop] iteration ${iter}/${o.max}: ${task}${lastFail ? " (retry — gate not green yet)" : ""}`);

      const progress = existsSync(progressFile) ? readFileSync(progressFile, "utf8") : "";
      // Agent COMMAND failure = infra error (missing binary etc.) → fail closed.
      if (!run(o.agent, buildPrompt(task, progress, lastFail))) {
        console.error(`[loop] agent command failed — stopping (task not marked done)`);
        return 1;
      }

      if (verify && !run(verify)) {
        // Not a false green: leave the box unchecked and retry it next cycle
        // until the gate passes or --max is hit.
        lastFail = `verify gate failed: \`${verify}\``;
        console.error(`[loop] "${task}" not green yet — retrying next cycle (${iter}/${o.max})`);
        continue;
      }
      lastFail = "";

      // Re-read before marking: the agent may have edited the goal file, and
      // writing the pre-agent `text` back would clobber those edits.
      const fresh = readFileSync(o.goalFile, "utf8");
      writeFileSync(o.goalFile, fresh.replace(m[0], `- [x] ${task}`));
      appendFileSync(progressFile, `[${new Date().toISOString()}] done: ${task}\n`);
      done += 1;
    }
    // Exhausted the cap. Stuck on a failing gate ⇒ not met (exit 1, no false
    // green). Otherwise just more tasks than the cap ⇒ progress, re-run to go on.
    if (lastFail) {
      console.error(`[loop] hit --max ${o.max} with the gate still red — goal NOT met (${done} done). No false green.`);
      return 1;
    }
    console.log(`[loop] hit --max ${o.max} (${done} done). Re-run to continue.`);
    return 0;
  } finally {
    rl?.close();
  }
}
