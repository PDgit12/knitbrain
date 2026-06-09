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
});
