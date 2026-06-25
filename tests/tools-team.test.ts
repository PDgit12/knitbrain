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

// Direct handler coverage for the team-board tools through real dispatch:
// post a finding, assert board + get surface it, clear empties it.
describe("MCP team tools (team_board/team_get/team_clear)", () => {
  let root: string;
  let ctx: ToolContext;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kb-tools-team-"));
    const ccr = createFileCCRStore(join(root, "ccr"));
    ctx = {
      ccr,
      memory: createMemory(join(root, "mem")),
      knowledge: createKnowledge(root, join(root, "kb")),
      feedback: createFeedback(join(root, "fb")),
      team: createTeamBoard(join(root, "team"), ccr),
      meter: createMeter(join(root, "meter")),
      skills: createSkillsStore(join(root, "skills")),
      calibration: createCalibration(join(root, "cal")),
    };
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const call = (name: string, args: Record<string, unknown> = {}): string =>
    dispatch(TOOLS.find((t) => t.name === name)!, args, ctx);

  it("post → board → get → clear round-trips a finding", () => {
    const content = "found a race condition in cache.ts: two writers, last-write-wins clobbers";
    const posted = call("knitbrain_team_post", { author: "alice", content });
    expect(posted).toMatch(/posted .+ by alice/);
    const id = posted.match(/posted (\S+) by/)![1];

    const board = JSON.parse(call("knitbrain_team_board")) as Array<{ id: string; author: string }>;
    expect(board.some((e) => e.id === id && e.author === "alice")).toBe(true);

    // team_get returns the FULL original byte-for-byte (verbatim output).
    expect(call("knitbrain_team_get", { id })).toBe(content);

    expect(call("knitbrain_team_clear")).toBe("board cleared");
    expect(JSON.parse(call("knitbrain_team_board"))).toEqual([]);
  });

  it("team_get on an unknown id returns a clear not-found message", () => {
    expect(call("knitbrain_team_get", { id: "nope" })).toContain("no board entry");
  });
});
