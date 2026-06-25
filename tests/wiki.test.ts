import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWikiStore, slug, parseTranscriptTurns, ingestTranscript } from "../src/engine/wiki.js";
import { countTokens } from "../src/tokenizer.js";
import { createFileCCRStore } from "../src/ccr/store.js";
import { createMemory } from "../src/engine/memory.js";
import { createKnowledge } from "../src/engine/knowledge.js";
import { createFeedback } from "../src/engine/feedback.js";
import { createTeamBoard } from "../src/engine/teams.js";
import { createMeter } from "../src/engine/meter.js";
import { createSkillsStore } from "../src/engine/skills.js";
import { createCalibration } from "../src/engine/calibration.js";
import { TOOLS, dispatch, type ToolContext } from "../src/mcp/tools.js";

describe("wiki-brain (leg 5) — ingest / index / log / cross-ref / lint", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kb-wiki-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("ingest writes a page, rebuilds the index, appends the log, stubs cross-refs", () => {
    const w = createWikiStore(root);
    const { page, touched } = w.ingest({
      title: "Auth Module",
      kind: "entity",
      content: "Handles login + session.\n- claim: auth = jwt",
      links: ["Session Store"],
    });
    expect(page).toBe("auth-module");
    // page exists with the content
    expect(w.page("auth-module")).toContain("Handles login");
    // cross-ref stub created for the link
    expect(touched).toContain(slug("Session Store"));
    expect(w.page("session-store")).toContain("stub");
    // index catalogs both pages
    expect(w.index()).toContain("[[auth-module]]");
    expect(w.index()).toContain("[[session-store]]");
    // log got a chronological entry
    expect(w.recentLog(5).some((l) => l.includes("ingest | Auth Module"))).toBe(true);
  });

  it("recentLog returns the per-session log tail (leg 3 cross-session context)", () => {
    const w = createWikiStore(root);
    w.log("session", "session A did X");
    w.log("session", "session B did Y");
    const recent = w.recentLog(2);
    expect(recent).toHaveLength(2);
    expect(recent[1]).toContain("session B did Y");
  });

  it("lint catches a seeded contradiction across pages", () => {
    const w = createWikiStore(root);
    w.ingest({ title: "Decision DB", kind: "concept", content: "We use Postgres.\n- claim: db = postgres" });
    w.ingest({ title: "Old Notes", kind: "summary", content: "DB is mysql.\n- claim: db = mysql" });
    const report = w.lint();
    expect(report.contradictions.some((c) => c.includes('claim "db"') && c.includes("postgres") && c.includes("mysql"))).toBe(true);
  });

  it("lint flags an orphan page (nothing links to it)", () => {
    const w = createWikiStore(root);
    w.ingest({ title: "Linked Hub", kind: "entity", content: "points around", links: ["Target Page"] });
    w.ingest({ title: "Lonely Page", kind: "concept", content: "no inbound links" });
    const report = w.lint();
    expect(report.orphans).toContain("lonely-page");
    expect(report.orphans).not.toContain("target-page"); // it IS linked
  });

  it("terse pages cost fewer tokens than the prose equivalent (the saving)", () => {
    const w = createWikiStore(root);
    const prose =
      "The authentication module is responsible for handling all of the user login functionality, " +
      "and it also manages the user session state across requests, and furthermore it validates tokens.";
    const terse = "Auth module: login + session state + token validation.";
    w.ingest({ title: "Terse Page", kind: "summary", content: terse });
    const terseTokens = countTokens(readFileSync(join(root, "pages", "terse-page.md"), "utf8"));
    const proseTokens = countTokens(prose);
    expect(terseTokens).toBeLessThan(proseTokens + 40); // page frontmatter overhead bounded; terse body wins
    expect(countTokens(terse)).toBeLessThan(proseTokens);
  });

  it("wiki MCP tools (ingest/query/lint) work through real dispatch + load_session surfaces the log", () => {
    const ccr = createFileCCRStore(join(root, "ccr"));
    const wiki = createWikiStore(join(root, "wiki"));
    const ctx: ToolContext = {
      ccr,
      memory: createMemory(join(root, "mem")),
      knowledge: createKnowledge(root, join(root, "kb")),
      feedback: createFeedback(join(root, "fb")),
      team: createTeamBoard(join(root, "team"), ccr),
      meter: createMeter(join(root, "meter")),
      skills: createSkillsStore(join(root, "skills")),
      calibration: createCalibration(join(root, "cal")),
      wiki,
    };
    const call = (name: string, args: Record<string, unknown> = {}): string =>
      dispatch(TOOLS.find((t) => t.name === name)!, args, ctx);

    // Ingest a real-shaped session note (the kind a session would file).
    const ing = call("knitbrain_wiki_ingest", {
      title: "P2 wiki-brain shipped",
      kind: "session",
      content: "Built wiki engine + 3 MCP tools.\n- claim: phase = p2",
      links: ["orchestrator"],
    });
    expect(ing).toContain("p2-wiki-brain-shipped");

    const q = call("knitbrain_wiki_query");
    expect(q).toContain("[[p2-wiki-brain-shipped]]"); // index
    expect(q).toContain("recent log");

    const lintOut = JSON.parse(call("knitbrain_wiki_lint")) as { contradictions: string[]; orphans: string[] };
    expect(Array.isArray(lintOut.orphans)).toBe(true);

    // Leg 3: load_session surfaces the wiki log so a fresh session inherits it.
    const session = JSON.parse(call("knitbrain_load_session")) as { wikiRecent: string[] };
    expect(session.wikiRecent.some((l) => l.includes("P2 wiki-brain shipped"))).toBe(true);
  });

  it("ingests a REAL session transcript → page + index + log, load_session surfaces it (e2e)", () => {
    // Genuine turns captured from an actual Claude Code session (.jsonl),
    // checked in so CI is deterministic — real data, not synthetic pages.
    const raw = readFileSync(join(process.cwd(), "tests/fixtures/real-transcript.jsonl"), "utf8");
    const turns = parseTranscriptTurns(raw);
    expect(turns.length).toBeGreaterThanOrEqual(2); // real user + assistant turns parsed

    const ccr = createFileCCRStore(join(root, "ccr-tx"));
    const wiki = createWikiStore(join(root, "wiki-tx"));
    const r = ingestTranscript(raw, wiki, "real session 2026");
    expect(r.turns).toBe(turns.length);
    // page written, indexed, logged
    expect(wiki.page(r.page)).toContain("Session:");
    expect(wiki.index()).toContain(`[[${r.page}]]`);
    expect(wiki.recentLog(5).some((l) => l.includes("real session 2026"))).toBe(true);

    // load_session (real dispatch) surfaces the prior-session context from log.md
    const ctx: ToolContext = {
      ccr,
      memory: createMemory(join(root, "mem-tx")),
      knowledge: createKnowledge(root, join(root, "kb-tx")),
      feedback: createFeedback(join(root, "fb-tx")),
      team: createTeamBoard(join(root, "team-tx"), ccr),
      meter: createMeter(join(root, "meter-tx")),
      skills: createSkillsStore(join(root, "skills-tx")),
      calibration: createCalibration(join(root, "cal-tx")),
      wiki,
    };
    const session = JSON.parse(dispatch(TOOLS.find((t) => t.name === "knitbrain_load_session")!, {}, ctx)) as { wikiRecent: string[] };
    expect(session.wikiRecent.some((l) => l.includes("real session 2026"))).toBe(true);
  });
});
