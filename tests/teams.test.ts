import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileCCRStore, type CCRStore } from "../src/ccr/store.js";
import { createTeamBoard, type TeamBoard } from "../src/engine/teams.js";

const bigJson = (seed: string): string =>
  JSON.stringify({ items: Array.from({ length: 40 }, (_, i) => ({ i, seed, blob: "x".repeat(50) })) });

describe("team board (rung 13)", () => {
  let root: string;
  let ccr: CCRStore;
  let team: TeamBoard;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "knitbrain-team-"));
    ccr = createFileCCRStore(join(root, "ccr"));
    team = createTeamBoard(join(root, "team"), ccr);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("posts a finding as a compressed skeleton, recoverable in full", () => {
    const content = bigJson("finding");
    const entry = team.post("agent-a", content);
    expect(entry.summary.length).toBeLessThan(content.length); // board holds a skeleton
    expect(team.get(entry.id)).toBe(content); // full original recoverable byte-for-byte
  });

  it("shows all postings on the shared board", () => {
    team.post("agent-a", bigJson("a"));
    team.post("agent-b", bigJson("b"));
    const board = team.board();
    expect(board.length).toBe(2);
    expect(board.map((e) => e.author).sort()).toEqual(["agent-a", "agent-b"]);
  });

  it("handles small (uncompressed) postings losslessly too", () => {
    const entry = team.post("agent-c", "short note");
    expect(entry.summary).toBe("short note");
    expect(team.get(entry.id)).toBe("short note");
  });

  it("clear empties the board but originals remain retrievable in CCR", () => {
    const entry = team.post("agent-a", bigJson("keep"));
    team.clear();
    expect(team.board()).toEqual([]);
    expect(ccr.get(entry.handle)).toBe(bigJson("keep")); // CCR original retained
  });

  it("persists the board across instances", () => {
    team.post("agent-a", bigJson("persist"));
    const reopened = createTeamBoard(join(root, "team"), ccr);
    expect(reopened.board().length).toBe(1);
  });
});
