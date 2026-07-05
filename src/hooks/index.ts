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
import { createFileCCRStore } from "../ccr/store.js";
import { createMemory } from "../engine/memory.js";
import { createMeter } from "../engine/meter.js";
import { createWikiStore } from "../engine/wiki.js";
import { currentContextTokens, currentContextModel } from "../engine/usage.js";
import { ccrRoot, memoryRoot, meterRoot, wikiRoot } from "../paths.js";
import { decidePostToolUse, type PostToolUseInput } from "./posttooluse.js";
import { decidePreToolUse, type PreToolUseInput } from "./pretooluse.js";
import { sessionStartOutput } from "./sessionstart.js";
import { mineNewTranscripts } from "../learn.js";
import { GOAL_LOOP_NUDGE } from "../platforms.js";
import { join } from "node:path";

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    setTimeout(() => resolve(data), 2000); // never hang the host
  });
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  try {
    if (mode === "pretooluse") {
      const input = JSON.parse(await readStdin()) as PreToolUseInput;
      const decision = decidePreToolUse(input);
      if (decision) process.stdout.write(JSON.stringify(decision));
      return;
    }
    if (mode === "posttooluse") {
      // Skeletonize the result of host tools PreToolUse can't redirect
      // (Bash/Grep/Glob/WebFetch). Replaces the model-visible output via
      // updatedToolOutput; the exact original lands in the shared CCR store so
      // knitbrain_retrieve restores it. The subscription auto-compression path.
      const input = JSON.parse(await readStdin()) as PostToolUseInput;
      const ccr = createFileCCRStore(ccrRoot());
      const meter = createMeter(meterRoot(), { realUsage: () => currentContextTokens(), realModel: () => currentContextModel() });
      const decision = decidePostToolUse(input, ccr, (n) => meter.onSaved(n));
      if (decision) process.stdout.write(JSON.stringify(decision));
      return;
    }
    if (mode === "userpromptsubmit") {
      // Whole-chat → wiki: append this turn to the wiki log (leg 5 real-time
      // chronicle). Cheap, append-only, never blocks; synthesis pages stay
      // LLM-driven via knitbrain_wiki_ingest.
      try {
        const input = JSON.parse(await readStdin()) as { prompt?: string };
        const prompt = typeof input.prompt === "string" ? input.prompt.replace(/\s+/g, " ").trim() : "";
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
      process.stdout.write(out);
      return;
    }
    if (mode === "sessionstart") {
      // Inject the protocol + prior handoff + top learnings so the session
      // starts already knowing how to operate AND where it left off — the
      // loop's first step no longer depends on the agent calling load_session.
      const memory = createMemory(memoryRoot());
      process.stdout.write(sessionStartOutput(memory.loadSession()));
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
