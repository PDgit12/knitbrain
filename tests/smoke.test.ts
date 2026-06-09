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
    );
    expect(server).toBeDefined();
  });

  it("advertises a semver version", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("has a stable server name", () => {
    expect(SERVER_NAME).toBe("knitbrain");
  });
});
