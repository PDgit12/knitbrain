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
    const esc = (v) => String(v).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
    document.getElementById("agents").innerHTML = (s.agents && s.agents.length)
      ? "<tr><th>agent (platform · plan)</th><th>calls</th><th>tokens saved</th><th>last</th></tr>" + s.agents.map(a => \`<tr><td>\${esc(a.agent)}</td><td>\${a.calls}</td><td>\${a.saved.toLocaleString()}</td><td>\${esc(a.lastTs.slice(11,19))}</td></tr>\`).join("")
      : "<tr><td>no agents yet — connect an MCP client</td></tr>";
    document.getElementById("activity").innerHTML = (s.activity && s.activity.length)
      ? "<tr><th>agent</th><th>tool</th><th>when</th><th>detail</th></tr>" + s.activity.map(a => \`<tr><td>\${esc(a.agent)}</td><td>\${esc(a.tool)}</td><td>\${esc(a.ts.slice(11,19))}</td><td>\${esc(a.summary)}</td></tr>\`).join("")
      : "<tr><td>no agent activity yet — run a knitbrain tool</td></tr>";
    document.getElementById("quota").innerHTML = (s.quota && s.quota.windows.length)
      ? "<tr><th>window</th><th>used</th><th>resets</th></tr>" + s.quota.windows.map(w => \`<tr><td>\${esc(w.label)}</td><td>\${w.usedPct}%</td><td>\${w.resetsInMin != null ? w.resetsInMin + "m" : "—"}</td></tr>\`).join("")
      : "<tr><td>no subscription source (using an API key, or platform has no usage API)</td></tr>";
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
  } catch {}
}
tick(); setInterval(tick, 2000);
</script></body></html>`;

/** Loopback-only dashboard server: GET / (page), GET /api/state (JSON). */
export function createDashboardServer(deps: DashboardDeps): Server {
  return createServer((req, res) => {
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
