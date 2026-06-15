import { createReadStream, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline";

/**
 * `knitbrain learn` — offline failure mining with success correlation.
 *
 * Scans real session transcripts, finds tool calls that FAILED, correlates
 * each failure with what later SUCCEEDED, and emits specific corrections
 * ("X is at b/, not a/" — not "Read failed 5 times"). Dry-run by default;
 * --apply writes a marker-managed section into the project's CLAUDE.md so
 * the next session starts already knowing.
 */

interface ToolEvent {
  tool: string;
  input: Record<string, unknown>;
  error: boolean;
  errText: string;
  seq: number;
}

export interface Learning {
  category: "paths" | "commands" | "environment" | "large-files";
  text: string;
  /** Occurrences across sessions — more evidence, higher in the list. */
  count: number;
}

const FAIL_TEXT =
  /\b(does not exist|No such file|not found|command not found|ModuleNotFoundError|No module named|ENOENT|Permission denied|is a directory|InputValidationError)\b/i;
const TOO_LARGE = /\b(exceeds maximum|too large|File content \(\d+|truncated)\b/i;

/** Secrets must never reach CLAUDE.md (it's often committed). */
const SECRET = /\b(hf_|sk-|ghp_|gho_|github_pat_|xox[abps]-|AKIA|ASIA)[A-Za-z0-9_-]{8,}/;
const SECRET_WORDS = /\b(password|secret|api[_-]?key|token)\s*[:=]/i;

/** A learning is publishable only if it's short, single-line, and secret-free. */
function publishable(text: string): boolean {
  return text.length <= 220 && !text.includes("\n") && !SECRET.test(text) && !SECRET_WORDS.test(text);
}

/** Generic basenames that collide across unrelated files — useless as anchors. */
const GENERIC_BASENAMES = new Set([
  "route.ts",
  "route.js",
  "index.ts",
  "index.js",
  "index.tsx",
  "page.tsx",
  "layout.tsx",
  "main.py",
  "main.go",
  "mod.rs",
  "lib.rs",
  "__init__.py",
  "types.ts",
  "utils.ts",
  "README.md",
  "CLAUDE.md",
  "package.json",
]);

/** Parse one transcript: ordered tool events (use+result matched by id). */
export async function parseSession(file: string): Promise<ToolEvent[]> {
  const uses = new Map<string, { tool: string; input: Record<string, unknown> }>();
  const events: ToolEvent[] = [];
  let seq = 0;
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    const content = (msg as { message?: { content?: unknown } })?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content as Array<Record<string, unknown>>) {
      if (block["type"] === "tool_use" && typeof block["id"] === "string") {
        uses.set(block["id"], {
          tool: String(block["name"] ?? ""),
          input: (block["input"] as Record<string, unknown>) ?? {},
        });
      }
      if (block["type"] === "tool_result" && typeof block["tool_use_id"] === "string") {
        const use = uses.get(block["tool_use_id"]);
        if (!use) continue;
        const raw = block["content"];
        const text =
          typeof raw === "string"
            ? raw
            : Array.isArray(raw)
              ? (raw as Array<{ type?: string; text?: string }>)
                  .filter((b) => b.type === "text")
                  .map((b) => b.text ?? "")
                  .join("\n")
              : "";
        // Trust the explicit flag; the regex is only a fallback when the
        // transcript doesn't carry one (ordinary output often CONTAINS the
        // words "not found" without being a failure).
        const error =
          block["is_error"] === true ||
          (block["is_error"] === undefined && FAIL_TEXT.test(text.slice(0, 500)));
        events.push({ tool: use.tool, input: use.input, error, errText: text.slice(0, 500), seq: (seq += 1) });
      }
    }
  }
  return events;
}

/**
 * The FILE a command targets (a token with a path-like extension), ignoring
 * redirections and pipe tails. High precision beats recall here: a wrong
 * "correction" in CLAUDE.md misleads every future session.
 */
function targetFile(cmd: string): string {
  const m = /(?:^|\s)((?:[\w./~-]+\/)?[\w.-]+\.(?:py|ts|tsx|js|mjs|go|rs|java|rb|sh|json|yml|yaml|toml|md))(?=\s|$)/.exec(
    cmd,
  );
  return m?.[1] ?? "";
}

