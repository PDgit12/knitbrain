import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * `knitbrain fan <goalfile>` — the PARALLEL outer loop. The single-worker loop
 * (`knitbrain loop`) drains a checkbox queue one task at a time; `fan` runs N
 * workers concurrently, each in its own git worktree (so parallel agent edits
 * never collide), draining the same queue. Matt Pocock's model: a queue with
 * multiple AFK workers + human-in-loop at merge — knitbrain coordinates, the
 * host agent does the work, and it NEVER merges or pushes (the human does).
 */

/** Parse the open `- [ ]` tasks (the queue). */
export function parseTasks(text: string): string[] {
  return [...text.matchAll(/^- \[ \] (.+)$/gm)].map((m) => m[1]!);
}

/** Mark one task done. Returns the new text (or unchanged if not found). */
export function markDone(text: string, task: string): string {
  return text.replace(`- [ ] ${task}`, `- [x] ${task}`);
}

interface FanOpts {
  goalFile?: string;
  workers: number;
  agent: string;
  verify: string | null;
  max: number;
  isolate: boolean;
}

function parseArgs(args: string[]): FanOpts {
  const o: FanOpts = { workers: 3, agent: "claude -p", verify: null, max: 50, isolate: true };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === "--workers") o.workers = Math.max(1, Number(args[(i += 1)]) || 3);
    else if (a === "--agent") o.agent = args[(i += 1)] ?? o.agent;
    else if (a === "--verify") o.verify = args[(i += 1)] ?? null;
    else if (a === "--max") o.max = Math.max(1, Number(args[(i += 1)]) || 50);
    else if (a === "--no-isolate") o.isolate = false;
    else if (a && !a.startsWith("--")) o.goalFile = a;
  }
  return o;
}

/** Run a shell command in `cwd`; resolve true on exit 0. Never rejects. */
function run(cmd: string, cwd: string, input?: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(cmd, { shell: true, cwd, stdio: input === undefined ? "inherit" : ["pipe", "inherit", "inherit"] });
    if (input !== undefined && child.stdin) {
      child.stdin.write(input);
      child.stdin.end();
    }
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });
}

/** Create an isolated git worktree for a worker; return its dir, or cwd on failure. */
function worktreeFor(id: number, isolate: boolean): string {
  if (!isolate) return process.cwd();
  const dir = join(process.cwd(), ".knitbrain", "worktrees", `fan-worker-${id}`);
  if (existsSync(dir)) return dir;
  mkdirSync(join(process.cwd(), ".knitbrain", "worktrees"), { recursive: true });
  const branch = `knit/fan-worker-${id}`;
  // stdio:"ignore" (in spawnSyncQuiet) already suppresses output — no unix-only
  // `2>/dev/null` needed; `||` works under cmd.exe too, so this stays cross-platform.
  const ok = spawnSyncQuiet(`git worktree add -b ${branch} "${dir}" || git worktree add "${dir}" "${branch}"`);
  return ok && existsSync(dir) ? dir : process.cwd();
}

function spawnSyncQuiet(cmd: string): boolean {
  try {
    return spawnSync(cmd, { shell: true, stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

function buildPrompt(task: string): string {
  return [
    "You are ONE worker in a parallel build. Do EXACTLY this one task, then stop:",
    "",
    task,
    "",
    "Work only within this worktree. Do NOT commit, push, merge, or touch other tasks.",
    "The orchestrator verifies and marks the task done.",
  ].join("\n");
}

export async function runFan(args: string[]): Promise<number> {
  const o = parseArgs(args);
  if (!o.goalFile || !existsSync(o.goalFile)) {
    console.error('usage: knitbrain fan <goalfile.md> [--workers N=3] [--agent "cmd"] [--verify "cmd"] [--max M=50] [--no-isolate]');
    return 1;
  }
  const goalFile = o.goalFile;
  const verify = o.verify ?? (existsSync("package.json") ? "npm test" : "");
  const queue = parseTasks(readFileSync(goalFile, "utf8"));
  if (queue.length === 0) {
    console.log("[fan] no open tasks");
    return 0;
  }
  console.log(`[fan] ${queue.length} tasks · ${o.workers} workers · verify: ${verify || "(none)"} · isolate: ${o.isolate}`);

  let completed = 0;
  let failed = false;
  const branches: string[] = [];

  const worker = async (id: number): Promise<void> => {
    const cwd = worktreeFor(id, o.isolate);
    if (o.isolate && cwd !== process.cwd()) branches.push(`knit/fan-worker-${id}`);
    for (;;) {
      if (completed >= o.max) return;
      const task = queue.shift(); // atomic in single-threaded JS — no double-claim
      if (task === undefined) return;
      console.log(`[fan] w${id} → ${task}`);
      if (!(await run(o.agent, cwd, buildPrompt(task)))) {
        console.error(`[fan] w${id}: agent failed on "${task}" — left unmarked`);
        failed = true;
        continue;
      }
      if (verify && !(await run(verify, cwd))) {
        console.error(`[fan] w${id}: verify failed on "${task}" — NOT marked (no false green)`);
        failed = true;
        continue;
      }
      // Mark done synchronously (read+write in one tick = atomic across workers).
      writeFileSync(goalFile, markDone(readFileSync(goalFile, "utf8"), task));
      completed += 1;
      console.log(`[fan] w${id} ✓ ${task}`);
    }
  };

  await Promise.all(Array.from({ length: o.workers }, (_, i) => worker(i + 1)));

  console.log(`[fan] done: ${completed} task(s) completed${failed ? " (some failed — see above)" : ""}`);
  if (branches.length > 0) {
    console.log(`[fan] worker branches (review + merge yourself — fan never merges/pushes):`);
    for (const b of branches) console.log(`        ${b}`);
    console.log(`[fan] clean up worktrees with: git worktree prune && git worktree list`);
  }
  return failed ? 1 : 0;
}
