import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import { workflowPath } from "../paths.js";

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
  tool_input?: { file_path?: string; command?: string; [k: string]: unknown };
  cwd?: string;
}

/** Files larger than this are denied in favor of knitbrain_read. */
export const READ_REDIRECT_BYTES = 20_000;

/**
 * Conservative CONSTRAINTS-line → forbidden-literal mapping (brain→body
 * enforcement). Each entry: if the composed workflow's CONSTRAINTS line
 * contains `trigger`, deny Bash commands containing ANY of `literals`.
 * Deliberately narrow — false negatives (missed constraint) are fine,
 * false positives (over-blocking) are not.
 */
const CONSTRAINT_RULES: Array<{ trigger: string; literals: string[] }> = [
  { trigger: "publish", literals: ["npm publish"] },
  { trigger: "force-push", literals: ["--force"] },
  { trigger: "force push", literals: ["--force"] },
  { trigger: "no-verify", literals: ["--no-verify"] },
];

/** Extract forbidden command literals for a given constraints line, gated to
 * rules whose `literals` are also verified to relate to a "push" when the
 * trigger is force-push-ish (so --force alone on an unrelated command isn't
 * blocked). Fail-open: unknown/no triggers found → empty array. */
function forbiddenLiteralsFor(constraintsLine: string): string[] {
  const lower = constraintsLine.toLowerCase();
  const literals: string[] = [];
  for (const rule of CONSTRAINT_RULES) {
    if (lower.includes(rule.trigger)) literals.push(...rule.literals);
  }
  return literals;
}

/** io.readWorkflow is optional so existing callers/tests need not supply it —
 * absence, a missing file, or an unparseable CONSTRAINTS line all fail open
 * (return null / no denial), never over-block. */
export interface PreToolUseIo {
  exists: (p: string) => boolean;
  sizeOf: (p: string) => number;
  readWorkflow?: () => string | null;
  /** G4 (all optional, fail-open): session reads-map entry for a path. */
  readEntry?: (path: string) => { count: number; mtimeMs: number } | null;
  /** Current mtime — belt+braces against a change racing the reads map. */
  mtimeOf?: (path: string) => number;
  /** sha256 of the file's exact bytes IF that content is already in CCR. */
  recallHandleFor?: (path: string) => string | null;
}

export const defaultPreToolUseIo: PreToolUseIo = {
  exists: existsSync,
  sizeOf: (p) => statSync(p).size,
  readWorkflow: () => {
    try {
      const path = workflowPath();
      if (!existsSync(path)) return null;
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  },
};

/** Check a Bash command / Write path against the composed workflow's
 * CONSTRAINTS line. Returns a deny decision or null (fail-open). */
function decideConstraintDenial(input: PreToolUseInput, io: PreToolUseIo): Record<string, unknown> | null {
  if (!io.readWorkflow) return null;
  if (input.tool_name !== "Bash" && input.tool_name !== "Write") return null;

  let text: string | null;
  try {
    text = io.readWorkflow();
  } catch {
    return null;
  }
  if (!text) return null;

  const match = /^CONSTRAINTS:\s*(.*)$/m.exec(text);
  if (!match) return null;
  const constraintsLine = match[1]?.trim();
  if (!constraintsLine) return null;

  const literals = forbiddenLiteralsFor(constraintsLine);
  if (literals.length === 0) return null;

  const target = input.tool_name === "Bash" ? input.tool_input?.command : input.tool_input?.file_path;
  if (typeof target !== "string" || target.length === 0) return null;

  const hit = literals.find((lit) => target.includes(lit));
  if (!hit) return null;

  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `Blocked by project CONSTRAINTS: ${constraintsLine}`,
    },
  };
}

/**
 * G4: repeat-read of an UNCHANGED file whose exact content already lives in
 * CCR → deny with the real, resolvable recall handle. Never blocks fresh
 * content: any missing io, changed mtime, absent CCR entry, or error → null.
 * Honest math: the deny itself claims saved:0 — savings count only when the
 * recall is actually retrieved.
 */
export function decideRepeatReadRecall(input: PreToolUseInput, io: PreToolUseIo): Record<string, unknown> | null {
  if (input.tool_name !== "Read") return null;
  const path = input.tool_input?.file_path;
  if (typeof path !== "string" || path.length === 0) return null;
  if (!io.readEntry || !io.mtimeOf || !io.recallHandleFor) return null;
  try {
    const entry = io.readEntry(path);
    // recordRead has already run for THIS attempt, so count>=2 = genuine
    // repeat; mtime equality guards a change racing the reads map.
    if (!entry || entry.count < 2 || entry.mtimeMs !== io.mtimeOf(path)) return null;
    const handle = io.recallHandleFor(path);
    if (!handle) return null;
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `unchanged since last read — the exact content is already in recall. Retrieve ⟨recall:${handle}⟩ (knitbrain_retrieve) instead of re-reading; byte-exact.`,
      },
    };
  } catch {
    return null;
  }
}

export function decidePreToolUse(input: PreToolUseInput, io: PreToolUseIo = defaultPreToolUseIo): Record<string, unknown> | null {
  const constraintDenial = decideConstraintDenial(input, io);
  if (constraintDenial) return constraintDenial;

  // G4 repeat-read recall beats the large-file redirect: if the content is
  // already stored, serving the handle is strictly better than a redirect.
  const recallDenial = decideRepeatReadRecall(input, io);
  if (recallDenial) return recallDenial;

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
