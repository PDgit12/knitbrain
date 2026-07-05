import { terseStore } from "../compress-file.js";

/**
 * Anti-* cleanse layer — the last gate before text enters the brain (the
 * source of truth). Two concerns, both SAFE (they never reject a valid write,
 * only sanitize it):
 *
 *   1. secret-scrub  — redact obvious credentials so a leaked key can't be
 *      persisted and then re-injected into every future session. The brain is
 *      re-read at each session start; a secret stored once leaks repeatedly.
 *   2. terse-store   — drop filler/hedging (compressProse, which byte-preserves
 *      code/paths/URLs) so recurring re-injection (handoff + top learnings) costs
 *      fewer tokens every session. Gated by KNITBRAIN_TERSE_STORE inside
 *      terseStore itself; scrub is unconditional.
 *
 * Deliberately NOT here: "reject unverified/hallucinated claims" — that is fuzzy
 * and would drop valid learnings. Verification is knitbrain_verify_claim's job,
 * upstream and explicit, not a silent write-filter.
 */

/** Credential patterns redacted before a write reaches the brain. Conservative
 * — each requires a distinctive prefix/shape so real prose is never mangled. */
const SECRET_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g, label: "PRIVATE-KEY" },
  { re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g, label: "ANTHROPIC-KEY" },
  { re: /\bsk-[A-Za-z0-9]{20,}/g, label: "OPENAI-KEY" },
  { re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}/g, label: "GITHUB-TOKEN" },
  { re: /\bgithub_pat_[A-Za-z0-9_]{22,}/g, label: "GITHUB-PAT" },
  { re: /\bhf_[A-Za-z0-9]{20,}/g, label: "HUGGINGFACE-TOKEN" },
  { re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, label: "AWS-KEY" },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, label: "SLACK-TOKEN" },
  { re: /\bAIza[0-9A-Za-z_-]{35}\b/g, label: "GOOGLE-KEY" },
  // Bearer <token> and generic `key=`/`token=`/`secret=` assignments with a long value.
  { re: /\bBearer\s+[A-Za-z0-9._-]{20,}/g, label: "BEARER-TOKEN" },
  { re: /\b(?:api[_-]?key|secret|token|password|passwd)\s*[=:]\s*["']?[A-Za-z0-9._-]{16,}["']?/gi, label: "CREDENTIAL" },
];

/** Redact credentials from text destined for the brain. Returns the scrubbed
 * text (unchanged when nothing matched). */
export function scrubSecrets(text: string): string {
  let out = text;
  for (const { re, label } of SECRET_PATTERNS) out = out.replace(re, `[REDACTED:${label}]`);
  return out;
}

/**
 * True if the text contains a credential — the single detection primitive for
 * callers that REJECT or SKIP rather than scrub (the hub rejects a poisoned
 * post; transcript mining skips a secret-bearing line). One source of truth so
 * the three sites don't drift apart. `.test` on a /g regex is stateful, so test
 * a fresh clone of each pattern. */
export function containsSecret(text: string): boolean {
  return SECRET_PATTERNS.some(({ re }) => new RegExp(re.source, re.flags.replace("g", "")).test(text));
}

/**
 * The full brain-write cleanse: scrub secrets (always), then terse-store (gated).
 * Order matters — scrub BEFORE terse so a credential is redacted even if terse
 * would later reshape the surrounding prose.
 */
export function cleanseForBrain(text: string): string {
  return terseStore(scrubSecrets(text));
}
