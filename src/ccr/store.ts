import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * CCR (Compress-Cache-Retrieve) store — the lossless safety net.
 *
 * Content-addressed: the SHA-256 of the original bytes IS the handle, so
 * identical content dedups automatically and every read is integrity-checked.
 * This is what makes structural compression safe: the pristine original is
 * always one `get(handle)` away, byte-for-byte.
 */
export interface CCRStore {
  /** Store an original, return its content-hash handle. Idempotent. */
  put(original: string): string;
  /** Retrieve the exact original by handle. Throws if missing or corrupt. */
  get(handle: string): string;
  /** Whether a handle is present. */
  has(handle: string): boolean;
}

/** Thrown when a requested handle is not in the store (e.g. evicted/purged). */
export class CCRMissingError extends Error {
  constructor(public readonly handle: string) {
    super(`CCR handle not found: ${handle} (expired or never stored — re-run the tool to regenerate)`);
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

/** Filesystem-backed CCR store rooted at `root`. Atomic writes, crash-safe. */
export function createFileCCRStore(root: string): CCRStore {
  mkdirSync(root, { recursive: true });

  return {
    put(original: string): string {
      const handle = sha256(original);
      const finalPath = join(root, handle);
      if (!existsSync(finalPath)) {
        const tmp = join(root, `.${handle}.${process.pid}.tmp`);
        writeFileSync(tmp, original, "utf8");
        renameSync(tmp, finalPath); // atomic on same filesystem
      }
      return handle;
    },

    has(handle: string): boolean {
      return existsSync(join(root, handle));
    },

    get(handle: string): string {
      const path = join(root, handle);
      if (!existsSync(path)) throw new CCRMissingError(handle);
      const data = readFileSync(path, "utf8");
      if (sha256(data) !== handle) throw new CCRIntegrityError(handle);
      return data;
    },
  };
}
