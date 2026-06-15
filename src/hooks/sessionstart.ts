import { INSTRUCTIONS } from "../mcp/instructions.js";

/** Minimal shape of what memory.loadSession() returns (decoupled for tests). */
export interface SessionSnapshot {
  handoff: string | null;
  topLearnings: Array<{ summary: string }>;
}

/**
 * Build the context a SessionStart hook injects into EVERY new session, so the
 * operating protocol + prior memory are present without the agent having to
 * call knitbrain_load_session itself. This is the adherence win: the loop's
 * first step stops depending on the agent choosing to take it.
 *
 * Pure: takes the snapshot, returns the additionalContext string.
 */
export function buildSessionStartContext(snap: SessionSnapshot): string {
  const parts: string[] = [INSTRUCTIONS];
  if (snap.handoff && snap.handoff.trim().length > 0) {
    parts.push(`\nRESUMABLE HANDOFF (prior session — continue from here):\n${snap.handoff.trim()}`);
  }
  if (snap.topLearnings.length > 0) {
    parts.push(
      `\nTOP PROJECT LEARNINGS (already proven — apply them):\n${snap.topLearnings
        .map((l) => `- ${l.summary}`)
        .join("\n")}`,
    );
  }
  return parts.join("\n");
}

/** The exact JSON a Claude Code SessionStart hook emits to add context. */
export function sessionStartOutput(snap: SessionSnapshot): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: buildSessionStartContext(snap),
    },
  });
}
