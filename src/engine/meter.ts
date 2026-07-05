import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { writeAtomic } from "../atomic.js";
import { join } from "node:path";

/**
 * Context-window meter — tracks how much of the model's context window the
 * session has consumed and tells the agent (and the dashboard) when it's time
 * to save a handoff and clear.
 *
 * Sources: the proxy reports the OPTIMIZED request size per turn (the true
 * context the model sees); the MCP side adds tool-output tokens as a floor
 * when no proxy is in the loop.
 */
export interface MeterReading {
  /** Best-known tokens occupying the context window right now. */
  usedTokens: number;
  /** The window budget being metered against. */
  windowTokens: number;
  /** 0–100. */
  usedPct: number;
  /** Tokens the optimizer saved this session (before − after). */
  savedTokens: number;
  /**
   * Optimization as a fraction of the LIVE conversation window:
   * `saved / (liveWindow + saved)` — i.e. how much smaller the live context is
   * than it would have been without knitbrain. 0–100. (gap #2)
   */
  optimizationPct: number;
  /** True when usedTokens includes the MCP-only baseline estimate (no proxy,
   * no real-usage probe — knitbrain sees only its own traffic). */
  estimated: boolean;
  /** True when the session idled past the provider prompt-cache TTL — the next
   * turn re-reads the whole window at full (uncached) price. */
  cacheCold: boolean;
  status: "ok" | "warn" | "handoff";
  /** Human advice matching the status. */
  advice: string;
}

export interface Meter {
  /** Proxy turn: the full optimized request size IS the current context. */
  onRequest(originalTokens: number, optimizedTokens: number): void;
  /** MCP-side: a tool emitted `tokens` into the conversation (additive floor). */
  onToolOutput(tokens: number): void;
  /** MCP-side: the optimizer saved `tokens` on a payload (savings accounting without the proxy). */
  onSaved(tokens: number): void;
  /** Proxy saw the request's model id — adopt its known window (env override still wins). */
  onModel(model: string): void;
  read(): MeterReading;
  /** New session: reset usage (savings history is kept). */
  reset(): void;
}

export interface MeterOptions {
  /** Context window budget in tokens. Default 200k (Claude-class). */
  windowTokens?: number;
  /** warn at this fraction. Default 0.7. */
  warnAt?: number;
  /** advise handoff+clear at this fraction. Default 0.85. */
  handoffAt?: number;
  /**
   * Probe for the host's REAL context-window occupancy (e.g. read from the
   * live transcript). Without it the meter only sees knitbrain's own throughput
   * and under-reports — handoff fires late or never. Returns null when no
   * source is available (then the meter falls back to its own tracking).
   */
  realUsage?: () => number | null;
  /** Host's current model id (transcript probe) → proactive real window via
   * modelWindow, so usedPct is honest BEFORE usage overflows a stale default.
   * Null/unknown → the default/reactive path is unchanged. */
  realModel?: () => string | null;
  /**
   * MCP-only hosts (no proxy, no realUsage data): assume this much standing
   * context (system prompt + instructions + chat) and label the reading an
   * ESTIMATE. Unset = never estimate (exact-only behavior).
   */
  baselineTokens?: number;
  /** Clock override for tests. */
  now?: () => number;
}

interface State {
  lastRequestTokens: number;
  toolTokens: number;
  savedTokens: number;
  /** Window adopted from the request's model id (proxy path). */
  modelWindowTokens?: number;
  /** Last time any traffic hit the meter — cache-staleness signal. */
  lastActivityTs?: number;
}

/** Anthropic/OpenAI prompt-cache TTL — idle past this = next turn uncached. */
const CACHE_TTL_MS = 5 * 60_000;
/** Don't nag about a cold cache when the window is still tiny. */
const CACHE_COLD_MIN_TOKENS = 30_000;

/**
 * Best-known context window by model id. Null = unknown (keep configured).
 * Kills both failure modes of a fixed 200k: false "SAVE HANDOFF" alarms on
 * 1M-window models and false comfort on 128k ones.
 */
