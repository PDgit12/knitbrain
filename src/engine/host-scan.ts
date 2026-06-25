import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SkillsStore, Skill } from "./skills.js";

/**
 * Host-setup scan (legs 1+2): knitbrain proposes skills/agents from the code
 * graph but was blind to what the user ALREADY has. This reads the host's
 * existing `.claude/skills/<name>/SKILL.md` and `.claude/agents/<name>.md`, so knitbrain
 * can (a) register them (dedupe, never re-propose/clobber) and (b) learn the
 * user's composition style and produce new skills/agents that match it.
 *
 * Pure: filesystem access is injected (`HostIO`) so tests run on real-shaped
 * fixtures in a temp dir, no mocks of the parser itself.
 */

export interface HostIO {
  exists: (p: string) => boolean;
  readDir: (p: string) => string[];
  readFile: (p: string) => string;
}

const realIO: HostIO = {
  exists: existsSync,
  readDir: (p) => readdirSync(p),
  readFile: (p) => readFileSync(p, "utf8"),
};

export interface HostSkill {
  name: string;
  description: string;
  triggers: string[];
  body: string;
  origin: string;
}

export interface HostAgent {
  name: string;
  description: string;
  tools: string[];
  model: string;
  body: string;
}

/** A frontmatter value is a scalar or a list (`key: [a, b]` / `key: a, b`). */
type FmValue = string | string[];

/**
 * Minimal YAML frontmatter parser for the `---` block at the top of a markdown
 * file. Handles `key: value`, `key: [a, b]`, and `key: a, b` (comma lists).
 * Deliberately not a full YAML parser (ponytail) — SKILL.md / agent.md
 * frontmatter is flat key/value, so a real dep buys nothing.
 */
export function parseFrontmatter(md: string): { fm: Record<string, FmValue>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(md);
  if (!m) return { fm: {}, body: md };
  const fm: Record<string, FmValue> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1]!;
    let raw = kv[2]!.trim();
    // strip wrapping quotes on a scalar
    const bracket = /^\[(.*)\]$/.exec(raw);
    if (bracket) {
      fm[key] = splitList(bracket[1]!);
    } else if (raw.includes(",")) {
      fm[key] = splitList(raw);
    } else {
      if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
        raw = raw.slice(1, -1);
      }
      fm[key] = raw;
    }
  }
  return { fm, body: (m[2] ?? "").trim() };
}

