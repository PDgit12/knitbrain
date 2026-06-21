import { renameSync, writeFileSync } from "node:fs";

/**
 * Atomic write: write a temp file, then rename onto the target. Rename is
 * atomic within a filesystem, so a concurrent reader never sees a half-written
 * file and a crash can't truncate the target. Handles string (utf8) and Buffer;
 * `mode` sets permissions for secret files (e.g. 0o600). Single source — every
 * persistence path in the engine uses this instead of re-inlining temp+rename.
 */
export function writeAtomic(path: string, data: string | Buffer, opts?: { mode?: number }): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data, opts?.mode !== undefined ? { mode: opts.mode } : undefined);
  renameSync(tmp, path);
}
