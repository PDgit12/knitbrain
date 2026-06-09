import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

/** Knit Brain's local-first home. Override with KNITBRAIN_HOME (used in tests). */
export function knitbrainHome(): string {
  return process.env["KNITBRAIN_HOME"] ?? join(homedir(), ".knitbrain");
}

/** Root directory for the (global, content-addressed) CCR store. */
export function ccrRoot(): string {
  return join(knitbrainHome(), "ccr");
}

/** Stable per-project id derived from the working directory. */
export function projectId(): string {
  return createHash("sha256").update(process.cwd()).digest("hex").slice(0, 16);
}

/** Per-project memory directory (learnings + sessions). */
export function memoryRoot(): string {
  return join(knitbrainHome(), "projects", projectId(), "memory");
}
