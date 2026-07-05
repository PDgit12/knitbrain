import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileCCRStore } from "../src/ccr/store.js";
import { createTeamBoard } from "../src/engine/teams.js";
import { createMemory } from "../src/engine/memory.js";
import { createWikiStore } from "../src/engine/wiki.js";
import { compress } from "../src/optimizer/router.js";
import { parseDuration } from "../src/loop.js";
import { applyArtifacts, claudeArtifacts, type Artifact } from "../src/platforms.js";
import { generateConfig } from "../src/setup.js";

const FAKE_SECRET = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

describe("audit fixes — 0.16.0", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "kb-audit-")); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("H2: team_post scrubs secrets before the board stores / hub mirrors them", () => {
    const ccr = createFileCCRStore(join(root, "ccr"));
    const board = createTeamBoard(join(root, "team"), ccr);
    const e = board.post("agent", `found a key ${FAKE_SECRET} in the config`);
    // neither the skeleton summary nor the recoverable original may carry the secret
    expect(e.summary).not.toContain(FAKE_SECRET);
    const original = board.get(e.id) ?? "";
    expect(original).not.toContain(FAKE_SECRET);
    expect(original).toContain("found a key"); // non-secret content preserved
  });

  it("M1: wiki.ingest scrubs secrets from content + title before persisting", () => {
    const wiki = createWikiStore(join(root, "wiki"));
    const r = wiki.ingest({ title: "note", kind: "summary", content: `token is ${FAKE_SECRET} keep this` });
    const page = readFileSync(join(root, "wiki", "pages", `${r.page}.md`), "utf8");
    expect(page).not.toContain(FAKE_SECRET);
    expect(page).toContain("keep this");
  });

  it("M5: dedup does NOT drop a distinct learning, and an empty summary is not a dedup anchor", () => {
    const mem = createMemory(join(root, "mem"));
    const a = mem.recordLearning({ summary: "fix the auth token expiry check", lesson: "use <= not <" });
    expect(a.duplicate).toBe(false);
    // a genuinely different learning that merely SHARES a word must not be swallowed
    const b = mem.recordLearning({ summary: "fix the database migration ordering", lesson: "run schema first" });
    expect(b.duplicate).toBe(false);
    expect(b.id).not.toBe(a.id);
    // exact re-record IS a duplicate (normalized equality)
    const c = mem.recordLearning({ summary: "fix the auth token expiry check", lesson: "again" });
    expect(c.duplicate).toBe(true);
    expect(c.id).toBe(a.id);
  });

  it("M2: strip-path compression always emits a ⟨recall:⟩ marker (numbered short text)", () => {
    const ccr = createFileCCRStore(join(root, "ccr"));
    // 12 short numbered lines — the region that hit the no-marker passthrough bug
    const numbered = Array.from({ length: 12 }, (_, i) => `${i + 1}→ line content number ${i + 1} here`).join("\n");
    const r = compress(numbered, ccr);
    if (r.compressed) {
      expect(r.skeleton).toContain("⟨recall:");
      // and the marker resolves to the TRUE original byte-for-byte
      const handle = /⟨recall:([0-9a-f]{64})⟩/.exec(r.skeleton)?.[1];
      expect(handle).toBeTruthy();
      expect(ccr.get(handle!)).toBe(numbered);
    }
  });

  it("M8: setup backs up a differing user-edited 'write' file to <path>.bak before overwriting", () => {
    const cfg = generateConfig();
    const goalArt = claudeArtifacts(cfg).find((a) => a.path === ".claude/commands/goal.md")!;
    // seed a user-edited version
    const arts: Artifact[] = [goalArt];
    applyArtifacts(root, arts, cfg); // first write
    const goalPath = join(root, ".claude/commands/goal.md");
    writeFileSync(goalPath, "# my custom goal command\n", "utf8");
    applyArtifacts(root, arts, cfg); // re-run setup
    expect(existsSync(`${goalPath}.bak`)).toBe(true);
    expect(readFileSync(`${goalPath}.bak`, "utf8")).toBe("# my custom goal command\n");
    expect(readFileSync(goalPath, "utf8")).toBe(goalArt.content); // fresh protocol restored
  });

  it("M9: parseDuration handles s/m/h/ms and rejects junk", () => {
    expect(parseDuration("30m")).toBe(1_800_000);
    expect(parseDuration("1h")).toBe(3_600_000);
    expect(parseDuration("90s")).toBe(90_000);
    expect(parseDuration("500ms")).toBe(500);
    expect(parseDuration("45")).toBe(45_000); // bare number → seconds
    expect(parseDuration("abc")).toBeNull();
    expect(parseDuration("")).toBeNull();
  });

  it("L1: put self-heals a corrupted hot file so future get no longer throws", () => {
    const ccr = createFileCCRStore(join(root, "ccr"));
    const original = "the exact original bytes that must round-trip";
    const handle = ccr.put(original);
    // corrupt the hot file on disk
    writeFileSync(join(root, "ccr", handle), "CORRUPTED", "utf8");
    // re-put the true bytes → self-heal
    ccr.put(original);
    expect(ccr.get(handle)).toBe(original);
  });
});
