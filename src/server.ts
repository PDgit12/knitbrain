import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  RootsListChangedNotificationSchema,
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
import { activityRoot, calibrationRoot, ccrRoot, feedbackRoot, knowledgeRoot, memoryRoot, meterRoot, skillsRoot, teamRoot, wikiRoot, projectRoot } from "./paths.js";
import { TOOLS, dispatch, validateToolArgs, type ToolContext } from "./mcp/tools.js";
import { INSTRUCTIONS } from "./mcp/instructions.js";
import { SERVER_NAME, VERSION } from "./version.js";
import { homedir } from "node:os";
import { realpathSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT_OPTIONAL = new Set(["knitbrain_ping", "knitbrain_read", "knitbrain_optimize", "knitbrain_retrieve"]);

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
  knowledge: Knowledge = createKnowledge(projectRoot(), knowledgeRoot()),
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
  const automaticContext = arguments.length === 0;
  const server = new Server(
    { name: SERVER_NAME, version: VERSION },
    // instructions ride the MCP handshake: every connected agent gets the
    // operating protocol with ZERO per-project file setup.
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );
  // agentId is set per-call from the MCP handshake + env (zero-setup platform +
  // billing detection); see the CallTool handler below.
  let ctx: ToolContext = { ccr, memory, knowledge, feedback, team, meter, skills, calibration, activity, wiki, projectRoot: projectRoot() };
  let rootReady: Promise<void> = Promise.resolve();
  let rootError: string | undefined;
  const discoverRoots = async () => {
    const explicit = ["KNITBRAIN_PROJECT_DIR", "CLAUDE_PROJECT_DIR", "CURSOR_PROJECT_DIR"].some((key) => process.env[key]?.trim());
    if (!automaticContext || explicit || !server.getClientCapabilities()?.roots) return;
    try {
      const result = await server.listRoots(undefined, { timeout: 5000 });
      if (result.roots.length !== 1) {
        rootError = "Project root required: client reported zero or multiple workspace roots. Set KNITBRAIN_PROJECT_DIR explicitly; no workspace was guessed.";
        return;
      }
      const root = realpathSync(fileURLToPath(result.roots[0]!.uri));
      if (!statSync(root).isDirectory()) throw new Error("workspace root is not a directory");
      if (root === ctx.projectRoot) { rootError = undefined; return; }
      // Rebind all typed stores together, without changing process-wide env.
      const scopedMeter = createMeter(meterRoot(root), { baselineTokens: 20_000 });
      ctx = { ...ctx,
        projectRoot: root, memory: createMemory(memoryRoot(root)), knowledge: createKnowledge(root, knowledgeRoot(root)),
        feedback: createFeedback(feedbackRoot(root)), team: createTeamBoard(teamRoot(root), ccr), meter: scopedMeter,
        skills: createSkillsStore(skillsRoot(root)), calibration: createCalibration(calibrationRoot(root)),
        activity: createActivityLog(activityRoot(root), { protectSince: () => readSessionMark(meterRoot(root))?.startTs ?? null }), wiki: createWikiStore(wikiRoot(root)),
      };
      rootError = undefined;
    } catch {
      rootError = "Project root discovery failed: configure KNITBRAIN_PROJECT_DIR explicitly and reconnect; no home-directory scan was attempted.";
    }
  };
  server.oninitialized = () => { rootReady = discoverRoots(); };
  server.setNotificationHandler(RootsListChangedNotificationSchema, () => { rootReady = rootReady.then(discoverRoots); });

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

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    await rootReady;
    const tool = TOOLS.find((t) => t.name === req.params.name);
    if (!tool) {
      return {
        content: [{ type: "text", text: `Unknown tool: ${req.params.name}` }],
        isError: true,
      };
    }
    const invalid = validateToolArgs(tool, req.params.arguments ?? {});
    if (invalid) return { content: [{ type: "text", text: `Invalid arguments: ${invalid}` }], isError: true };
    if (!ROOT_OPTIONAL.has(tool.name) && (rootError || ctx.projectRoot === realpathSync(homedir()))) {
      return { content: [{ type: "text", text: rootError ?? "Project root required: refusing to scan your entire home directory. Run knitbrain setup from the intended repository, set KNITBRAIN_PROJECT_DIR in its MCP configuration, and reconnect the client. Direct absolute-path reads remain available." }], isError: true };
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
