import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "../atomic.js";

/**
 * Wiki-brain (leg 5): a compounding markdown knowledge base the LLM maintains.
 * Unlike RAG (re-derive on every query), the wiki is a persistent artifact —
 * ingest integrates a source into pages + cross-refs + the index once, and it
 * stays current. Three files on disk per project:
 *   index.md  — content catalog (rebuilt from page frontmatter on every ingest)
 *   log.md    — append-only chronicle (`## [date] event | title`) = the
 *               per-session log (leg 3); load_session surfaces recent entries
 *   pages/<slug>.md — one page per entity/concept/summary/session
 *
 * Pages are terse (caveman-method: max knowledge per token). Lossless source
 * recovery is the CCR's job, not the wiki's — the wiki is the synthesis layer.
 */

export type PageKind = "session" | "entity" | "concept" | "summary";

export interface IngestInput {
  title: string;
  kind: PageKind;
  /** Terse body (the synthesis, not the raw source). */
  content: string;
  /** Other page titles this one references → become `[[wiki-links]]`. */
  links?: string[];
}

export interface LintReport {
  /** Same claim key with conflicting values across pages (incl. stale-over-time). */
  contradictions: string[];
  /** Pages no other page links to (dead ends). */
  orphans: string[];
}

/** One parsed page, exposed for the browsable dashboard view (gap #3). */
export interface WikiPage {
  slug: string;
  kind: string;
  title: string;
  /** Raw markdown body (no frontmatter). Rendered to HTML mechanically by the view. */
  body: string;
  /** Slugs this page links to via `[[…]]`. */
  links: string[];
}

export interface WikiStore {
  ingest(input: IngestInput): { page: string; touched: string[] };
  log(event: string, title: string): void;
  recentLog(n: number): string[];
  page(slug: string): string | null;
  /** All pages parsed (slug/kind/title/body/links) — for the browsable view. */
  listPages(): WikiPage[];
  index(): string;
  lint(): LintReport;
}

export function slug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "page";
}

interface TranscriptLine {
  type?: string;
  message?: { content?: unknown };
}

/** Extract user/assistant text turns from a real host transcript (.jsonl). */
export function parseTranscriptTurns(rawJsonl: string): Array<{ role: string; text: string }> {
  const turns: Array<{ role: string; text: string }> = [];
  for (const line of rawJsonl.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let o: TranscriptLine;
    try {
      o = JSON.parse(line) as TranscriptLine;
    } catch {
      continue;
    }
    if (o.type !== "user" && o.type !== "assistant") continue;
    const c = o.message?.content;
    let text = "";
    if (typeof c === "string") text = c;
    else if (Array.isArray(c)) text = c.map((b) => (b && typeof (b as { text?: unknown }).text === "string" ? (b as { text: string }).text : "")).join(" ").trim();
    if (text) turns.push({ role: o.type, text });
  }
  return turns;
}

/**
 * Ingest a REAL host session transcript into the wiki: synthesize a terse
 * session page (first prompt + turn count + files touched), cross-reference
 * the files it mentions (stub pages), and log it. This is the whole-chat → wiki
 * path; the per-turn live chronicle is the UserPromptSubmit hook.
 */
export function ingestTranscript(rawJsonl: string, wiki: WikiStore, title = `session ${today()}`): { page: string; turns: number; touched: string[] } {
  const turns = parseTranscriptTurns(rawJsonl);
  const firstPrompt = (turns.find((t) => t.role === "user")?.text ?? "session").replace(/\s+/g, " ").slice(0, 80);
  const files = [...new Set([...rawJsonl.matchAll(/\b([\w.-]+\.(?:ts|tsx|js|mjs|py|go|rs|md|json))\b/g)].map((m) => m[1]!))].slice(0, 8);
  const content =
    `Session: ${firstPrompt}\n` +
    `- claim: turns = ${turns.length}\n` +
    `files: ${files.join(", ") || "(none)"}`;
  const r = wiki.ingest({ title, kind: "session", content, links: files.map((f) => f.split("/").pop() ?? f) });
  return { page: r.page, turns: turns.length, touched: r.touched };
}

const today = (): string => new Date().toISOString().slice(0, 10);

interface ParsedPage {
  slug: string;
  kind: string;
  title: string;
  summary: string;
  links: string[];
  claims: Array<{ key: string; value: string }>;
  body: string;
}

