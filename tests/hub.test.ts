import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Server } from "node:http";
import { createHub } from "../src/hub/server.js";
import { mirrorToHub, fetchHubBoard, type HubConfig } from "../src/hub/client.js";

const listen = (s: Server): Promise<number> =>
  new Promise((r) => s.listen(0, "127.0.0.1", () => r((s.address() as { port: number }).port)));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("team hub (rung 18)", () => {
  let root: string;
  let server: Server;
  let token: string;
  let url: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "knitbrain-hub-"));
    const hub = createHub(join(root, "hub"));
    server = hub.server;
    token = hub.token;
    url = `http://127.0.0.1:${await listen(server)}`;
  });
  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(root, { recursive: true, force: true });
  });

  it("health is open; everything else requires the token", async () => {
    expect((await fetch(`${url}/health`)).status).toBe(200);
    expect((await fetch(`${url}/board`)).status).toBe(401);
    expect(
      (await fetch(`${url}/board`, { headers: { authorization: "Bearer wrong" } })).status,
    ).toBe(401);
  });

  it("post → list (summaries only) → fetch full original by id", async () => {
    const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const original = JSON.stringify({ finding: "x".repeat(500) });
    const post = await fetch(`${url}/board`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ author: "alice", summary: "skeleton", original }),
    });
    const { id } = (await post.json()) as { id: string };
    expect(id).toMatch(/^[0-9a-f]{8}$/);

    const list = (await (await fetch(`${url}/board`, { headers: auth })).json()) as Array<Record<string, unknown>>;
    expect(list.length).toBe(1);
    expect(list[0]!["original"]).toBeUndefined(); // summaries only on the list

    const full = (await (await fetch(`${url}/board/${id}`, { headers: auth })).json()) as { original: string };
    expect(full.original).toBe(original); // full original recoverable by any teammate
  });

  it("token persists across hub restarts (same root)", async () => {
    const again = createHub(join(root, "hub"));
    expect(again.token).toBe(token);
  });

  it("client mirror lands on the hub; fetchHubBoard reads it back", async () => {
    const cfg: HubConfig = { url, token, member: "bob" };
    mirrorToHub(cfg, { author: "ignored", summary: "from bob", original: "full content here" });
    await sleep(300); // fire-and-forget — give it a beat
    const board = await fetchHubBoard(cfg);
    expect(board.length).toBe(1);
    expect(board[0]!.author).toBe("bob"); // member name wins
  });

  it("a dead hub never throws or blocks the client", async () => {
    const cfg: HubConfig = { url: "http://127.0.0.1:1", token: "x", member: "bob" };
    expect(() => mirrorToHub(cfg, { author: "a", summary: "s", original: "o" })).not.toThrow();
    expect(await fetchHubBoard(cfg, 300)).toEqual([]); // graceful empty
  });

  it("token is high-entropy and stored 0600 (how the team secret is created)", async () => {
    expect(token).toMatch(/^khub_[0-9a-f]{48}$/); // 24 random bytes → 192 bits
    // Unix file modes only — Windows has no POSIX perms (reports 0o666), so
    // the 0600 guarantee is Unix-only; the entropy guarantee holds everywhere.
    if (process.platform !== "win32") {
      const { statSync } = await import("node:fs");
      const mode = statSync(join(root, "hub", "token.txt")).mode & 0o777;
      expect(mode).toBe(0o600); // owner-only
    }
  });

  it("append-only board: many posts persist in order (O(1) per post)", async () => {
    const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    for (let i = 0; i < 25; i++) {
      await fetch(`${url}/board`, { method: "POST", headers: auth, body: JSON.stringify({ author: `u${i}`, original: `finding ${i}` }) });
    }
    const list = (await (await fetch(`${url}/board`, { headers: auth })).json()) as Array<{ author: string }>;
    expect(list.length).toBe(25);
    expect(list[0]!.author).toBe("u0"); // append order preserved
    expect(list[24]!.author).toBe("u24");
  });

  it("rejects an oversized body (no authenticated memory-exhaustion vector)", async () => {
    const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const huge = "x".repeat(1_200_000); // > 1MB cap
    const res = await fetch(`${url}/board`, { method: "POST", headers: auth, body: JSON.stringify({ author: "a", original: huge }) });
    expect(res.status).toBeGreaterThanOrEqual(400); // refused, not accepted
    const list = (await (await fetch(`${url}/board`, { headers: auth })).json()) as unknown[];
    expect(list.length).toBe(0); // nothing persisted
  });

  it("migrates a legacy board.json into the JSONL log once", async () => {
    const { writeFileSync, existsSync, mkdirSync } = await import("node:fs");
    const root2 = mkdtempSync(join(tmpdir(), "knitbrain-hub-legacy-"));
    const hubDir = join(root2, "hub");
    mkdirSync(hubDir, { recursive: true });
    writeFileSync(
      join(hubDir, "board.json"),
      JSON.stringify([{ id: "abcd1234", author: "legacy", summary: "old", original: "old finding", ts: "2026-01-01T00:00:00Z" }]),
    );
    const legacyHub = createHub(hubDir);
    const port = await listen(legacyHub.server);
    try {
      expect(existsSync(join(hubDir, "board.jsonl"))).toBe(true);
      const list = (await (await fetch(`http://127.0.0.1:${port}/board`, { headers: { authorization: `Bearer ${legacyHub.token}` } })).json()) as Array<{ author: string }>;
      expect(list[0]!.author).toBe("legacy");
    } finally {
      await new Promise<void>((r) => legacyHub.server.close(() => r()));
      rmSync(root2, { recursive: true, force: true });
    }
  });
});
