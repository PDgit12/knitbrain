import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { realpathSync, statSync } from "node:fs";

/** One canonical root for scanning, relative reads, verification and stores. */
export function projectRoot(): string {
  const configured = ["KNITBRAIN_PROJECT_DIR", "CLAUDE_PROJECT_DIR", "CURSOR_PROJECT_DIR"].map((key) => process.env[key]).find((value) => value?.trim());
  const path = resolve(configured?.trim() || process.cwd());
  if (!statSync(path).isDirectory()) throw new Error(`Knitbrain project root is not a directory: ${path}`);
  return realpathSync(path);
}

/** Knit Brain's local-first home. Override with KNITBRAIN_HOME (used in tests). */
export function knitbrainHome(): string {
  return process.env["KNITBRAIN_HOME"] ?? join(homedir(), ".knitbrain");
}

/** Root directory for the (global, content-addressed) CCR store. */
export function ccrRoot(): string {
  return join(knitbrainHome(), "ccr");
}

/** Stable per-project id derived from the working directory.
 * KNITBRAIN_PROJECT_DIR overrides cwd so a helper process launched elsewhere
 * (the proxy, a cron trigger) still lands its state in the RIGHT project. */
export function projectId(root: string = projectRoot()): string {
  const dir = realpathSync(resolve(root));
  return createHash("sha256").update(dir).digest("hex").slice(0, 16);
}

/** Per-project memory directory (learnings + sessions). */
export function memoryRoot(root?: string): string {
  return join(knitbrainHome(), "projects", projectId(root), "memory");
}

/** Per-project knowledge-graph cache directory. */
export function knowledgeRoot(root?: string): string {
  return join(knitbrainHome(), "projects", projectId(root), "knowledge");
}

/** Per-project TOIN feedback directory (compression self-tuning). */
export function feedbackRoot(root?: string): string {
  return join(knitbrainHome(), "projects", projectId(root), "feedback");
}

/** Per-project team board directory (shared compressed context). */
export function teamRoot(root?: string): string {
  return join(knitbrainHome(), "projects", projectId(root), "team");
}

/** Per-project context-meter directory (token-window tracking). */
export function meterRoot(root?: string): string {
  return join(knitbrainHome(), "projects", projectId(root), "meter");
}

/** Per-project skills store (find-or-write playbooks). */
export function skillsRoot(root?: string): string {
  return join(knitbrainHome(), "projects", projectId(root), "skills");
}

/** Per-project classifier-calibration directory (false-positive loop). */
export function calibrationRoot(root?: string): string {
  return join(knitbrainHome(), "projects", projectId(root), "calibration");
}

/** Per-project live agent-activity log (the dashboard CRM feed). */
export function activityRoot(root?: string): string {
  return join(knitbrainHome(), "projects", projectId(root), "activity");
}

/** Per-project wiki-brain (index.md · log.md · pages/) — the compounding brain. */
export function wikiRoot(root?: string): string {
  return join(knitbrainHome(), "projects", projectId(root), "wiki");
}

/** Per-project host-toolkit index (skills/agents the user has across project +
 *  global + plugins) — config awareness kept across sessions. */
export function hostIndexPath(root?: string): string {
  return join(knitbrainHome(), "projects", projectId(root), "host-index.json");
}

/** Per-project composed workflow — the standing driver load_session re-surfaces. */
export function workflowPath(root?: string): string {
  return join(knitbrainHome(), "projects", projectId(root), "workflow.md");
}

/** Per-project autonomous-loop state (cross-call iteration counter for run_loop). */
export function loopStatePath(root?: string): string {
  return join(knitbrainHome(), "projects", projectId(root), "loop-state.json");
}
