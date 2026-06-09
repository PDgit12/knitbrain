import type { CCRStore } from "../ccr/store.js";
import { compress } from "../optimizer/router.js";
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
}

export interface ProxyStats {
  originalTokens: number;
  optimizedTokens: number;
  savedPct: number;
  blocksCompressed: number;
  handles: string[];
}

const DEFAULTS: Required<OptimizeOptions> = { keepLastTurns: 2, minBlockChars: 200 };

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
  let blocksCompressed = 0;

  const compressString = (text: string): string => {
    if (text.length < opts.minBlockChars) return text;
    const r = compress(text, ccr);
    if (!r.compressed) return text;
    blocksCompressed += 1;
    handles.push(r.handle);
    return r.skeleton;
  };

  const compressContent = (content: MessageContent): MessageContent => {
    if (typeof content === "string") return compressString(content);
    return content.map((b) =>
      typeof b.text === "string" ? { ...b, text: compressString(b.text) } : b,
    );
  };

  const msgs = body.messages;
  // Rolling window: indexes >= protectFrom are recent → kept full.
  const protectFrom = Math.max(0, msgs.length - opts.keepLastTurns);
  const messages = msgs.map((m, i) =>
    i >= protectFrom ? m : { ...m, content: compressContent(m.content) },
  );

  // CacheAligner: whitespace-normalize the system prefix (meaning-preserving).
  let system = body.system;
  if (typeof system === "string") system = normalizePrefix(system);

  const optimized: RequestBody = { ...body, messages };
  if (system !== undefined) optimized.system = system;

  const after = countTokens(collectText(optimized));
  const savedPct = before === 0 ? 0 : Math.round((1 - after / before) * 1000) / 10;
  return { body: optimized, stats: { originalTokens: before, optimizedTokens: after, savedPct, blocksCompressed, handles } };
}
