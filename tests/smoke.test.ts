import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer, VERSION, SERVER_NAME } from "../src/server.js";
import { createFileCCRStore } from "../src/ccr/store.js";
import { createMemory } from "../src/engine/memory.js";
import { createKnowledge } from "../src/engine/knowledge.js";
import { createFeedback } from "../src/engine/feedback.js";
import { createTeamBoard } from "../src/engine/teams.js";
import { createMeter } from "../src/engine/meter.js";
import { createSkillsStore } from "../src/engine/skills.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

describe("knitbrain server (rung 0/6)", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "knitbrain-smoke-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("builds an MCP server without throwing", () => {
    const server = buildServer(
      createFileCCRStore(root),
      createMemory(join(root, "mem")),
      createKnowledge(root, join(root, "kn")),
      createFeedback(join(root, "fb")),
      createTeamBoard(join(root, "team"), createFileCCRStore(root)),
      createMeter(join(root, "meter")),
      createSkillsStore(join(root, "skills")),
    );
    expect(server).toBeDefined();
  });

  it("rejects missing required tool arguments at the MCP boundary", async () => {
    const server = buildServer(
      createFileCCRStore(join(root, "ccr")),
      createMemory(join(root, "mem")),
      createKnowledge(root, join(root, "kn")),
      createFeedback(join(root, "fb")),
      createTeamBoard(join(root, "team"), createFileCCRStore(join(root, "ccr"))),
      createMeter(join(root, "meter")),
      createSkillsStore(join(root, "skills")),
    );
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({ name: "knitbrain_optimize", arguments: {} });
      expect(result.isError).toBe(true);
      expect(result.content).toEqual(expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining("requires argument `text`") })]));
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });

  it("advertises a semver version", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("has a stable server name", () => {
    expect(SERVER_NAME).toBe("knitbrain");
  });
});
