import { createServer, type Server } from "node:http";
import { fetchHubBoard, loadHubConfig } from "./hub/client.js";
import type { CCRStore } from "./ccr/store.js";
import type { Knowledge } from "./engine/knowledge.js";
import type { Memory } from "./engine/memory.js";
import type { Feedback } from "./engine/feedback.js";
import type { SkillsStore } from "./engine/skills.js";
import type { TeamBoard } from "./engine/teams.js";
import type { Meter } from "./engine/meter.js";
import type { PlatformUsage } from "./engine/usage.js";
import type { PlatformQuota } from "./engine/quota.js";
import type { ActivityEvent, AgentRollup } from "./engine/activity.js";
import type { WikiStore } from "./engine/wiki.js";
import { slug } from "./engine/wiki.js";

export interface DashboardDeps {
  ccr: CCRStore;
  memory: Memory;
  feedback: Feedback;
  team: TeamBoard;
  meter: Meter;
  /** Optional: project knowledge graph (per-project; absent in global mode). */
  knowledge?: Knowledge;
  /** Optional: skills store. */
  skills?: SkillsStore;
  /** Optional: real platform token usage (from host transcripts), computed
   *  per-request so it reflects the live session as it grows. */
  usage?: () => PlatformUsage | null;
  /** Optional: live subscription quota window (async; provider usage API). */
  quota?: () => Promise<PlatformQuota | null>;
  /** Optional: recent agent activity events (the CRM feed). */
  activity?: () => ActivityEvent[];
  /** Optional: per-agent optimization rollup (universal meter, all platforms). */
  agents?: () => AgentRollup[];
  /** Optional: the compounding wiki-brain (leg 5). */
  wiki?: WikiStore;
}

/** Knowledge-graph summary: file count + the highest-fanout files (blast radius). */
function knowledgeSummary(k: Knowledge): { files: number; topFanout: Array<{ file: string; dependents: number }> } {
  const files = k.listFiles();
  const fanout = files
    .map((file) => ({ file, dependents: k.queryDependents(file).length }))
    .filter((f) => f.dependents > 0)
    .sort((a, b) => b.dependents - a.dependents)
    .slice(0, 5);
  return { files: files.length, topFanout: fanout };
}

/**
 * Hand-rolled minimal markdown → HTML (gap #3). NO new dependency — the wiki
 * bodies are terse (headings, bullets, code, `[[links]]`), so a line parser
 * covers them. Everything is HTML-escaped; `[[link]]` becomes an in-panel
 * anchor carrying the target slug. Headings shift to h3–h5 (h1/h2 are chrome).
 */
export function renderMarkdown(md: string): string {
  const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inline = (s: string): string =>
    esc(s)
      .replace(/`([^`]+)`/g, (_m, c: string) => `<code>${c}</code>`)
      .replace(/\[\[([^\]]+)\]\]/g, (_m, c: string) => `<a href="#" data-slug="${slug(c)}">${c}</a>`);
  const out: string[] = [];
  let inCode = false;
  let inList = false;
  const closeList = (): void => {
    if (inList) {
      out.push("</ul>");
      inList = false;
    }
  };
  for (const line of md.split(/\r?\n/)) {
    if (/^```/.test(line)) {
      closeList();
      out.push(inCode ? "</code></pre>" : "<pre><code>");
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      out.push(esc(line));
      continue;
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      closeList();
      const n = h[1]!.length + 2;
      out.push(`<h${n}>${inline(h[2]!)}</h${n}>`);
      continue;
    }
    const b = /^[-*]\s+(.*)$/.exec(line);
    if (b) {
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push(`<li>${inline(b[1]!)}</li>`);
      continue;
    }
    if (line.trim() === "") {
      closeList();
      continue;
    }
    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  if (inCode) out.push("</code></pre>");
  return out.join("\n");
}