export function modelWindow(model: string): number | null {
  const m = model.toLowerCase();
  if (m.includes("[1m]") || m.includes("-1m")) return 1_000_000;
  // Current-gen frontier Claude ships a 1M window (Opus 4.x incl.
  // claude-opus-4-8 — verified live — Sonnet/Opus 5, the Claude 5 family /
  // fable). Mapping ALL claude* → 200k pinned usedPct at ~100% near 200k on
  // these, firing a FALSE "clear now" with ~800k of real headroom. Everything
  // else Claude (legacy 2/3, Haiku, unverified) stays the conservative 200k —
  // the reactive tier-heal still corrects if real usage overflows it.
  if (/^claude-(opus-4|opus-5|sonnet-5|fable-5|fable|5)/.test(m)) return 1_000_000;
  if (m.startsWith("claude")) return 200_000;
  if (m.startsWith("gpt-5")) return 400_000;
  if (m.startsWith("gpt-4.1")) return 1_000_000;
  if (m.startsWith("gpt-4o") || m.startsWith("gpt-4-turbo")) return 128_000;
  if (m.startsWith("o1") || m.startsWith("o3") || m.startsWith("o4")) return 200_000;
  if (m.startsWith("gemini")) return 1_000_000;
  return null;
}

/** Standard context-window tiers (tokens). The smallest tier ≥ observed usage
 *  is the honest effective window when the configured one is stale. */
const WINDOW_TIERS = [200_000, 1_000_000];

