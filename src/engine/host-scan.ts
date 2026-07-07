import { existsSync, readdirSync, readFileSync, statSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { writeAtomic } from "../atomic.js";
import type { SkillsStore, Skill } from "./skills.js";

/** Where a scanned artifact came from. project overrides global overrides plugin. */
export type HostSource = "project" | "global" | "plugin";

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
  /** True if p is a directory. Optional — falls back to a readDir probe. */
  isDir?: (p: string) => boolean;
}

const realIO: HostIO = {
  exists: existsSync,
  readDir: (p) => readdirSync(p),
  readFile: (p) => readFileSync(p, "utf8"),
  isDir: (p) => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  },
};

export interface HostSkill {
  name: string;
  description: string;
  triggers: string[];
  body: string;
  origin: string;
  /** Which surface it was found on (project/global/plugin). */
  source: HostSource;
}

export interface HostAgent {
  name: string;
  description: string;
  tools: string[];
  model: string;
  /** Frontmatter keys in file order — the user's scheme, for replication. */
  fmKeys?: string[];
  body: string;
  /** Which surface it was found on (project/global/plugin). */
  source: HostSource;
}

/** A slash-command definition — `.claude/commands/<name>.md` (frontmatter + body). */
export interface HostCommand {
  name: string;
  description: string;
  body: string;
  /** Which surface it was found on (project/global/plugin). */
  source: HostSource;
}

/** One event→command hook binding, flattened from settings.json / plugin hooks.json. */
export interface HostHook {
  /** Lifecycle event, e.g. SessionStart, PostToolUse, UserPromptSubmit. */
  event: string;
  /** Tool/event matcher pattern (empty = fires on all). */
  matcher: string;
  /** The shell command the hook runs. */
  command: string;
  /** Which surface it was found on (project/global/plugin). */
  source: HostSource;
}

/** An MCP connector declared in a project's or the user's global MCP config —
 * name + how it's launched, SECURITY-scrubbed to command/origin only (no env,
 * headers, url query/fragment, or auth tokens ever leave readMcpServers). */
export interface HostConnector {
  name: string;
  command: string;
  source: "project" | "global";
}

interface McpServerEntry {
  command?: string;
  args?: string[];
  url?: string;
}

/** Read one MCP config file's `mcpServers` object, guarded — missing/corrupt/
 * non-object files return {} rather than throwing (scan must never crash on a
 * hand-edited config). */
function readMcpServers(path: string): Record<string, McpServerEntry> {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { mcpServers?: unknown };
    const servers = parsed?.mcpServers;
    return servers && typeof servers === "object" ? (servers as Record<string, McpServerEntry>) : {};
  } catch {
    return {};
  }
}

/** Derive the connector's launch command, SECURITY-scrubbed: a `url` server
 * yields only its origin (new URL().origin — no query/fragment/token), never
 * headers/env. Returns null if the entry has neither command nor url. */
function connectorCommand(entry: McpServerEntry): string | null {
  if (entry.url) {
    try {
      return new URL(entry.url).origin;
    } catch {
      return null;
    }
  }
  if (entry.command) {
    return `${entry.command} ${(entry.args ?? []).join(" ")}`.trim();
  }
  return null;
}

/** Scan project + global MCP configs for declared connectors (name + launch
 * command only — never env/headers/tokens). Project configs win over global on
 * name collision; any server whose name or command mentions "knitbrain" is
 * excluded (this tool doesn't list itself in its own inventory). */
