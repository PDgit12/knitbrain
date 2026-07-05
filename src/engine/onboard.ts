import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import type { Knowledge } from "./knowledge.js";
import type { WikiStore } from "./wiki.js";
import { ingestTranscript, parseTranscriptTurns } from "./wiki.js";
import type { Memory } from "./memory.js";
import type { SkillsStore, Skill } from "./skills.js";
import { projectTranscriptDir } from "./usage.js";
import { parseSession, mineSession, mergeLearnings } from "../learn.js";
import { proposeAgents, writeAgent } from "./agents.js";
import { composeSkill, type StyleProfile } from "./host-scan.js";

/**
 * The onboard IMPORT half (the front door's first job): make the brain know the
 * project on day one instead of waking up blank. PRESENT = scan the repo into
 * the knowledge graph now (not lazily); PAST = ingest this project's existing
 * Claude transcripts into the wiki (pages + spine) and mine failure→success
 * learnings from them. FUTURE is already handled by the hooks. The intent
 * interview (Phase 3) is the second half. Reuses the existing engine fns — no
 * new parsing/mining logic. Bounded + best-effort: a malformed transcript is
 * skipped, never throws, so a huge or garbage history can't hang or crash setup.
 */

export interface OnboardResult {
  filesScanned: number;
  sessionsIngested: number;
  learningsMined: number;
}

export interface OnboardStores {
  knowledge: Knowledge;
  wiki: WikiStore;
  memory: Memory;
}

/** Cap the number of past sessions imported so a long history can't hang onboard. */
const MAX_SESSIONS = 25;

/** This project's transcript files, newest first, capped. */
function listTranscripts(cwd: string, home: string): string[] {
  const dir = projectTranscriptDir(cwd, home);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => join(dir, f))
    .map((p) => ({ p, m: safeMtime(p) }))
    .sort((a, b) => b.m - a.m)
    .slice(0, MAX_SESSIONS)
    .map((x) => x.p);
}

/**
 * SYNC subset of onboard: scan the repo + ingest the past transcripts into the
 * wiki (pages + spine). No async mining — so the MCP tool (sync dispatch) can
 * call it. Returns the files it considered so the async caller can mine them.
 */
export function scanAndIngest(
  cwd: string,
  stores: { knowledge: Knowledge; wiki: WikiStore },
  home: string = homedir(),
): { filesScanned: number; sessionsIngested: number; files: string[] } {
  const filesScanned = stores.knowledge.scan().files;
  const files = listTranscripts(cwd, home);
  let sessionsIngested = 0;
  for (const file of files) {
    // Each transcript is independent: a malformed/empty one is skipped (no page,
    // no count), never aborts the onboard.
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (parseTranscriptTurns(raw).length === 0) continue; // garbage/empty → skip
    try {
      ingestTranscript(raw, stores.wiki, `session ${baseName(file)}`);
      sessionsIngested += 1;
    } catch {
      continue;
    }
  }
  return { filesScanned, sessionsIngested, files };
}

export async function runOnboard(cwd: string, stores: OnboardStores, home: string = homedir()): Promise<OnboardResult> {
  // PRESENT + PAST (sync): scan + ingest.
  const { filesScanned, sessionsIngested, files } = scanAndIngest(cwd, stores, home);

  // Mining is async (transcript readline) — done after ingest, best-effort.
  const mined: ReturnType<typeof mineSession> = [];
  for (const file of files) {
    try {
      mined.push(...mineSession(await parseSession(file)));
    } catch {
      /* mining is best-effort — a page was still ingested above */
    }
  }

  // Persist the merged learnings into typed memory (BM25), tagged; dedupe.
  let learningsMined = 0;
  for (const l of mergeLearnings(mined)) {
    const { duplicate } = stores.memory.recordLearning({
      summary: l.text,
      lesson: `${l.category}: ${l.text}`,
      tags: ["onboarded", l.category],
    });
    if (!duplicate) learningsMined += 1;
  }

  return { filesScanned, sessionsIngested, learningsMined };
}

