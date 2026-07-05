import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

  it("records and retrieves a learning by id (terse-stored: articles dropped)", () => {
    const { id, duplicate } = mem.recordLearning({
      summary: "always normalize the prefix",
      lesson: "CacheAligner keeps the system prompt byte-stable across turns",
      tags: ["proxy", "cache"],
    });
    expect(duplicate).toBe(false);
    // terseStore is default-ON (the caveman-in-brain optimization): the article
    // "the" is dropped, technical substance kept.
    expect(mem.getLearning(id)?.summary).toBe("always normalize prefix");
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

import { learningHealth } from "../src/engine/memory.js";

describe("learnings closed loop (signal → adjustment)", () => {
  let root: string;
  let mem: Memory;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "knitbrain-mem-loop-"));
    mem = createMemory(root);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("learningOutcome records helpful/unhelpful and folds corrections into the lesson", () => {
    const { id } = mem.recordLearning({ summary: "use uv run python in this repo", lesson: "python3 misses the venv", tags: ["python"] });
    expect(mem.learningOutcome(id, true)!.helpful).toBe(1);
    const after = mem.learningOutcome(id, false, "only for the ml/ subdir, not the api");
    expect(after!.unhelpful).toBe(1);
    expect(mem.getLearning(id)!.lesson).toContain("correction");
    expect(mem.getLearning(id)!.lesson).toContain("only for the ml/ subdir");
    expect(mem.learningOutcome("nope", true)).toBeNull();
  });

  it("learningHealth discredits repeat-wrong learnings, proves repeat-right ones", () => {
    const { id } = mem.recordLearning({ summary: "alpha beta gamma", lesson: "x" });
    expect(learningHealth(mem.getLearning(id)!)).toBe("unproven");
    mem.learningOutcome(id, false, "a");
    mem.learningOutcome(id, false, "b");
    expect(learningHealth(mem.getLearning(id)!)).toBe("discredited");
  });

  it("search ranks proven learnings above discredited ones with equal term match", () => {
    const good = mem.recordLearning({ summary: "deploy needs the staging flag set", lesson: "g", tags: ["deploy"] });
    const bad = mem.recordLearning({ summary: "deploy needs a full db reset first", lesson: "b", tags: ["deploy"] });
    mem.learningOutcome(good.id, true);
    mem.learningOutcome(good.id, true);
    mem.learningOutcome(bad.id, false, "wrong, never reset the db");
    mem.learningOutcome(bad.id, false);
    const hits = mem.searchLearnings("deploy", 5);
    expect(hits[0]!.id).toBe(good.id); // proven first
    expect(hits.find((h) => h.id === bad.id)!.net).toBe(-2); // discredited carries its net
  });

  it("loadSession surfaces the most PROVEN learnings first, not just the newest", () => {
    mem.recordLearning({ summary: "old but proven fact", lesson: "x" });
    const proven = mem.listLearnings()[0]!;
    mem.learningOutcome(proven.id, true);
    mem.learningOutcome(proven.id, true);
    for (let i = 0; i < 6; i++) mem.recordLearning({ summary: `newer note ${i}`, lesson: "y" });
    const top = mem.loadSession().topLearnings;
    expect(top[0]!.id).toBe(proven.id); // proven beats recency
  });

  it("forward-migrates pre-loop learning records without signal fields", () => {
    writeFileSync(
      join(root, "learnings.json"),
      JSON.stringify([{ id: "old1", date: "2026-01-01", summary: "legacy learning", lesson: "z", tags: [] }]),
    );
    const fresh = createMemory(root);
    expect(fresh.getLearning("old1")!.helpful).toBe(0);
    expect(fresh.learningOutcome("old1", true)!.helpful).toBe(1);
  });
});


describe("handoff freshness", () => {
  let r: string;
  let m: ReturnType<typeof createMemory>;
  let hf: string;
  beforeEach(() => { r = mkdtempSync(join(tmpdir(), "kb-hf-")); m = createMemory(join(r, "memory")); hf = join(r, "memory", "handoff.txt"); });
  afterEach(() => rmSync(r, { recursive: true, force: true }));
  const old = (days: number) => new Date(Date.now() - days * 86400000).toISOString();

  it("fresh handoff is not stale", () => {
    m.saveHandoff("resume me");
    const s = m.loadSession();
    expect(s.handoff).toBe("resume me");
    expect(s.handoffStale).toBe(false);
    expect(s.handoffSavedAt).toBeTruthy();
  });
  it("flags a handoff older than 7 days", () => {
    writeFileSync(hf, JSON.stringify({ state: "older", savedAt: old(10) }));
    const s = m.loadSession();
    expect(s.handoff).toBe("older");
    expect(s.handoffStale).toBe(true);
  });
  it("auto-clears a handoff older than 14 days", () => {
    writeFileSync(hf, JSON.stringify({ state: "ancient", savedAt: old(20) }));
    expect(m.loadSession().handoff).toBeNull();
    expect(m.loadSession().handoff).toBeNull(); // file removed, stays gone
  });
  it("treats a legacy bare-string handoff as undated + stale", () => {
    writeFileSync(hf, "legacy plain text");
    const s = m.loadSession();
    expect(s.handoff).toBe("legacy plain text");
    expect(s.handoffSavedAt).toBeNull();
    expect(s.handoffStale).toBe(true);
  });
});
