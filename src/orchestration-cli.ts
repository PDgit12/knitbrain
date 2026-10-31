import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { validatePlan } from "./orchestrator.js";
import { runOffice, requestOfficeCancel } from "./orchestration-runner.js";
import { postMessage, readMessageBatch, acknowledge, type OfficeMessageType } from "./orchestration-mailbox.js";
import { projectRoot } from "./paths.js";

export async function runOrchestrate(args: string[]): Promise<number> {
  const [action, path, ...rest] = args;
  try {
    if (!path) throw new Error("usage: knitbrain orchestrate validate|start|resume <plan.json> [--run-dir <path>] | status|cancel <runDir> | message <runDir> <recipient> <text> [--type request|result|blocker|handoff|decision|ack] | messages <runDir> <taskId> <domainId>");
    if (action === "status") {
      console.log(readFileSync(join(resolve(path), "snapshot.json"), "utf8")); return 0;
    }
    if (action === "cancel") { requestOfficeCancel(resolve(path)); console.log("Cancellation requested; inspect status for termination confirmation."); return 0; }
    if (action === "message") {
      const snapshot = JSON.parse(readFileSync(join(resolve(path), "snapshot.json"), "utf8")) as { id: string };
      const index = rest.indexOf("--type");
      const type = (index >= 0 ? rest[index + 1] : "request") as OfficeMessageType;
      const replyIndex = rest.indexOf("--reply-to");
      const result = postMessage(resolve(path), { runId: snapshot.id, from: process.env.KNITBRAIN_ORCHESTRATION_TASK_ID ?? "operator", to: rest[0] ?? "", body: rest[1] ?? "", type, ...(replyIndex >= 0 ? { replyTo: rest[replyIndex + 1] } : {}) });
      console.log(JSON.stringify(result)); return 0;
    }
    if (action === "messages") {
      const snapshot = JSON.parse(readFileSync(join(resolve(path), "snapshot.json"), "utf8")) as { id: string };
      console.log(JSON.stringify(readMessageBatch(resolve(path), { runId: snapshot.id, taskId: rest[0] ?? "", domainId: rest[1] ?? "" }), null, 2)); return 0;
    }
    if (action === "ack") { acknowledge(resolve(path), rest[0] ?? "", rest.slice(1)); console.log("Acknowledged supplied message IDs."); return 0; }
    if (!["validate", "start", "resume"].includes(action ?? "")) throw new Error(`unknown orchestration action: ${action}`);
    const planPath = resolve(path);
    const plan = validatePlan(JSON.parse(readFileSync(planPath, "utf8")));
    if (action === "validate") { console.log(JSON.stringify({ valid: true, plan }, null, 2)); return 0; }
    const rootArg = rest.indexOf("--root");
    if (rootArg >= 0 && !rest[rootArg + 1]) throw new Error("--root needs a directory");
    const configuredRoot = ["KNITBRAIN_PROJECT_DIR", "CLAUDE_PROJECT_DIR", "CURSOR_PROJECT_DIR"].some((key) => process.env[key]?.trim());
    const root = realpathSync(rootArg >= 0 ? resolve(rest[rootArg + 1]!) : configuredRoot ? projectRoot() : dirname(planPath));
    const directoryArg = rest.indexOf("--run-dir");
    if (directoryArg >= 0 && !rest[directoryArg + 1]) throw new Error("--run-dir needs a path");
    const rootHash = createHash("sha256").update(root).digest("hex").slice(0, 12);
    const runDir = directoryArg >= 0 ? resolve(rest[directoryArg + 1]!) : join(homedir(), ".knitbrain", "offices", rootHash, plan.id);
    const snapshotExists = existsSync(join(runDir, "snapshot.json"));
    if (action === "start" && snapshotExists) throw new Error("run already exists; use resume with the same plan");
    if (action === "resume" && !snapshotExists) throw new Error("run does not exist; use start");
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
    console.log(`Office ${plan.id}: ${runDir}`);
    try {
      const snapshot = await runOffice(plan, { root, runDir, signal: controller.signal, resume: action === "resume" });
      console.log(JSON.stringify(snapshot, null, 2));
      return snapshot.status === "succeeded" ? 0 : snapshot.status === "cancelled" ? 130 : 1;
    } finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
  } catch (error) { console.error(`orchestrate: ${error instanceof Error ? error.message : String(error)}`); return 1; }
}
