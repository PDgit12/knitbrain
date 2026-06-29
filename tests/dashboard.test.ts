import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Server } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { createFileCCRStore } from "../src/ccr/store.js";
import { createKnowledge } from "../src/engine/knowledge.js";
import { createMemory } from "../src/engine/memory.js";
import { createFeedback } from "../src/engine/feedback.js";
import { createSkillsStore } from "../src/engine/skills.js";
import { createTeamBoard } from "../src/engine/teams.js";
import { createMeter } from "../src/engine/meter.js";
import { createWikiStore } from "../src/engine/wiki.js";
import { createDashboardServer, dashboardState, renderMarkdown, type DashboardDeps } from "../src/dashboard.js";

describe("dashboard (rung 17)", () => {
  let root: string;
  let deps: DashboardDeps;
  let srv: Server | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "knitbrain-dash-"));
    const ccr = createFileCCRStore(join(root, "ccr"));
    deps = {
      ccr,
      memory: createMemory(join(root, "mem")),
      feedback: createFeedback(join(root, "fb")),
      team: createTeamBoard(join(root, "team"), ccr),
      meter: createMeter(join(root, "meter")),
    };
  });
  afterEach(async () => {
    if (srv) await new Promise<void>((r) => srv!.close(() => r()));
    rmSync(root, { recursive: true, force: true });
  });

  it("state snapshot reflects real store contents", () => {
    deps.memory.recordLearning({ summary: "dash test", lesson: "x" });
    deps.team.post("alice", "a finding about the proxy");
    deps.meter.onToolOutput(1234);
    const s = dashboardState(deps);
    expect((s["meter"] as { usedTokens: number }).usedTokens).toBe(1234);
    expect(s["learnings"]).toBe(1);
    expect((s["board"] as unknown[]).length).toBe(1);
    const recent = s["recentLearnings"] as Array<{ summary: string }>;
    expect(recent[0]!.summary).toBe("dash test");
  });

  it("knowledge + skills panels reflect a real scanned project and saved skills", () => {
    // Real mini-project on disk: b.ts imports a.ts → a.ts has 1 dependent.
    const proj = join(root, "proj");
    mkdirSync(proj, { recursive: true });
    writeFileSync(join(proj, "a.ts"), "export const shared = 1;\n");
    writeFileSync(join(proj, "b.ts"), 'import { shared } from "./a.js";\nexport const twice = shared * 2;\n');
    const knowledge = createKnowledge(proj, join(root, "kg"));
    knowledge.scan();
    const skills = createSkillsStore(join(root, "skills"));
    skills.save({ name: "deploy-checklist", body: "verify gates. push. tag.", triggers: ["deploy"] });

    const s = dashboardState({ ...deps, knowledge, skills });
    const kg = s["knowledge"] as { files: number; topFanout: Array<{ file: string; dependents: number }> };
    expect(kg.files).toBe(2);
    expect(kg.topFanout[0]).toEqual({ file: "a.ts", dependents: 1 });
    const sk = s["skills"] as Array<{ name: string; uses: number }>;
    expect(sk.length).toBe(1);
    expect(sk[0]!.name).toBe("deploy-checklist");
  });

  // Gap #3: hand-rolled markdown → HTML render (mechanical, no new dep).
  it("renderMarkdown turns a [[link]] into a clickable in-panel anchor and escapes HTML", () => {
    const html = renderMarkdown("# Title\n\n- a bullet with [[Some Page]]\n\n`code` and <script>");
    expect(html).toContain('<a href="#" data-slug="some-page">Some Page</a>');
    expect(html).toContain("<h3>Title</h3>");
    expect(html).toContain("<li>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain("&lt;script&gt;"); // escaped, not injected
  });

  // Gap #3: browsable wiki state — rendered pages + correct backlinks + graph edges.
  it("wiki state exposes rendered pages, backlinks, and link-graph edges", () => {
    const wiki = createWikiStore(join(root, "wiki"));
    // alpha links to beta → beta has a backlink from alpha, and an edge alpha→beta.
    wiki.ingest({ title: "Beta", kind: "concept", content: "the beta page" });
    wiki.ingest({ title: "Alpha", kind: "concept", content: "alpha refers to [[Beta]]", links: ["Beta"] });
    const s = dashboardState({ ...deps, wiki });
    const w = s["wiki"] as {
      pages: Array<{ slug: string; bodyHtml: string; links: string[]; backlinks: string[] }>;
      edges: Array<{ from: string; to: string }>;
    };
    const beta = w.pages.find((p) => p.slug === "beta")!;
    const alpha = w.pages.find((p) => p.slug === "alpha")!;
    expect(alpha.bodyHtml).toContain('data-slug="beta"');
    expect(alpha.links).toContain("beta");
    expect(beta.backlinks).toContain("alpha");
    expect(w.edges).toContainEqual({ from: "alpha", to: "beta" });
  });

  it("serves a real seeded wiki over /api/state with bodyHtml + backlinks + edge + log", async () => {
    const wiki = createWikiStore(join(root, "wiki"));
    wiki.ingest({ title: "Beta", kind: "concept", content: "the beta page" });
    wiki.ingest({ title: "Alpha", kind: "concept", content: "see [[Beta]]", links: ["Beta"] });
    srv = createDashboardServer({ ...deps, wiki });
    const port: number = await new Promise((r) =>
      srv!.listen(0, "127.0.0.1", () => r((srv!.address() as { port: number }).port)),
    );
    const api = (await (await fetch(`http://127.0.0.1:${port}/api/state`)).json()) as {
      wiki: {
        pages: Array<{ slug: string; bodyHtml: string; links: string[]; backlinks: string[] }>;
        edges: Array<{ from: string; to: string }>;
        recent: string[];
      };
    };
    const alpha = api.wiki.pages.find((p) => p.slug === "alpha")!;
    expect(alpha.bodyHtml).toContain('data-slug="beta"');
    expect(alpha.links).toContain("beta");
    expect(api.wiki.pages.find((p) => p.slug === "beta")!.backlinks).toContain("alpha");
    expect(api.wiki.edges).toContainEqual({ from: "alpha", to: "beta" });
    expect(api.wiki.recent.length).toBeGreaterThan(0); // log present
  });

  it("serves the page and the JSON API over HTTP", async () => {
    srv = createDashboardServer(deps);
    const port: number = await new Promise((r) =>
      srv!.listen(0, "127.0.0.1", () => r((srv!.address() as { port: number }).port)),
    );
    const page = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    expect(page).toContain("knitbrain — live");
    const api = (await (await fetch(`http://127.0.0.1:${port}/api/state`)).json()) as {
      meter: { status: string };
    };
    expect(api.meter.status).toBe("ok");
  });
});
