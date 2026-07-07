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
import { createDashboardServer, dashboardState, renderMarkdown, xrayState, type DashboardDeps, type XrayState } from "../src/dashboard.js";
import type { ActivityEvent } from "../src/engine/activity.js";

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

  // G1 X-ray: pure aggregation function, no server involved.
  it("xrayState sums per-source rollups exactly, bucketing source-less legacy events under mcp", () => {
    const events: ActivityEvent[] = [
      { ts: "t1", agent: "a", tool: "read", summary: "s1", saved: 10, source: "mcp", rawTokens: 100, storedTokens: 20 },
      { ts: "t2", agent: "a", tool: "read", summary: "s2", saved: 5, source: "mcp", rawTokens: 50, storedTokens: 10 },
      { ts: "t3", agent: "a", tool: "hook", summary: "s3", saved: 7, source: "hook", rawTokens: 30, storedTokens: 3 },
      { ts: "t4", agent: "a", tool: "proxy", summary: "s4", saved: 2, source: "proxy", rawTokens: 40, storedTokens: 8 },
      // legacy event, no source field at all — must bucket under "mcp", not a separate "undefined" key.
      { ts: "t5", agent: "a", tool: "read", summary: "s5", saved: 1 },
    ];
    const x = xrayState(events, "RECEIPT TEXT", "2026-01-01T00:00:00Z", true);
    expect(x.receipt).toBe("RECEIPT TEXT");
    expect(x.sessionStart).toBe("2026-01-01T00:00:00Z");
    expect(x.trimmed).toBe(true);
    expect(Object.keys(x.bySource).sort()).toEqual(["hook", "mcp", "proxy"]);
    // mcp = the two explicit "mcp" events + the one source-less legacy event
    expect(x.bySource["mcp"]).toEqual({ events: 3, raw: 150, stored: 30, saved: 16 });
    expect(x.bySource["hook"]).toEqual({ events: 1, raw: 30, stored: 3, saved: 7 });
    expect(x.bySource["proxy"]).toEqual({ events: 1, raw: 40, stored: 8, saved: 2 });
  });

  it("xrayState defaults raw/stored to 0 when absent from an event", () => {
    const events: ActivityEvent[] = [{ ts: "t1", agent: "a", tool: "x", summary: "no numbers", saved: 0, source: "hook" }];
    const x = xrayState(events, "r", null, false);
    expect(x.bySource["hook"]).toEqual({ events: 1, raw: 0, stored: 0, saved: 0 });
    expect(x.sessionStart).toBeNull();
    expect(x.trimmed).toBe(false);
  });

  it("dashboardState/api exposes deps.xray via a getter; absent xray → null (back-compat)", async () => {
    const fixture: XrayState = {
      bySource: { mcp: { events: 3, raw: 150, stored: 30, saved: 16 }, hook: { events: 1, raw: 30, stored: 3, saved: 7 } },
      receipt: "session receipt fixture",
      sessionStart: "2026-01-01T00:00:00Z",
      trimmed: false,
    };
    const s = dashboardState({ ...deps, xray: () => fixture });
    expect(s["xray"]).toEqual(fixture);

    // back-compat: deps with no xray getter at all → null, not a throw.
    const s2 = dashboardState(deps);
    expect(s2["xray"]).toBeNull();

    srv = createDashboardServer({ ...deps, xray: () => fixture });
    const port: number = await new Promise((r) =>
      srv!.listen(0, "127.0.0.1", () => r((srv!.address() as { port: number }).port)),
    );
    const api = (await (await fetch(`http://127.0.0.1:${port}/api/state`)).json()) as {
      xray: { receipt: string; bySource: XrayState["bySource"] } | null;
    };
    expect(typeof api.xray?.receipt).toBe("string");
    expect(api.xray?.receipt).toBe("session receipt fixture");
    expect(api.xray?.bySource).toEqual(fixture.bySource);
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
