#!/usr/bin/env node
/**
 * knitbrain-hook — host lifecycle hooks (Layer 2, per-platform enhancement on
 * top of the universal knitbrain_read steering).
 *
 *   knitbrain-hook pretooluse    stdin: PreToolUse JSON → deny+redirect large raw Reads
 *   knitbrain-hook sessionstart  inject protocol + handoff + learnings into a new session
 *   knitbrain-hook precompact    auto-save a handoff BEFORE the host compacts
 *   knitbrain-hook stop          auto-save a resumable handoff at session end (non-clobbering)
 *
 * Hooks must NEVER break the host: any internal error exits 0 silently.
 */
import { createMemory } from "../engine/memory.js";
import { createMeter } from "../engine/meter.js";
import { currentContextTokens } from "../engine/usage.js";
import { memoryRoot, meterRoot } from "../paths.js";
import { decidePreToolUse, type PreToolUseInput } from "./pretooluse.js";
import { sessionStartOutput } from "./sessionstart.js";

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
    if (mode === "userpromptsubmit") {
      // Re-inject the protocol EVERY turn so the agent doesn't drift over a long
      // session (SessionStart fires once; this fights mid-session forgetting —
      // the way caveman/ponytail stay active). Kept short to cost ~nothing; the
      // live real-window status only appends when the window is no longer "ok".
      const meter = createMeter(meterRoot(), { realUsage: () => currentContextTokens() });
      const r = meter.read();
      let out =
        "knitbrain active — classify_task before non-trivial edits · knitbrain_read for big files · verify claims with output (no yes-man) · record_learning before done.";
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
