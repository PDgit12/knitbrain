import { createServer, type Server } from "node:http";
import type { CCRStore } from "./ccr/store.js";
import type { Memory } from "./engine/memory.js";
import type { Feedback } from "./engine/feedback.js";
import type { TeamBoard } from "./engine/teams.js";
import type { Meter } from "./engine/meter.js";

export interface DashboardDeps {
  ccr: CCRStore;
  memory: Memory;
  feedback: Feedback;
  team: TeamBoard;
  meter: Meter;
}

/** One JSON snapshot of everything the dashboard shows. */
export function dashboardState(deps: DashboardDeps): Record<string, unknown> {
  const meter = deps.meter.read();
  return {
    meter,
    ccr: deps.ccr.stats(),
    feedback: deps.feedback.stats(),
    board: deps.team.board().map((e) => ({ id: e.id, author: e.author, ts: e.ts, summary: e.summary.slice(0, 200) })),
    learnings: deps.memory.listLearnings().length,
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
</style></head><body>
<h1>🧠 knitbrain — live</h1>
<div class="grid">
  <div class="card"><div class="label">Context window</div><div class="big" id="pct">–</div>
    <div class="bar"><div class="fill ok" id="fill" style="width:0%"></div></div>
    <div class="advice" id="advice"></div></div>
  <div class="card"><div class="label">Tokens saved (session)</div><div class="big" id="saved">–</div></div>
  <div class="card"><div class="label">CCR store (hot / cold)</div><div class="big" id="ccr">–</div></div>
  <div class="card"><div class="label">Learnings</div><div class="big" id="learnings">–</div></div>
</div>
<div class="card"><div class="label">Self-tuning (retrieval rate per kind)</div><table id="fb"></table></div>
<div class="card" style="margin-top:.8rem"><div class="label">Team board</div><table id="board"></table></div>
<script>
async function tick() {
  try {
    const s = await (await fetch("/api/state")).json();
    document.getElementById("pct").textContent = s.meter.usedPct + "%";
    const fill = document.getElementById("fill");
    fill.style.width = Math.min(100, s.meter.usedPct) + "%";
    fill.className = "fill " + s.meter.status;
    document.getElementById("advice").textContent = s.meter.advice;
    document.getElementById("saved").textContent = s.meter.savedTokens.toLocaleString();
    document.getElementById("ccr").textContent = s.ccr.hot + " / " + s.ccr.cold;
    document.getElementById("learnings").textContent = s.learnings;
    document.getElementById("fb").innerHTML = "<tr><th>kind</th><th>compressed</th><th>retrieved</th><th>rate</th><th>state</th></tr>" +
      s.feedback.map(f => \`<tr><td>\${f.kind}</td><td>\${f.compressions}</td><td>\${f.retrievals}</td><td>\${f.rate}</td><td>\${f.skipping ? "backing off" : "active"}</td></tr>\`).join("");
    document.getElementById("board").innerHTML = "<tr><th>who</th><th>when</th><th>finding</th></tr>" +
      (s.board.length ? s.board.map(b => \`<tr><td>\${b.author}</td><td>\${b.ts.slice(11,19)}</td><td>\${b.summary.replace(/</g,"&lt;")}</td></tr>\`).join("") : "<tr><td colspan=3>—</td></tr>");
  } catch {}
}
tick(); setInterval(tick, 2000);
</script></body></html>`;

/** Loopback-only dashboard server: GET / (page), GET /api/state (JSON). */
export function createDashboardServer(deps: DashboardDeps): Server {
  return createServer((req, res) => {
    if (req.url === "/api/state") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(dashboardState(deps)));
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
