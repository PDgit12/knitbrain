import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Knowledge } from "./knowledge.js";
import type { WikiStore } from "./wiki.js";
import { ingestTranscript, parseTranscriptTurns } from "./wiki.js";
import type { Memory } from "./memory.js";
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

export async function runOnboard(cwd: string, stores: OnboardStores, home: string = homedir()): Promise<OnboardResult> {
  // PRESENT: build the knowledge graph up front.
  const filesScanned = stores.knowledge.scan().files;

  // PAST: this project's transcripts, newest first, capped.
  const dir = projectTranscriptDir(cwd, home);
  const files = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => join(dir, f))
        .map((p) => ({ p, m: safeMtime(p) }))
        .sort((a, b) => b.m - a.m)
        .slice(0, MAX_SESSIONS)
        .map((x) => x.p)
    : [];

  let sessionsIngested = 0;
  const mined: ReturnType<typeof mineSession> = [];
  for (const file of files) {
    // Each transcript is independent: a malformed/empty one is skipped (no page,
    // no count), never aborts the whole onboard.
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
    try {
      mined.push(...mineSession(await parseSession(file)));
    } catch {
      /* mining is best-effort — a page was still ingested above */
    }
  }

  // Persist the merged learnings into typed memory (BM25), tagged so they're
  // distinguishable from in-session learnings; dedupe via recordLearning.
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