/** Mine one session's events for failure→success corrections. */
export function mineSession(events: ToolEvent[]): Learning[] {
  const out: Learning[] = [];
  const WINDOW = 12; // a fix usually lands within a few steps of the failure

  for (let i = 0; i < events.length; i += 1) {
    const ev = events[i]!;
    if (!ev.error) continue;
    const later = events.slice(i + 1, i + 1 + WINDOW).filter((e) => !e.error);

    // 1. FILE PATH CORRECTIONS — failed file op, later success on the same
    //    basename. Generic basenames (route.ts, index.ts) collide across
    //    unrelated files, so they're excluded.
    const failedPath = typeof ev.input["file_path"] === "string" ? (ev.input["file_path"] as string) : "";
    if (failedPath && ["Read", "Edit", "Write"].includes(ev.tool) && !GENERIC_BASENAMES.has(basename(failedPath))) {
      const fix = later.find(
        (e) =>
          typeof e.input["file_path"] === "string" &&
          e.input["file_path"] !== failedPath &&
          basename(e.input["file_path"] as string) === basename(failedPath),
      );
      if (fix) {
        const text = `\`${failedPath}\` → actually at \`${fix.input["file_path"] as string}\``;
        if (publishable(text)) out.push({ category: "paths", text, count: 1 });
        continue;
      }
    }

    // 2. COMMAND CORRECTIONS — failed command, later success on the SAME
    //    target file with a different runner (python3 x.py → uv run python
    //    x.py). Single-line, short commands only: a correction must be
    //    readable and unambiguous or it's noise.
    const failedCmd = typeof ev.input["command"] === "string" ? (ev.input["command"] as string) : "";
    if (failedCmd && ev.tool === "Bash" && !failedCmd.includes("\n") && failedCmd.length <= 120) {
      const target = targetFile(failedCmd);
      const fix = later.find(
        (e) =>
          e.tool === "Bash" &&
          typeof e.input["command"] === "string" &&
          !(e.input["command"] as string).includes("\n") &&
          (e.input["command"] as string).length <= 120 &&
          e.input["command"] !== failedCmd &&
          target.length > 0 &&
          targetFile(e.input["command"] as string) === target,
      );
      if (fix) {
        const text = `use \`${fix.input["command"] as string}\` (not \`${failedCmd}\`)`;
        if (publishable(text)) out.push({ category: "commands", text, count: 1 });
        continue;
      }
    }

    // 4. LARGE FILES — reads that blew the size limit need offset/limit.
    //    Ephemeral paths (/tmp task outputs) won't exist next session — skip.
    if (ev.tool === "Read" && failedPath && TOO_LARGE.test(ev.errText) && !/^(\/private)?\/tmp\//.test(failedPath)) {
      const text = `\`${failedPath}\` is too large for a whole-file Read — use offset/limit`;
      if (publishable(text)) out.push({ category: "large-files", text, count: 1 });
    }
  }

  // 3. ENVIRONMENT FACTS — runners that failed repeatedly and never succeeded.
  const firstTok = (c: string): string => c.trim().split(/\s+/)[0] ?? "";
  // Shell builtins / generic helpers say nothing about the environment.
  const NOISE_RUNNERS = new Set(["cd", "echo", "ls", "cat", "#", "[", "for", "if", "while", "sleep", "true"]);
  const cmdStats = new Map<string, { fail: number; ok: number }>();
  for (const e of events) {
    if (e.tool !== "Bash" || typeof e.input["command"] !== "string") continue;
    const tok = firstTok(e.input["command"] as string);
    if (!tok || tok.length < 2 || NOISE_RUNNERS.has(tok)) continue;
    const s = cmdStats.get(tok) ?? { fail: 0, ok: 0 };
    if (e.error) s.fail += 1;
    else s.ok += 1;
    cmdStats.set(tok, s);
  }
  for (const [tok, s] of cmdStats) {
    if (s.fail >= 3 && s.ok === 0) {
      out.push({
        category: "environment",
        text: `\`${tok}\` failed ${s.fail}× and never succeeded in past sessions — prefer an alternative`,
        count: 1,
      });
    }
  }

  return out;
}

