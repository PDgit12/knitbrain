import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Server } from "node:http";
import { createFileCCRStore } from "../src/ccr/store.js";
import { createMemory } from "../src/engine/memory.js";
import { createFeedback } from "../src/engine/feedback.js";
import { createTeamBoard } from "../src/engine/teams.js";
import { createMeter } from "../src/engine/meter.js";
import { createDashboardServer, dashboardState, type DashboardDeps } from "../src/dashboard.js";

describe("dashboard (rung 17)", () => {
  let root: string;
  let deps: DashboardDeps;
  let srv: Server | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "knitbrain-dash-"));
    const ccr = createFileCCRStore(join(root, "ccr"));
    deps = {
      ccr,
      memory: createMemory(join(root, "mem")),
      feedback: createFeedback(join(root, "fb")),
      team: createTeamBoard(join(root, "team"), ccr),
      meter: createMeter(join(root, "meter")),
    };
  });
  afterEach(async () => {
    if (srv) await new Promise<void>((r) => srv!.close(() => r()));
    rmSync(root, { recursive: true, force: true });
  });

  it("state snapshot reflects real store contents", () => {
    deps.memory.recordLearning({ summary: "dash test", lesson: "x" });
    deps.team.post("alice", "a finding about the proxy");
    deps.meter.onToolOutput(1234);
    const s = dashboardState(deps);
    expect((s["meter"] as { usedTokens: number }).usedTokens).toBe(1234);
    expect(s["learnings"]).toBe(1);
    expect((s["board"] as unknown[]).length).toBe(1);
  });

  it("serves the page and the JSON API over HTTP", async () => {
    srv = createDashboardServer(deps);
    const port: number = await new Promise((r) =>
      srv!.listen(0, "127.0.0.1", () => r((srv!.address() as { port: number }).port)),
    );
    const page = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    expect(page).toContain("knitbrain — live");
    const api = (await (await fetch(`http://127.0.0.1:${port}/api/state`)).json()) as {
      meter: { status: string };
    };
    expect(api.meter.status).toBe("ok");
  });
});
