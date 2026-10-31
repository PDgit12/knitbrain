import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, appendFileSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { writeAtomic } from "./atomic.js";

export interface OrchestrationPlan {
  version: 1;
  id: string;
  goal: string;
  verify: string;
  review?: string;
  integrate?: string;
  maxConcurrency: number;
  workspaceMode: "isolated" | "serial";
  domains: Array<{ id: string; workers: number }>;
  tasks: Array<{
    id: string;
    /** Canonical domain identifier returned by validatePlan. */
    domainId: string;
    goal: string;
    agent: string;
    fallbackAgents?: string[];
    verify: string;
    review?: string;
    cwd?: string;
    dependsOn?: string[];
    maxAttempts?: number | null;
  }>;
  commandTimeoutMs: number;
  retryDelayMs?: number;
  deadlineMs?: number;
  hooks?: Record<string, string>;
}

export type TaskStatus = "queued" | "running" | "verifying" | "retry_wait" | "succeeded" | "failed" | "cancelled" | "blocked";
export type RunStatus = "running" | "succeeded" | "blocked" | "cancelled";

export interface TaskSnapshot {
  status: TaskStatus;
  attempts: number;
  lastError?: string;
  cwd?: string;
  lastResult?: unknown;
  quarantine?: boolean;
}

export interface RunSnapshot {
  version: 1;
  planHash: string;
  id: string;
  status: RunStatus;
  startedAt: string;
  updatedAt: string;
  tasks: Record<string, TaskSnapshot>;
  parentError?: string;
  /** Parent-level subprocess that may outlive a crashed/cancelled coordinator. */
  parentResult?: unknown;
  /** True means resume is unsafe until the parent process is confirmed stopped. */
  parentQuarantine?: boolean;
}

interface LockRecord {
  pid: number;
  host: string;
  token: string;
  startedAt: string;
}

const MAX_COMMAND_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const LOCK_STALE_MALFORMED_MS = 60_000;

function setPrivateMode(path: string, mode: number): void {
  // Node cannot enforce POSIX modes on Windows; the directory ACL remains the host boundary there.
  if (process.platform !== "win32") chmodSync(path, mode);
}

