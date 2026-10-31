import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/server.js";
import { projectRoot } from "../src/paths.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { pathToFileURL } from "node:url";

describe("MCP launch directory differs from the configured project", () => {
  let temp: string, project: string;
  beforeEach(() => {
    temp = mkdtempSync(join(tmpdir(), "kb-project-root-")); project = join(temp, "repo"); mkdirSync(project);
    writeFileSync(join(project, "sample.ts"), "export function projectSpecificHelper() { return 42; }\n");
    vi.stubEnv("KNITBRAIN_PROJECT_DIR", project); vi.stubEnv("KNITBRAIN_HOME", join(temp, "state"));
  });
  afterEach(() => { vi.unstubAllEnvs(); rmSync(temp, { recursive: true, force: true }); });
  it("binds search, relative reading and verify execution to the same project over MCP", async () => {
    expect(projectRoot()).toBe(realpathSync(project));
    const server = buildServer(); const client = new Client({ name: "root-regression", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const call = async (name: string, args: Record<string, unknown>) => {
      const out = await client.callTool({ name, arguments: args });
      expect(out.isError).not.toBe(true);
      return (out.content as Array<{ type: string; text?: string }>).filter((c) => c.type === "text").map((c) => c.text).join("\n");
    };
    try {
      expect(await call("knitbrain_search_code", { query: "projectSpecificHelper" })).toContain("sample.ts");
      expect(await call("knitbrain_read", { path: "sample.ts" })).toContain("projectSpecificHelper");
      const result = JSON.parse(await call("knitbrain_run_loop", { goal: "verify the configured project", verify_cmd: 'node -e "require(\'fs\').writeFileSync(\'verified-root\',\'yes\')"' }));
      expect(result.met).toBe(true); expect(readFileSync(join(project, "verified-root"), "utf8")).toBe("yes");
    } finally { await Promise.all([client.close(), server.close()]); }
  });
  it("reports a missing project binding before scanning a home directory", async () => {
    vi.stubEnv("KNITBRAIN_PROJECT_DIR", homedir());
    const server = buildServer(); const client = new Client({ name: "home-root-regression", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(b), client.connect(a)]);
    try {
      const result = await client.callTool({ name: "knitbrain_search_code", arguments: { query: "helper" } });
      expect(result.isError).toBe(true); expect(JSON.stringify(result.content)).toContain("Project root required");
    } finally { await Promise.all([client.close(), server.close()]); }
  });
  it("autodetects a single advertised client root without a fixed global project binding", async () => {
    vi.stubEnv("KNITBRAIN_PROJECT_DIR", ""); vi.stubEnv("CLAUDE_PROJECT_DIR", ""); vi.stubEnv("CURSOR_PROJECT_DIR", "");
    const server = buildServer();
    const client = new Client({ name: "root-discovery", version: "1" }, { capabilities: { roots: { listChanged: true } } });
    client.setRequestHandler(ListRootsRequestSchema, () => ({ roots: [{ uri: pathToFileURL(project).href, name: "project" }] }));
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(b), client.connect(a)]);
    try {
      const result = await client.callTool({ name: "knitbrain_search_code", arguments: { query: "projectSpecificHelper" } });
      expect(result.isError).not.toBe(true); expect(JSON.stringify(result.content)).toContain("sample.ts");
    } finally { await Promise.all([client.close(), server.close()]); }
  });
  it("requires explicit selection for multiple advertised roots and blocks project writes", async () => {
    vi.stubEnv("KNITBRAIN_PROJECT_DIR", ""); vi.stubEnv("CLAUDE_PROJECT_DIR", ""); vi.stubEnv("CURSOR_PROJECT_DIR", "");
    const server = buildServer();
    const client = new Client({ name: "multi-root", version: "1" }, { capabilities: { roots: {} } });
    client.setRequestHandler(ListRootsRequestSchema, () => ({ roots: [{ uri: pathToFileURL(project).href }, { uri: pathToFileURL(temp).href }] }));
    const [a, b] = InMemoryTransport.createLinkedPair(); await Promise.all([server.connect(b), client.connect(a)]);
    try {
      const result = await client.callTool({ name: "knitbrain_record_learning", arguments: { summary: "x", lesson: "x" } });
      expect(result.isError).toBe(true); expect(JSON.stringify(result.content)).toContain("multiple workspace roots");
    } finally { await Promise.all([client.close(), server.close()]); }
  });
});