/** Browsable wiki snapshot: rendered pages + backlinks + link-graph edges (gap #3). */
export function wikiState(wiki: WikiStore): Record<string, unknown> {
  const raw = wiki.listPages();
  const known = new Set(raw.map((p) => p.slug));
  // Dedupe per page: a page often links the same target both inline ([[X]]) and
  // via the `related:` footer ingest appends — count it once.
  const linksOf = (p: { slug: string; links: string[] }): string[] =>
    [...new Set(p.links)].filter((l) => l !== p.slug);
  const backlinks = new Map<string, Set<string>>();
  const edges: Array<{ from: string; to: string }> = [];
  for (const p of raw) {
    for (const l of linksOf(p)) {
      (backlinks.get(l) ?? backlinks.set(l, new Set()).get(l)!).add(p.slug);
      if (known.has(l)) edges.push({ from: p.slug, to: l });
    }
  }
  const pages = raw.map((p) => ({
    slug: p.slug,
    kind: p.kind,
    title: p.title,
    bodyHtml: renderMarkdown(p.body),
    links: linksOf(p),
    backlinks: [...(backlinks.get(p.slug) ?? [])],
  }));
  return { pageCount: pages.length, pages, edges, recent: wiki.recentLog(8), lint: wiki.lint() };
}

/** One JSON snapshot of everything the dashboard shows. */
export function dashboardState(deps: DashboardDeps): Record<string, unknown> {
  const meter = deps.meter.read();
  const learnings = deps.memory.listLearnings();
  return {
    meter,
    activity: deps.activity?.() ?? [],
    agents: deps.agents?.() ?? [],
    platformUsage: deps.usage?.() ?? null,
    ccr: deps.ccr.stats(),
    feedback: deps.feedback.stats(),
    board: deps.team.board().map((e) => ({ id: e.id, author: e.author, ts: e.ts, summary: e.summary.slice(0, 200) })),
    learnings: learnings.length,
    recentLearnings: learnings.slice(-5).reverse().map((l) => ({ date: l.date, summary: l.summary.slice(0, 160) })),
    knowledge: deps.knowledge ? knowledgeSummary(deps.knowledge) : null,
    wiki: deps.wiki ? wikiState(deps.wiki) : null,
    skills: deps.skills
      ? deps.skills.list().map((s) => ({ name: s.name, uses: s.uses, triggers: s.triggers.slice(0, 6), updatedAt: s.updatedAt }))
      : null,
    generatedAt: new Date().toISOString(),
  };
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Knit Brain</title>
<style>
  :root { color-scheme: dark; }
  body { font: 14px/1.5 ui-monospace, monospace; background: #0d1117; color: #e6edf3; margin: 2rem auto; max-width: 880px; padding: 0 1rem; }
  h1 { font-size: 1.2rem; letter-spacing: .04em; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: .8rem; margin: 1rem 0; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: .9rem 1rem; }
  .big { font-size: 1.6rem; font-weight: 700; }
  .label { color: #8b949e; font-size: .75rem; text-transform: uppercase; letter-spacing: .08em; }
  .bar { height: 10px; background: #21262d; border-radius: 5px; overflow: hidden; margin-top: .5rem; }
  .fill { height: 100%; transition: width .4s; }
  .ok { background: #3fb950; } .warn { background: #d29922; } .handoff { background: #f85149; }
  .advice { margin-top: .5rem; color: #8b949e; }
  table { width: 100%; border-collapse: collapse; margin-top: .4rem; }
  td, th { text-align: left; padding: .25rem .5rem; border-bottom: 1px solid #21262d; }
  .wikilink { padding: .15rem .35rem; cursor: pointer; border-radius: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .wikilink:hover { background: #21262d; }
  .wikilink.sel { background: #1f6feb33; color: #58a6ff; }
  .wikibody { padding: .2rem .4rem; }
  .wikibody h3, .wikibody h4, .wikibody h5 { margin: .6rem 0 .2rem; font-size: .95rem; }
  .wikibody a { color: #58a6ff; }
  .wikibody code { background: #21262d; padding: 0 .25rem; border-radius: 3px; }
  .wikibody pre { background: #161b22; padding: .5rem; overflow: auto; border-radius: 6px; }
  .wikibody pre code { background: none; padding: 0; }
</style></head><body>
<h1>🧠 knitbrain — live</h1>
<div class="grid">
  <div class="card"><div class="label">Context window</div><div class="big" id="pct">–</div>
    <div class="bar"><div class="fill ok" id="fill" style="width:0%"></div></div>
    <div class="advice" id="advice"></div></div>
  <div class="card"><div class="label">Tokens saved (optimizer)</div><div class="big" id="saved">–</div></div>
  <div class="card"><div class="label">Platform tokens (real, this project)</div><div class="big" id="ptok">–</div><div class="advice" id="pbreak"></div></div>
  <div class="card"><div class="label">Recall store (hot / cold)</div><div class="big" id="ccr">–</div></div>
  <div class="card"><div class="label">Learnings</div><div class="big" id="learnings">–</div></div>
</div>
<div class="card"><div class="label">Per-agent optimization (every platform · auto-detected)</div><table id="agents"></table></div>
<div class="card" style="margin-top:.8rem"><div class="label">Agents — live activity</div><table id="activity"></table></div>
<div class="card" style="margin-top:.8rem"><div class="label">Subscription window (Pro/Max)</div><table id="quota"></table></div>
<div class="card" style="margin-top:.8rem"><div class="label">Self-tuning (retrieval rate per kind)</div><table id="fb"></table></div>
<div class="card" style="margin-top:.8rem"><div class="label">Knowledge graph (top blast radius)</div><div class="advice" id="kfiles"></div><table id="kg"></table></div>
<div class="card" style="margin-top:.8rem"><div class="label">Skills</div><table id="skills"></table></div>
<div class="card" style="margin-top:.8rem"><div class="label">Recent learnings</div><table id="recent"></table></div>
<div class="card" style="margin-top:.8rem"><div class="label">Team board</div><table id="board"></table></div>
<div class="card" style="margin-top:.8rem"><div class="label">Wiki-brain (browsable · click a page or a [[link]])</div>
  <div id="wiki-empty" class="advice">no wiki yet — ingest with knitbrain_wiki_ingest</div>
  <div id="wiki-wrap" style="display:none">
    <div style="display:flex; gap:1rem; flex-wrap:wrap">
      <div style="flex:0 0 200px; max-height:340px; overflow:auto" id="wiki-list"></div>
      <div style="flex:1 1 320px; min-width:280px">
        <div id="wiki-body" class="wikibody"></div>
        <div id="wiki-back" class="advice" style="margin-top:.4rem"></div>
      </div>
    </div>
    <svg id="wiki-graph" width="100%" height="200" style="margin-top:.6rem; border-top:1px solid #21262d"></svg>
    <div class="advice" id="wiki-log"></div>
  </div>
</div>
<script>
const esc = (v) => String(v).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
let wikiPages = [], wikiEdges = [], wikiSel = null;
function wikiOpen(slug) { if (wikiPages.some(p => p.slug === slug)) { wikiSel = slug; wikiRender(); } }
document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-slug]");
  if (t) { e.preventDefault(); wikiOpen(t.getAttribute("data-slug")); }
});
function wikiGraph() {
  const svg = document.getElementById("wiki-graph");
  const W = svg.clientWidth || 600, H = 200, cx = W/2, cy = H/2, R = Math.min(W,H)/2 - 28, n = wikiPages.length || 1;
  const pos = {};
  wikiPages.forEach((p,i) => { const a = (i/n)*2*Math.PI - Math.PI/2; pos[p.slug] = { x: cx + R*Math.cos(a), y: cy + R*Math.sin(a) }; });
  let out = "";
  wikiEdges.forEach(e => { const a = pos[e.from], b = pos[e.to]; if (a && b) out += \`<line x1="\${a.x}" y1="\${a.y}" x2="\${b.x}" y2="\${b.y}" stroke="#30363d" stroke-width="1"/>\`; });
  wikiPages.forEach(p => { const o = pos[p.slug], sel = p.slug === wikiSel; out += \`<g data-slug="\${esc(p.slug)}" style="cursor:pointer"><circle cx="\${o.x}" cy="\${o.y}" r="\${sel?7:5}" fill="\${sel?'#3fb950':'#58a6ff'}"/><text x="\${o.x}" y="\${o.y-9}" fill="#8b949e" font-size="9" text-anchor="middle">\${esc(p.title.slice(0,14))}</text></g>\`; });
  svg.innerHTML = out;
}
function wikiRender() {
  const wrap = document.getElementById("wiki-wrap"), empty = document.getElementById("wiki-empty");
  if (!wikiPages.length) { wrap.style.display = "none"; empty.style.display = ""; return; }
  empty.style.display = "none"; wrap.style.display = "";
  const byKind = {};
  wikiPages.forEach(p => { (byKind[p.kind] = byKind[p.kind] || []).push(p); });
  if (!wikiPages.some(p => p.slug === wikiSel)) wikiSel = wikiPages[0].slug;
  let list = "";
  Object.keys(byKind).sort().forEach(k => {
    list += \`<div class="label" style="margin-top:.4rem">\${esc(k)}</div>\`;
    byKind[k].sort((a,b) => a.title.localeCompare(b.title)).forEach(p => {
      list += \`<div class="wikilink\${p.slug===wikiSel?' sel':''}" data-slug="\${esc(p.slug)}" title="\${esc(p.title)}">\${esc(p.title)}</div>\`;
    });
  });
  document.getElementById("wiki-list").innerHTML = list;
  const pg = wikiPages.find(p => p.slug === wikiSel);
  document.getElementById("wiki-body").innerHTML = \`<h2>\${esc(pg.title)}</h2>\` + pg.bodyHtml;
  document.getElementById("wiki-back").innerHTML = pg.backlinks.length
    ? "linked from: " + pg.backlinks.map(s => \`<a href="#" data-slug="\${esc(s)}">\${esc(s)}</a>\`).join(", ")
    : "no backlinks";
  wikiGraph();
}
async function tick() {
  try {
    const s = await (await fetch("/api/state")).json();
    document.getElementById("pct").textContent = s.meter.usedPct + "%";
    const fill = document.getElementById("fill");
    fill.style.width = Math.min(100, s.meter.usedPct) + "%";
    fill.className = "fill " + s.meter.status;
    document.getElementById("advice").textContent = s.meter.advice;
    document.getElementById("saved").textContent = s.meter.savedTokens.toLocaleString();
    if (s.platformUsage) {
      const p = s.platformUsage;
      document.getElementById("ptok").textContent = p.totalTokens.toLocaleString();
      document.getElementById("pbreak").textContent =
        "in " + p.inputTokens.toLocaleString() + " · out " + p.outputTokens.toLocaleString() +
        " · cache " + (p.cacheReadTokens + p.cacheCreationTokens).toLocaleString() + " · " + p.messages + " msgs";
    } else {
      document.getElementById("ptok").textContent = "—";
      document.getElementById("pbreak").textContent = "no sessions for this project yet";
    }
    document.getElementById("ccr").textContent = s.ccr.hot + " / " + s.ccr.cold;
    document.getElementById("learnings").textContent = s.learnings;
    document.getElementById("fb").innerHTML = "<tr><th>kind</th><th>compressed</th><th>retrieved</th><th>rate</th><th>state</th></tr>" +
      s.feedback.map(f => \`<tr><td>\${f.kind}</td><td>\${f.compressions}</td><td>\${f.retrievals}</td><td>\${f.rate}</td><td>\${f.skipping ? "backing off" : "active"}</td></tr>\`).join("");
    document.getElementById("agents").innerHTML = (s.agents && s.agents.length)
      ? "<tr><th>agent (platform · plan)</th><th>calls</th><th>tokens saved</th><th>last</th></tr>" + s.agents.map(a => \`<tr><td>\${esc(a.agent)}</td><td>\${a.calls}</td><td>\${a.saved.toLocaleString()}</td><td>\${esc(a.lastTs.slice(11,19))}</td></tr>\`).join("")
      : "<tr><td>no agents yet — connect an MCP client</td></tr>";
    document.getElementById("activity").innerHTML = (s.activity && s.activity.length)
      ? "<tr><th>agent</th><th>tool</th><th>when</th><th>detail</th></tr>" + s.activity.map(a => \`<tr><td>\${esc(a.agent)}</td><td>\${esc(a.tool)}</td><td>\${esc(a.ts.slice(11,19))}</td><td>\${esc(a.summary)}</td></tr>\`).join("")
      : "<tr><td>no agent activity yet — run a knitbrain tool</td></tr>";
    document.getElementById("quota").innerHTML = (s.quota && s.quota.windows.length)
      ? "<tr><th>window</th><th>used</th><th>resets</th></tr>" + s.quota.windows.map(w => \`<tr><td>\${esc(w.label)}</td><td>\${w.usedPct}%</td><td>\${w.resetsInMin != null ? w.resetsInMin + "m" : "—"}</td></tr>\`).join("")
      : "<tr><td>no subscription usage source found — either you're on an API key (see billing), or no local OAuth credentials were readable (env CLAUDE_CODE_OAUTH_TOKEN · ~/.claude/.credentials.json · macOS Keychain 'Claude Code-credentials'). On macOS the first read may show a Keychain allow dialog.</td></tr>";
    if (s.knowledge) {
      document.getElementById("kfiles").textContent = s.knowledge.files + " files indexed";
      document.getElementById("kg").innerHTML = "<tr><th>file</th><th>dependents</th></tr>" +
        (s.knowledge.topFanout.length ? s.knowledge.topFanout.map(f => \`<tr><td>\${esc(f.file)}</td><td>\${f.dependents}</td></tr>\`).join("") : "<tr><td colspan=2>— run a scan —</td></tr>");
    } else {
      document.getElementById("kfiles").textContent = "no project scope (start the dashboard inside a project)";
    }
    document.getElementById("skills").innerHTML = "<tr><th>skill</th><th>uses</th><th>triggers</th><th>updated</th></tr>" +
      (s.skills && s.skills.length ? s.skills.map(k => \`<tr><td>\${esc(k.name)}</td><td>\${k.uses}</td><td>\${esc(k.triggers.join(", "))}</td><td>\${esc(k.updatedAt.slice(0,10))}</td></tr>\`).join("") : "<tr><td colspan=4>—</td></tr>");
    document.getElementById("recent").innerHTML = "<tr><th>date</th><th>learning</th></tr>" +
      (s.recentLearnings.length ? s.recentLearnings.map(l => \`<tr><td>\${esc(l.date)}</td><td>\${esc(l.summary)}</td></tr>\`).join("") : "<tr><td colspan=2>—</td></tr>");
    document.getElementById("board").innerHTML = "<tr><th>who</th><th>when</th><th>finding</th></tr>" +
      (s.board.length ? s.board.map(b => \`<tr><td>\${esc(b.author)}</td><td>\${esc(b.ts.slice(11,19))}</td><td>\${esc(b.summary)}</td></tr>\`).join("") : "<tr><td colspan=3>—</td></tr>");
    if (s.wiki) {
      wikiPages = s.wiki.pages || [];
      wikiEdges = s.wiki.edges || [];
      document.getElementById("wiki-log").innerHTML = s.wiki.recent && s.wiki.recent.length
        ? "<b>recent log</b><br>" + s.wiki.recent.map(l => esc(l)).join("<br>")
        : "";
    } else {
      wikiPages = []; wikiEdges = [];
    }
    wikiRender();
  } catch {}
}
tick(); setInterval(tick, 2000);
</script></body></html>`;

/** Loopback-only dashboard server: GET / (page), GET /api/state (JSON). */
export function createDashboardServer(deps: DashboardDeps): Server {
  return createServer((req, res) => {
    // SECURITY: the server binds loopback, but a DNS-rebinding page in the
    // user's browser reaches 127.0.0.1 with an attacker Host header — reject
    // any Host that isn't loopback so /api/state (learnings, board, wiki)
    // can't be read cross-origin.
    const host = (req.headers.host ?? "").replace(/:\d+$/, "").toLowerCase();
    if (host !== "127.0.0.1" && host !== "localhost" && host !== "[::1]") {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "forbidden host" }));
      return;
    }
    if (req.url === "/api/state") {
      void (async () => {
        try {
          const state = dashboardState(deps);
          // COMMON view: merge the team hub's board. Best-effort as the comment
          // promises: a hub fetch failure degrades to the local board, never
          // fails the whole response.
          const hub = loadHubConfig();
          if (hub) {
            try {
              const remote = await fetchHubBoard(hub);
              const local = state["board"] as Array<{ id: string }>;
              const seen = new Set(local.map((e) => e.id));
              state["board"] = [
                ...local,
                ...remote.filter((e) => !seen.has(e.id)).map((e) => ({ ...e, author: `${e.author} (hub)` })),
              ];
            } catch {
              /* hub unreachable — keep the local board */
            }
          }
          // Subscription quota (async, best-effort — degrades to null on failure).
          try {
            state["quota"] = deps.quota ? await deps.quota() : null;
          } catch {
            state["quota"] = null;
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(state));
        } catch (err) {
          // Anything unexpected: still END the request (an unhandled rejection
          // here would otherwise hang the connection and the browser tick).
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: (err as Error).message }));
        }
      })();
      return;
    }
    if (req.url === "/" || req.url === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(PAGE);
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
}