function fail(message: string): never {
  throw new Error(`invalid orchestration plan: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(value);
}

function positiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value));
}

/** Validate and return a detached, normalized plan before creating any state. */
export function validatePlan(input: unknown): OrchestrationPlan {
  if (!isRecord(input)) fail("plan must be an object");
  if (input.version !== 1) fail("version must be 1");
  if (!validId(input.id)) fail("id must be a short path-safe identifier");
  if (!nonEmpty(input.goal)) fail("goal is required");
  if (!nonEmpty(input.verify)) fail("parent verify command is required");
  if (!positiveInt(input.maxConcurrency)) fail("maxConcurrency must be a positive integer");
  const workspaceMode = input.workspaceMode ?? "isolated";
  if (workspaceMode !== "isolated" && workspaceMode !== "serial") fail("workspaceMode must be isolated or serial");
  if (workspaceMode === "isolated" && !nonEmpty(input.integrate)) fail("isolated workspaceMode requires an integrate command");
  if (!positiveInt(input.commandTimeoutMs) || input.commandTimeoutMs > MAX_COMMAND_TIMEOUT_MS) {
    fail(`commandTimeoutMs must be between 1 and ${MAX_COMMAND_TIMEOUT_MS}`);
  }
  if (input.review !== undefined && !nonEmpty(input.review)) fail("review must be non-empty when provided");
  if (input.integrate !== undefined && !nonEmpty(input.integrate)) fail("integrate must be non-empty when provided");
  if (input.retryDelayMs !== undefined && (typeof input.retryDelayMs !== "number" || !Number.isSafeInteger(input.retryDelayMs) || input.retryDelayMs < 0)) {
    fail("retryDelayMs must be a non-negative integer");
  }
  if (input.deadlineMs !== undefined && !positiveInt(input.deadlineMs)) fail("deadlineMs must be a positive integer");
  if (!Array.isArray(input.domains) || input.domains.length === 0) fail("at least one domain is required");
  if (!Array.isArray(input.tasks) || input.tasks.length === 0) fail("at least one task is required");

  const domains = input.domains.map((raw, index) => {
    if (!isRecord(raw) || !validId(raw.id)) fail(`domains[${index}].id is invalid`);
    if (!positiveInt(raw.workers)) fail(`domains[${index}].workers must be a positive integer`);
    return { id: raw.id, workers: raw.workers };
  });
  const domainIds = new Set<string>();
  for (const domain of domains) {
    if (domainIds.has(domain.id)) fail(`duplicate domain id ${domain.id}`);
    domainIds.add(domain.id);
  }

  const taskIds = new Set<string>();
  const tasks = input.tasks.map((raw, index) => {
    if (!isRecord(raw)) fail(`tasks[${index}] must be an object`);
    if (!validId(raw.id)) fail(`tasks[${index}].id is invalid`);
    if (taskIds.has(raw.id)) fail(`duplicate task id ${raw.id}`);
    taskIds.add(raw.id);
    const domainId = raw.domainId ?? raw.domain;
    if (raw.domainId !== undefined && raw.domain !== undefined && raw.domainId !== raw.domain) {
      fail(`tasks[${index}].domainId and legacy domain alias disagree`);
    }
    if (!validId(domainId) || !domainIds.has(domainId)) fail(`tasks[${index}].domainId must name a declared domain`);
    if (!nonEmpty(raw.goal)) fail(`tasks[${index}].goal is required`);
    if (!nonEmpty(raw.agent)) fail(`tasks[${index}].agent command is required`);
    if (!nonEmpty(raw.verify)) fail(`tasks[${index}].verify command is required`);
    if (raw.review !== undefined && !nonEmpty(raw.review)) fail(`tasks[${index}].review must be non-empty when provided`);
    if (raw.cwd !== undefined && !nonEmpty(raw.cwd)) fail(`tasks[${index}].cwd must be non-empty when provided`);
    if (raw.maxAttempts !== undefined && raw.maxAttempts !== null && !positiveInt(raw.maxAttempts)) {
      fail(`tasks[${index}].maxAttempts must be a positive integer or null`);
    }
    const fallbackAgents = raw.fallbackAgents === undefined ? undefined : raw.fallbackAgents;
    if (fallbackAgents !== undefined && (!Array.isArray(fallbackAgents) || !fallbackAgents.every(nonEmpty))) {
      fail(`tasks[${index}].fallbackAgents must be an array of non-empty commands`);
    }
    const dependsOn = raw.dependsOn === undefined ? undefined : raw.dependsOn;
    if (dependsOn !== undefined && (!Array.isArray(dependsOn) || !dependsOn.every(validId))) {
      fail(`tasks[${index}].dependsOn must be an array of task ids`);
    }
    return {
      id: raw.id,
      domainId,
      goal: raw.goal,
      agent: raw.agent,
      ...(fallbackAgents ? { fallbackAgents: [...new Set(fallbackAgents as string[])] } : {}),
      verify: raw.verify,
      ...(raw.review !== undefined ? { review: raw.review } : {}),
      ...(raw.cwd !== undefined ? { cwd: raw.cwd } : {}),
      ...(dependsOn ? { dependsOn: [...new Set(dependsOn as string[])] } : {}),
      ...(raw.maxAttempts !== undefined ? { maxAttempts: raw.maxAttempts as number | null } : {}),
    };
  });

  for (const task of tasks) {
    for (const dependency of task.dependsOn ?? []) {
      if (!taskIds.has(dependency)) fail(`task ${task.id} depends on unknown task ${dependency}`);
      if (dependency === task.id) fail(`task ${task.id} cannot depend on itself`);
    }
  }
  assertAcyclic(tasks);

  if (input.hooks !== undefined) {
    if (!isRecord(input.hooks) || Object.entries(input.hooks).some(([key, value]) => !nonEmpty(key) || !nonEmpty(value))) {
      fail("hooks must map non-empty event names to non-empty commands");
    }
  }

  return {
    version: 1,
    id: input.id,
    goal: input.goal.trim(),
    verify: input.verify.trim(),
    ...(input.review !== undefined ? { review: (input.review as string).trim() } : {}),
    ...(input.integrate !== undefined ? { integrate: (input.integrate as string).trim() } : {}),
    maxConcurrency: input.maxConcurrency,
    workspaceMode,
    domains,
    tasks,
    commandTimeoutMs: input.commandTimeoutMs,
    ...(input.retryDelayMs !== undefined ? { retryDelayMs: input.retryDelayMs } : {}),
    ...(input.deadlineMs !== undefined ? { deadlineMs: input.deadlineMs } : {}),
    ...(input.hooks !== undefined ? { hooks: { ...(input.hooks as Record<string, string>) } } : {}),
  };
}

function assertAcyclic(tasks: OrchestrationPlan["tasks"]): void {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) fail(`dependency cycle includes task ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const task of tasks) visit(task.id);
}

function hashPlan(plan: OrchestrationPlan): string {
  return createHash("sha256").update(JSON.stringify(plan)).digest("hex");
}

function snapshotPath(runDir: string): string {
  return join(runDir, "snapshot.json");
}

function lockPath(runDir: string): string {
  return join(runDir, "run.lock");
}

