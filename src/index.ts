#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./server.js";
import { runSetup } from "./setup.js";

/** Compact token count for the statusline: 12.4k / 1.2M. */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

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
  if (process.argv[2] === "wrap") {
    const { runWrap } = await import("./wrap.js");
    process.exit(await runWrap(process.argv.slice(3)));
  }
  if (process.argv[2] === "help" || process.argv[2] === "--help" || process.argv[2] === "-h") {
    console.log(`knitbrain — the local-first brain for coding agents

usage: knitbrain <command>

  setup        one-click integration for your platform(s) (MCP, hooks, rules, slash commands)
  profile      measure savings on YOUR real transcripts (run before installing anything)
  wrap <agent> launch claude/codex/aider/copilot with the optimizer proxy wired in
  evals        answer-preservation gates on your transcripts (exit 1 on failure)
  learn        mine past sessions for failure→success corrections (--apply writes CLAUDE.md)
  compress <f> terse-rewrite a memory file (CLAUDE.md) to cut input tokens; keeps <f>.original
  loop <goal>  autonomous loop: drive an agent through a checkbox goal file until done (--max, --verify, --interactive)
  fan <goal>   PARALLEL loop: N workers drain a checkbox queue concurrently, isolated in git worktrees (--workers, --verify, --max)
  dashboard    live local dashboard (127.0.0.1:8790)
  prompt       print the full operating prompt (for platforms without MCP instructions)
  terse [lvl]  print terse-output instruction (lite|full|ultra) — paste, or /terse in Claude Code
  statusline   print the tokens-saved badge for your editor's statusline (KNITBRAIN_STATUSLINE=0 silences)
  hub          start the team hub (host runs once; teammates join)
  join         join a team hub: knitbrain join <url> <token> <name>
  help         this message

  (no command) start the MCP server on stdio — this is what your editor invokes`);
    return;
  }
  if (process.argv[2] === "prompt") {
    const { INSTRUCTIONS } = await import("./mcp/instructions.js");
    console.log("# knitbrain — full operating prompt (paste into your platform's system prompt / rules)");
    console.log("");
    console.log(INSTRUCTIONS);
    console.log("");
    console.log("NOTATION: a ⟨recall:HASH⟩ marker in any output means the exact original is stored locally —");
    console.log("call knitbrain_retrieve with that hash to read it byte-for-byte. Compression is lossless.");
    return;
  }
  if (process.argv[2] === "statusline") {
    // Runs on every prompt render — must be fast and NEVER throw (a crashing
    // statusline command breaks the editor's prompt line).
    if (process.env["KNITBRAIN_STATUSLINE"] === "0") return;
    try {
      const [{ createMeter }, paths] = await Promise.all([
        import("./engine/meter.js"),
        import("./paths.js"),
      ]);
      const saved = createMeter(paths.meterRoot()).read().savedTokens;
      if (saved > 0) process.stdout.write(`[knitbrain] saved ${fmtTokens(saved)}`);
    } catch {
      /* statusline must never break the prompt */
    }
    return;
  }
  if (process.argv[2] === "terse") {
    const { terseGuide } = await import("./platforms.js");
    const lvl = process.argv[3];
    console.log(terseGuide(lvl === "lite" || lvl === "ultra" ? lvl : "full"));
    return;
  }
  if (process.argv[2] === "evals") {
    const { runEvals } = await import("./evals.js");
    const rep = await runEvals(process.argv.slice(3));
    process.exit(rep.pass ? 0 : 1);
  }
  if (process.argv[2] === "compress") {
    const { runCompressFile } = await import("./compress-file.js");
    process.exit(runCompressFile(process.argv.slice(3)));
  }
  if (process.argv[2] === "loop") {
    const { runLoop } = await import("./loop.js");
    process.exit(await runLoop(process.argv.slice(3)));
  }
  if (process.argv[2] === "fan") {
    const { runFan } = await import("./fan.js");
    process.exit(await runFan(process.argv.slice(3)));
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
    const { readProjectUsage } = await import("./engine/usage.js");
    const { fetchPlatformQuota } = await import("./engine/quota.js");
    const { createActivityLog } = await import("./engine/activity.js");
    const activityLog = createActivityLog(paths.activityRoot());
    const srv = createDashboardServer({
      ccr,
      memory: createMemory(paths.memoryRoot()),
      feedback: createFeedback(paths.feedbackRoot()),
      team: createTeamBoard(paths.teamRoot(), ccr),
      meter: createMeter(paths.meterRoot()),
      // Project scope: the directory the dashboard was started in.
      knowledge: createKnowledge(process.cwd(), paths.knowledgeRoot()),
      skills: createSkillsStore(paths.skillsRoot()),
      // Real platform token usage from the host's transcripts (live per request).
      usage: () => readProjectUsage(process.cwd()),
      // Live subscription window (Pro/Max) when a provider usage source exists.
      quota: () => fetchPlatformQuota(),
      // Live agent-activity feed (the CRM view).
      activity: () => activityLog.recent(30),
      // Per-agent optimization rollup — universal meter across all platforms.
      agents: () => activityLog.rollup(),
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
