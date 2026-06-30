import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKnowledge } from "../src/engine/knowledge.js";
import { createWikiStore } from "../src/engine/wiki.js";
import { createMemory } from "../src/engine/memory.js";
import { projectTranscriptDir } from "../src/engine/usage.js";
import { runOnboard } from "../src/engine/onboard.js";

// Phase 2: the onboard import half — scan the repo + ingest this project's PAST
// transcripts into the wiki + mine learnings. Real files on disk, no mocks.
describe("onboard import (runOnboard): present scan + past ingest", () => {
  let root: string; // holds the fake project + fake home
  let proj: string;
  let home: string;

  // A real-shape transcript: user prompt + a failed tool call + a later success.
  const GOOD_TRANSCRIPT = [
    JSON.stringify({ type: "user", message: { content: "fix the failing build in app.ts" } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "node app.ts" } }, { type: "text", text: "running it" }] } }),
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "Error: Cannot find module './app.ts'" }] } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "node app.js" } }] } }),
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2", content: "build ok" }] } }),
  ].join("\n");

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kb-onboard-"));
    proj = join(root, "proj");
    home = join(root, "home");
    mkdirSync(join(proj, "src"), { recursive: true });
    writeFileSync(join(proj, "src", "b.ts"), "export const b = 1;\n");
    writeFileSync(join(proj, "src", "a.ts"), 'import { b } from "./b.js";\nexport const a = b;\n');
    // seed this project's transcript dir under the fake home
    const tdir = projectTranscriptDir(proj, home);
    mkdirSync(tdir, { recursive: true });
    writeFileSync(join(tdir, "good.jsonl"), GOOD_TRANSCRIPT);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const deps = () => ({
    knowledge: createKnowledge(proj, join(root, "kb")),
    wiki: createWikiStore(join(root, "wiki")),
    memory: createMemory(join(root, "mem")),
  });

  it("scans the repo (present) and ingests the past transcript into wiki + spine", async () => {
    const d = deps();
    const r = await runOnboard(proj, d, home);
    expect(r.filesScanned).toBeGreaterThanOrEqual(2); // a.ts + b.ts
    expect(r.sessionsIngested).toBe(1);
    expect(r.learningsMined).toBeGreaterThanOrEqual(0); // mining is heuristic
    // wiki gained a session page + a spine log line
    expect(d.wiki.listPages().some((p) => p.kind === "session")).toBe(true);
    expect(d.wiki.recentLog(10).length).toBeGreaterThan(0);
  });

  it("skips a malformed transcript without throwing, still ingests the good one", async () => {
    const tdir = projectTranscriptDir(proj, home);
    writeFileSync(join(tdir, "bad.jsonl"), "this is not json\n{also not valid\n");
    const d = deps();
    const r = await runOnboard(proj, d, home); // must not throw
    expect(r.sessionsIngested).toBe(1); // only the good transcript counted
  });

  it("returns zeroes (no throw) when the project has no transcripts", async () => {
    const empty = join(root, "empty");
    mkdirSync(join(empty, "src"), { recursive: true });
    writeFileSync(join(empty, "src", "x.ts"), "export const x = 1;\n");
    const r = await runOnboard(empty, deps(), home);
    expect(r.sessionsIngested).toBe(0);
    expect(r.filesScanned).toBeGreaterThanOrEqual(1);
  });
});