function recoverLockPath(path: string): string {
  return `${path}.recovery`;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function acquireLock(runDir: string): { path: string; token: string } {
  const path = lockPath(runDir);
  const token = randomUUID();
  const record: LockRecord = { pid: process.pid, host: hostname(), token, startedAt: new Date().toISOString() };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(path, "wx", 0o600);
      try {
        writeFileSync(fd, JSON.stringify(record));
      } finally {
        closeSync(fd);
      }
      return { path, token };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let current: Partial<LockRecord> | null;
      try {
        current = JSON.parse(readFileSync(path, "utf8")) as Partial<LockRecord>;
      } catch {
        current = null;
      }
      const sameHostStale = current?.host === hostname() && typeof current.pid === "number" && !processAlive(current.pid);
      let malformedStale = false;
      if (!current) {
        try {
          malformedStale = Date.now() - statSync(path).mtimeMs > LOCK_STALE_MALFORMED_MS;
        } catch {
          malformedStale = true;
        }
      }
      if (!(sameHostStale || malformedStale)) throw new Error(`orchestration run is locked${current?.pid ? ` by pid ${current.pid}` : ""}`, { cause: error });
      recoverStaleLock(path, current?.token);
    }
  }
  throw new Error("could not acquire orchestration run lock after stale-lock recovery");
}

