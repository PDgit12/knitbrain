import { closeSync, constants, lstatSync, openSync, readFileSync, writeSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const CONTEXT_LIMIT = 16 * 1024;
const FIELD_LIMIT = 8 * 1024;

export interface OrchestrationAssignment {
  version: 1;
  runId: string;
  taskId: string;
  domainId: string;
  goal: string;
  verify: string;
  attempt: number;
  runDir: string;
}

function boundedString(value: unknown, max = FIELD_LIMIT): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

/** Read the runner-owned worker assignment. Invalid or absent context is a no-op. */
export function readOrchestrationAssignment(
  env: Record<string, string | undefined> = process.env,
): OrchestrationAssignment | null {
  const path = env["KNITBRAIN_ORCHESTRATION_CONTEXT"];
  if (!path || !isAbsolute(path)) return null;
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > CONTEXT_LIMIT) return null;
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const x = raw as Record<string, unknown>;
    const domainId = x.domainId ?? x.domain; // accept older runner context at ingress
    if (x.version !== 1 || !boundedString(x.runId, 200) || !boundedString(x.taskId, 200) ||
      !boundedString(domainId, 200) || !boundedString(x.goal) || !boundedString(x.verify) ||
      !Number.isSafeInteger(x.attempt) || (x.attempt as number) < 1 || !boundedString(x.runDir, 4096) ||
      !isAbsolute(x.runDir)) return null;
    return { version: 1, runId: x.runId, taskId: x.taskId, domainId, goal: x.goal,
      verify: x.verify, attempt: x.attempt as number, runDir: x.runDir };
  } catch {
    return null;
  }
}

/** Concise assignment frame; gate ownership stays with the parent runner. */
export function orchestrationContext(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const x = readOrchestrationAssignment(env);
  if (!x) return null;
  return [
    "KNITBRAIN WORKER ASSIGNMENT (runner-provided context)",
    `Run: ${x.runId} · task: ${x.taskId} · domain: ${x.domainId} · attempt: ${x.attempt}`,
    `Goal: ${x.goal}`,
    `Exact verification gate: ${x.verify}`,
    `Questions, blockers, or handoffs: use knitbrain orchestrate message ${x.runDir} all "message text" (or recipient domain:DOMAIN_ID/task:TASK_ID); set KNITBRAIN_ORCHESTRATION_TASK_ID to your task ID when posting.`,
    "Work only this assignment and report evidence to the parent. The parent owns verification, retries, and final success; do not claim the overall goal passed.",
  ].join("\n");
}

export type HookLifecycleEvent = "session_start" | "subagent_start" | "subagent_stop" | "stop_observed";

/** Best-effort telemetry only. This never changes runner/goal status. */
export function recordOrchestrationHookEvent(
  event: HookLifecycleEvent,
  details: { agentType?: unknown } = {},
  env: Record<string, string | undefined> = process.env,
): void {
  const x = readOrchestrationAssignment(env);
  if (!x) return;
  try {
    const agentType = typeof details.agentType === "string"
      ? details.agentType.replace(/[\r\n\t]/g, " ").slice(0, 120)
      : undefined;
    const row = {
      ts: new Date().toISOString(), event, runId: x.runId, taskId: x.taskId,
      domainId: x.domainId, attempt: x.attempt,
      ...(agentType ? { agentType } : {}),
    };
    const fd = openSync(join(x.runDir, "hook-events.jsonl"), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    try {
      writeSync(fd, `${JSON.stringify(row)}\n`, undefined, "utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    // Hook telemetry must never affect the host or become authoritative state.
  }
}
