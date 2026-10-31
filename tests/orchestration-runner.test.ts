import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOffice, requestOfficeCancel } from "../src/orchestration-runner.js";
import { runOrchestrate } from "../src/orchestration-cli.js";
import { openRun } from "../src/orchestrator.js";

describe("domain office integration", () => {
  let temp: string, root: string, runDir: string, serial: number;
  beforeEach(() => { temp = mkdtempSync(join(tmpdir(), "kb-office-")); root = join(temp, "project"); mkdirSync(root); runDir = join(temp, "run"); serial = 0; });
  afterEach(() => { vi.unstubAllEnvs(); rmSync(temp, { recursive: true, force: true }); });
  function script(source: string): string {
    const path = join(temp, `command-${serial++}.cjs`); writeFileSync(path, source);
    return `node "${path}"`;
  }
  const ok = () => script("process.exit(0)");
  const fail = () => script("console.error('gate red');process.exit(1)");
  function plan(agent: string, verify: string) {
    return { version: 1, id: "office-test", goal: "deliver verified office artifacts", workspaceMode: "serial", maxConcurrency: 3,
      domains: [{ id: "core", workers: 2 }, { id: "hooks", workers: 1 }], commandTimeoutMs: 3000, retryDelayMs: 0,
      verify: ok(), tasks: [{ id: "a", domainId: "core", goal: "produce a verified artifact", agent, verify, maxAttempts: 3 }] };
  }

  it("repeats independent worker cycles until the real gate passes and persists evidence", async () => {
    const agent = script("const f=require('fs');let n=f.existsSync('attempts')?+f.readFileSync('attempts'):0;f.writeFileSync('attempts',String(n+1))");
    const verify = script("process.exit(+require('fs').readFileSync('attempts')>=2?0:1)");
    const state = await runOffice(plan(agent, verify), { root, runDir });
    expect(state.status).toBe("succeeded"); expect(state.tasks.a!.attempts).toBe(2);
    const events = readFileSync(join(runDir, "events.jsonl"), "utf8");
    expect(events).toContain('"type":"retry"'); expect(events).toContain('"type":"parent_gate"');
  });

  it("uses an explicit fallback command after a confirmed failure, retaining the same gate", async () => {
    const fallback = script("require('fs').writeFileSync('artifact','ok')");
    const p = plan(fail(), script("process.exit(require('fs').existsSync('artifact')?0:1)"));
    Object.assign(p.tasks[0]!, { fallbackAgents: [fallback] });
    const result = await runOffice(p, { root, runDir });
    expect(result.status).toBe("succeeded"); expect(result.tasks.a!.attempts).toBe(1);
    expect(readFileSync(join(runDir, "events.jsonl"), "utf8")).toContain('"type":"fallback"');
  });

  it("delivers a cross-domain verified handoff before a dependent worker starts", async () => {
    const p = plan(script("require('fs').writeFileSync('a','ready')"), script("process.exit(require('fs').existsSync('a')?0:1)"));
    p.tasks.push({ id: "b", domainId: "hooks", goal: "consume upstream handoff", agent: script("let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{if(!s.includes('Task a passed its local gates'))process.exit(1);require('fs').writeFileSync('b','ready')})"), verify: script("process.exit(require('fs').existsSync('b')?0:1)"), maxAttempts: 1, ...{ dependsOn: ["a"] } });
    const result = await runOffice(p, { root, runDir });
    expect(result.status).toBe("succeeded"); expect(result.tasks.b!.attempts).toBe(1);
  });

  it("blocks on an exhausted child without running a dependent or declaring parent success", async () => {
    const p = plan(ok(), fail()); p.tasks[0]!.maxAttempts = 1;
    p.tasks.push({ ...p.tasks[0]!, id: "b", ...{ dependsOn: ["a"] } });
    const result = await runOffice(p, { root, runDir });
    expect(result.status).toBe("blocked"); expect(result.tasks.b!.attempts).toBe(0);
  });

  it("requires parent verification after child success, and rechecks gates on resume", async () => {
    const p = plan(script("require('fs').writeFileSync('child','ready')"), script("process.exit(require('fs').existsSync('child')?0:1)"));
    p.verify = script("process.exit(require('fs').existsSync('integrated')?0:1)");
    const first = await runOffice(p, { root, runDir });
    expect(first.tasks.a!.status).toBe("succeeded"); expect(first.status).toBe("blocked");
    writeFileSync(join(root, "integrated"), "ready");
    const second = await runOffice(p, { root, runDir });
    expect(second.status).toBe("succeeded"); expect(second.tasks.a!.attempts).toBe(1);
  });

  it("cancels a running worker without launching a configured fallback", async () => {
    const p = plan(script("setInterval(()=>{},1000)"), ok());
    Object.assign(p.tasks[0]!, { fallbackAgents: [script("require('fs').writeFileSync('unexpected','bad')")] });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 250);
    try {
      const state = await runOffice(p, { root, runDir, signal: controller.signal });
      expect(state.status).toBe("cancelled"); expect(existsSync(join(root, "unexpected"))).toBe(false);
    } finally { clearTimeout(timer); }
  }, 10_000);

  it("blocks worktree failure without touching the canonical workspace", async () => {
    const p = { ...plan(script("require('fs').writeFileSync('unexpected','bad')"), ok()), workspaceMode: "isolated", integrate: ok() };
    const state = await runOffice(p, { root, runDir });
    expect(state.status).toBe("blocked"); expect(state.parentError).toContain("worktree setup failed");
    expect(existsSync(join(root, "unexpected"))).toBe(false);
  });

  it("supports CLI validation/status/cancellation without claiming a live connection", async () => {
    const path = join(root, "office.json"); writeFileSync(path, JSON.stringify(plan(ok(), ok())));
    expect(await runOrchestrate(["validate", path])).toBe(0);
    expect(await runOrchestrate(["start", path, "--run-dir", runDir, "--root", root])).toBe(0);
    expect(await runOrchestrate(["status", runDir])).toBe(0);
    requestOfficeCancel(runDir); expect(existsSync(join(runDir, "cancel.json"))).toBe(true);
    expect(await runOrchestrate(["message", runDir, "all", "office ready"])).toBe(0);
  });

  it("fairly admits another domain when the first task retries indefinitely with zero delay", async () => {
    const p = plan(ok(), script("process.exit(require('fs').existsSync('unblock')?0:1)"));
    Object.assign(p.tasks[0]!, { maxAttempts: null });
    p.tasks.push({ id: "b", domainId: "hooks", goal: "provide the dependency unblock artifact", agent: script("require('fs').writeFileSync('unblock','ready')"), verify: ok(), maxAttempts: 1 });
    const result = await runOffice({ ...p, deadlineMs: 5000 }, { root, runDir });
    expect(result.status).toBe("succeeded"); expect(result.tasks.a!.attempts).toBe(2); expect(result.tasks.b!.attempts).toBe(1);
  }, 10_000);

  it("reintegrates changed isolated artifacts after resuming a previously successful office", async () => {
    const child = join(temp, "child"); mkdirSync(child);
    const desired = join(temp, "desired"); writeFileSync(desired, "1");
    const p = { ...plan(script(`require('fs').copyFileSync(${JSON.stringify(desired)},'artifact')`), script(`const f=require('fs');process.exit(f.readFileSync('artifact','utf8')===f.readFileSync(${JSON.stringify(desired)},'utf8')?0:1)`)), workspaceMode: "isolated", integrate: script(`require('fs').copyFileSync(${JSON.stringify(join(child, "artifact"))},'artifact')`) };
    Object.assign(p.tasks[0]!, { cwd: child });
    p.verify = script(`const f=require('fs');process.exit(f.readFileSync('artifact','utf8')===f.readFileSync(${JSON.stringify(desired)},'utf8')?0:1)`);
    expect((await runOffice(p, { root, runDir })).status).toBe("succeeded");
    writeFileSync(desired, "2");
    const resumed = await runOffice(p, { root, runDir });
    expect(resumed.status).toBe("succeeded"); expect(readFileSync(join(root, "artifact"), "utf8")).toBe("2");
  });

  it("runs separate domains concurrently while enforcing each domain and global cap", async () => {
    const workspaces = ["a", "b", "c"].map((id) => { const path = join(temp, id); mkdirSync(path); return path; });
    const agent = script("setTimeout(()=>require('fs').writeFileSync('done','yes'),100)");
    const verify = script("process.exit(require('fs').existsSync('done')?0:1)");
    const p = { ...plan(agent, verify), workspaceMode: "isolated", integrate: ok(), maxConcurrency: 2,
      domains: [{ id: "core", workers: 1 }, { id: "hooks", workers: 1 }],
      tasks: workspaces.map((cwd, i) => ({ id: String.fromCharCode(97 + i), domainId: i < 2 ? "core" : "hooks", goal: "finish assigned isolated artifact", agent, verify, cwd, maxAttempts: 1 })) };
    const state = await runOffice(p, { root, runDir }); expect(state.status).toBe("succeeded");
    const events = readFileSync(join(runDir, "events.jsonl"), "utf8").trim().split("\n").map((s) => JSON.parse(s));
    const active = new Map<string, string>(); let peak = 0;
    for (const event of events) {
      if (event.type === "task_start") active.set(event.taskId, event.domainId);
      if (event.type === "task_verified") active.delete(event.taskId);
      peak = Math.max(peak, active.size); expect(active.size).toBeLessThanOrEqual(2);
      expect([...active.values()].filter((d) => d === "core").length).toBeLessThanOrEqual(1);
    }
    expect(peak).toBe(2);
  });
  it("does not erase another live coordinator's cancellation request on a failed resume", async () => {
    const p = plan(ok(), ok()); const path = join(root, "office.json"); writeFileSync(path, JSON.stringify(p));
    const owner = openRun(p, runDir);
    try {
      requestOfficeCancel(runDir);
      expect(await runOrchestrate(["resume", path, "--run-dir", runDir])).toBe(1);
      expect(existsSync(join(runDir, "cancel.json"))).toBe(true);
    } finally { owner.close(); }
  });
  it.each(["CLAUDE_PROJECT_DIR", "CURSOR_PROJECT_DIR"])("uses %s for an externally stored plan", async (alias) => {
    for (const name of ["KNITBRAIN_PROJECT_DIR", "CLAUDE_PROJECT_DIR", "CURSOR_PROJECT_DIR"]) vi.stubEnv(name, "");
    vi.stubEnv(alias, root);
    const path = join(temp, "external-plan.json");
    writeFileSync(path, JSON.stringify(plan(script("require('fs').writeFileSync('bound-root','yes')"), ok())));
    expect(await runOrchestrate(["start", path, "--run-dir", runDir])).toBe(0);
    expect(readFileSync(join(root, "bound-root"), "utf8")).toBe("yes");
  });
});
