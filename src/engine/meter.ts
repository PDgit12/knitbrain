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
}

interface State {
  lastRequestTokens: number;
  toolTokens: number;
  savedTokens: number;
}

export function createMeter(root: string, opts: MeterOptions = {}): Meter {
  const windowTokens = opts.windowTokens ?? 200_000;
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
      const usedTokens = state.lastRequestTokens + state.toolTokens;
      const usedPct = Math.min(100, Math.round((usedTokens / windowTokens) * 1000) / 10);
      const frac = usedTokens / windowTokens;
      const status: MeterReading["status"] =
        frac >= handoffAt ? "handoff" : frac >= warnAt ? "warn" : "ok";
      const advice =
        status === "handoff"
          ? `Context ${usedPct}% full — SAVE A HANDOFF NOW (knitbrain_save_handoff with goal/state/next steps), then clear the session and resume; knitbrain_load_session restores everything.`
          : status === "warn"
            ? `Context ${usedPct}% full — finish the current step, then consider knitbrain_save_handoff before starting anything large.`
            : `Context ${usedPct}% full — healthy.`;
      return { usedTokens, windowTokens, usedPct, savedTokens: state.savedTokens, status, advice };
    },
    reset() {
      state = { lastRequestTokens: 0, toolTokens: 0, savedTokens: state.savedTokens };
      save();
    },
  };
}
