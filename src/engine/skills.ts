import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { writeAtomic } from "../atomic.js";
import { join } from "node:path";
import { scrubSecrets } from "./cleanse.js";

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
  /** Non-negotiable guardrails — propagate into every agent briefed with
   * this skill ("never run migrations directly", "ask before deleting"). */
  constraints: string[];
  uses: number;
  /** SIGNAL: outcomes reported after using the skill (Act → Measure). */
  wins: number;
  losses: number;
  updatedAt: string;
}

/** ADJUSTMENT verdict: a skill that keeps failing must be revised, not reused. */
export function skillHealth(s: Skill): "unproven" | "working" | "needs-revision" {
  const outcomes = s.wins + s.losses;
  if (outcomes < 2) return "unproven";
  return s.losses >= 2 && s.wins / outcomes < 0.5 ? "needs-revision" : "working";
}

export interface SkillsStore {
  /** Best skill for a task, or null. Bumps `uses` on hit. */
  find(task: string): Skill | null;
  /** Draft a NEW telegraphic skill skeleton for a task (not persisted). */
  draft(task: string, seedLessons: string[]): string;
  /** Persist a skill (create or update by name). */
  save(input: { name: string; body: string; triggers?: string[]; constraints?: string[] }): Skill;
  /** SIGNAL: record whether the skill actually worked (closes the loop). */
  outcome(name: string, worked: boolean, note?: string): Skill | null;
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
      const raw = JSON.parse(readFileSync(path, "utf8")) as Array<Partial<Skill> & { name: string }>;
      // forward-migrate records written before constraints/outcome fields
      return raw.map((s) => ({
        constraints: [],
        wins: 0,
        losses: 0,
        ...s,
      })) as Skill[];
    } catch {
      return [];
    }
  };
  const persist = (skills: Skill[]): void => {
    writeAtomic(path, JSON.stringify(skills, null, 2));
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
1. ground first: knitbrain_search_code the task's concepts (read ONLY the hits), then query_imports/dependents on touched files.
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
      // Security gate: a skill body must not carry a credential into the store
      // (skills are re-served into future sessions). Scrub here so every caller
      // — tool handler and internal composeSkill — is covered uniformly.
      const body = scrubSecrets(input.body);
      const existing = all.find((s) => s.name === input.name);
      if (existing) {
        existing.body = body;
        existing.triggers = [...new Set([...existing.triggers, ...triggers])];
        if (input.constraints) existing.constraints = [...new Set([...existing.constraints, ...input.constraints])];
        existing.updatedAt = new Date().toISOString();
        persist(all);
        return existing;
      }
      const skill: Skill = {
        id: createHash("sha256").update(input.name + Date.now()).digest("hex").slice(0, 8),
        name: input.name,
        triggers,
        body,
        constraints: input.constraints ?? [],
        uses: 0,
        wins: 0,
        losses: 0,
        updatedAt: new Date().toISOString(),
      };
      persist([...all, skill]);
      return skill;
    },

    outcome(name, worked, note) {
      const all = load();
      const skill = all.find((s) => s.name === name);
      if (!skill) return null;
      if (worked) skill.wins += 1;
      else skill.losses += 1;
      // A failure note is knowledge — fold it into the playbook's pitfalls so
      // the ADJUSTMENT is concrete, not just a counter.
      if (!worked && note && note.trim().length > 0) {
        const clean = scrubSecrets(note.trim());
        if (!skill.body.includes(clean)) skill.body += `\n- pitfall (reported ${new Date().toISOString().slice(0, 10)}): ${clean}`;
      }
      skill.updatedAt = new Date().toISOString();
      persist(all);
      return skill;
    },

    list: load,
  };
}
