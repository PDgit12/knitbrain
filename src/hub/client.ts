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
export function mirrorToHub(
  cfg: HubConfig,
  entry: { author: string; summary: string; original: string },
): void {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  void fetch(`${cfg.url.replace(/\/+$/, "")}/board`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${cfg.token}` },
    body: JSON.stringify({ ...entry, author: cfg.member || entry.author }),
    signal: controller.signal,
  })
    .catch(() => {})
    .finally(() => clearTimeout(timer));
}

/** Best-effort hub board fetch (for the dashboard's merged view). */
export async function fetchHubBoard(
  cfg: HubConfig,
  timeoutMs = 1500,
): Promise<Array<{ id: string; author: string; summary: string; ts: string }>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${cfg.url.replace(/\/+$/, "")}/board`, {
      headers: { authorization: `Bearer ${cfg.token}` },
      signal: controller.signal,
    });
    if (!res.ok) return [];
    return (await res.json()) as Array<{ id: string; author: string; summary: string; ts: string }>;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}
