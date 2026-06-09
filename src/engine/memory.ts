import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** A recorded project learning. */
export interface Learning {
  id: string;
  date: string;
  summary: string;
  lesson: string;
  tags: string[];
}

/** A search hit: headline only (call getLearning for the full lesson). */
export interface LearningHeadline {
  id: string;
  summary: string;
  tags: string[];
  score: number;
}

export interface Memory {
  recordLearning(input: { summary: string; lesson: string; tags?: string[] }): {
    id: string;
    duplicate: boolean;
  };
  searchLearnings(query: string, limit?: number): LearningHeadline[];
  getLearning(id: string): Learning | undefined;
  listLearnings(): Learning[];
  saveHandoff(state: string): void;
  loadSession(): { handoff: string | null; topLearnings: LearningHeadline[] };
}

const tokenize = (s: string): string[] =>
  s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1);

function writeAtomic(path: string, data: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data, "utf8");
  renameSync(tmp, path);
}

/** Per-project, file-backed memory (learnings + handoff). Deterministic, local. */
export function createMemory(root: string): Memory {
  mkdirSync(root, { recursive: true });
  const learningsPath = join(root, "learnings.json");
  const handoffPath = join(root, "handoff.txt");

  const load = (): Learning[] => {
    if (!existsSync(learningsPath)) return [];
    try {
      return JSON.parse(readFileSync(learningsPath, "utf8")) as Learning[];
    } catch {
      return [];
    }
  };

  const headline = (l: Learning, score: number): LearningHeadline => ({
    id: l.id,
    summary: l.summary,
    tags: l.tags,
    score,
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
      };
      writeAtomic(learningsPath, JSON.stringify([...all, learning], null, 2));
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
        return headline(l, score);
      });
      return scored
        .filter((h) => h.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
    },

    getLearning(id) {
      return load().find((l) => l.id === id);
    },

    listLearnings() {
      return load();
    },

    saveHandoff(state) {
      writeAtomic(handoffPath, state);
    },

    loadSession() {
      const handoff = existsSync(handoffPath) ? readFileSync(handoffPath, "utf8") : null;
      const top = load()
        .slice(-5)
        .reverse()
        .map((l) => headline(l, 0));
      return { handoff, topLearnings: top };
    },
  };
}
