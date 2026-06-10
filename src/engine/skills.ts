import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Skills engine — find-or-write executable playbooks.
 *
 * Skills are made ON-DEMAND when the user states a task (never pre-installed,
 * never downloaded): knitbrain drafts a telegraphic (caveman-method) playbook
 * seeded from past learnings, the agent refines it while working, and the
 * refined version is saved back. Skills persist and compound; agents are
 * disposable workers briefed with them.
 */
export interface Skill {
  id: string;
  name: string;
  /** Trigger keywords for matching future tasks. */
  triggers: string[];
  /** Telegraphic playbook body (caveman-method: max knowledge per token). */
  body: string;
  uses: number;
  updatedAt: string;
}

export interface SkillsStore {
  /** Best skill for a task, or null. Bumps `uses` on hit. */
  find(task: string): Skill | null;
  /** Draft a NEW telegraphic skill skeleton for a task (not persisted). */
  draft(task: string, seedLessons: string[]): string;
  /** Persist a skill (create or update by name). */
  save(input: { name: string; body: string; triggers?: string[] }): Skill;
  list(): Skill[];
}

const tokenize = (s: string): string[] =>
  s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2);

export function createSkillsStore(root: string): SkillsStore {
  mkdirSync(root, { recursive: true });
  const path = join(root, "skills.json");

  const load = (): Skill[] => {
    if (!existsSync(path)) return [];
    try {
      return JSON.parse(readFileSync(path, "utf8")) as Skill[];
    } catch {
      return [];
    }
  };
  const persist = (skills: Skill[]): void => {
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(skills, null, 2), "utf8");
    renameSync(tmp, path);
  };

  return {
    find(task) {
      const terms = new Set(tokenize(task));
      let best: Skill | null = null;
      let bestScore = 0;
      const all = load();
      for (const s of all) {
        let score = 0;
        for (const t of s.triggers) if (terms.has(t)) score += 2;
        for (const t of tokenize(s.name)) if (terms.has(t)) score += 1;
        if (score > bestScore) {
          best = s;
          bestScore = score;
        }
      }
      if (best && bestScore >= 2) {
        best.uses += 1;
        persist(all);
        return best;
      }
      return null;
    },

    draft(task, seedLessons) {
      // Telegraphic skeleton (caveman method): no filler, fragments OK,
      // sections the agent fills while working, then saves via skill_save.
      const pitfalls =
        seedLessons.length > 0
          ? seedLessons.map((l) => `- ${l}`).join("\n")
          : "- (none known. add what bites.)";
      return `# skill: ${task.slice(0, 64)}

GOAL: ${task}

STEPS:
1. ground first: query_imports/dependents on touched files.
2. smallest correct change. verify before claim.
3. gates green before done.

CHECKS:
- lossless? never-expand? tests pass?

PITFALLS (from memory):
${pitfalls}

AFTER: refine this skill w/ what you learned → knitbrain_skill_save (same name). Skill compound.`;
    },

    save(input) {
      const all = load();
      const triggers =
        input.triggers && input.triggers.length > 0 ? input.triggers : tokenize(input.name);
      const existing = all.find((s) => s.name === input.name);
      if (existing) {
        existing.body = input.body;
        existing.triggers = [...new Set([...existing.triggers, ...triggers])];
        existing.updatedAt = new Date().toISOString();
        persist(all);
        return existing;
      }
      const skill: Skill = {
        id: createHash("sha256").update(input.name + Date.now()).digest("hex").slice(0, 8),
        name: input.name,
        triggers,
        body: input.body,
        uses: 0,
        updatedAt: new Date().toISOString(),
      };
      persist([...all, skill]);
      return skill;
    },

    list: load,
  };
}
