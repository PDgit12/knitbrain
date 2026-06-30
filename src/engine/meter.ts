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
}

interface State {
  lastRequestTokens: number;
  toolTokens: number;
  savedTokens: number;
}

/** Standard context-window tiers (tokens). The smallest tier ≥ observed usage
 *  is the honest effective window when the configured one is stale. */
const WINDOW_TIERS = [200_000, 1_000_000];

export function createMeter(root: string, opts: MeterOptions = {}): Meter {
  // Configured window: env override → option → 200k default. Hardcoding 200k
  // pinned usedPct at 100% on bigger models (false handoff) — env + auto-heal fix it.
  const envWindow = Number(process.env["KNITBRAIN_WINDOW_TOKENS"]);
  const windowTokens = (Number.isFinite(envWindow) && envWindow > 0 ? envWindow : undefined) ?? opts.windowTokens ?? 200_000;
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
      save();
    },
    onToolOutput(tokens) {
      reload();
      state.toolTokens += tokens;
      save();
    },
    onSaved(tokens) {
      reload();
      state.savedTokens += Math.max(0, tokens);
      save();
    },
    read() {
      reload();
      // Prefer the host's REAL window (transcript probe) when available; else
      // fall back to knitbrain's own tracked throughput (under-counts, honest).
      const real = opts.realUsage?.() ?? 0;
      const usedTokens = Math.max(state.lastRequestTokens + state.toolTokens, real);
      // Auto-heal: if observed usage exceeds the configured window, the window
      // is stale (large-context model) — use the smallest standard tier that
      // actually fits, so usedPct/status are honest instead of pinned at 100%.
      const effectiveWindow =
        usedTokens > windowTokens
          ? WINDOW_TIERS.find((t) => t >= usedTokens) ?? Math.ceil(usedTokens / 1_000_000) * 1_000_000
          : windowTokens;
      const usedPct = Math.min(100, Math.round((usedTokens / effectiveWindow) * 1000) / 10);
      const frac = usedTokens / effectiveWindow;
      const status: MeterReading["status"] =
        frac >= handoffAt ? "handoff" : frac >= warnAt ? "warn" : "ok";
      const advice =
        status === "handoff"
          ? `Context ${usedPct}% full — SAVE A HANDOFF NOW (knitbrain_save_handoff with goal/state/next steps), then clear and resume with knitbrain_load_session. Prefer this over /compact: a handoff is structured and lossless (originals stay in the recall store), while /compact lossily summarizes and forgets.`
          : status === "warn"
            ? `Context ${usedPct}% full — finish the current step, then consider knitbrain_save_handoff before starting anything large.`
            : `Context ${usedPct}% full — healthy.`;
      // Conversation-relative optimization: what the live window saved vs. the
      // unoptimized counterfactual (liveWindow + saved). usedTokens is the live
      // window (realUsage probe or tracked throughput).
      const optimizationPct =
        state.savedTokens > 0
          ? Math.round((state.savedTokens / (usedTokens + state.savedTokens)) * 1000) / 10
          : 0;
      // Report the EFFECTIVE window so the dashboard/meter show the honest
      // denominator (e.g. "420k / 1M"), not the stale configured 200k.
      return { usedTokens, windowTokens: effectiveWindow, usedPct, savedTokens: state.savedTokens, optimizationPct, status, advice };
    },
    reset() {
      state = { lastRequestTokens: 0, toolTokens: 0, savedTokens: state.savedTokens };
      save();
    },
  };
}
