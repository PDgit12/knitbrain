/**
 * End-to-end check of the BUILT artifact (dist/):
 *   1. spawn the MCP server, drive a real stdio session: initialize →
 *      tools/list → ping → optimize → retrieve (the reverse loop), asserting
 *      a lossless round-trip over the wire.
 *   2. run the unified compress() on REAL files, asserting never-expand +
 *      byte-for-byte CCR recovery, reporting real token savings.
 *
 * Run after `npm run build`. Exits non-zero on any failure.
 */
import { spawn } from "node:child_process";
import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const distUrl = (p) => pathToFileURL(join(ROOT, "dist", p)).href;

let failures = 0;
const ok = (cond, msg) => {
  console.log(`  ${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failures += 1;
};

function makeClient(proc) {
  let buf = "";
  const pending = new Map();
  proc.stdout.on("data", (d) => {
    buf += d.toString();
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id != null && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });
  let id = 0;
  const rpc = (method, params) =>
    new Promise((resolve) => {
      const myId = ++id;
      pending.set(myId, resolve);
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n");
    });
  const notify = (method, params) =>
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  return { rpc, notify };
}

const text = (resp) => resp?.result?.content?.[0]?.text ?? "";

async function mcpSession() {
  console.log("[e2e] Part 1 — live MCP server session (optimize → retrieve)");
  const server = join(ROOT, "dist", "index.js");
  ok(existsSync(server), "built server artifact exists (dist/index.js)");

  const home = mkdtempSync(join(tmpdir(), "knitbrain-home-"));
  const proc = spawn("node", [server], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, KNITBRAIN_HOME: home },
  });
  try {
    const { rpc, notify } = makeClient(proc);

    const init = await rpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "e2e", version: "0" },
    });
    ok(init.result?.serverInfo?.name === "knitbrain", "initialize → serverInfo.name = knitbrain");
    notify("notifications/initialized");

    const list = await rpc("tools/list", {});
    const names = (list.result?.tools ?? []).map((t) => t.name);
    ok(names.includes("knitbrain_optimize"), "tools/list advertises knitbrain_optimize");
    ok(names.includes("knitbrain_retrieve"), "tools/list advertises knitbrain_retrieve");

    const pong = await rpc("tools/call", { name: "knitbrain_ping", arguments: {} });
    ok(text(pong).includes("pong"), "ping → pong");

    const payload = JSON.stringify(
      { items: Array.from({ length: 40 }, (_, i) => ({ i, blob: "z".repeat(60) })) },
      null,
      2,
    );
    const opt = await rpc("tools/call", { name: "knitbrain_optimize", arguments: { text: payload } });
    const optText = text(opt);
    ok(optText.length < payload.length, "optimize → skeleton smaller than original");
    const handle = optText.match(/⟨ccr:([0-9a-f]{64})⟩/)?.[1];
    ok(Boolean(handle), "optimize → returns a ⟨ccr:hash⟩ handle");

    const ret = await rpc("tools/call", { name: "knitbrain_retrieve", arguments: { handle } });
    ok(text(ret) === payload, "retrieve(handle) → recovers the exact original over stdio");
  } finally {
    proc.kill();
    rmSync(home, { recursive: true, force: true });
  }
}

async function pipelineOnRealFiles() {
  console.log("[e2e] Part 2 — unified compress() on real files (via dist)");
  const { createFileCCRStore } = await import(distUrl("ccr/store.js"));
  const { compress } = await import(distUrl("optimizer/router.js"));

  const root = mkdtempSync(join(tmpdir(), "knitbrain-e2e-"));
  const ccr = createFileCCRStore(root);

  const E = "/Users/piyushdua/engram";
  const targets = [
    `${ROOT}/package-lock.json`,
    `${ROOT}/src/optimizer/code.ts`,
    `${ROOT}/src/optimizer/types.ts`,
    `${E}/src/mcp/handlers.ts`,
    `${E}/src/engine/types.ts`,
    `${E}/package.json`,
  ].filter((p) => existsSync(p));

  let totalBefore = 0;
  let totalAfter = 0;
  try {
    for (const path of targets) {
      const original = readFileSync(path, "utf8");
      const r = compress(original, ccr);
      const neverExpands = r.skeletonTokens <= r.originalTokens;
      const lossless = r.compressed ? ccr.get(r.handle) === original : r.skeleton === original;
      totalBefore += r.originalTokens;
      totalAfter += r.skeletonTokens;
      const name = path.replace(E, "engram").replace(ROOT, "knit-brain");
      ok(neverExpands, `never-expands: ${name} (${r.contentType}, ${r.originalTokens}→${r.skeletonTokens} tok, saved ${r.savedPct}%${r.compressed ? "" : ", passthrough"})`);
      ok(lossless, `lossless: ${name}`);
    }
    const totalSaved = totalBefore === 0 ? 0 : Math.round((1 - totalAfter / totalBefore) * 1000) / 10;
    console.log(`[e2e] real-file TOTAL ${totalBefore} → ${totalAfter} tokens  saved=${totalSaved}%`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

await mcpSession();
await pipelineOnRealFiles();

console.log(failures === 0 ? "\n[e2e] PASS — built artifact works end-to-end on real input" : `\n[e2e] FAIL — ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
