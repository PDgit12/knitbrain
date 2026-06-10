import { existsSync, statSync } from "node:fs";
import { isAbsolute, relative } from "node:path";

/**
 * PreToolUse hook logic (pure — IO injected for tests).
 *
 * When the host is about to raw-Read a LARGE file, deny with a reason that
 * redirects the agent to `knitbrain_read` — turning the rules-file steering
 * into automatic ENFORCEMENT. Small files pass through untouched. This uses
 * the stable PreToolUse deny contract (works across host versions, unlike
 * PostToolUse output replacement).
 */
export interface PreToolUseInput {
  tool_name?: string;
  tool_input?: { file_path?: string; [k: string]: unknown };
  cwd?: string;
}

/** Files larger than this are denied in favor of knitbrain_read. */
export const READ_REDIRECT_BYTES = 20_000;

export function decidePreToolUse(
  input: PreToolUseInput,
  io: { exists: (p: string) => boolean; sizeOf: (p: string) => number } = {
    exists: existsSync,
    sizeOf: (p) => statSync(p).size,
  },
): Record<string, unknown> | null {
  if (input.tool_name !== "Read") return null;
  const path = input.tool_input?.file_path;
  if (typeof path !== "string" || path.length === 0) return null;
  if (!io.exists(path)) return null;

  let size: number;
  try {
    size = io.sizeOf(path);
  } catch {
    return null;
  }
  if (size <= READ_REDIRECT_BYTES) return null;

  const cwd = input.cwd ?? process.cwd();
  const rel = isAbsolute(path) ? relative(cwd, path) : path;
  // Never redirect reads outside the project — knitbrain_read is project-scoped.
  if (rel.startsWith("..")) return null;

  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `Large file (${Math.round(size / 1024)}KB). Use knitbrain_read with path "${rel}" instead — optimized skeleton (~70-90% fewer tokens), exact original via knitbrain_retrieve. Raw Read only for the specific region you are about to edit.`,
    },
  };
}
