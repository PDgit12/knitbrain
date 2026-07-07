import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Real platform token usage — read from the host's own session transcripts
 * (Claude Code writes per-message `usage` counts to ~/.claude/projects/<enc>/).
 * This is the ACTUAL meter the user is billed/budgeted against, distinct from
 * the optimizer's internal savedTokens accounting. The dashboard shows both so
 * "tokens saved" is grounded in real consumption, not a self-reported number.
 */
export interface PlatformUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  messages: number;
}

/** Claude Code encodes a project's abs path as the transcript dir name,
 * replacing path separators, dots, AND the Windows drive colon with dashes
 * (a raw `C:` in a dir name is an illegal Windows path → mkdir/readdir fail). */
export function projectTranscriptDir(cwd: string, home: string = homedir()): string {
  return join(home, ".claude", "projects", cwd.replace(/[/\\.:]/g, "-")); // / \ . : → -
}

const empty = (): PlatformUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  totalTokens: 0,
  messages: 0,
});

/** Accumulate one transcript file's `usage` lines into `u` in place — the
 * shared inner loop for both readUsageFromDir (many files) and
 * readTranscriptUsage (one file), so the field accumulation lives once. */
function accumulateFile(content: string, u: PlatformUsage): void {
  for (const line of content.split("\n")) {
    if (!line.includes('"usage"')) continue;
    let msg: { message?: { usage?: Record<string, number> } };
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    const us = msg.message?.usage;
    if (!us) continue;
    u.inputTokens += us["input_tokens"] ?? 0;
    u.outputTokens += us["output_tokens"] ?? 0;
    u.cacheReadTokens += us["cache_read_input_tokens"] ?? 0;
    u.cacheCreationTokens += us["cache_creation_input_tokens"] ?? 0;
    u.messages += 1;
  }
}

/** Sum real usage across a transcript directory's .jsonl files. */
export function readUsageFromDir(dir: string): PlatformUsage | null {
  if (!existsSync(dir)) return null;
  const u = empty();
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".jsonl")) continue;
    let content: string;
    try {
      content = readFileSync(join(dir, f), "utf8");
    } catch {
      continue;
    }
    accumulateFile(content, u);
  }
  if (u.messages === 0) return null;
  u.totalTokens = u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheCreationTokens;
  return u;
}

/** Real usage from ONE transcript file (same field accumulation as
 * readUsageFromDir, scoped to a single .jsonl) — null if missing/unreadable/
 * has no usage lines. Lets callers meter a single session's transcript
 * without needing its whole project directory. */
export function readTranscriptUsage(file: string): PlatformUsage | null {
  if (!existsSync(file)) return null;
  let content: string;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const u = empty();
  accumulateFile(content, u);
  if (u.messages === 0) return null;
  u.totalTokens = u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheCreationTokens;
  return u;
}

/** Real usage for the project rooted at `cwd` (null if no transcripts yet). */
export function readProjectUsage(cwd: string, home: string = homedir()): PlatformUsage | null {
  return readUsageFromDir(projectTranscriptDir(cwd, home));
}

/**
 * The host's CURRENT context-window occupancy, read from the live transcript:
 * the newest session's latest message input + cache tokens (= what the model
 * actually saw this turn). Lets the context meter fire handoff advice on the
 * REAL window, not just knitbrain's slice. Claude Code only — the one host with
 * a readable per-message token transcript; null elsewhere (meter falls back).
 */
/**
 * The newest transcript's content across ALL projects (globally), or null. The
 * shared substrate for currentContextTokens + currentContextModel — both scan
 * ~/.claude/projects for the most-recently-touched .jsonl, so the walk lives
 * once here. Best-effort: unreadable dirs/files are skipped, never throw.
 */
function newestTranscriptContent(home: string): string | null {
  const dir = join(home, ".claude", "projects");
  if (!existsSync(dir)) return null;
  let newest: string | null = null;
  let newestMtime = 0;
  for (const proj of readdirSync(dir)) {
    const pd = join(dir, proj);
    let files: string[];
    try {
      if (!statSync(pd).isDirectory()) continue;
      files = readdirSync(pd);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      try {
        const m = statSync(join(pd, f)).mtimeMs;
        if (m > newestMtime) {
          newestMtime = m;
          newest = join(pd, f);
        }
      } catch {
        /* skip */
      }
    }
  }
  if (!newest) return null;
  try {
    return readFileSync(newest, "utf8");
  } catch {
    return null;
  }
}

export function currentContextTokens(home: string = homedir()): number | null {
  const content = newestTranscriptContent(home);
  if (content === null) return null;
  const lines = content.split("\n").filter((l) => l.includes('"usage"'));
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    let msg: { message?: { usage?: Record<string, number> } };
    try {
      msg = JSON.parse(lines[i]!);
    } catch {
      continue;
    }
    const u = msg.message?.usage;
    if (u) {
      return (u["input_tokens"] ?? 0) + (u["cache_read_input_tokens"] ?? 0) + (u["cache_creation_input_tokens"] ?? 0);
    }
  }
  return null;
}

/**
 * The model id the host is CURRENTLY running, read from the newest transcript's
 * latest assistant message (`message.model`). Lets the context meter learn the
 * REAL window proactively (via modelWindow) instead of reactively healing only
 * after usage overflows a stale default — which produced a FALSE "clear now" at
 * ~90-100% of a 200k default on a model whose real window is 1M. Claude Code
 * only; null elsewhere (meter keeps its default/reactive path). Synthetic
 * placeholder ids (e.g. "<synthetic>") are ignored — they carry no window.
 */
export function currentContextModel(home: string = homedir()): string | null {
  const content = newestTranscriptContent(home);
  if (content === null) return null;
  const lines = content.split("\n").filter((l) => l.includes('"model"'));
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    let msg: { message?: { model?: string } };
    try {
      msg = JSON.parse(lines[i]!);
    } catch {
      continue;
    }
    const model = msg.message?.model;
    // Ignore synthetic/placeholder ids Claude Code writes for non-model turns.
    if (typeof model === "string" && model.length > 0 && !model.startsWith("<")) return model;
  }
  return null;
}
