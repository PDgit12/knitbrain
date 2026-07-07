#!/usr/bin/env node
/**
 * knitbrain-hook — host lifecycle hooks (Layer 2, per-platform enhancement on
 * top of the universal knitbrain_read steering).
 *
 *   knitbrain-hook pretooluse    stdin: PreToolUse JSON → deny+redirect large raw Reads
 *   knitbrain-hook posttooluse   stdin: PostToolUse JSON → skeletonize Bash/Grep/WebFetch output
 *   knitbrain-hook sessionstart  inject protocol + handoff + learnings into a new session
 *   knitbrain-hook precompact    auto-save a handoff BEFORE the host compacts
 *   knitbrain-hook stop          auto-save a resumable handoff at session end (non-clobbering)
 *
 * Hooks must NEVER break the host: any internal error exits 0 silently.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { createFileCCRStore } from "../ccr/store.js";
import { createMemory } from "../engine/memory.js";
import { createMeter } from "../engine/meter.js";
import { createWikiStore } from "../engine/wiki.js";
import { createActivityLog } from "../engine/activity.js";
import { createFeedback } from "../engine/feedback.js";
import { markSessionStart, readSessionMark, recordRead, recordRedirect, buildReceipt } from "../engine/receipt.js";
import { currentContextTokens, currentContextModel } from "../engine/usage.js";
import { ccrRoot, memoryRoot, meterRoot, wikiRoot, loopStatePath, activityRoot, feedbackRoot } from "../paths.js";
import { decideLoopStop } from "./stop.js";
import { decidePostToolUse, type PostToolUseInput } from "./posttooluse.js";
import { decidePreToolUse, defaultPreToolUseIo, type PreToolUseInput } from "./pretooluse.js";
import { sessionStartOutput } from "./sessionstart.js";
import { mineNewTranscripts } from "../learn.js";
import { GOAL_LOOP_NUDGE } from "../platforms.js";
import { join } from "node:path";
import { detectHookPlatform, normalizeEventName, normalizeInput, adaptOutput, type HookMode } from "./adapters.js";

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    setTimeout(() => resolve(data), 2000); // never hang the host
  });
}

async function main(): Promise<void> {
  const cliMode = process.argv[2] as HookMode | undefined;
  try {
    const raw = await readStdin();
    let payload: Record<string, unknown> = {};
    try {
      payload = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    } catch {
      payload = {}; // malformed payload — fall through to CLI-arg mode, empty fields
    }

    const platform = detectHookPlatform(payload);
    const rawEvent = payload["hook_event_name"];
    // Payload's declared event wins when it maps to a known mode; the CLI arg
    // (how claude invokes `knitbrain-hook <mode>`) is the fallback — this keeps
    // claude behavior byte-for-byte unchanged when no/irrelevant event name.
    const eventMode = typeof rawEvent === "string" ? normalizeEventName(platform, rawEvent) : null;
    const mode: HookMode | undefined = eventMode ?? cliMode;
    const input = normalizeInput(platform, mode ?? "pretooluse", payload);

    if (mode === "pretooluse") {
      const preInput = input as PreToolUseInput;
      // Ledger the read attempt (any Read, not just denied ones) so the G1
      // receipt can compare read frequency vs redirect frequency later.
      if (preInput.tool_name === "Read" && typeof preInput.tool_input?.file_path === "string") {
        try {
          const p = preInput.tool_input.file_path;
          if (existsSync(p)) recordRead(meterRoot(), p, statSync(p).mtimeMs);
        } catch {
          /* receipt bookkeeping — never break the host */
        }
      }
      // G4 io: session reads-map entry + current mtime + CCR content-hash
      // probe. All fail-open — any error means the decide sees null and allows.
      const decision = decidePreToolUse(preInput, {
        ...defaultPreToolUseIo, // keeps readWorkflow → constraint denial intact
        readEntry: (fp) => {
          try {
            return readSessionMark(meterRoot())?.reads[fp] ?? null;
          } catch {
            return null;
          }
        },
        mtimeOf: (fp) => statSync(fp).mtimeMs,
        recallHandleFor: (fp) => {
          try {
            const h = createHash("sha256").update(readFileSync(fp, "utf8"), "utf8").digest("hex");
            return createFileCCRStore(ccrRoot()).has(h) ? h : null;
          } catch {
            return null;
          }
        },
      });
      // Distinguish the LARGE-READ redirect deny from a CONSTRAINTS deny by
      // reason text — decidePreToolUse's redirect reason always starts with
      // "Large file"; the constraints reason starts with "Blocked by project".
      if (decision) {
        const hso = decision["hookSpecificOutput"] as Record<string, unknown> | undefined;
        const reason = hso?.["permissionDecisionReason"] as string | undefined;
        if (typeof reason === "string" && reason.startsWith("unchanged since last read") && typeof preInput.tool_input?.file_path === "string") {
          try {
            createActivityLog(activityRoot(), { protectSince: () => readSessionMark(meterRoot())?.startTs ?? null }).record({
              agent: "hook",
              tool: "Read",
              summary: "served from recall (repeat read)",
              saved: 0, // honest math: counted only when the recall is retrieved
              source: "hook",
              kind: "redirect",
              file: preInput.tool_input.file_path,
            });
          } catch {
            /* receipt bookkeeping — never break the host */
          }
        }
        if (typeof reason === "string" && reason.startsWith("Large file") && typeof preInput.tool_input?.file_path === "string") {
          try {
            const p = preInput.tool_input.file_path;
            recordRedirect(meterRoot(), p);
            createActivityLog(activityRoot(), { protectSince: () => readSessionMark(meterRoot())?.startTs ?? null }).record({
              agent: "hook",
              tool: "Read",
              summary: "redirected oversized read",
              saved: 0,
              source: "hook",
              kind: "redirect",
              file: p,
            });
          } catch {
            /* receipt bookkeeping — never break the host */
          }
        }
      }
      const out = adaptOutput(platform, "pretooluse", decision);
      if (out) process.stdout.write(JSON.stringify(out));
      return;
    }
    if (mode === "posttooluse") {
      // Skeletonize the result of host tools PreToolUse can't redirect
      // (Bash/Grep/Glob/WebFetch). Replaces the model-visible output via
      // updatedToolOutput; the exact original lands in the shared CCR store so
      // knitbrain_retrieve restores it. The subscription auto-compression path.
      const ccr = createFileCCRStore(ccrRoot());
      const meter = createMeter(meterRoot(), { realUsage: () => currentContextTokens(), realModel: () => currentContextModel() });
      const toolName = typeof (input as PostToolUseInput).tool_name === "string" ? (input as PostToolUseInput).tool_name! : "unknown";
      const decision = decidePostToolUse(input as PostToolUseInput, ccr, (n, info) => {
        meter.onSaved(n);
        try {
          createActivityLog(activityRoot(), { protectSince: () => readSessionMark(meterRoot())?.startTs ?? null }).record({
            agent: "hook",
            tool: toolName,
            summary: `skeletonized ${toolName} output`,
            saved: n,
            source: "hook",
            rawTokens: info?.rawTokens,
            storedTokens: info?.storedTokens,
          });
        } catch {
          /* ledger is observability — never break the hook */
        }
      });
      const out = adaptOutput(platform, "posttooluse", decision);
      if (out) process.stdout.write(JSON.stringify(out));
      return;
    }
    if (mode === "userpromptsubmit") {
      // Whole-chat → wiki: append this turn to the wiki log (leg 5 real-time
      // chronicle). Cheap, append-only, never blocks; synthesis pages stay
      // LLM-driven via knitbrain_wiki_ingest.
      try {
        const prompt = typeof input["prompt"] === "string" ? (input["prompt"] as string).replace(/\s+/g, " ").trim() : "";
        if (prompt) createWikiStore(wikiRoot()).log("turn", prompt.slice(0, 80));
      } catch {
        /* never break the host on a malformed prompt payload */
      }
      // Re-inject the protocol EVERY turn so the agent doesn't drift over a long
      // session (SessionStart fires once; this fights mid-session forgetting —
      // the way caveman/ponytail stay active). Kept short to cost ~nothing; the
      // live real-window status only appends when the window is no longer "ok".
      const meter = createMeter(meterRoot(), { realUsage: () => currentContextTokens(), realModel: () => currentContextModel() });
      const r = meter.read();
      let out =
        "knitbrain active — classify_task before non-trivial edits · search_code before reading files · knitbrain_read for big files · verify claims with output (no yes-man) · answer terse (same facts, fewer words) · record_learning before done.\n" +
        GOAL_LOOP_NUDGE;
      // Live conversation-relative optimization (gap #2): how much smaller the
      // live window is than its unoptimized counterfactual.
      if (r.optimizationPct > 0) out += ` · optimized ${r.optimizationPct}% of the live window (saved ${r.savedTokens.toLocaleString()} tok)`;
      if (r.status !== "ok") out += `\n[context ${r.usedPct}%] ${r.advice}`;
      // Non-claude/codex hosts that support context injection get the same
      // text via their native shape; plain stdout still works as a fallback.
      const adapted = adaptOutput(platform, "userpromptsubmit", { hookSpecificOutput: { additionalContext: out } });
      if (platform === "claude" || platform === "codex") {
        process.stdout.write(out);
      } else if (adapted) {
        process.stdout.write(JSON.stringify(adapted));
      } else {
        process.stdout.write(out);
      }
      return;
    }
    if (mode === "sessionstart") {
      // Inject the protocol + prior handoff + top learnings so the session
      // starts already knowing how to operate AND where it left off — the
      // loop's first step no longer depends on the agent calling load_session.
      const memory = createMemory(memoryRoot());
      const sessionText = sessionStartOutput(memory.loadSession());
      if (platform === "claude" || platform === "codex") {
        process.stdout.write(sessionText);
      } else {
        const adapted = adaptOutput(platform, "sessionstart", { hookSpecificOutput: { additionalContext: sessionText } });
        process.stdout.write(adapted ? JSON.stringify(adapted) : sessionText);
      }
      // Ingestion-gap closer: on subscription hosts assistant prose is
      // uncapturable live but IS in the on-disk transcripts — incrementally
      // mine new/changed ones (state-keyed, capped) into the brain.
      try {
        const mined = await mineNewTranscripts(process.cwd(), join(memoryRoot(), "learn-state.json"), 2);
        for (const l of mined.slice(0, 5)) {
          memory.recordLearning({ summary: l.text.slice(0, 120), lesson: l.text, tags: ["mined:transcript", l.category] });
        }
      } catch {
        /* never break session start */
      }
      // G1 receipt: stamp a session marker (start-of-session meter/retrieval
      // snapshot) so `stop` can compute this-session deltas via activity.since().
      try {
        const meter = createMeter(meterRoot(), { realUsage: () => currentContextTokens(), realModel: () => currentContextModel() });
        const r = meter.read();
        // Retrievals-at-start: same feedback.stats() source the stop branch
        // uses, kept cheap (small on-disk JSON, not the transcript).
        const retrievals = createFeedback(feedbackRoot())
          .stats()
          .reduce((sum, s) => sum + s.retrievals, 0);
        markSessionStart(meterRoot(), { savedTokens: r.savedTokens, usedTokens: r.usedTokens, retrievals });
      } catch {
        /* never break session start */
      }
      return;
    }
    if (mode === "precompact") {
      // The host is about to compact — capture a resumable handoff first so
      // nothing is lost to compaction. load_session restores it next time.
      const memory = createMemory(memoryRoot());
      const prior = memory.loadSession().handoff ?? "";
      const note = `[auto-handoff @ ${new Date().toISOString()}] Host compaction imminent. If resuming after a clear: re-run knitbrain_load_session, re-check knitbrain_context_meter, and continue from the state below.\n${prior}`;
      memory.saveHandoff(note);
      return;
    }
    if (mode === "stop") {
      // Gap 6b — ENFORCE the loop (not just steer): block the FIRST stop when a
      // goal is still in progress, then fall through to the normal handoff.
      const stopDecision = decideLoopStop(loopStatePath());
      if (stopDecision) {
        const out = adaptOutput(platform, "stop", stopDecision as unknown as Record<string, unknown>);
        if (out) process.stdout.write(JSON.stringify(out));
        return;
      }
      // Session ending: ensure a resumable handoff EXISTS, but never clobber a
      // richer one the agent already wrote — only stamp a minimal marker when
      // there's nothing to resume from, so an abrupt end is still recoverable.
      const memory = createMemory(memoryRoot());
      const prior = memory.loadSession().handoff;
      if (!prior || prior.trim().length === 0) {
        memory.saveHandoff(
          `[auto-handoff @ ${new Date().toISOString()}] Session ended. On resume: knitbrain_load_session, then knitbrain_run with your next task.`,
        );
      }
      // G1 receipt: end-of-session summary of what this session actually
      // optimized (skeletonizations, redirects, retrievals) vs sessionstart's
      // marker. Never on the loop-block path — only when the stop is real.
      try {
        const meter = createMeter(meterRoot(), { realUsage: () => currentContextTokens(), realModel: () => currentContextModel() });
        const meterReading = meter.read();
        const mark = readSessionMark(meterRoot());
        const activity = createActivityLog(activityRoot(), { protectSince: () => readSessionMark(meterRoot())?.startTs ?? null });
        const { events, trimmed } = mark ? activity.since(mark.startTs) : { events: [], trimmed: false };
        const retrievalsTotal = createFeedback(feedbackRoot())
          .stats()
          .reduce((sum, s) => sum + s.retrievals, 0);
        const receipt = buildReceipt({ meter: meterReading, mark, events, eventsTrimmed: trimmed, retrievalsTotal });
        const out = adaptOutput(platform, "stop", { systemMessage: receipt });
        if (out) process.stdout.write(JSON.stringify(out));
      } catch {
        /* receipt is observability — never break the host on stop */
      }
      return;
    }
  } catch {
    // swallow — a hook failure must never break the host session
  }
}

main().then(
  () => process.exit(0),
  () => process.exit(0),
);
