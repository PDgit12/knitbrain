import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemory, type Memory } from "../src/engine/memory.js";

describe("memory engine (rung 8)", () => {
  let root: string;
  let mem: Memory;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "knitbrain-mem-"));
    mem = createMemory(join(root, "memory"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("records and retrieves a learning by id", () => {
    const { id, duplicate } = mem.recordLearning({
      summary: "always normalize the prefix",
      lesson: "CacheAligner keeps the system prompt byte-stable across turns",
      tags: ["proxy", "cache"],
    });
    expect(duplicate).toBe(false);
    expect(mem.getLearning(id)?.summary).toBe("always normalize the prefix");
  });

  it("dedups by summary substring", () => {
    const a = mem.recordLearning({ summary: "tiered ccr keeps old data", lesson: "x" });
    const b = mem.recordLearning({ summary: "tiered ccr keeps old data", lesson: "y" });
    expect(b.duplicate).toBe(true);
    expect(b.id).toBe(a.id);
  });

  it("search ranks by keyword overlap and returns headlines", () => {
    mem.recordLearning({ summary: "proxy provider detection by path", lesson: "...", tags: ["proxy"] });
    mem.recordLearning({ summary: "json skeleton keeps keys", lesson: "...", tags: ["json"] });
    const hits = mem.searchLearnings("proxy provider", 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.summary).toContain("proxy");
    // headlines carry no lesson body
    expect(hits[0]).not.toHaveProperty("lesson");
  });

  it("persists across instances + save/load handoff", () => {
    mem.recordLearning({ summary: "persist me", lesson: "durable" });
    mem.saveHandoff("resume: finish rung 8");
    const reopened = createMemory(join(root, "memory"));
    expect(reopened.listLearnings().some((l) => l.summary === "persist me")).toBe(true);
    const session = reopened.loadSession();
    expect(session.handoff).toBe("resume: finish rung 8");
    expect(session.topLearnings.length).toBeGreaterThan(0);
  });
});
