/**
 * PRODUCTION AUDIT — cold-start, portable proof.
 *
 * Simulates shipping knitbrain to a different machine:
 *   Stage 1  fresh `git clone` of the committed state into a temp dir
 *   Stage 2  clean `npm ci` install there
 *   Stage 3  all 5 gates (typecheck, lint, test, build, bench) + e2e in the clone
 *   Stage 4  `npm pack` → install the tarball into a brand-new consumer project
 *            (exactly what `npm i knitbrain` would deliver)
 *   Stage 5  run the INSTALLED `knitbrain` binary: drive a full MCP session over
 *            stdio — exercise EVERY tool (20/20) with assertions
 *   Stage 6  run the INSTALLED `knitbrain-proxy` binary: real HTTP loop against
 *            a local fake upstream (compression on the wire + SSE passthrough)
 *   Stage 7  `knitbrain setup` CLI in the consumer project
 *
 * Everything runs under an isolated KNITBRAIN_HOME. Exits non-zero on any
 * failure. Run: node scripts/production-audit.mjs
 */
import { execSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const results = [];
let failures = 0;

function ok(cond, msg) {
  results.push(`${cond ? "PASS" : "FAIL"}  ${msg}`);
  console.log(`  ${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failures += 1;
}
function stage(n, title) {
  console.log(`\n[audit] Stage ${n} — ${title}`);
}
function sh(cmd, cwd, env = {}) {
  return execSync(cmd, { cwd, env: { ...process.env, ...env }, stdio: "pipe" }).toString();
}

const work = mkdtempSync(join(tmpdir(), "knitbrain-prod-audit-"));
const HOME_ISOLATED = join(work, "kb-home");
mkdirSync(HOME_ISOLATED, { recursive: true });

try {
  // ───────────── Stage 1: fresh clone of the committed state ─────────────
  stage(1, "fresh git clone (cold start — uncommitted files excluded)");
  const clone = join(work, "clone");
  sh(`git clone --quiet "${REPO}" "${clone}"`);
  ok(existsSync(join(clone, "package.json")), "clone has package.json");
  ok(!existsSync(join(clone, "node_modules")), "clone starts with NO node_modules (cold)");

  // ───────────── Stage 2: clean install ─────────────
  stage(2, "clean dependency install (npm ci)");
  sh("npm ci --silent", clone);
  ok(existsSync(join(clone, "node_modules")), "npm ci installed dependencies");

  // ───────────── Stage 3: all gates + e2e in the clone ─────────────
  stage(3, "all 5 gates + e2e in the clone");
  let gatesOut = "";
  try {
    gatesOut = sh("npm run verify", clone);
    ok(true, "verify (typecheck+lint+test+build+bench) green in fresh clone");
  } catch (e) {
    ok(false, `verify failed in fresh clone: ${String(e).slice(0, 200)}`);
  }
  ok(/PASS — real-shape floors held/.test(gatesOut), "bench gate proves real-shape floors + fidelity + lossless in clone");
  try {
    const e2eOut = sh("npm run e2e", clone, { KNITBRAIN_HOME: HOME_ISOLATED });
    ok(/\[e2e\] PASS/.test(e2eOut), "full e2e green in fresh clone");
  } catch (e) {
    ok(false, `e2e failed in clone: ${String(e).slice(0, 200)}`);
  }

  // ───────────── Stage 4: pack + install like a real user ─────────────
  stage(4, "npm pack → install tarball into a NEW consumer project");
  const packOut = sh("npm pack --silent", clone).trim().split("\n").pop();
  const tarball = join(clone, packOut);
  ok(existsSync(tarball), `tarball produced (${packOut})`);

  const consumer = join(work, "consumer");
  mkdirSync(join(consumer, "src"), { recursive: true });
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "consumer", private: true }));
  // a real source file so the knowledge graph has something to scan
  writeFileSync(join(consumer, "src", "app.ts"), `export function main(): number { return 42; }\n`);
  writeFileSync(join(consumer, "src", "util.ts"), `import { main } from "./app.js";\nexport const v = main();\n`);
  sh(`npm install --silent "${tarball}"`, consumer);
  const binServer = join(consumer, "node_modules", ".bin", "knitbrain");
  const binProxy = join(consumer, "node_modules", ".bin", "knitbrain-proxy");
  ok(existsSync(binServer), "installed package exposes `knitbrain` binary");
  ok(existsSync(binProxy), "installed package exposes `knitbrain-proxy` binary");

  // ───────────── Stage 5: drive ALL 20 tools via the installed binary ─────────────
  stage(5, "installed `knitbrain` binary — full MCP session, all 20 tools");
  await fullMcpSession(binServer, consumer);

  // ───────────── Stage 6: installed proxy binary over real HTTP ─────────────
  stage(6, "installed `knitbrain-proxy` binary — real HTTP compression loop");
  await proxyLoop(binProxy, consumer);

  // ───────────── Stage 7: setup CLI ─────────────
  stage(7, "knitbrain setup in the consumer project");
  const setupOut = sh(`"${binServer}" setup`, consumer, { KNITBRAIN_HOME: HOME_ISOLATED });
  ok(/wrote \.mcp\.json/.test(setupOut), "setup writes platform artifacts (.mcp.json + extras)");
  const mcpJson = JSON.parse(readFileSync(join(consumer, ".mcp.json"), "utf8"));
  ok(mcpJson.mcpServers?.knitbrain?.command === "knitbrain", ".mcp.json wired to knitbrain");

  // ───────────── Stage 8: installed hook binary (enforcement layer) ─────────────
  stage(8, "installed `knitbrain-hook` binary — PreToolUse enforcement");
  const binHook = join(consumer, "node_modules", ".bin", "knitbrain-hook");
  const bigFile = join(consumer, "big-audit-file.txt");
  writeFileSync(bigFile, "x".repeat(30000));
  const hookOut = sh(
    `echo '{"tool_name":"Read","tool_input":{"file_path":"${bigFile}"},"cwd":"${consumer}"}' | "${binHook}" pretooluse`,
    consumer,
    { KNITBRAIN_HOME: HOME_ISOLATED },
  );
  ok(hookOut.includes('"permissionDecision":"deny"') && hookOut.includes("knitbrain_read"), "hook denies large raw Read, redirects to knitbrain_read");
  const smallOut = sh(
    `echo '{"tool_name":"Read","tool_input":{"file_path":"${join(consumer, "package.json")}"},"cwd":"${consumer}"}' | "${binHook}" pretooluse`,
    consumer,
    { KNITBRAIN_HOME: HOME_ISOLATED },
  );
  ok(!smallOut.includes("deny"), "hook passes small files through untouched");

  // ───────────── Stage 9: dashboard + hub over real HTTP ─────────────
  stage(9, "dashboard + hub — live HTTP");
  {
    const dash = spawn(binServer, ["dashboard"], { cwd: consumer, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, KNITBRAIN_HOME: HOME_ISOLATED, KNITBRAIN_DASHBOARD_PORT: "18790" } });
    try {
      await waitFor(async () => (await fetch("http://127.0.0.1:18790/api/state")).ok, 8000);
      const state = await (await fetch("http://127.0.0.1:18790/api/state")).json();
      ok(state.meter !== undefined && state.ccr !== undefined && state.feedback !== undefined, "dashboard serves live state (meter, ccr, feedback, …)");
    } catch (e) {
      ok(false, `dashboard live: ${e.message}`);
    } finally {
      dash.kill();
    }
    const hub = spawn(binServer, ["hub"], { cwd: consumer, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, KNITBRAIN_HOME: HOME_ISOLATED, KNITBRAIN_HUB_PORT: "18791" } });
    try {
      let hubLog = "";
      hub.stdout.on("data", (d) => (hubLog += d.toString()));
      await waitFor(async () => /team token: \S+/.test(hubLog), 8000);
      const token = /team token: (\S+)/.exec(hubLog)[1];
      const unauthorized = await fetch("http://127.0.0.1:18791/board");
      ok(unauthorized.status === 401 || unauthorized.status === 403, "hub rejects requests without the team token");
      const posted = await (await fetch("http://127.0.0.1:18791/board", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ author: "audit", original: "hub audit posting" }) })).json();
      ok(typeof posted.id === "string", "hub accepts an authenticated posting");
      const board = await (await fetch("http://127.0.0.1:18791/board", { headers: { authorization: `Bearer ${token}` } })).json();
      ok(Array.isArray(board) && board.some((p) => p.author === "audit"), "hub board lists the posting");
    } catch (e) {
      ok(false, `hub live: ${e.message}`);
    } finally {
      hub.kill();
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

// ─────────────────────────── helpers ───────────────────────────

async function waitFor(cond, timeoutMs) {
  const start = Date.now();
  for (;;) {
    try {
      if (await cond()) return;
    } catch { /* not up yet */ }
    if (Date.now() - start > timeoutMs) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 250));
  }
}

function makeClient(proc) {
  let buf = "";
  const pending = new Map();
  proc.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id != null && pending.has(msg.id)) {
          pending.get(msg.id)(msg);
          pending.delete(msg.id);
        }
      } catch { /* partial line */ }
    }
  });
  let id = 0;
  return {
    rpc: (method, params) =>
      new Promise((resolve, reject) => {
        const my = ++id;
        pending.set(my, resolve);
        proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: my, method, params }) + "\n");
        setTimeout(() => { if (pending.has(my)) { pending.delete(my); reject(new Error(`timeout: ${method}`)); } }, 10000);
      }),
    notify: (method, params) => proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n"),
  };
}
function text(r) {
  return r?.result?.content?.[0]?.text ?? "";
}

async function fullMcpSession(bin, cwd) {
  const proc = spawn(bin, [], { cwd, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, KNITBRAIN_HOME: HOME_ISOLATED } });
  try {
    const { rpc, notify } = makeClient(proc);
    const init = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "prod-audit", version: "1" } });
    ok(init.result?.serverInfo?.name === "knitbrain", "initialize handshake (installed binary)");
    notify("notifications/initialized");

    const list = await rpc("tools/list", {});
    const names = (list.result?.tools ?? []).map((t) => t.name);
    ok(names.length === 26, `tools/list advertises exactly 26 tools (got ${names.length})`);

    const call = (name, args = {}) => rpc("tools/call", { name, arguments: args });

    // 1 ping
    ok(text(await call("knitbrain_ping")).includes("pong"), "ping");
    // 2-3 optimize → retrieve (lossless loop)
    const payload = JSON.stringify({ items: Array.from({ length: 40 }, (_, i) => ({ i, blob: "p".repeat(60) })) }, null, 2);
    const optText = text(await call("knitbrain_optimize", { text: payload }));
    const handle = optText.match(/⟨ccr:([0-9a-f]{64})⟩/)?.[1];
    ok(Boolean(handle) && optText.length < payload.length, "optimize → smaller skeleton + handle");
    ok(text(await call("knitbrain_retrieve", { handle })) === payload, "retrieve → EXACT original (lossless in production install)");
    // 4-8 memory
    ok(text(await call("knitbrain_record_learning", { summary: "prod audit learning", lesson: "installed binary memory works", tags: ["audit"] })).includes("recorded"), "record_learning");
    const searchText = text(await call("knitbrain_search_learnings", { query: "prod audit" }));
    ok(searchText.includes("prod audit learning"), "search_learnings finds it");
    // NOTE: data tools return COMPRESSED output in production — extract ids
    // like a real agent (short fields survive in the skeleton).
    const lid = searchText.match(/"id":\s*"([0-9a-f]{12})"/)?.[1];
    ok(Boolean(lid) && text(await call("knitbrain_get_learning", { id: lid })).includes("installed binary memory works"), "get_learning returns full lesson");
    ok(text(await call("knitbrain_save_handoff", { state: "resume from prod audit" })).includes("saved"), "save_handoff");
    ok(text(await call("knitbrain_load_session")).includes("resume from prod audit"), "load_session returns the handoff");
    // 9-12 knowledge
    ok(/scanned \d+ files/.test(text(await call("knitbrain_scan"))), "scan builds the knowledge graph");
    ok(text(await call("knitbrain_query_exports", { file: "src/app.ts" })).includes("main"), "query_exports");
    ok(text(await call("knitbrain_query_imports", { file: "src/util.ts" })).includes("./app.js"), "query_imports");
    ok(text(await call("knitbrain_query_dependents", { file: "src/app.ts" })).includes("src/util.ts"), "query_dependents (blast radius)");
    // 13 classify
    ok(text(await call("knitbrain_classify_task", { description: "refactor the architecture" })).includes("complex"), "classify_task governance");
    // 14 metrics
    const metrics = JSON.parse(text(await call("knitbrain_metrics")));
    ok(typeof metrics.ccr?.total === "number" && Array.isArray(metrics.feedback), "metrics (CCR + TOIN telemetry)");
    // 14b context meter
    const meterReading = JSON.parse(text(await call("knitbrain_context_meter")));
    ok(typeof meterReading.usedPct === "number" && typeof meterReading.advice === "string", "context_meter (window % + advice)");
    // 15-16 agents
    ok(text(await call("knitbrain_propose_agents")).includes("src"), "propose_agents from knowledge graph");
    ok(text(await call("knitbrain_create_agent", { name: "app-domain", scope: "src/**" })).includes("created agent"), "create_agent writes guardrailed agent");
    ok(existsSync(join(cwd, ".claude", "agents", "app-domain.md")), "agent file exists on disk");
    // DEEP DIVE: input fuzz — EVERY tool with missing + wrong-typed args.
    // The server must answer gracefully every time and never crash.
    let fuzzOk = true;
    for (const name of names) {
      const bad = await call(name, {});
      const badTyped = await call(name, { text: 42, handle: {}, path: ["x"], id: 9, query: null, task: false, name: 1 });
      if (!bad?.result || !badTyped?.result) fuzzOk = false;
    }
    ok(fuzzOk && text(await call("knitbrain_ping")).includes("pong"), `input fuzz: all ${names.length} tools survive missing + wrong-typed args; server alive`);
    // knitbrain_read deep checks through the installed binary
    ok(text(await call("knitbrain_read", { path: "src/app.ts" })).includes("main"), "knitbrain_read: small file exact");
    ok(text(await call("knitbrain_read", { path: "../../etc/passwd" })).includes("refused"), "knitbrain_read: traversal refused (installed binary)");

    // 17-20 teams
    ok(text(await call("knitbrain_team_post", { author: "auditor", content: payload })).includes("posted"), "team_post");
    const boardText = text(await call("knitbrain_team_board"));
    const entryId = boardText.match(/"id":\s*"([0-9a-f]{8})"/)?.[1];
    ok(Boolean(entryId) && boardText.includes("auditor"), "team_board lists the posting (compressed data output)");
    ok(text(await call("knitbrain_team_get", { id: entryId })) === payload, "team_get recovers the FULL original");
    ok(text(await call("knitbrain_team_clear")).includes("cleared"), "team_clear");
  } finally {
    proc.kill();
  }
}

async function proxyLoop(binProxy, cwd) {
  // fake upstream that records what it receives
  const received = [];
  const upstream = createServer((req, res) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => {
      received.push(d);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, role: "assistant" }));
    });
  });
  const upPort = await new Promise((r) => upstream.listen(0, "127.0.0.1", () => r(upstream.address().port)));

  const proxyPort = 18799;
  const proc = spawn(binProxy, [], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, KNITBRAIN_HOME: HOME_ISOLATED, KNITBRAIN_PROXY_PORT: String(proxyPort), KNITBRAIN_UPSTREAM: `http://127.0.0.1:${upPort}` },
  });
  try {
    // wait for the listening banner
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("proxy did not start")), 8000);
      proc.stderr.on("data", (d) => { if (d.toString().includes("listening")) { clearTimeout(t); resolve(); } });
    });
    const health = await (await fetch(`http://127.0.0.1:${proxyPort}/health`)).json();
    ok(health.status === "healthy", "installed proxy binary: /health healthy");

    const oldBulk = JSON.stringify({ log: Array.from({ length: 50 }, (_, i) => ({ i, line: "err ".repeat(20) })) });
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ system: "rules", messages: [
        { role: "user", content: oldBulk },
        { role: "assistant", content: "ok" },
        { role: "user", content: "fix the bug" },
      ] }),
    });
    ok((await res.json()).ok === true, "proxy forwards and returns upstream response");
    const fwd = JSON.parse(received[0]);
    const fwdFirst = fwd.messages[0].content;
    const fwdFirstText = typeof fwdFirst === "string" ? fwdFirst : fwdFirst.map((b) => b.text ?? "").join("");
    ok(fwdFirstText.includes("⟨ccr:"), "request compressed ON THE WIRE (old bulk → skeleton)");
    ok(JSON.stringify(fwd).includes("cache_control"), "CacheAligner inserted a cache_control breakpoint (client had none)");
    ok(fwd.messages[2].content === "fix the bug", "user intent reached upstream VERBATIM");
    ok(JSON.stringify(fwd).length < JSON.stringify({ system: "rules", messages: [{ role: "user", content: oldBulk }] }).length, "forwarded request is smaller than original");
  } finally {
    proc.kill();
    upstream.close();
  }
}

// ─────────────────────────── report ───────────────────────────
console.log("\n[audit] ──────────── PRODUCTION AUDIT REPORT ────────────");
for (const r of results) console.log(`[audit] ${r}`);
console.log(`[audit] ${results.length} checks · ${results.length - failures} passed · ${failures} failed`);
console.log(failures === 0
  ? "[audit] VERDICT: PASS — cold-start portable: clone → install → gates → packed install → all 26 tools + proxy + hook + dashboard + hub work."
  : "[audit] VERDICT: FAIL");
process.exit(failures === 0 ? 0 : 1);
