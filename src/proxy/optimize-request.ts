import type { CCRStore } from "../ccr/store.js";
import { sha256 } from "../ccr/store.js";
import { compress } from "../optimizer/router.js";
import type { ContentType } from "../optimizer/types.js";
import { countTokens } from "../tokenizer.js";
import { alignDynamicContent, prefixHash } from "./cache-aligner.js";

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
  /** Wire protocol — enables provider-specific cache strategy (cache_control). */
  provider?: "anthropic" | "openai";
  /** CacheAligner master switch (default on). */
  cacheAlign?: boolean;
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
  /** Volatile lines CacheAligner moved out of the system prefix. */
  dynamicMoved: number;
  /** Anthropic cache_control breakpoints we inserted (0 if client had its own). */
  cacheBreakpoints: number;
  /** Hash of the aligned system prefix — equal across turns ⇒ cache-hittable. */
  prefixHash: string;
}

const DEFAULTS: Required<Omit<OptimizeOptions, "provider">> = {
  keepLastTurns: 2,
  minBlockChars: 200,
  allowProse: true,
  cacheAlign: true,
};

/** Does the request already carry client-set cache_control anywhere? */
function hasClientCacheControl(body: RequestBody): boolean {
  const blockHas = (b: ContentBlock): boolean => b["cache_control"] !== undefined;
  if (Array.isArray(body.system) && body.system.some(blockHas)) return true;
  for (const m of body.messages) {
    if (Array.isArray(m.content) && m.content.some(blockHas)) return true;
  }
  return false;
}

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
 * preserved in CCR, recoverable via the ⟨recall:hash⟩ the model sees). The system
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
    return `⟪same as earlier ⟨recall:${hash}⟩⟫`;
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

  // CACHE ALIGNER: stabilize the system prefix. Whitespace-normalize AND move
  // volatile lines ("Today's date is …") to a marked tail section — content
  // preserved verbatim, but the leading bytes stop churning between sessions.
  let dynamicMoved = 0;
  let system = body.system;
  if (opts.cacheAlign) {
    if (typeof system === "string") {
      const a = alignDynamicContent(system);
      system = a.text;
      dynamicMoved += a.moved;
    } else if (Array.isArray(system)) {
      system = system.map((b) => {
        if (typeof b.text !== "string") return b;
        const a = alignDynamicContent(b.text);
        dynamicMoved += a.moved;
        return { ...b, text: a.text };
      });
    }
    // OpenAI protocol: the system prompt is the leading system/developer message.
    if (options.provider === "openai") {
      for (let i = 0; i < messages.length && (messages[i]!.role === "system" || messages[i]!.role === "developer"); i += 1) {
        const m = messages[i]!;
        if (typeof m.content === "string") {
          const a = alignDynamicContent(m.content);
          dynamicMoved += a.moved;
          messages[i] = { ...m, content: a.text };
        }
      }
    }
  }

  const optimized: RequestBody = { ...body, messages };
  if (system !== undefined) optimized.system = system;

  // PROVIDER CACHE STRATEGY (Anthropic): explicit cache_control breakpoints —
  // system prompt + the stable history boundary (the last fully-compressed
  // turn). Inserted ONLY when the client set none of its own: hosts like
  // Claude Code manage their own breakpoints and we never fight them.
  let cacheBreakpoints = 0;
  if (opts.cacheAlign && options.provider === "anthropic" && !hasClientCacheControl(optimized)) {
    const ephemeral = { type: "ephemeral" };
    if (typeof optimized.system === "string") {
      optimized.system = [{ type: "text", text: optimized.system, cache_control: ephemeral }];
      cacheBreakpoints += 1;
    } else if (Array.isArray(optimized.system) && optimized.system.length > 0) {
      const last = optimized.system[optimized.system.length - 1]!;
      optimized.system[optimized.system.length - 1] = { ...last, cache_control: ephemeral };
      cacheBreakpoints += 1;
    }
    const boundary = protectFrom - 1;
    if (boundary >= 0) {
      const m = messages[boundary]!;
      const blocks: ContentBlock[] =
        typeof m.content === "string" ? [{ type: "text", text: m.content }] : [...m.content];
      if (blocks.length > 0) {
        blocks[blocks.length - 1] = { ...blocks[blocks.length - 1]!, cache_control: ephemeral };
        messages[boundary] = { ...m, content: blocks };
        cacheBreakpoints += 1;
      }
    }
  }

  const sysText =
    typeof optimized.system === "string"
      ? optimized.system
      : Array.isArray(optimized.system)
        ? optimized.system.map((b) => b.text ?? "").join("\n")
        : "";

  const after = countTokens(collectText(optimized));
  const savedPct = before === 0 ? 0 : Math.round((1 - after / before) * 1000) / 10;
  return {
    body: optimized,
    stats: {
      originalTokens: before,
      optimizedTokens: after,
      savedPct,
      blocksCompressed,
      blocksDeduped,
      handles,
      kinds,
      dynamicMoved,
      cacheBreakpoints,
      prefixHash: prefixHash(sysText),
    },
  };
}
