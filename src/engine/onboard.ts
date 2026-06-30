import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Knowledge } from "./knowledge.js";
import type { WikiStore } from "./wiki.js";
import { ingestTranscript, parseTranscriptTurns } from "./wiki.js";
import type { Memory } from "./memory.js";
import type { SkillsStore, Skill } from "./skills.js";
import { projectTranscriptDir } from "./usage.js";
import { parseSession, mineSession, mergeLearnings } from "../learn.js";

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
  return { page: r.page, learningId: id, skill: skill.name };
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
