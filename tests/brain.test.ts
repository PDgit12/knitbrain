import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemory, type Memory } from "../src/engine/memory.js";
import { createKnowledge, type Knowledge } from "../src/engine/knowledge.js";
import { createWikiStore, type WikiStore } from "../src/engine/wiki.js";
import { createSkillsStore, type SkillsStore } from "../src/engine/skills.js";
import { createBrain, type Brain } from "../src/engine/brain.js";

// Gap #8: the brain facade fans reads across the TYPED stores (no mocks — real
// memory/wiki/knowledge on disk) and routes writes to the right store + spine.
describe("brain facade (gap #8): unified read across typed stores, routed writes", () => {
  let root: string;
  let memory: Memory;
  let knowledge: Knowledge;
  let wiki: WikiStore;
  let skills: SkillsStore;
  let brain: Brain;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "knitbrain-brain-"));
    // a real 2-file project so the knowledge graph has edges: a imports b.
    writeFileSync(join(root, "b.ts"), "export const foo = 1;\n");
    writeFileSync(join(root, "a.ts"), 'import { foo } from "./b.js";\nexport const x = foo;\n');
    memory = createMemory(join(root, "mem"));
    knowledge = createKnowledge(root, join(root, "kb"));
    wiki = createWikiStore(join(root, "wiki"));
    skills = createSkillsStore(join(root, "skills"));
    brain = createBrain({ memory, knowledge, wiki, skills });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("read fans a query across memory + wiki + knowledge and returns SOURCED ranked hits", () => {
    memory.recordLearning({ summary: "validation lives in b.ts", lesson: "boundary checks funnel through b.ts" });
    wiki.ingest({ title: "Validation", kind: "concept", content: "how validation works in b.ts" });
    knowledge.scan();

    const hits = brain.read("validation b.ts", 10);
    const sources = new Set(hits.map((h) => h.source));
    expect(sources.has("memory")).toBe(true);
    expect(sources.has("wiki")).toBe(true);
    expect(sources.has("knowledge")).toBe(true);
    // every hit is tagged with its store and a normalized score
    for (const h of hits) {
      expect(["memory", "wiki", "knowledge", "skills"]).toContain(h.source);
      expect(h.score).toBeGreaterThanOrEqual(0);
      expect(h.score).toBeLessThanOrEqual(1);
    }
    // the knowledge hit surfaces the graph fact (b.ts has a dependent: a.ts)
    const kg = hits.find((h) => h.source === "knowledge" && h.id === "b.ts");
    expect(kg).toBeDefined();
    expect(kg!.title).toContain("dependents 1");
    // ranked descending
    for (let i = 1; i < hits.length; i++) expect(hits[i - 1]!.score).toBeGreaterThanOrEqual(hits[i]!.score);
  });

  it("write(learning) routes to memory AND drops one spine line", () => {
    expect(wiki.recentLog(10).length).toBe(0);
    const r = brain.write({ kind: "learning", summary: "spine via brain", lesson: "x" });
    expect(r.source).toBe("memory");
    expect(memory.searchLearnings("spine via brain", 5).some((h) => h.id === r.id)).toBe(true);
    const log = wiki.recentLog(10);
    expect(log.length).toBe(1);
    expect(log[0]).toContain("learning");
  });

  it("write(wiki) routes to the wiki with exactly ONE spine line (ingest self-logs, no double)", () => {
    const r = brain.write({ kind: "wiki", title: "Routed Page", pageKind: "concept", content: "body" });
    expect(r.source).toBe("wiki");
    expect(wiki.page(r.id)).toContain("Routed Page");
    expect(wiki.recentLog(10).length).toBe(1); // exactly one, not two
  });

  it("write(skill) routes to the skills store + spine line", () => {
    const r = brain.write({ kind: "skill", name: "deploy", body: "verify. push.", triggers: ["deploy"] });
    expect(r.source).toBe("skills");
    expect(skills.list().some((s) => s.name === "deploy")).toBe(true);
    expect(wiki.recentLog(10).some((l) => l.includes("skill"))).toBe(true);
  });

  it("a deduped learning write drops NO spine line (matches the typed contract)", () => {
    brain.write({ kind: "learning", summary: "dupe me", lesson: "x" });
    const before = wiki.recentLog(20).length;
    const r = brain.write({ kind: "learning", summary: "dupe me", lesson: "x" });
    expect(r.duplicate).toBe(true);
    expect(wiki.recentLog(20).length).toBe(before); // no extra spine line
  });
});
