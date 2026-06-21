import { existsSync, readdirSync, readFileSync } from "node:fs";
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
 * replacing path separators and dots with dashes. */
export function projectTranscriptDir(cwd: string, home: string = homedir()): string {
  return join(home, ".claude", "projects", cwd.replace(/[/.]/g, "-"));
}

const empty = (): PlatformUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  totalTokens: 0,
  messages: 0,
});

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
  if (u.messages === 0) return null;
  u.totalTokens = u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheCreationTokens;
  return u;
}

/** Real usage for the project rooted at `cwd` (null if no transcripts yet). */
export function readProjectUsage(cwd: string, home: string = homedir()): PlatformUsage | null {
  return readUsageFromDir(projectTranscriptDir(cwd, home));
}