/** The intent interview (the closed-loop questions that shape the loop to THIS project). */
export const INTENT_QUESTIONS: readonly string[] = [
  "What is this project — what are you building? (one or two lines)",
  "Definition of done: what must be true before any task here counts as 'done'?",
  "Hard constraints: what must the agent NEVER do without your explicit OK? (one per line)",
  "Build / test / verify commands for this project?",
  "Current primary goal — what are we working toward right now?",
];

export interface IntentResult {
  page: string;
  learningId: string;
  skill: string;
  /** Parsed charter fields — fed to composeWorkflow (Gap D) without re-parsing. */
  charter: { project: string; dod: string; constraints: string; verify: string; goal: string };
}

/**
 * Persist the interview answers INTO the brain so they shape the loop and
 * re-surface every session (anti-drift): a Project Charter wiki page (claim:
 * lines the lint/charter track), an intent-tagged learning, and a constraints
 * skill whose guardrails propagate into every spawned agent.
 */
export function persistIntent(
  answers: string[],
  stores: { wiki: WikiStore; memory: Memory; skills: SkillsStore },
): IntentResult {
  const a = (i: number): string => (answers[i] ?? "").replace(/\s+/g, " ").trim() || "(unspecified)";
  const [project, dod, constraints, verify, goal] = [a(0), a(1), a(2), a(3), a(4)];
  const content =
    `Project Charter — the intent that shapes this project's loop.\n\n` +
    `- claim: project = ${project}\n` +
    `- claim: dod = ${dod}\n` +
    `- claim: constraints = ${constraints}\n` +
    `- claim: verify = ${verify}\n` +
    `- claim: goal = ${goal}`;
  const r = stores.wiki.ingest({ title: "Project Charter", kind: "concept", content });
  const { id } = stores.memory.recordLearning({
    summary: `project intent: ${project}`,
    lesson: content,
    tags: ["intent"],
  });
  // Constraints become a skill's guardrails → inherited by every briefed agent.
  const constraintItems = (answers[2] ?? "")
    .split(/[\n;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const skill: Skill = stores.skills.save({
    name: "project-constraints",
    body: "Hard constraints for this project — never violate without the user's explicit OK.",
    constraints: constraintItems.length > 0 ? constraintItems : [constraints],
  });
  return { page: r.page, learningId: id, skill: skill.name, charter: { project, dod, constraints, verify, goal } };
}

/** A capability the project LACKS that adaptive onboarding can offer to create. */
export interface OnboardGap {
  kind: "agent" | "skill";
  /** Suggested name for the thing to create. */
  name: string;
  /** Why it's a gap (one line). */
  reason: string;
  /** The conditional question to ask the user. */
  question: string;
}

/** Files that look like tests (test/spec suffix or a tests/ dir). */
export function projectHasTests(files: string[]): boolean {
  return files.some((f) => /(^|\/)tests?\//.test(f) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(f));
}

/**
 * Judge what the project LACKS: detected code domains with no covering agent,
 * plus a test-runner skill when the repo has tests but nothing test-related.
 * Returns [] when everything's covered — so a fully-covered repo asks nothing
 * extra. Pure + deterministic (Gap B). `domains` come from proposeAgents; `host`
 * is the deduped scanHostAll surface.
 */
export function computeOnboardGaps(
  domains: string[],
  host: { skills: Array<{ name: string; triggers?: string[] }>; agents: Array<{ name: string }> },
  hasTests: boolean,
): OnboardGap[] {
  const gaps: OnboardGap[] = [];
  const agentNames = host.agents.map((a) => a.name.toLowerCase());
  const covers = (kw: string): boolean =>
    agentNames.some((n) => n === kw || n.includes(kw)) ||
    host.skills.some((s) => `${s.name} ${(s.triggers ?? []).join(" ")}`.toLowerCase().includes(kw));

  for (const d of domains) {
    if (!covers(d.toLowerCase())) {
      gaps.push({
        kind: "agent",
        name: d,
        reason: `domain "${d}" has no covering agent`,
        question: `No agent covers the "${d}" domain — create a scoped agent for it? (yes/no)`,
      });
    }
  }
  if (hasTests && !covers("test")) {
    gaps.push({
      kind: "skill",
      name: "run-tests",
      reason: "project has tests but no test-runner skill",
      question: "This project has tests but no test-runner skill — compose one? (yes/no)",
    });
  }
  return gaps;
}

/**
 * Act on a "yes": compose a skill or write a scoped agent in the user's inferred
 * style. Reuses composeSkill / writeAgent — no new creation logic (ponytail).
 */
export function resolveOnboardGap(
  gap: OnboardGap,
  stores: { skills: SkillsStore; style: StyleProfile; projectRoot: string; files?: string[] },
): { kind: "agent" | "skill"; name: string; path?: string } {
  if (gap.kind === "skill") {
    const s = composeSkill(`${gap.name} for this project`, stores.style, [gap.reason], stores.skills);
    return { kind: "skill", name: s.name };
  }
  // Scope the agent to its domain's real files (src/<domain>/**) when the domain
  // exists in code — proposeAgents already computes that glob. Falls back to the
  // writeAgent default ("(whole project)") only for a pure greenfield declared
  // part with no files yet. A tight scope keeps the guardrail meaningful.
  const scope = stores.files
    ? proposeAgents(stores.files).find((prop) => prop.name.toLowerCase() === gap.name.toLowerCase())?.scope
    : undefined;
  const path = writeAgent(
    stores.projectRoot,
    { name: gap.name, description: `Agent scoped to the ${gap.name} domain.`, ...(scope ? { scope } : {}) },
    stores.style,
  );
  return { kind: "agent", name: gap.name, path };
}

/** Convenience: detected domains for a set of graph files (Gap B onboarding). */
export function detectDomains(files: string[]): string[] {
  return proposeAgents(files).map((p) => p.name);
}

/**
 * Loop-ready goal checkboxes derived from the charter goal — actionable, never
 * the vague "design + implement + verify" boilerplate. When the project has
 * real parts (detected domains or declared greenfield modules) each part is its
 * own checkbox carrying the goal; otherwise the goal itself is ONE checkbox.
 *
 * Deliberately NOT split into sub-clauses: the loop runs ONE holistic verify
 * gate after each box, so a box must independently pass the gate. Splitting a
 * single goal into "A"/"B" clauses that only pass together would stall the loop
 * on the first box — real modules are independent units; sentence clauses are not.
 */
export function goalCheckboxes(goal: string, parts: string[]): string[] {
  const g = goal.replace(/\s+/g, " ").trim() || "the current goal";
  return parts.length > 0 ? parts.map((d) => `- [ ] ${d}: ${g}`) : [`- [ ] ${g}`];
}

/**
 * Gap 5 — resume detection. Onboarding imports the transcript but never told
 * the agent WHERE the work stands, so a resumed session asked "what do I do?"
 * instead of continuing. This diffs the live signals — git (what shipped / what's
 * in flight), goal.md checkboxes (done / todo), and the last user intent — into
 * a structured brief so the brain picks up mid-stream instead of re-asking.
 */
export interface ResumeState {
  branch: string;
  /** Commit subjects on this branch not yet on main — recently DONE work. */
  shipped: string[];
  /** Uncommitted / untracked paths — IN-FLIGHT work. */
  inFlight: string[];
  /** Checked goal.md boxes — DONE. */
  goalDone: string[];
  /** Unchecked goal.md boxes — the explicit TODO. */
  goalTodo: string[];
  /** The last thing the user actually asked (newest transcript). */
  lastIntent: string;
}

/** Split a goal.md body into done ([x]) vs todo ([ ]) checkbox lines. */
export function parseGoalProgress(goalMd: string): { done: string[]; todo: string[] } {
  const done: string[] = [];
  const todo: string[] = [];
  for (const line of goalMd.split(/\r?\n/)) {
    const m = /^\s*[-*]\s*\[( |x|X)\]\s*(.+)$/.exec(line);
    if (!m) continue;
    (m[1] === " " ? todo : done).push(m[2]!.trim());
  }
  return { done, todo };
}

type GitRunner = (args: string) => string;

/** Default git runner — quiet, cwd-scoped, never throws (empty on any failure,
 * e.g. not a git repo). */
function makeGit(cwd: string): GitRunner {
  return (args) => {
    try {
      return execSync(`git ${args}`, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15_000, killSignal: "SIGKILL" }).trim();
    } catch {
      return "";
    }
  };
}

/**
 * Detect where the work stands so a resumed session CONTINUES instead of asking.
 * All signals are best-effort — a missing git repo, goal.md, or transcript each
 * degrade to empty, never throw. `git` is injectable for tests.
 */
export function detectResumeState(
  cwd: string,
  home: string = homedir(),
  opts: { git?: GitRunner } = {},
): ResumeState {
  const git = opts.git ?? makeGit(cwd);
  const branch = git("rev-parse --abbrev-ref HEAD") || "";
  // Commits ahead of main (fall back to origin/main, then the last few commits).
  const base = git("merge-base HEAD main") ? "main" : git("merge-base HEAD origin/main") ? "origin/main" : "";
  const logRange = base ? `${base}..HEAD` : "-5";
  const shipped = git(`log --oneline ${logRange}`)
    .split(/\r?\n/)
    .map((l) => l.replace(/^[0-9a-f]+\s+/, "").trim())
    .filter(Boolean);
  const inFlight = git("status --porcelain")
    .split(/\r?\n/)
    .map((l) => l.slice(3).trim())
    .filter(Boolean);
  // goal.md checkboxes (project root).
  let goalDone: string[] = [];
  let goalTodo: string[] = [];
  const goalPath = join(cwd, "goal.md");
  if (existsSync(goalPath)) {
    try {
      ({ done: goalDone, todo: goalTodo } = parseGoalProgress(readFileSync(goalPath, "utf8")));
    } catch {
      /* unreadable goal.md — leave empty */
    }
  }
  // Last user intent from the newest transcript.
  let lastIntent = "";
  const transcripts = listTranscripts(cwd, home);
  if (transcripts.length > 0) {
    try {
      const turns = parseTranscriptTurns(readFileSync(transcripts[0]!, "utf8"));
      const lastUser = [...turns].reverse().find((t) => t.role === "user" && t.text.trim().length > 0);
      if (lastUser) lastIntent = lastUser.text.replace(/\s+/g, " ").trim().slice(0, 200);
    } catch {
      /* unreadable transcript — leave empty */
    }
  }
  return { branch, shipped, inFlight, goalDone, goalTodo, lastIntent };
}

/**
 * Format the resume state as a directive that tells the agent to CONTINUE from
 * the detected point, not re-ask. Empty string when there's nothing to resume
 * (fresh repo, no work) so onboard falls back to the normal intent interview.
 */
export function resumeBrief(s: ResumeState): string {
  const hasWork = s.shipped.length > 0 || s.inFlight.length > 0 || s.goalTodo.length > 0;
  if (!hasWork) return "";
  const parts: string[] = [];
  if (s.branch) parts.push(`On branch \`${s.branch}\`.`);
  if (s.shipped.length > 0) parts.push(`DONE (${s.shipped.length} commit${s.shipped.length === 1 ? "" : "s"}): ${s.shipped.slice(0, 5).join("; ")}${s.shipped.length > 5 ? " …" : ""}.`);
  if (s.goalDone.length > 0) parts.push(`Goal boxes done: ${s.goalDone.length}.`);
  if (s.inFlight.length > 0) parts.push(`IN-FLIGHT (uncommitted): ${s.inFlight.slice(0, 8).join(", ")}${s.inFlight.length > 8 ? " …" : ""}.`);
  if (s.goalTodo.length > 0) parts.push(`TODO (goal boxes): ${s.goalTodo.slice(0, 5).join("; ")}${s.goalTodo.length > 5 ? " …" : ""}.`);
  if (s.lastIntent) parts.push(`Last ask: "${s.lastIntent}".`);
  parts.push("CONTINUE from here — resume the in-flight/TODO work; do NOT ask what to do.");
  return parts.join(" ");
}

function safeMtime(p: string): number {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

function baseName(p: string): string {
  return p.split(/[/\\]/).pop() ?? p;
}