export function createWikiStore(root: string): WikiStore {
  const pagesDir = join(root, "pages");
  const indexPath = join(root, "index.md");
  const logPath = join(root, "log.md");
  mkdirSync(pagesDir, { recursive: true });

  const pagePath = (s: string): string => join(pagesDir, `${s}.md`);

  const parsePage = (s: string): ParsedPage | null => {
    const p = pagePath(s);
    if (!existsSync(p)) return null;
    const raw = readFileSync(p, "utf8");
    const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
    const fm: Record<string, string> = {};
    let body = raw;
    if (m) {
      body = (m[2] ?? "").trim();
      for (const line of m[1]!.split(/\r?\n/)) {
        const kv = /^([a-z]+):\s*(.*)$/.exec(line);
        if (kv) fm[kv[1]!] = kv[2]!.trim();
      }
    }
    const links = [...body.matchAll(/\[\[([^\]]+)\]\]/g)].map((x) => slug(x[1]!));
    // claims: lines like `- claim: <key> = <value>`
    const claims = [...body.matchAll(/^[-*]\s*claim:\s*(.+?)\s*=\s*(.+)$/gim)].map((x) => ({
      key: x[1]!.trim().toLowerCase(),
      value: x[2]!.trim().toLowerCase(),
    }));
    return { slug: s, kind: fm["kind"] ?? "summary", title: fm["title"] ?? s, summary: fm["summary"] ?? "", links, claims, body };
  };

  const allPages = (): ParsedPage[] =>
    readdirSync(pagesDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => parsePage(f.replace(/\.md$/, "")))
      .filter((p): p is ParsedPage => p !== null);

  const rebuildIndex = (): void => {
    const pages = allPages();
    const byKind = new Map<string, ParsedPage[]>();
    for (const p of pages) {
      const arr = byKind.get(p.kind);
      if (arr) arr.push(p);
      else byKind.set(p.kind, [p]);
    }
    let out = `# Wiki Index\n\n${pages.length} page(s).\n`;
    for (const kind of [...byKind.keys()].sort()) {
      out += `\n## ${kind}\n`;
      for (const p of byKind.get(kind)!.sort((a, b) => a.title.localeCompare(b.title))) {
        out += `- [[${p.slug}]] — ${p.summary || p.title}\n`;
      }
    }
    writeAtomic(indexPath, out);
  };

  return {
    ingest(input) {
      const s = slug(input.title);
      const links = (input.links ?? []).map(slug);
      const summary = input.content.split(/\r?\n/).find((l) => l.trim().length > 0)?.slice(0, 100) ?? input.title;
      const fm = `---\nkind: ${input.kind}\ntitle: ${input.title}\ndate: ${today()}\nsummary: ${summary.replace(/\n/g, " ")}\n---\n`;
      const linkLine = links.length ? `\nrelated: ${links.map((l) => `[[${l}]]`).join(" · ")}\n` : "";
      writeAtomic(pagePath(s), `${fm}\n${input.content.trim()}\n${linkLine}`);
      const touched = [s];
      // Stub any linked page that doesn't exist yet (so cross-refs resolve).
      for (const l of links) {
        if (!existsSync(pagePath(l))) {
          writeAtomic(pagePath(l), `---\nkind: entity\ntitle: ${l}\ndate: ${today()}\nsummary: (stub — referenced by [[${s}]])\n---\n\n(stub)\n`);
          touched.push(l);
        }
      }
      rebuildIndex();
      this.log("ingest", input.title);
      return { page: s, touched };
    },

    log(event, title) {
      const line = `## [${today()}] ${event} | ${title}\n`;
      const prior = existsSync(logPath) ? readFileSync(logPath, "utf8") : "# Wiki Log\n\n";
      writeAtomic(logPath, prior + line);
    },

    recentLog(n) {
      if (!existsSync(logPath)) return [];
      return readFileSync(logPath, "utf8")
        .split(/\r?\n/)
        .filter((l) => l.startsWith("## ["))
        .slice(-n);
    },

    page(s) {
      const p = pagePath(slug(s));
      return existsSync(p) ? readFileSync(p, "utf8") : null;
    },

    listPages() {
      return allPages().map((p) => ({ slug: p.slug, kind: p.kind, title: p.title, body: p.body, links: p.links }));
    },

    index() {
      return existsSync(indexPath) ? readFileSync(indexPath, "utf8") : "";
    },

    lint() {
      const pages = allPages();
      // contradictions: same claim key, different values, across pages
      const byKey = new Map<string, Map<string, string[]>>(); // key → value → [slugs]
      for (const p of pages) {
        for (const c of p.claims) {
          const vmap = byKey.get(c.key) ?? new Map<string, string[]>();
          (vmap.get(c.value) ?? vmap.set(c.value, []).get(c.value)!).push(p.slug);
          byKey.set(c.key, vmap);
        }
      }
      const contradictions: string[] = [];
      for (const [key, vmap] of byKey) {
        if (vmap.size > 1) {
          const parts = [...vmap.entries()].map(([v, slugs]) => `${v} (${slugs.join(",")})`);
          contradictions.push(`claim "${key}": ${parts.join(" vs ")}`);
        }
      }
      // orphans: a page no OTHER page links to
      const linkedTo = new Set<string>();
      for (const p of pages) for (const l of p.links) if (l !== p.slug) linkedTo.add(l);
      const orphans = pages.filter((p) => !linkedTo.has(p.slug)).map((p) => p.slug);
      return { contradictions, orphans };
    },
  };
}