function splitList(s: string): string[] {
  return s
    .split(",")
    .map((x) => x.trim().replace(/^["']|["']$/g, ""))
    .filter((x) => x.length > 0);
}

const asStr = (v: FmValue | undefined): string => (typeof v === "string" ? v : Array.isArray(v) ? v.join(", ") : "");
const asList = (v: FmValue | undefined): string[] => (Array.isArray(v) ? v : typeof v === "string" && v ? splitList(v) : []);

/** Scan each `skills/<name>/SKILL.md`. Returns [] if the dir is absent. */
export function scanHostSkills(claudeDir: string, io: HostIO = realIO): HostSkill[] {
  const skillsDir = join(claudeDir, "skills");
  if (!io.exists(skillsDir)) return [];
  const out: HostSkill[] = [];
  for (const entry of io.readDir(skillsDir)) {
    const file = join(skillsDir, entry, "SKILL.md");
    if (!io.exists(file)) continue;
    let raw: string;
    try {
      raw = io.readFile(file);
    } catch {
      continue; // unreadable skill — skip, never break the scan
    }
    const { fm, body } = parseFrontmatter(raw);
    const name = asStr(fm["name"]) || entry;
    out.push({
      name,
      description: asStr(fm["description"]),
      // triggers may be explicit, else fall back to the directory/name keyword
      triggers: asList(fm["triggers"]).length ? asList(fm["triggers"]) : [entry.toLowerCase()],
      body,
      origin: asStr(fm["origin"]) || "host",
    });
  }
  return out;
}

/** Scan `<claudeDir>/agents/*.md`. Returns [] if the dir is absent. */
export function scanHostAgents(claudeDir: string, io: HostIO = realIO): HostAgent[] {
  const agentsDir = join(claudeDir, "agents");
  if (!io.exists(agentsDir)) return [];
  const out: HostAgent[] = [];
  for (const entry of io.readDir(agentsDir)) {
    if (!entry.endsWith(".md")) continue;
    const file = join(agentsDir, entry);
    let raw: string;
    try {
      raw = io.readFile(file);
    } catch {
      continue;
    }
    const { fm, body } = parseFrontmatter(raw);
    out.push({
      name: asStr(fm["name"]) || entry.replace(/\.md$/, ""),
      description: asStr(fm["description"]),
      tools: asList(fm["tools"]),
      model: asStr(fm["model"]),
      body,
    });
  }
  return out;
}

/**
 * Composition style learned from the user's existing artifacts, so new ones
 * match their shape. Lightweight heuristics, not an ML model (ponytail).
 */
export interface StyleProfile {
  /** Median body length in chars — target size for composed bodies. */
  medianBodyLen: number;
  /** True if bodies skew terse (short avg line / heavy bullet use). */
  terse: boolean;
  /** User's agents carry a `model:` frontmatter line. */
  usesModel: boolean;
  /** User's skills carry an explicit `triggers:` line. */
  usesTriggers: boolean;
  /** Common `## ` section headers seen across bodies (most frequent first). */
  headers: string[];
}

export function inferStyle(skills: HostSkill[], agents: HostAgent[]): StyleProfile {
  const bodies = [...skills.map((s) => s.body), ...agents.map((a) => a.body)].filter((b) => b.length > 0);
  const lens = bodies.map((b) => b.length).sort((a, b) => a - b);
  const medianBodyLen = lens.length ? lens[Math.floor(lens.length / 2)]! : 0;

  let bulletLines = 0;
  let totalLines = 0;
  const headerCount = new Map<string, number>();
  for (const b of bodies) {
    for (const line of b.split(/\r?\n/)) {
      totalLines += 1;
      if (/^\s*[-*]\s/.test(line)) bulletLines += 1;
      const h = /^##\s+(.*)$/.exec(line.trim());
      if (h) headerCount.set(h[1]!, (headerCount.get(h[1]!) ?? 0) + 1);
    }
  }
  const terse = totalLines > 0 && bulletLines / totalLines > 0.25;
  const headers = [...headerCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([h]) => h);

  return {
    medianBodyLen,
    terse,
    usesModel: agents.some((a) => a.model.length > 0),
    usesTriggers: skills.some((s) => s.triggers.length > 0 && s.triggers[0] !== ""),
    headers,
  };
}

/** Marker (stored in a skill's `constraints`) flagging it came from a host scan. */
export const HOST_IMPORT_MARK = "imported:host";

/**
 * Register scanned host skills into knitbrain's SkillsStore so they're visible
 * to `find`/`run`. Dedupe by name (case-insensitive) against what's already
 * stored — re-running setup adds nothing and never clobbers user edits.
 */
export function registerHostSkills(scanned: HostSkill[], store: SkillsStore): { added: number; skipped: number } {
  const existing = new Set(store.list().map((s) => s.name.toLowerCase()));
  let added = 0;
  let skipped = 0;
  for (const hs of scanned) {
    if (existing.has(hs.name.toLowerCase())) {
      skipped += 1;
      continue;
    }
    store.save({ name: hs.name, body: hs.body, triggers: hs.triggers, constraints: [HOST_IMPORT_MARK] });
    existing.add(hs.name.toLowerCase());
    added += 1;
  }
  return { added, skipped };
}

/**
 * Compose a NEW project-tailored skill in the user's style: draft a skeleton
 * for the task, shape it toward the learned profile (trim toward terse/median
 * length when the user writes terse), then persist.
 */
export function composeSkill(
  task: string,
  style: StyleProfile,
  seedLessons: string[],
  store: SkillsStore,
): Skill {
  let body = store.draft(task, seedLessons);
  if (style.terse && style.medianBodyLen > 0 && body.length > style.medianBodyLen * 1.5) {
    // user writes tight — keep the lead, mark the elision honestly
    body = body.slice(0, style.medianBodyLen).trimEnd() + "\n… (tightened to match your skill style)";
  }
  return store.save({ name: task.slice(0, 48), body, triggers: keywords(task) });
}

function keywords(task: string): string[] {
  return task.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2).slice(0, 6);
}

/** One-shot scan of a project's `.claude` dir for the setup/run surface. */
export function scanHost(claudeDir: string, io: HostIO = realIO): { skills: HostSkill[]; agents: HostAgent[]; style: StyleProfile } {
  const skills = scanHostSkills(claudeDir, io);
  const agents = scanHostAgents(claudeDir, io);
  return { skills, agents, style: inferStyle(skills, agents) };
}