/** Serialize stale-lock cleanup so concurrent openers cannot unlink a new owner. */
function recoverStaleLock(path: string, expectedToken?: string): void {
  const recoveryPath = recoverLockPath(path);
  const recoveryToken = randomUUID();
  const recovery: LockRecord = { pid: process.pid, host: hostname(), token: recoveryToken, startedAt: new Date().toISOString() };
  let fd: number;
  try {
    fd = openSync(recoveryPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("stale run lock recovery is already in progress; retry shortly", { cause: error });
    throw error;
  }
  try {
    writeFileSync(fd, JSON.stringify(recovery));
  } finally {
    closeSync(fd);
  }
  try {
    let latest: Partial<LockRecord> | null;
    try {
      latest = JSON.parse(readFileSync(path, "utf8")) as Partial<LockRecord>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      latest = null;
    }
    if (expectedToken !== undefined && latest?.token !== expectedToken) return;
    const stalePid = latest?.host === hostname() && typeof latest.pid === "number" && !processAlive(latest.pid);
    let staleMalformed = false;
    if (!latest) {
      try {
        staleMalformed = Date.now() - statSync(path).mtimeMs > LOCK_STALE_MALFORMED_MS;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
    }
    if (stalePid || staleMalformed) rmSync(path, { force: true });
  } finally {
    try {
      const owner = JSON.parse(readFileSync(recoveryPath, "utf8")) as Partial<LockRecord>;
      if (owner.token === recoveryToken) rmSync(recoveryPath, { force: true });
    } catch {
      /* leave an unknown/replaced recovery guard untouched */
    }
  }
}

function initializeSnapshot(plan: OrchestrationPlan, planHash: string): RunSnapshot {
  const now = new Date().toISOString();
  const tasks: RunSnapshot["tasks"] = {};
  for (const task of plan.tasks) {
    tasks[task.id] = {
      status: task.dependsOn?.length ? "blocked" : "queued",
      attempts: 0,
      ...(task.cwd ? { cwd: task.cwd } : {}),
    };
  }
  return { version: 1, planHash, id: plan.id, status: "running", startedAt: now, updatedAt: now, tasks };
}

function validateSnapshot(raw: unknown, plan: OrchestrationPlan, planHash: string): RunSnapshot {
  if (!isRecord(raw) || raw.version !== 1 || raw.planHash !== planHash || raw.id !== plan.id || !isRecord(raw.tasks)) {
    throw new Error("orchestration snapshot is corrupt or belongs to a different plan");
  }
  const snapshot = raw as unknown as RunSnapshot;
  if (!isIsoTimestamp(snapshot.startedAt) || !isIsoTimestamp(snapshot.updatedAt) || Date.parse(snapshot.updatedAt) < Date.parse(snapshot.startedAt)) {
    throw new Error("orchestration snapshot has invalid timestamps");
  }
  if (snapshot.parentQuarantine !== undefined && typeof snapshot.parentQuarantine !== "boolean") {
    throw new Error("orchestration snapshot has invalid parentQuarantine flag");
  }
  if (snapshot.parentResult !== undefined && isRecord(snapshot.parentResult) && snapshot.parentResult.terminationConfirmed !== undefined && typeof snapshot.parentResult.terminationConfirmed !== "boolean") {
    throw new Error("orchestration snapshot has invalid parent command termination flag");
  }
  if (snapshot.parentQuarantine === true && (!isRecord(snapshot.parentResult) || snapshot.parentResult.terminationConfirmed !== false)) {
    throw new Error("parentQuarantine requires a parentResult with terminationConfirmed=false");
  }
  if (!new Set<RunStatus>(["running", "succeeded", "blocked", "cancelled"]).has(snapshot.status)) {
    throw new Error("orchestration snapshot has invalid run status");
  }
  for (const task of plan.tasks) {
    const state = snapshot.tasks[task.id];
    if (!state || !new Set<TaskStatus>(["queued", "running", "verifying", "retry_wait", "succeeded", "failed", "cancelled", "blocked"]).has(state.status) || !Number.isSafeInteger(state.attempts) || state.attempts < 0) {
      throw new Error(`orchestration snapshot has invalid state for task ${task.id}`);
    }
    if (state.quarantine !== undefined && typeof state.quarantine !== "boolean") throw new Error(`orchestration snapshot has invalid quarantine flag for task ${task.id}`);
    if (state.quarantine === true && state.status !== "blocked") throw new Error(`quarantined task ${task.id} must be blocked`);
    if (state.lastResult !== undefined && isRecord(state.lastResult) && state.lastResult.terminationConfirmed !== undefined && typeof state.lastResult.terminationConfirmed !== "boolean") {
      throw new Error(`orchestration snapshot has invalid termination flag for task ${task.id}`);
    }
  }
  return snapshot;
}

function resumeInterrupted(snapshot: RunSnapshot): boolean {
  let changed = false;
  for (const task of Object.values(snapshot.tasks)) {
    if (task.status === "running" || task.status === "verifying") {
      const priorError = task.lastError ? `${task.lastError}; ` : "";
      task.status = "blocked";
      task.quarantine = true;
      task.lastError = `${priorError}recovery required: the previous worker may still be running; confirm termination before retrying`;
      changed = true;
    } else if (task.status === "retry_wait") {
      const terminationConfirmed = isRecord(task.lastResult) && task.lastResult.terminationConfirmed === true;
      if (terminationConfirmed) {
        task.status = "queued";
        task.quarantine = false;
      } else {
        const priorError = task.lastError ? `${task.lastError}; ` : "";
        task.status = "blocked";
        task.quarantine = true;
        task.lastError = `${priorError}recovery required: retry_wait lacks terminationConfirmed=true; confirm termination before retrying`;
      }
      changed = true;
    }
  }
  if (changed) snapshot.updatedAt = new Date().toISOString();
  return changed;
}

/** Open one exclusively-owned durable run. A second live owner is rejected. */
export function openRun(planInput: unknown, runDir: string): { snapshot: RunSnapshot; save(): void; close(): void } {
  const plan = validatePlan(planInput);
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  setPrivateMode(runDir, 0o700);
  const lock = acquireLock(runDir);
  let closed = false;
  try {
    const hash = hashPlan(plan);
    const path = snapshotPath(runDir);
    let snapshot: RunSnapshot;
    let resumed = false;
    if (existsSync(path)) {
      let stored: unknown;
      try {
        stored = JSON.parse(readFileSync(path, "utf8")) as unknown;
      } catch {
        throw new Error("orchestration snapshot is malformed; refusing to overwrite it");
      }
      snapshot = validateSnapshot(stored, plan, hash);
      setPrivateMode(path, 0o600);
      if (snapshot.parentQuarantine === true || (isRecord(snapshot.parentResult) && snapshot.parentResult.terminationConfirmed === false)) {
        throw new Error("recovery required: previous parent command may still be running; confirm termination before resuming this run");
      }
      resumed = resumeInterrupted(snapshot);
    } else {
      snapshot = initializeSnapshot(plan, hash);
    }
    const save = (): void => {
      if (closed) throw new Error("orchestration run is closed");
      snapshot.updatedAt = new Date().toISOString();
      writeAtomic(path, JSON.stringify(snapshot, null, 2), { mode: 0o600 });
    };
    const close = (): void => {
      if (closed) return;
      closed = true;
      try {
        const current = JSON.parse(readFileSync(lock.path, "utf8")) as Partial<LockRecord>;
        if (current.token === lock.token) rmSync(lock.path, { force: true });
      } catch {
        /* preserve a replacement lock or tolerate prior cleanup */
      }
    };
    if (resumed || !existsSync(path)) save();
    return { snapshot, save, close };
  } catch (error) {
    try {
      const current = JSON.parse(readFileSync(lock.path, "utf8")) as Partial<LockRecord>;
      if (current.token === lock.token) rmSync(lock.path, { force: true });
    } catch {
      /* no cleanup needed */
    }
    throw error;
  }
}

/** Append one event for audit/debug history; run ownership must be held. */
export function appendEvent(runDir: string, event: Record<string, unknown>): void {
  if (!isRecord(event) || !nonEmpty(event.type)) throw new Error("orchestration event requires a non-empty type");
  mkdirSync(runDir, { recursive: true });
  setPrivateMode(runDir, 0o700);
  const path = join(runDir, "events.jsonl");
  appendFileSync(path, `${JSON.stringify({ ...event, at: new Date().toISOString() })}\n`, { mode: 0o600 });
  setPrivateMode(path, 0o600);
}
