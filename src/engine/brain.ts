import type { Memory } from "./memory.js";
import type { Knowledge } from "./knowledge.js";
import type { WikiStore, PageKind } from "./wiki.js";
import type { SkillsStore } from "./skills.js";

/**
 * The brain facade (gap #8) — Model B: ONE thin interface OVER the typed
 * backends, not a flattening of them. Each store keeps its strength
 * (memory = BM25, knowledge = graph, wiki = synthesis spine, skills). The
 * facade only fans reads across them and routes writes to the right one while
 * dropping the unified spine line (Phase A #1). It owns no storage of its own.
 */

export type BrainSource = "memory" | "wiki" | "knowledge" | "skills";

export interface BrainHit {
  /** Which typed store this hit came from. */
  source: BrainSource;
  id: string;
  title: string;
  /** Normalized 0–1 within the merged result (per-store max-normalized). */
  score: number;
}

export type BrainWrite =
  | { kind: "learning"; summary: string; lesson: string; tags?: string[] }
  | { kind: "skill"; name: string; body: string; triggers?: string[]; constraints?: string[] }
  | { kind: "wiki"; title: string; pageKind: PageKind; content: string; links?: string[] };

export interface BrainWriteResult {
  source: BrainSource;
  id: string;
  /** Learning route only: the store deduped this write (no spine line dropped). */
  duplicate?: boolean;
}

export interface Brain {
  /** Fan a query across the relevant stores → ranked, sourced hits. */
  read(query: string, limit?: number): BrainHit[];
  /** Route a write to the correct typed store + drop the spine line. */
  write(input: BrainWrite): BrainWriteResult;
}

/** The subset of stores the facade reads/writes (a structural slice of ctx). */
export interface BrainStores {
  memory: Memory;
  knowledge: Knowledge;
  wiki?: WikiStore;
  skills?: SkillsStore;
}

const tokenize = (s: string): string[] => s.toLowerCase().match(/[a-z0-9_.-]+/g) ?? [];

/** Best-effort spine line — a wiki/disk error must never break the route. */
function logSpine(stores: BrainStores, event: string, title: string): void {
  try {
    stores.wiki?.log(event, title);
  } catch {
    /* spine is best-effort */
  }
}

export function createBrain(stores: BrainStores): Brain {
  return {
    read(query, limit = 8) {
      const terms = new Set(tokenize(query));
      const raw: BrainHit[] = [];

      // memory (BM25) — already ranked + scored.
      for (const h of stores.memory.searchLearnings(query, limit)) {
        raw.push({ source: "memory", id: h.id, title: h.summary, score: Math.max(0, h.score) });
      }

      // wiki — token overlap in title/body (synthesis layer).
      if (stores.wiki) {
        for (const p of stores.wiki.listPages()) {
          const hay = new Set(tokenize(`${p.title} ${p.body}`));
          let overlap = 0;
          for (const t of terms) if (hay.has(t)) overlap += 1;
          if (overlap > 0) raw.push({ source: "wiki", id: p.slug, title: p.title, score: overlap });
        }
      }

      // knowledge (graph) — a query token that names a scanned file surfaces its
      // blast radius, sourced as graph fact rather than text match.
      const files = stores.knowledge.listFiles();
      for (const f of files) {
        const base = f.toLowerCase();
        // Match a token to a file by exact path or trailing path segment — NOT a
        // bare suffix (which over-matches, e.g. token "ts" hitting every *.ts).
        if ([...terms].some((t) => t === base || base.endsWith(`/${t}`))) {
          const imports = stores.knowledge.queryImports(f)?.length ?? 0;
          const dependents = stores.knowledge.queryDependents(f).length;
          raw.push({ source: "knowledge", id: f, title: `imports ${imports} · dependents ${dependents}`, score: 1 + dependents });
        }
      }

      // skills — the playbook layer (one best match).
      if (stores.skills) {
        const s = stores.skills.find(query);
        if (s) raw.push({ source: "skills", id: s.name, title: s.name, score: 1 });
      }

      // Per-store max-normalize to [0,1] so BM25 scores and overlap counts merge
      // on one scale, then rank. Each hit keeps its source.
      const maxBy = new Map<BrainSource, number>();
      for (const h of raw) maxBy.set(h.source, Math.max(maxBy.get(h.source) ?? 0, h.score));
      return raw
        .map((h) => ({ ...h, score: Math.round((h.score / (maxBy.get(h.source) || 1)) * 1000) / 1000 }))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
    },

    write(input) {
      if (input.kind === "learning") {
        const { id, duplicate } = stores.memory.recordLearning({ summary: input.summary, lesson: input.lesson, ...(input.tags ? { tags: input.tags } : {}) });
        if (!duplicate) logSpine(stores, "learning", input.summary); // no spine line for a dedupe
        return { source: "memory", id, duplicate };
      }
      if (input.kind === "skill") {
        const s = stores.skills!.save({ name: input.name, body: input.body, ...(input.triggers ? { triggers: input.triggers } : {}), ...(input.constraints ? { constraints: input.constraints } : {}) });
        logSpine(stores, "skill", s.name);
        return { source: "skills", id: s.name };
      }
      // wiki: ingest already appends its own spine line — do NOT double-log.
      const r = stores.wiki!.ingest({ title: input.title, kind: input.pageKind, content: input.content, ...(input.links ? { links: input.links } : {}) });
      return { source: "wiki", id: r.page };
    },
  };
}
