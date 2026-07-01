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

/** Per-project knowledge-graph cache directory. */
export function knowledgeRoot(): string {
  return join(knitbrainHome(), "projects", projectId(), "knowledge");
}

/** Per-project TOIN feedback directory (compression self-tuning). */
export function feedbackRoot(): string {
  return join(knitbrainHome(), "projects", projectId(), "feedback");
}

/** Per-project team board directory (shared compressed context). */
export function teamRoot(): string {
  return join(knitbrainHome(), "projects", projectId(), "team");
}

/** Per-project context-meter directory (token-window tracking). */
export function meterRoot(): string {
  return join(knitbrainHome(), "projects", projectId(), "meter");
}

/** Per-project skills store (find-or-write playbooks). */
export function skillsRoot(): string {
  return join(knitbrainHome(), "projects", projectId(), "skills");
}

/** Per-project classifier-calibration directory (false-positive loop). */
export function calibrationRoot(): string {
  return join(knitbrainHome(), "projects", projectId(), "calibration");
}

/** Per-project live agent-activity log (the dashboard CRM feed). */
export function activityRoot(): string {
  return join(knitbrainHome(), "projects", projectId(), "activity");
}

/** Per-project wiki-brain (index.md · log.md · pages/) — the compounding brain. */
export function wikiRoot(): string {
  return join(knitbrainHome(), "projects", projectId(), "wiki");
}

/** Per-project host-toolkit index (skills/agents the user has across project +
 *  global + plugins) — config awareness kept across sessions. */
export function hostIndexPath(): string {
  return join(knitbrainHome(), "projects", projectId(), "host-index.json");
}
