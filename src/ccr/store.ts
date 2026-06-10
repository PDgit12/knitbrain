import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

/**
 * CCR (Compress-Cache-Retrieve) store — the lossless safety net, tiered.
 *
 * Content-addressed: the SHA-256 of the original IS the handle (dedup +
 * integrity). Tiered so disk stays bounded WITHOUT losing anything you might
 * need: HOT (recent, stored as-is) → COLD (gzip-compressed, kept long-term,
 * still fully recoverable) → PURGE (only as a warned last resort, by budget).
 * File existence is authoritative; the manifest holds tiering metadata only.
 */
export interface CCRStore {
  /** Store an original, return its content-hash handle. Idempotent. */
  put(original: string): string;
  /** Retrieve the exact original by handle (hot or cold). Throws if absent/corrupt. */
  get(handle: string): string;
  /** Whether a handle is present in any tier. */
  has(handle: string): boolean;
  /** Which tier a handle lives in. */
  tierOf(handle: string): "hot" | "cold" | "absent";
  /** Move a handle HOT → COLD (gzip). No-op if not hot. */
  demote(handle: string): void;
  /** Move a handle COLD → HOT (re-warm). No-op if not cold. */
  promote(handle: string): void;
  /** Apply a retention policy: demote stale hot entries, purge over-budget cold. */
  maintain(policy: MaintainPolicy): { demoted: number; purged: number };
  /** Tier counts. */
  stats(): CCRStats;
}

export interface MaintainPolicy {
  /** Demote hot entries whose lastUsed is older than this many ms. */
  hotMaxAgeMs?: number;
  /** Keep at most this many hot entries (demote least-recently-used beyond it). */
  hotMaxEntries?: number;
  /** Keep at most this many cold entries (purge fewest-retrieved/oldest beyond it). */
  coldMaxEntries?: number;
}

export interface CCRStats {
  total: number;
  hot: number;
  cold: number;
}

/** Thrown when a requested handle is in no tier (purged or never stored). */
export class CCRMissingError extends Error {
  constructor(public readonly handle: string) {
    super(`CCR handle not found: ${handle} (purged or never stored — re-run the tool to regenerate)`);
    this.name = "CCRMissingError";
  }
}

/** Thrown when stored bytes no longer hash to their handle (corruption). */
export class CCRIntegrityError extends Error {
  constructor(public readonly handle: string) {
    super(`CCR integrity check failed for handle: ${handle}`);
    this.name = "CCRIntegrityError";
  }
}

/** SHA-256 hex digest of a UTF-8 string. */
export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

interface Meta {
  lastUsed: number;
  retrievals: number;
}

const HANDLE_RE = /^[0-9a-f]{64}$/;

