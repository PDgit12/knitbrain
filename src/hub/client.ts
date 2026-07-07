import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { writeAtomic } from "../atomic.js";
import { join } from "node:path";
import { knitbrainHome } from "../paths.js";

/** Where this machine's hub membership lives. */
export interface HubConfig {
  url: string;
  token: string;
  /** Display name for this member's postings. */
  member: string;
}

function configPath(): string {
  return join(knitbrainHome(), "hub.json");
}

/** `knitbrain join <url> <token> [member]` writes this. */
export function saveHubConfig(cfg: HubConfig): string {
  mkdirSync(knitbrainHome(), { recursive: true });
  const path = configPath();
  writeAtomic(path, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  return path;
}

export function loadHubConfig(): HubConfig | null {
  const path = configPath();
  if (!existsSync(path)) return null;
  try {
    const cfg = JSON.parse(readFileSync(path, "utf8")) as HubConfig;
    return cfg.url && cfg.token ? cfg : null;
  } catch {
    return null;
  }
}

/**
 * Mirror a board posting to the hub — FIRE-AND-FORGET. Never throws, never
 * blocks: a dead/unreachable hub must never slow local work.
 */
/** Backoff schedule between attempts (ms) — index i is the wait before attempt i+2. */
const MIRROR_BACKOFF_MS = [250, 1000];

export function mirrorToHub(
  cfg: HubConfig,
  entry: { author: string; summary: string; original: string },
): void {
  void (async () => {
    const url = `${cfg.url.replace(/\/+$/, "")}/board`;
    const body = JSON.stringify({ ...entry, author: cfg.member || entry.author });
    for (let attempt = 0; attempt < 3; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${cfg.token}` },
          body,
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (res.ok) return;
        // 4xx (bad token, body too large, etc.) will never succeed on retry.
        if (res.status >= 400 && res.status < 500) return;
        // else: 5xx — fall through to retry.
      } catch {
        clearTimeout(timer);
        // network error / abort (timeout) — fall through to retry.
      }
      const wait = MIRROR_BACKOFF_MS[attempt];
      if (wait !== undefined) await new Promise((r) => setTimeout(r, wait));
    }
    // fire-and-forget: all errors swallowed after the final attempt.
  })();
}

/** Backoff between the two fetchHubBoard attempts (ms). */
const BOARD_FETCH_BACKOFF_MS = 300;

/** Best-effort hub board fetch (for the dashboard's merged view). */
export async function fetchHubBoard(
  cfg: HubConfig,
  timeoutMs = 1500,
): Promise<Array<{ id: string; author: string; summary: string; ts: string }>> {
  const url = `${cfg.url.replace(/\/+$/, "")}/board`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: { authorization: `Bearer ${cfg.token}` },
        signal: controller.signal,
      });
      if (!res.ok) {
        // 4xx will never succeed on retry; 5xx falls through to retry.
        if (res.status >= 400 && res.status < 500) return [];
      } else {
        return (await res.json()) as Array<{ id: string; author: string; summary: string; ts: string }>;
      }
    } catch {
      // network error / abort (timeout) — fall through to retry.
    } finally {
      clearTimeout(timer);
    }
    if (attempt === 0) await new Promise((r) => setTimeout(r, BOARD_FETCH_BACKOFF_MS));
  }
  return [];
}
