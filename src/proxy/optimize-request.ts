import type { CCRStore } from "../ccr/store.js";
import { sha256 } from "../ccr/store.js";
import { compress } from "../optimizer/router.js";
import type { ContentType } from "../optimizer/types.js";
import { countTokens } from "../tokenizer.js";
import { normalizePrefix } from "./cache-aligner.js";

/**
 * Minimal Anthropic-style request shapes. We treat the body as mostly opaque
 * (pass unknown fields through untouched) and only transform message content.
 */
export interface ContentBlock {
  type: string;
  text?: string;
  [k: string]: unknown;
}
export type MessageContent = string | ContentBlock[];
export interface Message {
  role: string;
  content: MessageContent;
  [k: string]: unknown;
}
export interface RequestBody {
  system?: string | ContentBlock[];
  messages: Message[];
  [k: string]: unknown;
}

export interface OptimizeOptions {
  /** Recent messages kept fully uncompressed (rolling window). */
  keepLastTurns?: number;
  /** Only compress text blocks longer than this many characters. */
  minBlockChars?: number;
  /** Whether short-prose sentence anchoring may apply (TOIN-gated by callers). */
  allowProse?: boolean;
}

export interface ProxyStats {
  originalTokens: number;
  optimizedTokens: number;
  savedPct: number;
  blocksCompressed: number;
  /** Blocks collapsed to a ⟪same as …⟫ marker because identical content appeared earlier in the history. */
  blocksDeduped: number;
  handles: string[];
  /** Content kind per compressed handle — lets callers feed TOIN (onCompress). */
  kinds: Record<string, ContentType>;
}

const DEFAULTS: Required<OptimizeOptions> = { keepLastTurns: 2, minBlockChars: 200, allowProse: true };

/** Concatenate all human-readable text in a request, for honest token accounting. */
function collectText(body: RequestBody): string {
  const parts: string[] = [];
  const sys = body.system;
  if (typeof sys === "string") parts.push(sys);
  else if (Array.isArray(sys)) for (const b of sys) if (b.text) parts.push(b.text);
  for (const m of body.messages) {
    if (typeof m.content === "string") parts.push(m.content);
    else for (const b of m.content) if (b.text) parts.push(b.text);
  }
  return parts.join("\n");
}

/**
 * Optimize an LLM request: protect the recent turns + the current intent +
 * the system prompt; compress large text blocks in older turns (original
 * preserved in CCR, recoverable via the ⟨ccr:hash⟩ the model sees). The system
 * prefix is whitespace-normalized (meaning-preserving) for KV-cache stability.
 */
export function optimizeRequest(
  body: RequestBody,
  ccr: CCRStore,
  options: OptimizeOptions = {},
): { body: RequestBody; stats: ProxyStats } {
  const opts = { ...DEFAULTS, ...options };
  const before = countTokens(collectText(body));

  const handles: string[] = [];
  const kinds: Record<string, ContentType> = {};
  let blocksCompressed = 0;
  let blocksDeduped = 0;

  const keep = (handle: string, kind: ContentType): void => {
    blocksCompressed += 1;
    handles.push(handle);
    kinds[handle] = kind;
  };

  // CROSS-TURN DEDUP: agents re-send the same bulk repeatedly (re-reading a
  // file, the same tool output pasted twice). The FIRST occurrence keeps its
  // skeleton; identical repeats collapse to a marker pointing at the same CCR
  // original (sha256(text) IS the handle — content-addressed). Lossless.
  const seen = new Set<string>();
  const dedup = (text: string): string | null => {
    const hash = sha256(text);
    if (!seen.has(hash)) {
      seen.add(hash);
      return null;
    }
    ccr.put(text); // idempotent — guarantees the handle resolves
    blocksDeduped += 1;
    handles.push(hash);
    return `⟪same as earlier ⟨ccr:${hash}⟩⟫`;
  };

  // OLD turns: compress the whole block (it already served its purpose).
  const compressString = (text: string): string => {
    if (text.length < opts.minBlockChars) return text;
    const repeat = dedup(text);
    if (repeat !== null) return repeat;
    const r = compress(text, ccr, { allowProse: opts.allowProse });
    if (!r.compressed) return text;
    keep(r.handle, r.contentType);
    return r.skeleton;
  };

  // PROTECTED turns (incl. current intent): keep the directive verbatim, but
  // compress EMBEDDED BULK — fenced code/data blocks pasted into the message.
  const FENCE = /```([A-Za-z0-9_+.-]*)\n([\s\S]*?)```/g;
  const splitCompress = (text: string): string =>
    text.replace(FENCE, (whole: string, lang: string, inner: string) => {
      if (inner.length < opts.minBlockChars) return whole;
      const repeat = dedup(inner);
      if (repeat !== null) return "```" + lang + "\n" + repeat + "\n```";
      const r = compress(inner, ccr, { allowProse: opts.allowProse });
      if (!r.compressed) return whole;
      keep(r.handle, r.contentType);
      return "```" + lang + "\n" + r.skeleton + "\n```";
    });

  const applyToContent = (
    content: MessageContent,
    fn: (t: string) => string,
  ): MessageContent => {
    if (typeof content === "string") return fn(content);
    return content.map((b) => (typeof b.text === "string" ? { ...b, text: fn(b.text) } : b));
  };

  const msgs = body.messages;
  // Rolling window: recent turns are protected (intent verbatim, bulk split);
  // older turns are fully compressed.
  const protectFrom = Math.max(0, msgs.length - opts.keepLastTurns);
  const messages = msgs.map((m, i) =>
    i >= protectFrom
      ? { ...m, content: applyToContent(m.content, splitCompress) }
      : { ...m, content: applyToContent(m.content, compressString) },
  );

  // CacheAligner: whitespace-normalize the system prefix (meaning-preserving).
  let system = body.system;
  if (typeof system === "string") system = normalizePrefix(system);

  const optimized: RequestBody = { ...body, messages };
  if (system !== undefined) optimized.system = system;

  const after = countTokens(collectText(optimized));
  const savedPct = before === 0 ? 0 : Math.round((1 - after / before) * 1000) / 10;
  return { body: optimized, stats: { originalTokens: before, optimizedTokens: after, savedPct, blocksCompressed, blocksDeduped, handles, kinds } };
}
