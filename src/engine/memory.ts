import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { writeAtomic } from "../atomic.js";

/** Handoff freshness: flag a handoff older than this, auto-clear past the hard limit. */
const HANDOFF_STALE_DAYS = 7;
const HANDOFF_CLEAR_DAYS = 14;
import { join } from "node:path";

/** A recorded project learning. */
export interface Learning {
  id: string;
  date: string;
  summary: string;
  lesson: string;
  tags: string[];
  /** SIGNAL: times this learning was reported useful when recalled. */
  helpful: number;
  /** SIGNAL: times it was reported wrong/unhelpful (discredits it). */
  unhelpful: number;
}

/** A search hit: headline only (call getLearning for the full lesson). */
export interface LearningHeadline {
  id: string;
  summary: string;
  tags: string[];
  score: number;
  /** Net usefulness (helpful − unhelpful) — lets callers see what's proven. */
  net: number;
}

/** ADJUSTMENT verdict: a learning reported wrong repeatedly is discredited and
 * sinks in ranking instead of misleading every future recall. */
export function learningHealth(l: Learning): "unproven" | "proven" | "discredited" {
  if (l.unhelpful >= 2 && l.unhelpful > l.helpful) return "discredited";
  return l.helpful >= 2 ? "proven" : "unproven";
}

export interface Memory {
  recordLearning(input: { summary: string; lesson: string; tags?: string[] }): {
    id: string;
    duplicate: boolean;
  };
  searchLearnings(query: string, limit?: number): LearningHeadline[];
  getLearning(id: string): Learning | undefined;
  listLearnings(): Learning[];
  /** SIGNAL: report whether a recalled learning actually helped. Closes the
   * loop — a wrong learning gets discredited and demoted, a useful one rises. */
  learningOutcome(id: string, helpful: boolean, note?: string): Learning | null;
  saveHandoff(state: string): void;
  loadSession(): {
    handoff: string | null;
    /** When the handoff was saved (null for a legacy undated handoff). */
    handoffSavedAt: string | null;
    /** True if the handoff is old enough to distrust before resuming. */
    handoffStale: boolean;
    topLearnings: LearningHeadline[];
  };
}

const tokenize = (s: string): string[] =>
  s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1);


/** Per-project, file-backed memory (learnings + handoff). Deterministic, local. */
export function createMemory(root: string): Memory {
  mkdirSync(root, { recursive: true });
  const learningsPath = join(root, "learnings.json");
  const handoffPath = join(root, "handoff.txt");

  const load = (): Learning[] => {
    if (!existsSync(learningsPath)) return [];
    try {
      const raw = JSON.parse(readFileSync(learningsPath, "utf8")) as Array<Partial<Learning>>;
      // Forward-migrate records written before the signal fields existed.
      return raw.map((l) => ({ helpful: 0, unhelpful: 0, ...l })) as Learning[];
    } catch {
      return [];
    }
  };

  const persist = (all: Learning[]): void =>
    writeAtomic(learningsPath, JSON.stringify(all, null, 2));

  const headline = (l: Learning, score: number): LearningHeadline => ({
    id: l.id,
    summary: l.summary,
    tags: l.tags,
    score,
    net: l.helpful - l.unhelpful,
  });

  return {
    recordLearning(input) {
      const all = load();
      const summary = input.summary.trim();
      // Dedup by substring match on summary (mirrors engram behavior).
      const dup = all.find(
        (l) => l.summary.includes(summary) || summary.includes(l.summary),
      );
      if (dup) return { id: dup.id, duplicate: true };

      const id = createHash("sha256")
        .update(summary + Date.now())
        .digest("hex")
        .slice(0, 12);
      const learning: Learning = {
        id,
        date: new Date().toISOString().slice(0, 10),
        summary,
        lesson: input.lesson,
        tags: input.tags ?? [],
        helpful: 0,
        unhelpful: 0,
      };
      persist([...all, learning]);
      return { id, duplicate: false };
    },

    searchLearnings(query, limit = 5) {
      const terms = new Set(tokenize(query));
      if (terms.size === 0) return [];
      const scored = load().map((l) => {
        const summaryTerms = new Set(tokenize(l.summary + " " + l.tags.join(" ")));
        const lessonTerms = new Set(tokenize(l.lesson));
        let score = 0;
        for (const t of terms) {
          if (summaryTerms.has(t)) score += 2; // headline/tag match weighted higher
          else if (lessonTerms.has(t)) score += 1;
        }
        return { l, score };
      });
      // ADJUSTMENT: among term matches, proven learnings (net helpful) rise and
      // discredited ones sink — recall is ranked by outcome, not just keywords.
      // Term match still gates relevance (score > 0); usefulness only re-orders.
      return scored
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score + b.l.helpful - b.l.unhelpful * 2 - (a.score + a.l.helpful - a.l.unhelpful * 2))
        .slice(0, limit)
        .map((s) => headline(s.l, s.score));
    },

    getLearning(id) {
      return load().find((l) => l.id === id);
    },

    learningOutcome(id, helpful, note) {
      const all = load();
      const l = all.find((x) => x.id === id);
      if (!l) return null;
      if (helpful) l.helpful += 1;
      else l.unhelpful += 1;
      // A correction is itself knowledge: fold it into the lesson so the next
      // recall carries the fix, not just a lower score.
      if (!helpful && note && note.trim().length > 0 && !l.lesson.includes(note)) {
        l.lesson += `\n- correction (${new Date().toISOString().slice(0, 10)}): ${note.trim()}`;
      }
      persist(all);
      return l;
    },

    listLearnings() {
      return load();
    },

    saveHandoff(state) {
      // Timestamped so loadSession can detect a stale handoff (a weeks-old
      // resume poisons the next session — the protocol's own warning).
      writeAtomic(handoffPath, JSON.stringify({ state, savedAt: new Date().toISOString() }));
    },

    loadSession() {
      let handoff: string | null = null;
      let handoffSavedAt: string | null = null;
      let handoffStale = false;
      if (existsSync(handoffPath)) {
        const raw = readFileSync(handoffPath, "utf8");
        let savedAt: string | null = null;
        try {
          const parsed = JSON.parse(raw) as { state?: string; savedAt?: string };
          if (parsed && typeof parsed.state === "string") {
            handoff = parsed.state;
            savedAt = typeof parsed.savedAt === "string" ? parsed.savedAt : null;
          } else {
            handoff = raw; // JSON, but not our shape — treat verbatim
          }
        } catch {
          handoff = raw; // legacy bare-string handoff (undated)
        }
        if (savedAt) {
          const ageDays = (Date.now() - Date.parse(savedAt)) / 86_400_000;
          if (ageDays > HANDOFF_CLEAR_DAYS) {
            rmSync(handoffPath, { force: true }); // too old to trust — auto-clear
            handoff = null;
          } else {
            handoffSavedAt = savedAt;
            handoffStale = ageDays > HANDOFF_STALE_DAYS;
          }
        } else {
          // Legacy undated handoff: keep (may still be relevant) but flag stale.
          handoffStale = true;
        }
      }
      // ADJUSTMENT: resume with the most PROVEN learnings first (net helpful),
      // recency breaking ties — not just whatever was recorded last. A
      // discredited learning never leads the next session.
      const all = load();
      const top = all
        .map((l, i) => ({ l, i }))
        .sort((a, b) => b.l.helpful - b.l.unhelpful - (a.l.helpful - a.l.unhelpful) || b.i - a.i)
        .slice(0, 5)
        .map(({ l }) => headline(l, 0));
      return { handoff, handoffSavedAt, handoffStale, topLearnings: top };
    },
  };
}
