import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ContentType } from "../optimizer/types.js";

export interface FeedbackStat {
  kind: ContentType;
  compressions: number;
  retrievals: number;
  /** retrievals / compressions — high means we over-compressed this kind. */
  rate: number;
  /** true once we've backed off (stopped compressing this kind). */
  skipping: boolean;
}

export interface Feedback {
  /** Record that a payload of `kind` was compressed under `handle`. */
  onCompress(kind: ContentType, handle: string): void;
  /** Record that a stored `handle` was paged back (a vote that the skeleton wasn't enough). */
  onRetrieve(handle: string): void;
  /** Self-tuning verdict: should we STOP compressing this kind (over-retrieved)? */
  shouldSkip(kind: ContentType): boolean;
  stats(): FeedbackStat[];
}

interface State {
  kinds: Record<string, { compressions: number; retrievals: number }>;
  handleKind: Record<string, ContentType>;
}

export interface FeedbackOptions {
  /** Minimum compressions before the skip verdict can trigger. */
  minSamples?: number;
  /** Retrieval rate above which we back off and stop compressing a kind. */
  maxRate?: number;
}

const KINDS: ContentType[] = ["json", "code", "text", "prose", "search", "log", "diff"];

/**
 * TOIN feedback — deterministic, local self-tuning. Because CCR is lossless, a
 * wrong verdict only costs efficiency (more retrievals), never correctness.
 */
export function createFeedback(root: string, opts: FeedbackOptions = {}): Feedback {
  const minSamples = opts.minSamples ?? 8;
  const maxRate = opts.maxRate ?? 0.6;
  mkdirSync(root, { recursive: true });
  const path = join(root, "feedback.json");

  let state: State = { kinds: {}, handleKind: {} };

  // Multiple processes share this store (MCP server, proxy, dashboard), so
  // every public operation re-reads disk first — a constructed-once instance
  // must never serve stale counters from another process's writes.
  const reload = (): void => {
    if (!existsSync(path)) return;
    try {
      state = JSON.parse(readFileSync(path, "utf8")) as State;
    } catch {
      /* keep current in-memory state */
    }
  };
  reload();

  const bucket = (kind: ContentType): { compressions: number; retrievals: number } => {
    const b = state.kinds[kind] ?? { compressions: 0, retrievals: 0 };
    state.kinds[kind] = b;
    return b;
  };

  const save = (): void => {
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state), "utf8");
    renameSync(tmp, path);
  };

  const rate = (kind: ContentType): number => {
    const b = state.kinds[kind];
    if (!b || b.compressions === 0) return 0;
    return b.retrievals / b.compressions;
  };

  const skip = (kind: ContentType): boolean => {
    const b = state.kinds[kind];
    return Boolean(b && b.compressions >= minSamples && rate(kind) > maxRate);
  };

  return {
    onCompress(kind, handle) {
      reload();
      bucket(kind).compressions += 1;
      state.handleKind[handle] = kind;
      save();
    },
    onRetrieve(handle) {
      reload();
      const kind = state.handleKind[handle];
      if (!kind) return;
      bucket(kind).retrievals += 1;
      save();
    },
    shouldSkip(kind) {
      reload();
      return skip(kind);
    },
    stats() {
      reload();
      return KINDS.map((kind) => {
        const b = state.kinds[kind] ?? { compressions: 0, retrievals: 0 };
        return {
          kind,
          compressions: b.compressions,
          retrievals: b.retrievals,
          rate: Math.round(rate(kind) * 100) / 100,
          skipping: skip(kind),
        };
      });
    },
  };
}
