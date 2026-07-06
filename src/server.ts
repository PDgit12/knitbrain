import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createFileCCRStore, type CCRStore } from "./ccr/store.js";
import { createMemory, type Memory } from "./engine/memory.js";
import { createKnowledge, type Knowledge } from "./engine/knowledge.js";
import { createFeedback, type Feedback } from "./engine/feedback.js";
import { createTeamBoard, type TeamBoard } from "./engine/teams.js";
import { createMeter, type Meter } from "./engine/meter.js";
import { createSkillsStore, type SkillsStore } from "./engine/skills.js";
import { createCalibration, type Calibration } from "./engine/calibration.js";
import { createActivityLog, type ActivityLog } from "./engine/activity.js";
import { readSessionMark } from "./engine/receipt.js";
import { createWikiStore, type WikiStore } from "./engine/wiki.js";
import { currentContextTokens, currentContextModel } from "./engine/usage.js";
import { agentLabel } from "./mcp/host.js";
import { activityRoot, calibrationRoot, ccrRoot, feedbackRoot, knowledgeRoot, memoryRoot, meterRoot, skillsRoot, teamRoot, wikiRoot } from "./paths.js";
import { TOOLS, dispatch, type ToolContext } from "./mcp/tools.js";
import { INSTRUCTIONS } from "./mcp/instructions.js";
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
/** H3: conservative CCR retention run at server startup so the recall store
 * stays bounded. Hot entries idle >7d demote to cold; caps bound both tiers.
 * Lossless is preserved — demote gzips, purge only removes the least-retrieved
 * cold entries beyond the cap. */
const DEFAULT_MAINTAIN = { hotMaxAgeMs: 7 * 24 * 60 * 60 * 1000, hotMaxEntries: 2_000, coldMaxEntries: 10_000 };

export function buildServer(
  ccr: CCRStore = createFileCCRStore(ccrRoot()),
  memory: Memory = createMemory(memoryRoot()),
  knowledge: Knowledge = createKnowledge(process.cwd(), knowledgeRoot()),
  feedback: Feedback = createFeedback(feedbackRoot()),
  team: TeamBoard = createTeamBoard(teamRoot(), ccr),
  meter: Meter = createMeter(meterRoot(), { realUsage: () => currentContextTokens(), realModel: () => currentContextModel(), baselineTokens: 20_000 }),
  skills: SkillsStore = createSkillsStore(skillsRoot()),
  calibration: Calibration = createCalibration(calibrationRoot()),
  // protectSince: session-aware trim — the receipt needs the whole session's
  // events, so trim never eats lines newer than the live session mark.
  activity: ActivityLog = createActivityLog(activityRoot(), {
    protectSince: () => readSessionMark(meterRoot())?.startTs ?? null,
  }),
  wiki: WikiStore = createWikiStore(wikiRoot()),
): Server {
  const server = new Server(
    { name: SERVER_NAME, version: VERSION },
    // instructions ride the MCP handshake: every connected agent gets the
    // operating protocol with ZERO per-project file setup.
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );
  // agentId is set per-call from the MCP handshake + env (zero-setup platform +
  // billing detection); see the CallTool handler below.
  const ctx: ToolContext = { ccr, memory, knowledge, feedback, team, meter, skills, calibration, activity, wiki };

  // H3: run the CCR janitor once at startup. Every tool output puts a permanent
  // file; without this the store grows without bound (maintain had no prod
  // caller). Best-effort — a maintenance failure must never block server boot.
  try {
    ccr.maintain(DEFAULT_MAINTAIN);
  } catch {
    /* janitor is best-effort — never block startup on it */
  }

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
      // Zero-setup: label the agent by the connected client + its billing mode.
      ctx.agentId = agentLabel(server.getClientVersion()?.name, process.env);
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