/** Filesystem-backed, tiered CCR store rooted at `root`. */
export function createFileCCRStore(root: string): CCRStore {
  const coldDir = join(root, "cold");
  const manifestPath = join(root, "manifest.json");
  mkdirSync(coldDir, { recursive: true });

  const meta = new Map<string, Meta>();
  loadManifest();

  function loadManifest(): void {
    if (!existsSync(manifestPath)) return;
    try {
      const raw = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, Meta>;
      for (const [k, v] of Object.entries(raw)) meta.set(k, v);
    } catch {
      // corrupt manifest is non-fatal — file existence is authoritative.
    }
  }

  function saveManifest(): void {
    const obj: Record<string, Meta> = {};
    for (const [k, v] of meta.entries()) obj[k] = v;
    const tmp = join(root, `.manifest.${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify(obj), "utf8");
    renameSync(tmp, manifestPath);
  }

  // SECURITY: a handle is ONLY ever a 64-hex SHA-256. Reject anything else
  // before it touches a filesystem path (prevents traversal + existence probes).
  const assertHandle = (h: string): void => {
    if (!HANDLE_RE.test(h)) throw new CCRMissingError(h);
  };
  const hotPath = (h: string): string => join(root, h);
  const coldPath = (h: string): string => join(coldDir, `${h}.gz`);
  const touch = (h: string): void => {
    const m = meta.get(h) ?? { lastUsed: 0, retrievals: 0 };
    meta.set(h, { lastUsed: Date.now(), retrievals: m.retrievals });
  };

  function writeAtomic(path: string, data: string | Buffer): void {
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, data);
    renameSync(tmp, path);
  }

  function listHot(): string[] {
    return readdirSync(root).filter((f) => HANDLE_RE.test(f));
  }
  function listCold(): string[] {
    return readdirSync(coldDir)
      .filter((f) => f.endsWith(".gz"))
      .map((f) => f.slice(0, -3))
      .filter((h) => HANDLE_RE.test(h));
  }

  function doDemote(handle: string): boolean {
    if (!existsSync(hotPath(handle))) return false;
    const data = readFileSync(hotPath(handle), "utf8");
    writeAtomic(coldPath(handle), gzipSync(Buffer.from(data, "utf8")));
    rmSync(hotPath(handle), { force: true });
    touch(handle);
    return true;
  }

  return {
    put(original: string): string {
      const handle = sha256(original);
      if (!existsSync(hotPath(handle)) && !existsSync(coldPath(handle))) {
        writeAtomic(hotPath(handle), original);
      }
      meta.set(handle, { lastUsed: Date.now(), retrievals: meta.get(handle)?.retrievals ?? 0 });
      saveManifest();
      return handle;
    },

    has(handle: string): boolean {
      if (!HANDLE_RE.test(handle)) return false;
      return existsSync(hotPath(handle)) || existsSync(coldPath(handle));
    },

    tierOf(handle: string): "hot" | "cold" | "absent" {
      if (!HANDLE_RE.test(handle)) return "absent";
      if (existsSync(hotPath(handle))) return "hot";
      if (existsSync(coldPath(handle))) return "cold";
      return "absent";
    },

    get(handle: string): string {
      assertHandle(handle);
      if (existsSync(hotPath(handle))) {
        const data = readFileSync(hotPath(handle), "utf8");
        if (sha256(data) !== handle) throw new CCRIntegrityError(handle);
        const m = meta.get(handle) ?? { lastUsed: 0, retrievals: 0 };
        meta.set(handle, { lastUsed: Date.now(), retrievals: m.retrievals + 1 });
        return data;
      }
      if (existsSync(coldPath(handle))) {
        const data = gunzipSync(readFileSync(coldPath(handle))).toString("utf8");
        if (sha256(data) !== handle) throw new CCRIntegrityError(handle);
        const m = meta.get(handle) ?? { lastUsed: 0, retrievals: 0 };
        meta.set(handle, { lastUsed: Date.now(), retrievals: m.retrievals + 1 });
        return data;
      }
      throw new CCRMissingError(handle);
    },

    demote(handle: string): void {
      if (!HANDLE_RE.test(handle)) return;
      if (doDemote(handle)) saveManifest();
    },

    promote(handle: string): void {
      if (!HANDLE_RE.test(handle)) return;
      if (!existsSync(coldPath(handle))) return;
      const data = gunzipSync(readFileSync(coldPath(handle))).toString("utf8");
      writeAtomic(hotPath(handle), data);
      rmSync(coldPath(handle), { force: true });
      touch(handle);
      saveManifest();
    },

    maintain(policy: MaintainPolicy): { demoted: number; purged: number } {
      const now = Date.now();
      const lastUsed = (h: string): number => meta.get(h)?.lastUsed ?? 0;
      const retrievals = (h: string): number => meta.get(h)?.retrievals ?? 0;

      // 1) Demote hot → cold (never delete): by age, then by hot-entry cap (LRU).
      const hot = listHot();
      const toDemote = new Set<string>();
      if (policy.hotMaxAgeMs !== undefined) {
        for (const h of hot) {
          if (now - lastUsed(h) > policy.hotMaxAgeMs) toDemote.add(h);
        }
      }
      if (policy.hotMaxEntries !== undefined) {
        const survivors = hot.filter((h) => !toDemote.has(h)).sort((a, b) => lastUsed(b) - lastUsed(a));
        for (const h of survivors.slice(policy.hotMaxEntries)) toDemote.add(h);
      }
      let demoted = 0;
      for (const h of toDemote) {
        if (doDemote(h)) demoted += 1;
      }

      // 2) Purge cold (last resort) by budget: fewest retrievals, then oldest.
      let purged = 0;
      if (policy.coldMaxEntries !== undefined) {
        const cold = listCold().sort(
          (a, b) => retrievals(a) - retrievals(b) || lastUsed(a) - lastUsed(b),
        );
        for (const h of cold.slice(policy.coldMaxEntries)) {
          rmSync(coldPath(h), { force: true });
          meta.delete(h);
          purged += 1;
        }
      }
      if (demoted > 0 || purged > 0) saveManifest();
      return { demoted, purged };
    },

    stats(): CCRStats {
      const hot = listHot().length;
      const cold = listCold().length;
      return { total: hot + cold, hot, cold };
    },
  };
}
