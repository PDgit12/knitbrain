#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./server.js";
import { runSetup } from "./setup.js";

async function main(): Promise<void> {
  if (process.argv[2] === "setup") {
    process.exit(runSetup());
  }
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err: unknown) => {
  console.error("[knitbrain] fatal:", err);
  process.exit(1);
});