export function scanHostConnectors(cwd: string, home: string = homedir()): HostConnector[] {
  const projectFiles = [join(cwd, ".mcp.json"), join(cwd, ".cursor", "mcp.json"), join(cwd, ".vscode", "mcp.json")];
  const globalFiles = [join(home, ".claude.json"), join(home, ".cursor", "mcp.json")];

  const byName = new Map<string, HostConnector>();
  const addFrom = (files: string[], source: "project" | "global") => {
    for (const file of files) {
      const servers = readMcpServers(file);
      for (const [name, entry] of Object.entries(servers)) {
        const command = connectorCommand(entry);
        if (!command) continue;
        if (name.toLowerCase().includes("knitbrain") || command.toLowerCase().includes("knitbrain")) continue;
        if (byName.has(name)) continue; // first writer wins — project pass runs before global
        byName.set(name, { name, command, source });
      }
    }
  };
  addFrom(projectFiles, "project");
  addFrom(globalFiles, "global");
  return Array.from(byName.values());
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
export function scanHostSkills(claudeDir: string, io: HostIO = realIO, source: HostSource = "project"): HostSkill[] {
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
      source,
    });
  }
  return out;
}

/** Scan `<claudeDir>/agents/*.md`. Returns [] if the dir is absent. */
export function scanHostAgents(claudeDir: string, io: HostIO = realIO, source: HostSource = "project"): HostAgent[] {
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
      // parseFrontmatter builds `fm` in file order, so Object.keys is the user's
      // actual frontmatter scheme — captured so generated agents replicate it.
      fmKeys: Object.keys(fm),
      body,
      source,
    });
  }
  return out;
}

/** Scan `<claudeDir>/commands/*.md`. Returns [] if the dir is absent. */
export function scanHostCommands(claudeDir: string, io: HostIO = realIO, source: HostSource = "project"): HostCommand[] {
  const cmdDir = join(claudeDir, "commands");
  if (!io.exists(cmdDir)) return [];
  const out: HostCommand[] = [];
  for (const entry of io.readDir(cmdDir)) {
    if (!entry.endsWith(".md")) continue;
    const file = join(cmdDir, entry);
    let raw: string;
    try {
      raw = io.readFile(file);
    } catch {
      continue; // unreadable command — skip, never break the scan
    }
    const { fm, body } = parseFrontmatter(raw);
    out.push({
      name: asStr(fm["name"]) || entry.replace(/\.md$/, ""),
      description: asStr(fm["description"]),
      body,
      source,
    });
  }
  return out;
}

/**
 * Flatten a hooks config object — `{ Event: [{ matcher?, hooks: [{ command }] }] }`
 * — into individual event→command bindings. Shared by settings.json (project/
 * global) and plugin `hooks/hooks.json`, which both nest under a `hooks` key.
 */
function flattenHooks(hooksObj: unknown, source: HostSource, out: HostHook[]): void {
  if (!hooksObj || typeof hooksObj !== "object") return;
  for (const [event, groups] of Object.entries(hooksObj as Record<string, unknown>)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!group || typeof group !== "object") continue;
      const matcher = typeof (group as Record<string, unknown>)["matcher"] === "string" ? String((group as Record<string, unknown>)["matcher"]) : "";
      const inner = (group as Record<string, unknown>)["hooks"];
      if (!Array.isArray(inner)) continue;
      for (const h of inner) {
        const command = h && typeof h === "object" && typeof (h as Record<string, unknown>)["command"] === "string" ? String((h as Record<string, unknown>)["command"]) : "";
        if (command) out.push({ event, matcher, command, source });
      }
    }
  }
}

/**
 * Scan the host's hook bindings. For project/global surfaces that's
 * `settings.json` + `settings.local.json` (top-level `hooks` key); for a
 * plugin it's `hooks/hooks.json` (`hooks` key). Malformed JSON is skipped, not
 * fatal — a broken settings file must never break the toolkit scan.
 */
