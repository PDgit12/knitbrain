import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

/** Single source of truth for the server version. */
export const VERSION = "0.0.0";

/** Server identity advertised at the MCP handshake. */
export const SERVER_NAME = "knitbrain";

/**
 * Build the Knit Brain MCP server.
 *
 * Rung 0 (scaffold): exposes a single `knitbrain_ping` health-check tool so the
 * MCP wiring is exercised end-to-end. Real tools land at later rungs.
 */
export function buildServer(): Server {
  const server = new Server(
    { name: SERVER_NAME, version: VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [
      {
        name: "knitbrain_ping",
        description: "Health check — returns pong and the server version.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, (req) => {
    if (req.params.name === "knitbrain_ping") {
      return {
        content: [
          { type: "text", text: `pong · ${SERVER_NAME} v${VERSION}` },
        ],
      };
    }
    throw new Error(`Unknown tool: ${req.params.name}`);
  });

  return server;
}
