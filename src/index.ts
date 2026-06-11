#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./server.js";
import { runSetup } from "./setup.js";

async function main(): Promise<void> {
  if (process.argv[2] === "setup") {
    process.exit(runSetup());
  }
  if (process.argv[2] === "hub") {
    const [{ createHub }, { knitbrainHome }, { join }] = await Promise.all([
      import("./hub/server.js"),
      import("./paths.js"),
      import("node:path"),
    ]);
    const { server, token } = createHub(join(knitbrainHome(), "hub"));
    const port = Number(process.env["KNITBRAIN_HUB_PORT"] ?? 8791);
    const host = process.env["KNITBRAIN_HUB_HOST"] ?? "127.0.0.1";
    server.listen(port, host, () => {
      console.log(`knitbrain hub → http://${host}:${port}`);
      console.log(`team token: ${token}`);
      console.log(`teammates join with:  knitbrain join http://<this-host>:${port} ${token} <name>`);
      if (host === "127.0.0.1") {
        console.log("(loopback only — set KNITBRAIN_HUB_HOST=0.0.0.0 to allow your team to reach it)");
      }
    });
    return;
  }
  if (process.argv[2] === "join") {
    const [url, token, member] = [process.argv[3], process.argv[4], process.argv[5] ?? "me"];
    if (!url || !token) {
      console.error("usage: knitbrain join <hub-url> <token> [member-name]");
      process.exit(1);
    }
    const { saveHubConfig } = await import("./hub/client.js");
    const path = saveHubConfig({ url, token, member });
    console.log(`joined hub ${url} as "${member}" (config: ${path})`);
    console.log("from now on, team_post mirrors to the hub automatically.");
    process.exit(0);
  }
  if (process.argv[2] === "profile") {
    const { runProfile } = await import("./profile.js");
    await runProfile(process.argv.slice(3));
    return;
  }
  if (process.argv[2] === "evals") {
    const { runEvals } = await import("./evals.js");
    const rep = await runEvals(process.argv.slice(3));
    process.exit(rep.pass ? 0 : 1);
  }
  if (process.argv[2] === "learn") {
    const { runLearn } = await import("./learn.js");
    await runLearn(process.argv.slice(3));
    return;
  }
  if (process.argv[2] === "dashboard") {
    const [{ createDashboardServer }, { createFileCCRStore }, { createKnowledge }, { createMemory }, { createFeedback }, { createSkillsStore }, { createTeamBoard }, { createMeter }, paths] =
      await Promise.all([
        import("./dashboard.js"),
        import("./ccr/store.js"),
        import("./engine/knowledge.js"),
        import("./engine/memory.js"),
        import("./engine/feedback.js"),
        import("./engine/skills.js"),
        import("./engine/teams.js"),
        import("./engine/meter.js"),
        import("./paths.js"),
      ]);
    const ccr = createFileCCRStore(paths.ccrRoot());
    const srv = createDashboardServer({
      ccr,
      memory: createMemory(paths.memoryRoot()),
      feedback: createFeedback(paths.feedbackRoot()),
      team: createTeamBoard(paths.teamRoot(), ccr),
      meter: createMeter(paths.meterRoot()),
      // Project scope: the directory the dashboard was started in.
      knowledge: createKnowledge(process.cwd(), paths.knowledgeRoot()),
      skills: createSkillsStore(paths.skillsRoot()),
    });
    const port = Number(process.env["KNITBRAIN_DASHBOARD_PORT"] ?? 8790);
    srv.listen(port, "127.0.0.1", () => {
      console.log(`knitbrain dashboard → http://127.0.0.1:${port}`);
    });
    return; // keep serving
  }
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err: unknown) => {
  console.error("[knitbrain] fatal:", err);
  process.exit(1);
});
