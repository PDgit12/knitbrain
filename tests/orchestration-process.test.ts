import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "../src/orchestration-process.js";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "kb-orchestration-process-"));
  dirs.push(dir);
  return dir;
}

function nodeCommand(source: string): string {
  return `"${process.execPath}" -e "${source.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function createTree(dir: string): { command: string; pidFile: string; heartbeat: string } {
  const pidFile = join(dir, "child.pid");
  const heartbeat = join(dir, "child.heartbeat");
  const script = join(dir, "tree.cjs");
  writeFileSync(script, [
    "const { spawn } = require('node:child_process');",
    "const { writeFileSync, appendFileSync } = require('node:fs');",
    "const child = spawn(process.execPath, ['-e', `const fs=require('node:fs'); fs.writeFileSync(${JSON.stringify(process.argv[3])}, 'ready'); setInterval(()=>fs.appendFileSync(${JSON.stringify(process.argv[3])}, 'x'), 25)`], { stdio: 'ignore' });",
    "writeFileSync(process.argv[2], String(child.pid));",
    "child.unref();",
    "setInterval(() => {}, 1000);",
  ].join("\n"));
  return { command: `"${process.execPath}" "${script}" "${pidFile}" "${heartbeat}"`, pidFile, heartbeat };
}

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      readFileSync(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error(`timed out waiting for readiness file: ${path}`);
}

async function expectProcessStopped(pid: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 25));
    } catch {
      return;
    }
  }
  expect.fail(`process ${pid} remained alive after process-tree termination`);
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("runCommand", () => {
  it("captures a successful command and exit status", async () => {
    const result = await runCommand(nodeCommand("process.stdout.write('hello')"), {
      cwd: process.cwd(),
      timeoutMs: 2_000,
    });
    expect(result).toMatchObject({ ok: true, exitCode: 0, signal: null, timedOut: false, cancelled: false, terminationConfirmed: true });
    expect(result.output).toContain("hello");
  });

  it("returns a failed command's exit code and stderr", async () => {
    const result = await runCommand(nodeCommand("process.stderr.write('broken'); process.exitCode = 7"), {
      cwd: process.cwd(),
      timeoutMs: 2_000,
    });
    expect(result).toMatchObject({ ok: false, exitCode: 7, timedOut: false, cancelled: false, terminationConfirmed: true });
    expect(result.output).toContain("broken");
  });

  it("rejects whitespace commands without spawning", async () => {
    const result = await runCommand(" \n\t ", { cwd: process.cwd(), timeoutMs: 1_000, maxOutputBytes: 24 });
    expect(result).toMatchObject({ ok: false, exitCode: null, signal: null, timedOut: false, cancelled: false, terminationConfirmed: true });
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(24);
    expect(result.output).toMatch(/empty|blank/i);
  });

  it("bounds combined stdout and stderr diagnostics", async () => {
    const result = await runCommand(nodeCommand("process.stdout.write('A'.repeat(10000)); process.stderr.write('B'.repeat(10000))"), {
      cwd: process.cwd(),
      timeoutMs: 2_000,
      maxOutputBytes: 128,
    });
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(128);
    expect(result.output).toContain("stdout");
    expect(result.output).toContain("stderr");
  });

  it("terminates the process tree on timeout and waits for close", async () => {
    const dir = tempDir();
    const tree = createTree(dir);
    const result = await runCommand(tree.command, {
      cwd: dir,
      timeoutMs: 2_000,
      maxOutputBytes: 256,
    });
    expect(result).toMatchObject({ ok: false, timedOut: true, cancelled: false });
    expect(result.terminationConfirmed).toBe(true);
    expect(result.output).toContain("timed out");
    const childPid = Number(readFileSync(tree.pidFile, "utf8"));
    expect(Number.isInteger(childPid)).toBe(true);
    await expectProcessStopped(childPid);
    const heartbeatAtReturn = readFileSync(tree.heartbeat, "utf8").length;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(readFileSync(tree.heartbeat, "utf8").length).toBe(heartbeatAtReturn);

    // A fallback can start only after runCommand resolves. It checks the old
    // worker's heartbeat over a delay to catch accidental overlap.
    const fallback = await runCommand(nodeCommand(
      `const fs=require('node:fs'); const p=${JSON.stringify(tree.heartbeat)}; const n=fs.existsSync(p)?fs.statSync(p).size:0; setTimeout(()=>process.exit((fs.existsSync(p)?fs.statSync(p).size:0)===n?0:1),120)`,
    ), { cwd: dir, timeoutMs: 1_000 });
    expect(fallback.ok).toBe(true);
  }, 8_000);

  it.skipIf(process.platform === "win32")("detects and cleans descendants after the shell parent exits", async () => {
    const dir = tempDir();
    const tree = createTree(dir);
    // This worker variant leaves its grandchild running, then exits zero.
    const exitScript = join(dir, "exit-parent.cjs");
    writeFileSync(exitScript, [
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      `const child = spawn(process.execPath, ['-e', ${JSON.stringify(`const fs=require('node:fs'); fs.writeFileSync(${JSON.stringify(tree.heartbeat)}, 'ready'); setInterval(()=>fs.appendFileSync(${JSON.stringify(tree.heartbeat)}, 'x'), 25)`)}], { stdio: 'ignore' });`,
      "writeFileSync(process.argv[2], String(child.pid));",
      "child.unref();",
      `const waitForReady = () => require('node:fs').existsSync(${JSON.stringify(tree.heartbeat)}) ? process.exit(0) : setTimeout(waitForReady, 10);`,
      "waitForReady();",
    ].join("\n"));
    const result = await runCommand(`"${process.execPath}" "${exitScript}" "${tree.pidFile}"`, {
      cwd: dir,
      timeoutMs: 2_000,
      maxOutputBytes: 256,
    });
    expect(result).toMatchObject({ ok: false, exitCode: 0, timedOut: false, cancelled: false, terminationConfirmed: true });
    expect(result.output).toContain("process group still exists");
    const childPid = Number(readFileSync(tree.pidFile, "utf8"));
    await expectProcessStopped(childPid);
    const heartbeatAtReturn = readFileSync(tree.heartbeat, "utf8").length;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(readFileSync(tree.heartbeat, "utf8").length).toBe(heartbeatAtReturn);
  }, 8_000);

  it("terminates and awaits an aborted worker", async () => {
    const dir = tempDir();
    const tree = createTree(dir);
    const controller = new AbortController();
    const running = runCommand(tree.command, {
      cwd: dir,
      timeoutMs: 5_000,
      signal: controller.signal,
    });
    await waitForFile(tree.heartbeat, 4_000);
    controller.abort();
    const result = await running;
    expect(result).toMatchObject({ ok: false, timedOut: false, cancelled: true, terminationConfirmed: true });
    expect(result.output).toContain("cancelled");
    await expectProcessStopped(Number(readFileSync(tree.pidFile, "utf8")));
  }, 8_000);

  it("runs the onSpawn callback with a PID before successful completion", async () => {
    let observedPid: number | undefined;
    const result = await runCommand(nodeCommand("process.exit(0)"), {
      cwd: process.cwd(),
      timeoutMs: 2_000,
      onSpawn: (pid) => { observedPid = pid; },
    });
    expect(Number.isInteger(observedPid)).toBe(true);
    expect(result.ok).toBe(true);
  });

  it("terminates the worker and fails if onSpawn cannot durably record its PID", async () => {
    const result = await runCommand(nodeCommand("setInterval(() => {}, 1000)"), {
      cwd: process.cwd(),
      timeoutMs: 5_000,
      onSpawn: () => { throw new Error("state store unavailable"); },
    });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("state store unavailable");
    expect(result.terminationConfirmed).toBe(true);
  }, 8_000);

  it("handles a rejected async onSpawn callback without an unhandled rejection", async () => {
    const result = await runCommand(nodeCommand("setInterval(() => {}, 1000)"), {
      cwd: process.cwd(),
      timeoutMs: 5_000,
      onSpawn: (() => Promise.reject(new Error("async persistence rejected"))) as unknown as (pid: number) => void,
    });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("callback must be synchronous");
    expect(result.terminationConfirmed).toBe(true);
  }, 8_000);
});
