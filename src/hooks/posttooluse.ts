import { compress } from "../optimizer/router.js";
import type { CCRStore } from "../ccr/store.js";
import { countTokens } from "../tokenizer.js";

/**
 * PostToolUse hook logic (pure — store + meter injected for tests).
 *
 * This is the subscription auto-compression lever. PreToolUse can only deny a
 * raw `Read` and redirect it to `knitbrain_read`; it CANNOT touch the output of
 * Bash / Grep / Glob / WebFetch (there is no knitbrain tool to redirect them
 * to). PostToolUse fires AFTER the tool ran with its result, so we skeletonize
 * the result and hand it back via `updatedToolOutput` — Claude Code replaces
 * the tool's output the model ingests with our skeleton, the exact original
 * stored in the shared CCR recall store (knitbrain_retrieve restores it
 * byte-for-byte). No API key, no proxy, no agent cooperation.
 *
 * `updatedToolOutput` is Claude-Code-specific; hosts that lack it simply never
 * fire this hook, and the universal knitbrain_read path still applies. The hook
 * NEVER expands output (compress() passes small/incompressible blocks through)
 * and never breaks the host (unknown response shapes return null → untouched).
 */
export interface PostToolUseInput {
  tool_name?: string;
  tool_response?: unknown;
}

/** Tools whose output PreToolUse can't redirect — the gap this hook fills.
 * Read stays on PreToolUse (deny→knitbrain_read), so it's intentionally absent. */
export const POSTTOOL_TARGETS = new Set(["Bash", "Grep", "Glob", "WebFetch", "WebSearch"]);

/** Below this many chars, skeletonizing isn't worth the round-trip — pass through. */
export const POSTTOOL_MIN_CHARS = 1000;

/** Extract the textual result from a tool_response of unknown shape. Handles a
 * plain string, Bash's {stdout,stderr}, and {text}/{content} objects. Unknown
 * shapes return null so the hook leaves them untouched (never break the host).
 * ponytail: covers string + Bash + common text fields; exotic shapes pass through. */
function textField(resp: unknown): { text: string; replace: (value: string) => unknown } | null {
  if (typeof resp === "string") return { text: resp, replace: (value) => value };
  if (resp && typeof resp === "object") {
    const o = resp as Record<string, unknown>;
    for (const key of ["stdout", "text", "content"]) {
      if (typeof o[key] === "string") return { text: o[key] as string, replace: (value) => ({ ...o, [key]: value }) };
    }
  }
  return null;
}

function responseTokens(value: unknown): number {
  return countTokens(typeof value === "string" ? value : JSON.stringify(value));
}

export function decidePostToolUse(
  input: PostToolUseInput,
  ccr: CCRStore,
  onSaved: (savedTokens: number, info?: { rawTokens: number; storedTokens: number }) => void = () => {},
): Record<string, unknown> | null {
  if (!input.tool_name || !POSTTOOL_TARGETS.has(input.tool_name)) return null;

  const field = textField(input.tool_response);
  if (field === null || field.text.length < POSTTOOL_MIN_CHARS) return null;
  const text = field.text;
  // Already carries a recall handle (e.g. nested knitbrain output) — don't re-compress.
  if (text.includes("⟨recall:")) return null;

  const r = compress(text, ccr, { allowProse: true });
  if (!r.compressed) return null; // not worth it → leave the original untouched

  const updatedText = `${r.skeleton}\n\n[knitbrain: ${input.tool_name} output · exact original: knitbrain_retrieve ⟨recall:${r.handle}⟩]`;
  const updatedToolOutput = field.replace(updatedText);
  const rawTokens = responseTokens(input.tool_response);
  const storedTokens = responseTokens(updatedToolOutput);
  if (storedTokens >= rawTokens) return null;
  onSaved(rawTokens - storedTokens, { rawTokens, storedTokens });
  return {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      updatedToolOutput,
    },
  };
}
