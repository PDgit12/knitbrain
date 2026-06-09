import { homedir } from "node:os";
import { join } from "node:path";

/** Knit Brain's local-first home. Override with KNITBRAIN_HOME (used in tests). */
export function knitbrainHome(): string {
  return process.env["KNITBRAIN_HOME"] ?? join(homedir(), ".knitbrain");
}

/** Root directory for the CCR store. */
export function ccrRoot(): string {
  return join(knitbrainHome(), "ccr");
}