export function createMeter(root: string, opts: MeterOptions = {}): Meter {
  // Configured window: env override → option → 200k default. Hardcoding 200k
  // pinned usedPct at 100% on bigger models (false handoff) — env + auto-heal fix it.
  const envWindow = Number(process.env["KNITBRAIN_WINDOW_TOKENS"]);
  const envSet = Number.isFinite(envWindow) && envWindow > 0;
  const windowTokens = (envSet ? envWindow : undefined) ?? opts.windowTokens ?? 200_000;
  const warnAt = opts.warnAt ?? 0.7;
  const handoffAt = opts.handoffAt ?? 0.85;
  mkdirSync(root, { recursive: true });
  const path = join(root, "meter.json");

  let state: State = { lastRequestTokens: 0, toolTokens: 0, savedTokens: 0 };

  // Proxy, MCP server, and dashboard all share this store across processes —
  // re-read disk before every public operation so no reader serves stale state.
  const reload = (): void => {
    if (!existsSync(path)) return;
    try {
      state = { ...state, ...(JSON.parse(readFileSync(path, "utf8")) as State) };
    } catch {
      /* keep current in-memory state */
    }
  };
  reload();
  const save = (): void => {
    writeAtomic(path, JSON.stringify(state));
  };

  return {
    onRequest(originalTokens, optimizedTokens) {
      reload();
      // The optimized request is the authoritative context size this turn.
      state.lastRequestTokens = optimizedTokens;
      state.toolTokens = 0; // request already contains prior tool outputs
      state.savedTokens += Math.max(0, originalTokens - optimizedTokens);
      state.lastActivityTs = (opts.now ?? Date.now)();
      save();
    },
    onToolOutput(tokens) {
      reload();
      state.toolTokens += tokens;
      state.lastActivityTs = (opts.now ?? Date.now)();
      save();
    },
    onSaved(tokens) {
      reload();
      state.savedTokens += Math.max(0, tokens);
      save();
    },
    onModel(model) {
      const w = modelWindow(model);
      if (w === null) return;
      reload();
      if (state.modelWindowTokens !== w) {
        state.modelWindowTokens = w;
        save();
      }
    },
    read() {
      reload();
      // Prefer the host's REAL window (transcript probe) when available; else
      // fall back to knitbrain's own tracked throughput (under-counts, honest).
      const real = opts.realUsage?.() ?? 0;
      // MCP-only host (no proxy request, no transcript probe): knitbrain sees
      // only its own traffic — add the configured baseline and SAY it's an
      // estimate rather than silently under-reporting until handoff fires late.
      const estimated = real === 0 && state.lastRequestTokens === 0 && (opts.baselineTokens ?? 0) > 0;
      const usedTokens = Math.max(state.lastRequestTokens + state.toolTokens, real) + (estimated ? opts.baselineTokens! : 0);
      // Window precedence: explicit env override > window from the request's
      // model id (proxy `onModel`) > window PROBED from the transcript model
      // (Claude Code, proactive) > configured/default. The probe kills the
      // false "clear now" that a stale 200k default fired near ~200k usage on a
      // 1M-window model, before the reactive tier-heal could correct it.
      const probedWindow = opts.realModel ? modelWindow(opts.realModel() ?? "") : null;
      const baseWindow = envSet ? windowTokens : state.modelWindowTokens ?? probedWindow ?? windowTokens;
      // Auto-heal: if observed usage exceeds the configured window, the window
      // is stale (large-context model) — use the smallest standard tier that
      // actually fits, so usedPct/status are honest instead of pinned at 100%.
      const effectiveWindow =
        usedTokens > baseWindow
          ? WINDOW_TIERS.find((t) => t >= usedTokens) ?? Math.ceil(usedTokens / 1_000_000) * 1_000_000
          : baseWindow;
      const usedPct = Math.min(100, Math.round((usedTokens / effectiveWindow) * 1000) / 10);
      const frac = usedTokens / effectiveWindow;
      const status: MeterReading["status"] =
        frac >= handoffAt ? "handoff" : frac >= warnAt ? "warn" : "ok";
      let advice =
        status === "handoff"
          ? `Context ${usedPct}% full — SAVE A HANDOFF NOW (knitbrain_save_handoff with goal/state/next steps), then clear and resume with knitbrain_load_session. Prefer this over /compact: a handoff is structured and lossless (originals stay in the recall store), while /compact lossily summarizes and forgets.`
          : status === "warn"
            ? `Context ${usedPct}% full — finish the current step, then consider knitbrain_save_handoff before starting anything large.`
            : `Context ${usedPct}% full — healthy.`;
      if (estimated) advice += " (estimate — knitbrain sees only its own traffic on this host; the proxy or Claude Code hooks give exact numbers)";
      // Cache-staleness: idle past the provider prompt-cache TTL means the next
      // turn re-reads the whole window at full price — cost signal, not capacity.
      const idleMs = state.lastActivityTs ? (opts.now ?? Date.now)() - state.lastActivityTs : 0;
      const cacheCold = idleMs > CACHE_TTL_MS && usedTokens >= CACHE_COLD_MIN_TOKENS;
      if (cacheCold) {
        advice += ` CACHE COLD (idle ${Math.round(idleMs / 60_000)}m > 5m TTL) — the next turn re-reads ~${Math.round(usedTokens / 1000)}k tokens uncached; if the task is near done, knitbrain_save_handoff + clear is cheaper than continuing.`;
      }
      // Conversation-relative optimization: what the live window saved vs. the
      // unoptimized counterfactual (liveWindow + saved). usedTokens is the live
      // window (realUsage probe or tracked throughput).
      const optimizationPct =
        state.savedTokens > 0
          ? Math.round((state.savedTokens / (usedTokens + state.savedTokens)) * 1000) / 10
          : 0;
      // Report the EFFECTIVE window so the dashboard/meter show the honest
      // denominator (e.g. "420k / 1M"), not the stale configured 200k.
      return { usedTokens, windowTokens: effectiveWindow, usedPct, savedTokens: state.savedTokens, optimizationPct, estimated, cacheCold, status, advice };
    },
    reset() {
      state = { lastRequestTokens: 0, toolTokens: 0, savedTokens: state.savedTokens };
      save();
    },
  };
}