/** Merge duplicate learnings across sessions, summing evidence counts. */
export function mergeLearnings(all: Learning[]): Learning[] {
  const map = new Map<string, Learning>();
  for (const l of all) {
    const key = `${l.category}:${l.text}`;
    const cur = map.get(key);
    if (cur) cur.count += l.count;
    else map.set(key, { ...l });
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

const START = "<!-- knitbrain:learn:start -->";
const END = "<!-- knitbrain:learn:end -->";

const TITLES: Record<Learning["category"], string> = {
  paths: "File locations (corrected from failed lookups)",
  commands: "Command patterns (what actually worked)",
  environment: "Environment facts",
  "large-files": "Known large files (Read with offset/limit)",
};

/** Render the marker-managed CLAUDE.md section. */
export function renderSection(learnings: Learning[]): string {
  const lines: string[] = [START, "## Learned from past sessions (knitbrain learn)", ""];
  lines.push("*Auto-generated by `knitbrain learn --apply` — edits inside the markers are overwritten.*", "");
  for (const cat of ["paths", "commands", "environment", "large-files"] as const) {
    const items = learnings.filter((l) => l.category === cat);
    if (items.length === 0) continue;
    lines.push(`### ${TITLES[cat]}`);
    for (const l of items) lines.push(`- ${l.text}${l.count > 1 ? ` (seen ${l.count}×)` : ""}`);
    lines.push("");
  }
  lines.push(END);
  return lines.join("\n");
}

/** Write/replace the marker section in the project's CLAUDE.md. */
export function applyToClaudeMd(projectRoot: string, section: string): string {
  const path = join(projectRoot, "CLAUDE.md");
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  let next: string;
  if (existing.includes(START) && existing.includes(END)) {
    const pre = existing.slice(0, existing.indexOf(START));
    const post = existing.slice(existing.indexOf(END) + END.length);
    next = pre + section + post;
  } else {
    next = existing.length > 0 ? `${existing.replace(/\n+$/, "")}\n\n${section}\n` : `${section}\n`;
  }
  writeFileSync(path, next);
  return path;
}

/** Claude Code's transcript-directory slug for a project path. */
export function projectSlug(projectRoot: string): string {
  // Normalize ALL path separators (Unix /, Windows \) plus dots and the
  // Windows drive colon, so the slug is portable and matches Claude Code's
  // transcript-dir encoding on either OS.
  return resolve(projectRoot).replace(/[/.\\:]/g, "-");
}

/** Transcript files for one project (or all projects with --all). */
export function transcriptsFor(projectRoot: string, all: boolean): string[] {
  const base = join(homedir(), ".claude", "projects");
  if (!existsSync(base)) return [];
  const slug = projectSlug(projectRoot);
  const files: string[] = [];
  for (const dir of readdirSync(base)) {
    if (!all && dir !== slug) continue;
    const pd = join(base, dir);
    try {
      if (!statSync(pd).isDirectory()) continue;
      for (const f of readdirSync(pd)) if (f.endsWith(".jsonl")) files.push(join(pd, f));
    } catch {
      /* skip unreadable */
    }
  }
  return files;
}

/** CLI entry: `knitbrain learn [--apply] [--all] [--project <path>]`. */
export async function runLearn(args: string[], log: (line: string) => void = console.log): Promise<number> {
  const apply = args.includes("--apply");
  const all = args.includes("--all");
  const pIdx = args.indexOf("--project");
  const projectRoot = pIdx >= 0 && args[pIdx + 1] ? resolve(args[pIdx + 1]!) : process.cwd();

  const files = transcriptsFor(projectRoot, all);
  log(`[learn] project: ${projectRoot}${all ? " (+ all projects)" : ""}`);
  log(`[learn] transcripts: ${files.length}`);
  if (files.length === 0) {
    log("[learn] no transcripts found — has this project been worked on with Claude Code?");
    return 0;
  }

  const collected: Learning[] = [];
  for (const f of files) collected.push(...mineSession(await parseSession(f)));
  const learnings = mergeLearnings(collected);

  if (learnings.length === 0) {
    log("[learn] no failure→success corrections found — clean sessions, nothing to write");
    return 0;
  }

  log(`[learn] ${learnings.length} corrections mined from real failures:`);
  for (const l of learnings.slice(0, 30)) log(`  [${l.category}] ${l.text}${l.count > 1 ? ` (×${l.count})` : ""}`);
  if (learnings.length > 30) log(`  … and ${learnings.length - 30} more`);

  if (apply) {
    const path = applyToClaudeMd(projectRoot, renderSection(learnings));
    log(`[learn] written to ${path} (marker-managed section)`);
  } else {
    log("[learn] dry-run — pass --apply to write these into CLAUDE.md");
  }
  return learnings.length;
}
