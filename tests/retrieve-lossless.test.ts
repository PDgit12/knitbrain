import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileCCRStore } from "../src/ccr/store.js";
import { createMemory } from "../src/engine/memory.js";
import { createKnowledge } from "../src/engine/knowledge.js";
import { createFeedback } from "../src/engine/feedback.js";
import { createTeamBoard } from "../src/engine/teams.js";
import { createMeter } from "../src/engine/meter.js";
import { createSkillsStore } from "../src/engine/skills.js";
import { createCalibration } from "../src/engine/calibration.js";
import { TOOLS, dispatch, type ToolContext } from "../src/mcp/tools.js";

// Regression: the dispatch chokepoint appends a context-meter advisory when the
// window runs hot — but it MUST NOT do so for the exact-recovery tools
// (knitbrain_retrieve / knitbrain_team_get), or it corrupts the recovered
// bytes. Caught by the production e2e under KNITBRAIN_HOME (meter read 100%).
describe("retrieve is byte-exact even when the context meter is HOT", () => {
  let root: string;
  let ctx: ToolContext;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kb-lossless-"));
    const ccr = createFileCCRStore(join(root, "ccr"));
    ctx = {
      ccr,
      memory: createMemory(join(root, "mem")),
      knowledge: createKnowledge(root, join(root, "kb")),
      feedback: createFeedback(join(root, "fb")),
      team: createTeamBoard(join(root, "team"), ccr),
      // Force a HOT window: a huge real-usage reading → status !== "ok".
      meter: createMeter(join(root, "meter"), { realUsage: () => 10_000_000 }),
      skills: createSkillsStore(join(root, "skills")),
      calibration: createCalibration(join(root, "cal")),
    };
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const call = (name: string, args: Record<string, unknown> = {}): string =>
    dispatch(TOOLS.find((t) => t.name === name)!, args, ctx);

  it("knitbrain_retrieve returns the EXACT original, no meter advisory appended", () => {
    const payload = JSON.stringify({ items: Array.from({ length: 40 }, (_, i) => ({ i, blob: "z".repeat(60) })) }, null, 2);
    const optText = call("knitbrain_optimize", { text: payload });
    const handle = optText.match(/⟨recall:([0-9a-f]{64})⟩/)![1]!;
    // sanity: the meter IS hot (a non-exact tool would get the advisory)
    expect(call("knitbrain_ping")).toContain("context-meter"); // ping is augmented
    // retrieve must NOT be augmented — byte-for-byte
    const recovered = call("knitbrain_retrieve", { handle });
    expect(recovered).toBe(payload);
    expect(recovered).not.toContain("context-meter");
  });

  it("knitbrain_team_get returns the exact posted original, no advisory", () => {
    const posted = call("knitbrain_team_post", { author: "alice", content: "exact finding: race in cache.ts under hot context" });
    const id = posted.match(/posted (\S+) by/)![1]!;
    const got = call("knitbrain_team_get", { id });
    expect(got).toBe("exact finding: race in cache.ts under hot context");
    expect(got).not.toContain("context-meter");
  });
});
