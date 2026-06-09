import { describe, it, expect } from "vitest";
import { buildServer, VERSION, SERVER_NAME } from "../src/server.js";

describe("knitbrain scaffold (rung 0)", () => {
  it("builds an MCP server without throwing", () => {
    const server = buildServer();
    expect(server).toBeDefined();
  });

  it("advertises a semver version", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("has a stable server name", () => {
    expect(SERVER_NAME).toBe("knitbrain");
  });
});
