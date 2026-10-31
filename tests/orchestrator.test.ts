import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent, openRun, validatePlan, type OrchestrationPlan } from "../src/orchestrator.js";

const dirs: string[] = [];
function tempDir(): string {
  const dir = join(tmpdir(), `kb-orchestrator-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function plan(overrides: Partial<OrchestrationPlan> = {}): OrchestrationPlan {
  return {
    version: 1,
    id: "audit-run",
    goal: "Complete the audit repairs",
    verify: "npm test",
    maxConcurrency: 3,
    workspaceMode: "serial",
    domains: [{ id: "correctness", workers: 2 }, { id: "operations", workers: 1 }],
    tasks: [
      { id: "schema", domainId: "correctness", goal: "Enforce tool input schemas", agent: "agent-a", verify: "npm test -- schema" },
      { id: "release", domainId: "operations", goal: "Audit release provenance", agent: "agent-b", verify: "npm test -- release", dependsOn: ["schema"], maxAttempts: null },
    ],
    commandTimeoutMs: 30_000,
    ...overrides,
  };
}

describe("orchestration plan validation", () => {
  it("accepts independent per-domain goals, bounded concurrency and explicit unbounded attempts", () => {
    const checked = validatePlan(plan());
    expect(checked.tasks.map((task) => task.domainId)).toEqual(["correctness", "operations"]);
    expect(checked.tasks[1]!.maxAttempts).toBeNull();
  });

  it("normalizes the legacy task.domain alias into canonical domainId", () => {
    const current = plan();
    const legacy = {
      ...current,
      tasks: current.tasks.map(({ domainId, ...task }) => ({ ...task, domain: domainId })),
    };
    const checked = validatePlan(legacy);
    expect(checked.tasks[0]!.domainId).toBe("correctness");
    expect(checked.tasks[0]).not.toHaveProperty("domain");
  });

  it("defaults to isolated workspaces and requires a parent integration gate", () => {
    const isolated = validatePlan({ ...plan(), workspaceMode: undefined, integrate: "npm run integration:verify" });
    expect(isolated.workspaceMode).toBe("isolated");
    expect(() => validatePlan({ ...plan(), workspaceMode: "isolated", integrate: undefined })).toThrow(/requires an integrate command/);
  });

  it.each([
    ["missing parent gate", { verify: " " }],
    ["zero concurrency", { maxConcurrency: 0 }],
    ["zero command timeout", { commandTimeoutMs: 0 }],
    ["duplicate domain", { domains: [{ id: "same", workers: 1 }, { id: "same", workers: 2 }] }],
    ["unknown task domain", { tasks: [{ id: "x", domainId: "missing", goal: "x", agent: "a", verify: "v" }] }],
    ["missing worker gate", { tasks: [{ id: "x", domainId: "correctness", goal: "x", agent: "a", verify: " " }] }],
    ["unknown dependency", { tasks: [{ id: "x", domainId: "correctness", goal: "x", agent: "a", verify: "v", dependsOn: ["missing"] }] }],
    ["conflicting domain aliases", { tasks: [{ id: "x", domainId: "correctness", domain: "operations", goal: "x", agent: "a", verify: "v" }] }],
    ["dependency cycle", { tasks: [
      { id: "x", domainId: "correctness", goal: "x", agent: "a", verify: "v", dependsOn: ["y"] },
      { id: "y", domainId: "correctness", goal: "y", agent: "a", verify: "v", dependsOn: ["x"] },
    ] }],
    ["invalid attempt count", { tasks: [{ id: "x", domainId: "correctness", goal: "x", agent: "a", verify: "v", maxAttempts: 0 }] }],
  ])("rejects %s before a run starts", (_name, overrides) => {
    expect(() => validatePlan(plan(overrides as Partial<OrchestrationPlan>))).toThrow(/invalid orchestration plan/);
  });
});

describe("durable orchestration run store", () => {
  it("initializes one parent and per-goal task states, then persists mutations atomically", () => {
    const dir = tempDir();
    const run = openRun(plan(), dir);
    expect(run.snapshot.status).toBe("running");
    expect(run.snapshot.tasks.schema).toMatchObject({ status: "queued", attempts: 0 });
    expect(run.snapshot.tasks.release).toMatchObject({ status: "blocked", attempts: 0 });
    run.snapshot.tasks.schema!.attempts = 2;
    run.snapshot.tasks.schema!.status = "running";
    run.save();
    expect(JSON.parse(readFileSync(join(dir, "snapshot.json"), "utf8")).tasks.schema.attempts).toBe(2);
    if (process.platform !== "win32") {
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(statSync(join(dir, "snapshot.json")).mode & 0o777).toBe(0o600);
    }
    run.close();
  });

  it("rejects a second live owner and releases the lock on close", () => {
    const dir = tempDir();
    const first = openRun(plan(), dir);
    expect(() => openRun(plan(), dir)).toThrow(/locked/);
    first.close();
    expect(existsSync(join(dir, "run.lock"))).toBe(false);
    const second = openRun(plan(), dir);
    second.close();
  });

  it("tightens permissions on pre-existing run directories and snapshots", () => {
    const dir = tempDir();
    const first = openRun(plan(), dir);
    first.close();
    if (process.platform !== "win32") {
      chmodSync(dir, 0o755);
      chmodSync(join(dir, "snapshot.json"), 0o644);
    }
    const resumed = openRun(plan(), dir);
    if (process.platform !== "win32") {
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(statSync(join(dir, "snapshot.json")).mode & 0o777).toBe(0o600);
    }
    resumed.close();
  });

  it("recovers a stale same-host PID lock", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "run.lock"), JSON.stringify({ pid: 2_147_483_647, host: hostname(), token: "dead", startedAt: new Date(0).toISOString() }));
    const run = openRun(plan(), dir);
    expect(run.snapshot.status).toBe("running");
    run.close();
  });

  it("blocks and quarantines interrupted running tasks while preserving attempt history and completed goals", () => {
    const dir = tempDir();
    const first = openRun(plan(), dir);
    first.snapshot.tasks.schema!.status = "running";
    first.snapshot.tasks.schema!.attempts = 3;
    first.snapshot.tasks.schema!.lastError = "agent exited during attempt";
    first.snapshot.tasks.release!.status = "succeeded";
    first.snapshot.tasks.release!.attempts = 1;
    first.save();
    first.close();

    const resumed = openRun(plan(), dir);
    expect(resumed.snapshot.tasks.schema).toMatchObject({ status: "blocked", attempts: 3, quarantine: true });
    expect(resumed.snapshot.tasks.schema!.lastError).toContain("recovery required");
    expect(resumed.snapshot.tasks.schema!.lastError).toContain("confirm termination");
    expect(resumed.snapshot.tasks.release).toMatchObject({ status: "succeeded", attempts: 1 });
    resumed.close();
  });

  it("requeues retry_wait only when the prior attempt confirms process termination", () => {
    const dir = tempDir();
    const first = openRun(plan(), dir);
    first.snapshot.tasks.schema!.status = "retry_wait";
    first.snapshot.tasks.schema!.attempts = 2;
    first.snapshot.tasks.schema!.lastResult = { terminationConfirmed: true, outcome: "verify_failed" };
    first.snapshot.tasks.release!.status = "retry_wait";
    first.snapshot.tasks.release!.attempts = 4;
    first.snapshot.tasks.release!.lastResult = { terminationConfirmed: false, outcome: "agent_timeout" };
    first.save();
    first.close();

    const resumed = openRun(plan(), dir);
    expect(resumed.snapshot.tasks.schema).toMatchObject({ status: "queued", attempts: 2, quarantine: false });
    expect(resumed.snapshot.tasks.release).toMatchObject({ status: "blocked", attempts: 4, quarantine: true });
    expect(resumed.snapshot.tasks.release!.lastError).toContain("terminationConfirmed=true");
    resumed.close();
  });

  it("refuses plan drift and leaves prior state intact", () => {
    const dir = tempDir();
    const first = openRun(plan(), dir);
    first.snapshot.tasks.schema!.attempts = 1;
    first.save();
    first.close();
    expect(() => openRun(plan({ verify: "npm run verify" }), dir)).toThrow(/different plan/);
    expect(JSON.parse(readFileSync(join(dir, "snapshot.json"), "utf8")).tasks.schema.attempts).toBe(1);
  });

  it("blocks resume when the persisted parent command is not confirmed terminated", () => {
    const dir = tempDir();
    const first = openRun(plan(), dir);
    first.snapshot.parentResult = { pid: 9876, terminationConfirmed: false };
    first.snapshot.parentQuarantine = true;
    first.save();
    first.close();
    expect(() => openRun(plan(), dir)).toThrow(/parent command may still be running/);
    expect(existsSync(join(dir, "run.lock"))).toBe(false);
  });

  it("derives the parent resume block from an unconfirmed result even if its flag was missed", () => {
    const dir = tempDir();
    const first = openRun(plan(), dir);
    first.snapshot.parentResult = { pid: 9876, terminationConfirmed: false };
    first.save();
    first.close();
    expect(() => openRun(plan(), dir)).toThrow(/parent command may still be running/);
  });

  it.each([
    ["invalid startedAt", (snapshot: Record<string, unknown>) => { snapshot.startedAt = "yesterday"; }],
    ["invalid updatedAt", (snapshot: Record<string, unknown>) => { snapshot.updatedAt = "yesterday"; }],
    ["updatedAt preceding startedAt", (snapshot: Record<string, unknown>) => { snapshot.updatedAt = "2000-01-01T00:00:00.000Z"; }],
    ["non-boolean parent quarantine", (snapshot: Record<string, unknown>) => { snapshot.parentQuarantine = "yes"; }],
    ["non-boolean parent termination result", (snapshot: Record<string, unknown>) => { snapshot.parentResult = { terminationConfirmed: "yes" }; }],
    ["non-boolean task quarantine", (snapshot: Record<string, unknown>) => { (snapshot.tasks as Record<string, Record<string, unknown>>).schema!.quarantine = "yes"; }],
    ["quarantined non-blocked task", (snapshot: Record<string, unknown>) => { const task = (snapshot.tasks as Record<string, Record<string, unknown>>).schema!; task.status = "running"; task.quarantine = true; }],
  ])("rejects persisted snapshots with %s", (_name, corrupt) => {
    const dir = tempDir();
    const first = openRun(plan(), dir);
    first.close();
    const path = join(dir, "snapshot.json");
    const snapshot = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    corrupt(snapshot);
    writeFileSync(path, JSON.stringify(snapshot));
    expect(() => openRun(plan(), dir)).toThrow(/invalid|must be blocked/);
  });

  it("rejects corrupt snapshots rather than silently starting a fresh run", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "snapshot.json"), "{");
    expect(() => openRun(plan(), dir)).toThrow(/malformed/);
    expect(existsSync(join(dir, "snapshot.json"))).toBe(true);
    expect(existsSync(join(dir, "run.lock"))).toBe(false);
  });

  it("appends structured events as JSONL", () => {
    const dir = tempDir();
    appendEvent(dir, { type: "run.created", runId: "audit-run" });
    appendEvent(dir, { type: "task.retry", taskId: "schema", attempt: 2 });
    const rows = readFileSync(join(dir, "events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.type)).toEqual(["run.created", "task.retry"]);
    expect(rows.every((row) => typeof row.at === "string")).toBe(true);
    if (process.platform !== "win32") expect(statSync(join(dir, "events.jsonl")).mode & 0o777).toBe(0o600);
  });
});
