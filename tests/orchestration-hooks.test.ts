import { afterEach, describe, expect, it } from "vitest";
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { orchestrationContext, readOrchestrationAssignment, recordOrchestrationHookEvent } from "../src/hooks/orchestration.js";

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "knitbrain-orchestration-hook-"));
  roots.push(root);
  const contextPath = join(root, "worker-context.json");
  const env = { KNITBRAIN_ORCHESTRATION_CONTEXT: contextPath };
  return { root, contextPath, env };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("worker orchestration context hook support", () => {
  it("reads a valid bounded assignment and injects the exact gate with parent ownership", () => {
    const f = fixture();
    writeFileSync(f.contextPath, JSON.stringify({
      version: 1, runId: "run-7", taskId: "task-a", domainId: "hooks", goal: "Add hook context",
      verify: "npm test -- orchestration-hooks", attempt: 2, runDir: f.root,
    }));
    expect(readOrchestrationAssignment(f.env)?.attempt).toBe(2);
    const context = orchestrationContext(f.env)!;
    expect(context).toContain("Exact verification gate: npm test -- orchestration-hooks");
    expect(context).toContain("parent owns verification, retries, and final success");
    expect(context).toContain("task: task-a · domain: hooks · attempt: 2");
  });

  it("normalizes legacy domain to canonical domainId at context ingress", () => {
    const f = fixture();
    writeFileSync(f.contextPath, JSON.stringify({
      version: 1, runId: "legacy-run", taskId: "task-a", domain: "legacy-domain", goal: "Migrate context",
      verify: "npm test", attempt: 1, runDir: f.root,
    }));
    expect(readOrchestrationAssignment(f.env)?.domainId).toBe("legacy-domain");
    expect(orchestrationContext(f.env)).toContain("domain: legacy-domain");
  });

  it("falls back harmlessly for missing, malformed, invalid, oversized, or symlinked context", () => {
    const f = fixture();
    expect(orchestrationContext(f.env)).toBeNull();
    writeFileSync(f.contextPath, "{");
    expect(orchestrationContext(f.env)).toBeNull();
    writeFileSync(f.contextPath, JSON.stringify({ version: 1, runId: "x" }));
    expect(orchestrationContext(f.env)).toBeNull();
    writeFileSync(f.contextPath, "x".repeat(16 * 1024 + 1));
    expect(orchestrationContext(f.env)).toBeNull();
    const target = join(f.root, "target.json");
    writeFileSync(target, JSON.stringify({ version: 1 }));
    rmSync(f.contextPath);
    symlinkSync(target, f.contextPath);
    expect(lstatSync(f.contextPath).isSymbolicLink()).toBe(true);
    expect(orchestrationContext(f.env)).toBeNull();
  });

  it("appends correlated observational events only; it never writes success or raw hook payload", () => {
    const f = fixture();
    writeFileSync(f.contextPath, JSON.stringify({
      version: 1, runId: "r1", taskId: "t1", domain: "tests", goal: "Observe hooks",
      verify: "npm test", attempt: 1, runDir: f.root,
    }));
    recordOrchestrationHookEvent("subagent_stop", { agentType: "worker\nsecret transcript" }, f.env);
    const rows = readFileSync(join(f.root, "hook-events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ event: "subagent_stop", runId: "r1", taskId: "t1", domainId: "tests", attempt: 1 });
    expect(rows[0].agentType).toBe("worker secret transcript");
    expect(rows[0]).not.toHaveProperty("status");
    expect(rows[0]).not.toHaveProperty("success");
    expect(rows[0]).not.toHaveProperty("transcript");
  });

  it("does not create telemetry when context is missing", () => {
    const f = fixture();
    recordOrchestrationHookEvent("session_start", {}, f.env);
    expect(() => readFileSync(join(f.root, "hook-events.jsonl"), "utf8")).toThrow();
  });

  it("injects the assignment into SessionStart and SubagentStart output", () => {
    const f = fixture();
    writeFileSync(f.contextPath, JSON.stringify({
      version: 1, runId: "integration-run", taskId: "integration-task", domainId: "mcp", goal: "Wire worker context",
      verify: "npm test -- orchestration-hooks", attempt: 1, runDir: f.root,
    }));
    const cli = join(process.cwd(), "dist", "hooks", "index.js");
    if (!existsSync(cli)) throw new Error("dist/hooks/index.js missing; build before focused hook integration test");
    for (const mode of ["sessionstart", "subagentstart"]) {
      const result = spawnSync("node", [cli, mode], {
        input: JSON.stringify({ hook_event_name: mode === "sessionstart" ? "SessionStart" : "SubagentStart" }),
        env: { ...process.env, ...f.env }, encoding: "utf8", timeout: 5000,
      });
      expect(result.status).toBe(0);
      const output = JSON.parse(result.stdout) as { hookSpecificOutput?: { additionalContext?: string } };
      expect(output.hookSpecificOutput?.additionalContext).toContain("Run: integration-run · task: integration-task · domain: mcp · attempt: 1");
      expect(output.hookSpecificOutput?.additionalContext).toContain("Exact verification gate: npm test -- orchestration-hooks");
    }
    const events = readFileSync(join(f.root, "hook-events.jsonl"), "utf8");
    expect(events).toContain('"event":"session_start"');
    expect(events).toContain('"event":"subagent_start"');
  });
});
