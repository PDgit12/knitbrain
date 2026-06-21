import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Subscription quota readout — the visibility half of plan parity. API users
 * see spend via billing; subscription (Pro/Max) users can't. This surfaces the
 * provider's own rolling-window usage so they get equal insight.
 *
 * Extensible per-platform. Only platforms that expose a real usage source get
 * numbers (Claude today, via the OAuth usage API); everything else returns null
 * — we never fabricate a quota. Security: the OAuth token is read locally and
 * sent ONLY to the provider's own endpoint, never logged, stored, or surfaced
 * in an error.
 */

export interface QuotaWindow {
  label: string;
  usedPct: number;
  used: number;
  limit: number;
  resetsInMin?: number;
}

export interface PlatformQuota {
  platform: string;
  windows: QuotaWindow[];
  fetchedAt: string;
}

const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_OAUTH_BETA = "oauth-2025-04-20";

/** Resolve a Claude OAuth token: env first, then the credentials file. Null if
 *  absent. Never returned to any caller that logs — used only for the request. */
export function readClaudeToken(home: string = homedir()): string | null {
  const env = (process.env["CLAUDE_CODE_OAUTH_TOKEN"] ?? "").trim();
  if (env) return env;
  const base = process.env["CLAUDE_CONFIG_DIR"] || join(home, ".claude");
  const path = join(base, ".credentials.json");
  if (!existsSync(path)) return null;
  try {
    const creds = JSON.parse(readFileSync(path, "utf8")) as {
      claudeAiOauth?: { accessToken?: string };
    };
    return creds.claudeAiOauth?.accessToken?.trim() || null;
  } catch {
    return null;
  }
}

interface RawWindow {
  used?: number;
  limit?: number;
  utilization?: number;
  resets_at?: string | number;
}

const WINDOW_LABELS: Record<string, string> = {
  five_hour: "5-hour",
  seven_day: "7-day",
  seven_day_opus: "7-day (Opus)",
  seven_day_sonnet: "7-day (Sonnet)",
};

function resetsInMin(resets_at: string | number | undefined): number | undefined {
  if (resets_at === undefined) return undefined;
  const t = typeof resets_at === "number" ? resets_at * 1000 : Date.parse(resets_at);
  if (Number.isNaN(t)) return undefined;
  return Math.max(0, Math.round((t - Date.now()) / 60000));
}

/** Map the Anthropic usage API payload to our windows. Pure + defensive. */
export function parseClaudeUsage(data: unknown): QuotaWindow[] {
  if (!data || typeof data !== "object") return [];
  const obj = data as Record<string, RawWindow>;
  const windows: QuotaWindow[] = [];
  for (const [key, label] of Object.entries(WINDOW_LABELS)) {
    const w = obj[key];
    if (!w || typeof w !== "object") continue;
    windows.push({
      label,
      usedPct: Math.round((w.utilization ?? 0) * 10) / 10,
      used: w.used ?? 0,
      limit: w.limit ?? 0,
      resetsInMin: resetsInMin(w.resets_at),
    });
  }
  return windows;
}

/** Fetch Claude's subscription windows. Never throws; null on any failure. */
export async function fetchClaudeQuota(home: string = homedir()): Promise<PlatformQuota | null> {
  const token = readClaudeToken(home);
  if (!token) return null;
  try {
    const res = await fetch(CLAUDE_USAGE_URL, {
      headers: { authorization: `Bearer ${token}`, "anthropic-beta": CLAUDE_OAUTH_BETA },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    const windows = parseClaudeUsage(await res.json());
    if (windows.length === 0) return null;
    return { platform: "claude", windows, fetchedAt: new Date().toISOString() };
  } catch {
    // Network/timeout/parse — surface nothing (and never the token).
    return null;
  }
}

/** Resolve the active platform's quota. Extensible: add a source per platform
 *  that exposes one; returns null when no source is available (never faked). */
export async function fetchPlatformQuota(home: string = homedir()): Promise<PlatformQuota | null> {
  return fetchClaudeQuota(home);
}
