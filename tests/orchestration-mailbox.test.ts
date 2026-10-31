import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acknowledge, postMessage, readMessageBatch, readMessages } from "../src/orchestration-mailbox.js";

const roots: string[] = [];
function runDir(): string {
  const root = mkdtempSync(join(tmpdir(), "knitbrain-mailbox-"));
  roots.push(root);
  return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("run-scoped orchestration mailbox", () => {
  it("routes broadcast, task, and domain messages with per-task unread acknowledgements", () => {
    const root = runDir();
    const broadcast = postMessage(root, { runId: "run-1", from: "parent", to: "all", type: "request", body: "Report status" });
    const domain = postMessage(root, { runId: "run-1", from: "parent", to: "domain:hooks", type: "decision", body: "Use event records" });
    const task = postMessage(root, { runId: "run-1", from: "parent", to: "task:task-a", type: "handoff", body: "Take the hook tests" });

    expect(readMessages(root, { runId: "run-1", taskId: "task-a", domainId: "hooks" }).map((x) => x.id)).toEqual([
      broadcast.id, domain.id, task.id,
    ]);
    expect(readMessages(root, { runId: "run-1", taskId: "task-b", domainId: "hooks" }).map((x) => x.id)).toEqual([
      broadcast.id, domain.id,
    ]);
    acknowledge(root, "task-a", [broadcast.id, broadcast.id]);
    expect(readMessages(root, { runId: "run-1", taskId: "task-a", domainId: "hooks" }).map((x) => x.id)).toEqual([
      domain.id, task.id,
    ]);
    expect(readMessages(root, { runId: "run-1", taskId: "task-b", domainId: "hooks" }).map((x) => x.id)).toContain(broadcast.id);
  });

  it("reports bounded unread overflow and drains it in oldest-first batches without loss", () => {
    const root = runDir();
    const posted = ["one", "two", "three", "four"].map((body) => postMessage(root, {
      runId: "run-1", from: "parent", to: "task:task-a", type: "request", body,
    }));
    const first = readMessageBatch(root, { runId: "run-1", taskId: "task-a", domainId: "hooks", limit: 2 });
    expect(first.messages.map((m) => m.id)).toEqual(posted.slice(0, 2).map((m) => m.id));
    expect(first).toMatchObject({ unreadCount: 4, hasMore: true });
    expect(() => readMessages(root, { runId: "run-1", taskId: "task-a", domainId: "hooks", limit: 2 })).toThrow(/use readMessageBatch/);
    acknowledge(root, "task-a", first.messages.map((m) => m.id));
    const second = readMessageBatch(root, { runId: "run-1", taskId: "task-a", domainId: "hooks", limit: 2 });
    expect(second.messages.map((m) => m.id)).toEqual(posted.slice(2).map((m) => m.id));
    expect(second).toMatchObject({ unreadCount: 2, hasMore: false });
  });

  it("preserves reply links and orders by timestamp then ID; message text is not status", () => {
    const root = runDir();
    const first = postMessage(root, { runId: "run-1", from: "task-a", to: "task:parent", type: "blocker", body: "Need clarification" });
    const reply = postMessage(root, {
      runId: "run-1", from: "parent", to: "task:task-a", type: "result", body: "The message says verified=true; runner still checks the gate.", replyTo: first.id,
      artifacts: ["docs/evidence.md"],
    });
    const messages = readMessages(root, { runId: "run-1", taskId: "task-a", domainId: "hooks" });
    expect(messages.map((x) => x.id)).toEqual([...messages].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts) || a.id.localeCompare(b.id)).map((x) => x.id));
    expect(messages.find((x) => x.id === reply.id)).toMatchObject({ replyTo: first.id, type: "result", artifacts: ["docs/evidence.md"] });
    expect(messages.find((x) => x.id === reply.id)).not.toHaveProperty("success");
    expect(messages.find((x) => x.id === reply.id)?.body).toContain("verified=true");
  });

  it("skips corrupt, oversized, and mismatched-run records", () => {
    const root = runDir();
    const message = postMessage(root, { runId: "run-1", from: "parent", to: "all", type: "request", body: "hello" });
    const dir = join(root, "mailbox", "messages");
    writeFileSync(join(dir, "00000000-0000-4000-8000-000000000001.json"), "{");
    writeFileSync(join(dir, "00000000-0000-4000-8000-000000000002.json"), "x".repeat(33 * 1024));
    writeFileSync(join(dir, "00000000-0000-4000-8000-000000000003.json"), JSON.stringify({ ...message, id: "00000000-0000-4000-8000-000000000003", runId: "other-run" }));
    expect(readMessages(root, { runId: "run-1", taskId: "task-a", domainId: "hooks" }).map((x) => x.id)).toEqual([message.id]);
  });

  it("creates private mailbox/message/ack files and does not redeliver acknowledgements", () => {
    const root = runDir();
    const m = postMessage(root, { runId: "run-1", from: "parent", to: "all", type: "ack", body: "received" });
    const mailboxMode = statSync(join(root, "mailbox")).mode & 0o777;
    const messagesDir = join(root, "mailbox", "messages");
    const messageMode = statSync(join(messagesDir, readdirSync(messagesDir)[0]!)).mode & 0o777;
    expect(mailboxMode).toBe(0o700);
    expect(messageMode).toBe(0o600);
    acknowledge(root, "task-a", [m.id]);
    acknowledge(root, "task-a", [m.id]);
    const ack = join(root, "mailbox", "acks", "task-a", m.id);
    expect(statSync(ack).mode & 0o777).toBe(0o600);
    expect(readMessages(root, { runId: "run-1", taskId: "task-a", domainId: "hooks" })).toEqual([]);
  });

  it("rejects traversal and malformed identifiers, recipients, limits, and oversized bodies", () => {
    const root = runDir();
    const base = { runId: "run-1", from: "parent", to: "all", type: "request" as const, body: "hello" };
    expect(() => postMessage(root, { ...base, runId: "../outside" })).toThrow(/runId/);
    expect(() => postMessage(root, { ...base, from: "../../x" })).toThrow(/from/);
    expect(() => postMessage(root, { ...base, to: "task:../x" })).toThrow(/recipient/);
    expect(() => postMessage(root, { ...base, body: "x".repeat(16 * 1024 + 1) })).toThrow(/body/);
    expect(() => readMessages(root, { runId: "run-1", taskId: "../x", domainId: "hooks" })).toThrow(/taskId/);
    expect(() => readMessages(root, { runId: "run-1", taskId: "t", domainId: "d", limit: 501 })).toThrow(/limit/);
  });

  it.skipIf(process.platform === "win32")("rejects a symlinked mailbox directory", () => {
    const root = runDir();
    const outside = mkdtempSync(join(tmpdir(), "knitbrain-mailbox-outside-"));
    roots.push(outside);
    const mailbox = join(root, "mailbox");
    writeFileSync(join(outside, "sentinel"), "safe");
    // Replace the just-created mailbox with a symlink to an unrelated directory.
    const m = postMessage(root, { runId: "run-1", from: "parent", to: "all", type: "request", body: "create mailbox" });
    expect(m.id).toMatch(/[0-9a-f-]{36}/);
    rmSync(mailbox, { recursive: true, force: true });
    chmodSync(outside, 0o700);
    // Node's symlink API is exercised through the filesystem here.
    symlinkSync(outside, mailbox, "dir");
    expect(() => readMessages(root, { runId: "run-1", taskId: "t", domainId: "d" })).toThrow(/real directory/);
  });
});