export function scanHostHooks(claudeDir: string, io: HostIO = realIO, source: HostSource = "project"): HostHook[] {
  const out: HostHook[] = [];
  const files = source === "plugin" ? [join(claudeDir, "hooks", "hooks.json")] : [join(claudeDir, "settings.json"), join(claudeDir, "settings.local.json")];
  for (const file of files) {
    if (!io.exists(file)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(io.readFile(file));
    } catch {
      continue; // malformed settings — skip, never break the scan
    }
    if (parsed && typeof parsed === "object") flattenHooks((parsed as Record<string, unknown>)["hooks"], source, out);
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
  /** The dominant `model:` value across the user's agents (e.g. "opus"), if any. */
  model?: string;
  /** User's skills carry an explicit `triggers:` line. */
  usesTriggers: boolean;
  /** Common `## ` section headers seen across bodies (most frequent first). */
  headers: string[];
  /** The user's agent frontmatter scheme — keys in their dominant order, so a
   * generated agent replicates their exact field set/order (Gap 3 fidelity).
   * Optional: absent on a hand-built profile / when no agents were scanned. */
  agentFrontmatterKeys?: string[];
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

  // Dominant model across the user's agents (most frequent non-empty value).
  const modelCount = new Map<string, number>();
  for (const a of agents) if (a.model) modelCount.set(a.model, (modelCount.get(a.model) ?? 0) + 1);
  const model = [...modelCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];

  // Dominant frontmatter scheme: the most common key ORDER across the user's
  // agents (keyed by the joined order so identical schemes aggregate).
  const schemeCount = new Map<string, number>();
  for (const a of agents) {
    const keys = a.fmKeys ?? [];
    if (keys.length > 0) schemeCount.set(keys.join(","), (schemeCount.get(keys.join(",")) ?? 0) + 1);
  }
  const dominantScheme = [...schemeCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const agentFrontmatterKeys = dominantScheme ? dominantScheme.split(",") : [];

  return {
    medianBodyLen,
    terse,
    usesModel: agents.some((a) => a.model.length > 0),
    ...(model ? { model } : {}),
    usesTriggers: skills.some((s) => s.triggers.length > 0 && s.triggers[0] !== ""),
    headers,
    agentFrontmatterKeys,
  };
}

/** Marker (stored in a skill's `constraints`) flagging it came from a host scan. */
/**
 * Context-hygiene scan (the "win on every machine"): standing host config is
 * paid on EVERY session/cache-write, and dead weight there routinely exceeds
 * what compression saves. Detects the three clutter shapes found in the wild:
 * oversized always-loaded rules, archive dirs still inside the load path, and
 * near-duplicate MCP servers (e.g. `knit-brain` + `knitbrain`).
 */
export interface HygieneReport {
  /** Human-readable findings; empty = clean. */
  findings: string[];
  /** Total bytes of always-loaded instructions (CLAUDE.md + rules/**). */
  instructionBytes: number;
}

const HYGIENE_BYTES_BUDGET = 30_000; // ~7.5k tokens of standing instructions
const ARCHIVE_DIR = /^(_archive|archive|disabled|_disabled|old|backup)$/i;

export function scanContextHygiene(home: string = homedir(), io: HostIO = realIO): HygieneReport {
  const findings: string[] = [];
  let instructionBytes = 0;
  const claudeDir = join(home, ".claude");
  const size = (p: string): number => {
    try {
      return io.readFile(p).length;
    } catch {
      return 0;
    }
  };
  if (io.exists(join(claudeDir, "CLAUDE.md"))) instructionBytes += size(join(claudeDir, "CLAUDE.md"));

  const rulesRoot = join(claudeDir, "rules");
  const isDir = io.isDir ?? ((p: string): boolean => io.exists(p) && !p.endsWith(".md"));
  const walk = (dir: string): void => {
    if (!io.exists(dir)) return;
    for (const name of io.readDir(dir)) {
      const p = join(dir, name);
      if (isDir(p)) {
        if (ARCHIVE_DIR.test(name)) {
          findings.push(`archive dir "${name}" inside ${rulesRoot} still loads every session — move it out of .claude/rules`);
        }
        walk(p);
      } else if (name.endsWith(".md")) {
        instructionBytes += size(p);
      }
    }
  };
  walk(rulesRoot);
  if (instructionBytes > HYGIENE_BYTES_BUDGET) {
    findings.push(
      `always-loaded instructions total ${Math.round(instructionBytes / 1000)}KB (> ${HYGIENE_BYTES_BUDGET / 1000}KB budget ≈ ${Math.round(HYGIENE_BYTES_BUDGET / 4 / 1000)}k tokens) — prune global CLAUDE.md/rules`,
    );
  }

  // Near-duplicate MCP servers: names equal after stripping non-alphanumerics.
  const configPath = join(home, ".claude.json");
  if (io.exists(configPath)) {
    try {
      const cfg = JSON.parse(io.readFile(configPath)) as { mcpServers?: Record<string, unknown> };
      const names = Object.keys(cfg.mcpServers ?? {});
      const seen = new Map<string, string>();
      for (const n of names) {
        const norm = n.toLowerCase().replace(/[^a-z0-9]/g, "");
        const prior = seen.get(norm);
        if (prior) findings.push(`near-duplicate MCP servers "${prior}" and "${n}" — overlapping tool sets confuse the agent; keep one`);
        else seen.set(norm, n);
      }
    } catch {
      /* unreadable host config — nothing to flag */
    }
  }
  return { findings, instructionBytes };
}

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

/** Is p a directory? Uses io.isDir when provided, else a readDir probe. */
function isDirectory(p: string, io: HostIO): boolean {
  if (io.isDir) return io.isDir(p);
  try {
    io.readDir(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Plugin roots: dirs under ~/.claude/plugins that hold a `skills/` or `agents/`
 * child. Plugins nest a few levels (marketplaces/<p>, cache/<mp>/<p>/<ver>), so
 * this walks bounded-depth and stops descending once a plugin root is found —
 * its skills/agents live right there.
 */
function pluginRoots(home: string, io: HostIO, maxDepth = 5): string[] {
  const start = join(home, ".claude", "plugins");
  if (!io.exists(start)) return [];
  const found: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth) return;
    if (io.exists(join(dir, "skills")) || io.exists(join(dir, "agents")) || io.exists(join(dir, "commands")) || io.exists(join(dir, "hooks"))) {
      found.push(dir);
      return; // don't descend past a plugin root
    }
    let entries: string[];
    try {
      entries = io.readDir(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      const child = join(dir, e);
      if (isDirectory(child, io)) walk(child, depth + 1);
    }
  };
  walk(start, 0);
  return found;
}

/**
 * Every scan root across the WHOLE user surface, tagged by source. Project
 * first so its skills/agents win on a name collision, then global (~/.claude),
 * then each plugin.
 */
export function scanRoots(projectClaudeDir: string, home: string = homedir(), io: HostIO = realIO): Array<{ dir: string; source: HostSource }> {
  const roots: Array<{ dir: string; source: HostSource }> = [{ dir: projectClaudeDir, source: "project" }];
  const globalDir = join(home, ".claude");
  if (globalDir !== projectClaudeDir) roots.push({ dir: globalDir, source: "global" });
  for (const p of pluginRoots(home, io)) roots.push({ dir: p, source: "plugin" });
  return roots;
}

/**
 * Scan project + global + every plugin, tag each result by source, and dedupe
 * by name (case-insensitive, first-wins → project beats global beats plugin).
 * This is the brain's awareness of the user's whole toolkit.
 */
export function scanHostAll(
  projectClaudeDir: string,
  home: string = homedir(),
  io: HostIO = realIO,
): { skills: HostSkill[]; agents: HostAgent[]; commands: HostCommand[]; hooks: HostHook[]; connectors: HostConnector[]; style: StyleProfile } {
  const skills: HostSkill[] = [];
  const agents: HostAgent[] = [];
  const commands: HostCommand[] = [];
  const hooks: HostHook[] = [];
  const seenSkill = new Set<string>();
  const seenAgent = new Set<string>();
  const seenCommand = new Set<string>();
  const seenHook = new Set<string>();
  for (const { dir, source } of scanRoots(projectClaudeDir, home, io)) {
    for (const s of scanHostSkills(dir, io, source)) {
      const k = s.name.toLowerCase();
      if (seenSkill.has(k)) continue;
      seenSkill.add(k);
      skills.push(s);
    }
    for (const a of scanHostAgents(dir, io, source)) {
      const k = a.name.toLowerCase();
      if (seenAgent.has(k)) continue;
      seenAgent.add(k);
      agents.push(a);
    }
    for (const c of scanHostCommands(dir, io, source)) {
      const k = c.name.toLowerCase();
      if (seenCommand.has(k)) continue;
      seenCommand.add(k);
      commands.push(c);
    }
    // Hooks dedupe on identity (event|matcher|command), not name — the same
    // binding declared on two surfaces is one hook, but distinct commands under
    // one event are all kept.
    for (const h of scanHostHooks(dir, io, source)) {
      const k = `${h.event}|${h.matcher}|${h.command}`;
      if (seenHook.has(k)) continue;
      seenHook.add(k);
      hooks.push(h);
    }
  }
  // projectClaudeDir is always `<projectRoot>/.claude` (see call sites) — the
  // connector configs (.mcp.json etc.) live at the project root, one level up.
  const connectors = scanHostConnectors(dirname(projectClaudeDir), home);
  return { skills, agents, commands, hooks, connectors, style: inferStyle(skills, agents) };
}

/**
 * Lightweight index of the user's whole toolkit — name/description/source +
 * shape, NOT full bodies. Config awareness the brain keeps across sessions
 * (Gap B reads this to judge what's missing) without bloating the skills store.
 */
export interface HostIndex {
  skills: Array<{ name: string; description: string; source: HostSource; triggers: string[] }>;
  agents: Array<{ name: string; description: string; source: HostSource; tools: string[]; model: string }>;
  commands: Array<{ name: string; description: string; source: HostSource }>;
  hooks: Array<{ event: string; matcher: string; command: string; source: HostSource }>;
  connectors: HostConnector[];
  updatedAt: string;
}

export function buildHostIndex(scan: {
  skills: HostSkill[];
  agents: HostAgent[];
  commands?: HostCommand[];
  hooks?: HostHook[];
  connectors?: HostConnector[];
}): HostIndex {
  return {
    skills: scan.skills.map((s) => ({ name: s.name, description: s.description, source: s.source, triggers: s.triggers })),
    agents: scan.agents.map((a) => ({ name: a.name, description: a.description, source: a.source, tools: a.tools, model: a.model })),
    commands: (scan.commands ?? []).map((c) => ({ name: c.name, description: c.description, source: c.source })),
    hooks: (scan.hooks ?? []).map((h) => ({ event: h.event, matcher: h.matcher, command: h.command, source: h.source })),
    connectors: scan.connectors ?? [],
    updatedAt: new Date().toISOString(),
  };
}

/** Persist the host index atomically. Creates its parent dir — a cold project
 * (nothing else has touched ~/.knitbrain/projects/<id>/ yet) must not crash
 * the onboard scan (writeAtomic intentionally does NOT mkdir). */
export function saveHostIndex(index: HostIndex, path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeAtomic(path, JSON.stringify(index, null, 2));
}

/** Load the persisted host index (the whole-toolkit inventory onboard built),
 * or null if it doesn't exist yet / is unreadable. Lets knitbrain_run surface
 * the user's own commands + hooks without a full re-scan every call. */
export function loadHostIndex(path: string): HostIndex | null {
  if (!existsSync(path)) return null;
  try {
    const idx = JSON.parse(readFileSync(path, "utf8")) as Partial<HostIndex>;
    // Forward-migrate: commands/hooks were added after the first index shape,
    // so backfill them on a legacy file rather than returning undefined arrays.
    return {
      skills: idx.skills ?? [],
      agents: idx.agents ?? [],
      commands: idx.commands ?? [],
      hooks: idx.hooks ?? [],
      connectors: idx.connectors ?? [],
      updatedAt: idx.updatedAt ?? "",
    };
  } catch {
    return null;
  }
}

/** Count artifacts per source, for the onboard greeting. */
export function countBySource(items: Array<{ source: HostSource }>): { project: number; global: number; plugin: number } {
  return {
    project: items.filter((i) => i.source === "project").length,
    global: items.filter((i) => i.source === "global").length,
    plugin: items.filter((i) => i.source === "plugin").length,
  };
}
