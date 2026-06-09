/**
 * End-to-end check of the BUILT artifact (dist/):
 *   1. spawn the MCP server, drive a real stdio handshake (initialize →
 *      tools/list → tools/call), assert correct responses.
 *   2. run the compression pipeline on REAL files, asserting byte-for-byte
 *      CCR recovery and reporting real token savings.
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

// ───────────────────────── Part 1: live MCP server ─────────────────────────
async function mcpHandshake() {
  console.log("[e2e] Part 1 — live MCP server over stdio");
  const server = join(ROOT, "dist", "index.js");
  ok(existsSync(server), "built server artifact exists (dist/index.js)");

  const proc = spawn("node", [server], { stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  proc.stdout.on("data", (d) => (out += d.toString()));

  const send = (obj) => proc.stdin.write(JSON.stringify(obj) + "\n");
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e", version: "0" } } });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "knitbrain_ping", arguments: {} } });

  await new Promise((r) => setTimeout(r, 600));
  proc.stdin.end();
  proc.kill();

  const lines = out.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const byId = (id) => lines.find((m) => m.id === id);
  ok(byId(1)?.result?.serverInfo?.name === "knitbrain", "initialize returns serverInfo.name = knitbrain");
  ok(Array.isArray(byId(2)?.result?.tools), "tools/list returns a tools array");
  ok(byId(2)?.result?.tools?.some((t) => t.name === "knitbrain_ping"), "knitbrain_ping is advertised");
  const callText = byId(3)?.result?.content?.[0]?.text ?? "";
  ok(callText.includes("pong"), `tools/call knitbrain_ping returns pong (got: "${callText}")`);
}

// ──────────────────── Part 2: pipeline on REAL files ───────────────────────
async function pipelineOnRealFiles() {
  console.log("[e2e] Part 2 — unified compress() on real files (via dist)");
  const { createFileCCRStore } = await import(distUrl("ccr/store.js"));
  const { compress } = await import(distUrl("optimizer/router.js"));

  const root = mkdtempSync(join(tmpdir(), "knitbrain-e2e-"));
  const ccr = createFileCCRStore(root);

  const E = "/Users/piyushdua/engram";
  const targets = [
    // Always-present repo-local files (portable):
    `${ROOT}/package-lock.json`,
    `${ROOT}/src/optimizer/code.ts`,
    `${ROOT}/src/optimizer/types.ts`,
    // Real-world engram files when available on this machine:
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

      // INVARIANT 1: never expand.
      const neverExpands = r.skeletonTokens <= r.originalTokens;
      // INVARIANT 2: lossless — when compressed, recover byte-for-byte.
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

await mcpHandshake();
await pipelineOnRealFiles();

console.log(failures === 0 ? "\n[e2e] PASS — built artifact works end-to-end on real input" : `\n[e2e] FAIL — ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
