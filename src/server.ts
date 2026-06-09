import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createFileCCRStore, type CCRStore } from "./ccr/store.js";
import { createMemory, type Memory } from "./engine/memory.js";
import { createKnowledge, type Knowledge } from "./engine/knowledge.js";
import { createFeedback, type Feedback } from "./engine/feedback.js";
import { ccrRoot, feedbackRoot, knowledgeRoot, memoryRoot } from "./paths.js";
import { TOOLS, dispatch, type ToolContext } from "./mcp/tools.js";
import { SERVER_NAME, VERSION } from "./version.js";

export { VERSION, SERVER_NAME } from "./version.js";

/**
 * Build the Knit Brain MCP server. Every tool result flows through the ONE
 * dispatch chokepoint, where data outputs are compressed (original preserved
 * in CCR) and governance/verbatim outputs pass through untouched.
 *
 * @param ccr injectable store (tests pass a temp store; default is the
 *            local-first store under ~/.knitbrain/ccr).
 */
export function buildServer(
  ccr: CCRStore = createFileCCRStore(ccrRoot()),
  memory: Memory = createMemory(memoryRoot()),
  knowledge: Knowledge = createKnowledge(process.cwd(), knowledgeRoot()),
  feedback: Feedback = createFeedback(feedbackRoot()),
): Server {
  const server = new Server(
    { name: SERVER_NAME, version: VERSION },
    { capabilities: { tools: {} } },
  );
  const ctx: ToolContext = { ccr, memory, knowledge, feedback };

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, (req) => {
    const tool = TOOLS.find((t) => t.name === req.params.name);
    if (!tool) {
      return {
        content: [{ type: "text", text: `Unknown tool: ${req.params.name}` }],
        isError: true,
      };
    }
    try {
      const text = dispatch(tool, req.params.arguments ?? {}, ctx);
      return { content: [{ type: "text", text }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  });

  return server;
}
