#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./server.js";
import { runSetup } from "./setup.js";

async function main(): Promise<void> {
  if (process.argv[2] === "setup") {
    process.exit(runSetup());
  }
  if (process.argv[2] === "dashboard") {
    const [{ createDashboardServer }, { createFileCCRStore }, { createMemory }, { createFeedback }, { createTeamBoard }, { createMeter }, paths] =
      await Promise.all([
        import("./dashboard.js"),
        import("./ccr/store.js"),
        import("./engine/memory.js"),
        import("./engine/feedback.js"),
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
