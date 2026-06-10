#!/usr/bin/env node
/**
 * knitbrain-hook — host lifecycle hooks (Layer 2, per-platform enhancement on
 * top of the universal knitbrain_read steering).
 *
 *   knitbrain-hook pretooluse   stdin: PreToolUse JSON → deny+redirect large raw Reads
 *   knitbrain-hook precompact   auto-save a handoff BEFORE the host compacts
 *
 * Hooks must NEVER break the host: any internal error exits 0 silently.
 */
import { createMemory } from "../engine/memory.js";
import { memoryRoot } from "../paths.js";
import { decidePreToolUse, type PreToolUseInput } from "./pretooluse.js";

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
    if (mode === "precompact") {
      // The host is about to compact — capture a resumable handoff first so
      // nothing is lost to compaction. load_session restores it next time.
      const memory = createMemory(memoryRoot());
      const prior = memory.loadSession().handoff ?? "";
      const note = `[auto-handoff @ ${new Date().toISOString()}] Host compaction imminent. If resuming after a clear: re-run knitbrain_load_session, re-check knitbrain_context_meter, and continue from the state below.\n${prior}`;
      memory.saveHandoff(note);
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
