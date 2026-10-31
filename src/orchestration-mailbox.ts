import { randomUUID } from "node:crypto";
import {
  closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readSync, readdirSync, renameSync, unlinkSync, writeFileSync, chmodSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";

export type OfficeMessageType = "request" | "result" | "blocker" | "handoff" | "decision" | "ack";
export interface OfficeMessage {
  id: string;
  runId: string;
  from: string;
  to: string;
  type: OfficeMessageType;
  body: string;
  ts: string;
  replyTo?: string;
  artifacts?: string[];
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BODY = 16 * 1024;
const MAX_FILE = 32 * 1024;
const MAX_ARTIFACTS = 100;
const MAX_ARTIFACT = 512;
const MAX_READ = 500;
const TYPES = new Set<OfficeMessageType>(["request", "result", "blocker", "handoff", "decision", "ack"]);

export interface PostMessageInput {
  runId: string;
  from: string;
  to: string;
  type: OfficeMessageType;
  body: string;
  replyTo?: string;
  artifacts?: string[];
}
export interface ReadMessagesInput {
  runId: string;
  taskId: string;
  domainId: string;
  limit?: number;
}
export interface ReadMessageBatch {
  /** Oldest-first messages delivered by this bounded read. */
  messages: OfficeMessage[];
  /** Total visible, unread messages for this recipient before this batch is acknowledged. */
  unreadCount: number;
  /** True when another read is needed to drain the current unread inbox. */
  hasMore: boolean;
}

function requireId(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !ID_RE.test(value) || value === "." || value === "..") {
    throw new Error(`invalid ${name}`);
  }
}

function parseRecipient(value: unknown): string {
  if (value === "all") return value;
  if (typeof value !== "string") throw new Error("invalid recipient");
  const m = /^(task|domain):(.+)$/.exec(value);
  if (!m) throw new Error("recipient must be all, task:<id>, or domain:<id>");
  requireId(m[2], "recipient id");
  return `${m[1]}:${m[2]}`;
}

function mailboxRoot(runDir: string): string {
  if (typeof runDir !== "string" || !isAbsolute(runDir) || runDir.split(/[\\/]/).includes("..")) {
    throw new Error("runDir must be an absolute path without traversal segments");
  }
  const rootInfo = lstatSync(runDir);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("runDir must be a real directory");
  const root = join(runDir, "mailbox");
  if (!existsSync(root)) mkdirSync(root, { mode: 0o700 });
  const info = lstatSync(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("mailbox path must be a real directory");
  chmodSync(root, 0o700);
  return root;
}

function ensureDirectory(path: string): void {
  if (!existsSync(path)) {
    try { mkdirSync(path, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("mailbox subdirectory must be a real directory");
  chmodSync(path, 0o700);
}

function readBoundedFile(path: string, limit: number): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > limit) return null;
    const buf = Buffer.alloc(limit + 1);
    const n = readSync(fd, buf, 0, limit + 1, 0);
    if (n > limit) return null;
    return buf.subarray(0, n).toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function atomicPrivateWrite(path: string, data: string): void {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    writeFileSync(fd, data, { encoding: "utf8" });
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, path);
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(tmp); } catch { /* no temp file */ }
    throw error;
  }
}

function validateArtifacts(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_ARTIFACTS) throw new Error("invalid artifacts");
  const out: string[] = [];
  let totalBytes = 0;
  for (const item of value) {
    if (typeof item !== "string" || item.trim().length === 0 || item.length > MAX_ARTIFACT || Array.from(item).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) {
      throw new Error("invalid artifact reference");
    }
    totalBytes += Buffer.byteLength(item, "utf8");
    if (totalBytes > 8 * 1024) throw new Error("artifact references exceed 8 KiB total");
    out.push(item);
  }
  return out;
}

function validateMessage(value: unknown, expectedRunId?: string): OfficeMessage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const x = value as Record<string, unknown>;
  if (typeof x.id !== "string" || !UUID_RE.test(x.id) || typeof x.runId !== "string" || !ID_RE.test(x.runId) ||
    (expectedRunId !== undefined && x.runId !== expectedRunId) || typeof x.from !== "string" || !ID_RE.test(x.from) ||
    typeof x.to !== "string" || parseRecipientSafe(x.to) === null || !TYPES.has(x.type as OfficeMessageType) ||
    typeof x.body !== "string" || x.body.length === 0 || Buffer.byteLength(x.body, "utf8") > MAX_BODY ||
    typeof x.ts !== "string" || !Number.isFinite(Date.parse(x.ts))) return null;
  if (x.replyTo !== undefined && (typeof x.replyTo !== "string" || !UUID_RE.test(x.replyTo))) return null;
  const artifacts = validateArtifactsSafe(x.artifacts);
  if (artifacts === null) return null;
  return {
    id: x.id, runId: x.runId, from: x.from, to: x.to,
    type: x.type as OfficeMessageType, body: x.body, ts: x.ts,
    ...(typeof x.replyTo === "string" ? { replyTo: x.replyTo } : {}),
    ...(artifacts !== undefined ? { artifacts } : {}),
  };
}

function parseRecipientSafe(value: string): string | null {
  try { return parseRecipient(value); } catch { return null; }
}
function validateArtifactsSafe(value: unknown): string[] | undefined | null {
  try { return validateArtifacts(value); } catch { return null; }
}

function ackDirectory(root: string, taskId: string): string {
  requireId(taskId, "taskId");
  const dir = join(root, "acks", taskId);
  ensureDirectory(join(root, "acks"));
  ensureDirectory(dir);
  return dir;
}

function hasAck(dir: string, id: string): boolean {
  const path = join(dir, id);
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("ack marker must be a regular file");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Persist a private, immutable mailbox message. Message text is data, never proof of a gate. */
export function postMessage(runDir: string, input: PostMessageInput): OfficeMessage {
  requireId(input?.runId, "runId");
  requireId(input?.from, "from");
  const to = parseRecipient(input?.to);
  if (!TYPES.has(input?.type)) throw new Error("invalid message type");
  if (typeof input?.body !== "string" || input.body.trim().length === 0 || Buffer.byteLength(input.body, "utf8") > MAX_BODY) {
    throw new Error("body must be non-empty and at most 16 KiB");
  }
  if (input.replyTo !== undefined && (typeof input.replyTo !== "string" || !UUID_RE.test(input.replyTo))) {
    throw new Error("invalid replyTo");
  }
  const artifacts = validateArtifacts(input.artifacts);
  const root = mailboxRoot(runDir);
  const dir = join(root, "messages");
  ensureDirectory(dir);
  const message: OfficeMessage = {
    id: randomUUID(), runId: input.runId, from: input.from, to, type: input.type,
    body: input.body, ts: new Date().toISOString(),
    ...(input.replyTo ? { replyTo: input.replyTo } : {}),
    ...(artifacts ? { artifacts } : {}),
  };
  atomicPrivateWrite(join(dir, `${message.id}.json`), JSON.stringify(message));
  return message;
}

/** Read one bounded recipient-visible batch and report any unread overflow. Invalid files are skipped. */
export function readMessageBatch(runDir: string, input: ReadMessagesInput): ReadMessageBatch {
  requireId(input?.runId, "runId");
  requireId(input?.taskId, "taskId");
  requireId(input?.domainId, "domainId");
  const limit = input.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_READ) throw new Error(`limit must be 1..${MAX_READ}`);
  const root = mailboxRoot(runDir);
  const dir = join(root, "messages");
  if (!existsSync(dir)) return { messages: [], unreadCount: 0, hasMore: false };
  const info = lstatSync(dir);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("messages path must be a real directory");
  const acks = join(root, "acks", input.taskId);
  const seenAck = existsSync(acks) ? lstatSync(acks) : null;
  if (seenAck && (!seenAck.isDirectory() || seenAck.isSymbolicLink())) throw new Error("ack path must be a real directory");
  const out: OfficeMessage[] = [];
  for (const name of readdirSync(dir)) {
    if (!UUID_RE.test(name.replace(/\.json$/, "")) || !name.endsWith(".json")) continue;
    const path = join(dir, name);
    try {
      const raw = readBoundedFile(path, MAX_FILE);
      if (raw === null) continue;
      const msg = validateMessage(JSON.parse(raw), input.runId);
      if (!msg || name !== `${msg.id}.json` || (acks && hasAck(acks, msg.id))) continue;
      if (msg.to === "all" || msg.to === `task:${input.taskId}` || msg.to === `domain:${input.domainId}`) out.push(msg);
    } catch {
      // A corrupt/partial foreign record is not delivered as trusted context.
    }
  }
  out.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts) || a.id.localeCompare(b.id));
  return { messages: out.slice(0, limit), unreadCount: out.length, hasMore: out.length > limit };
}

/** Compatibility helper for inboxes that fit one batch; overflow must be handled explicitly. */
export function readMessages(runDir: string, input: ReadMessagesInput): OfficeMessage[] {
  const batch = readMessageBatch(runDir, input);
  if (batch.hasMore) throw new Error(`mailbox has ${batch.unreadCount} unread messages; use readMessageBatch to drain bounded batches`);
  return batch.messages;
}

/** Acknowledge message IDs for one task. Per-message marker files avoid lost updates. */
export function acknowledge(runDir: string, taskId: string, messageIds: string[]): void {
  requireId(taskId, "taskId");
  if (!Array.isArray(messageIds) || messageIds.length > MAX_READ || messageIds.some((id) => typeof id !== "string" || !UUID_RE.test(id))) {
    throw new Error("messageIds must contain at most 500 UUIDs");
  }
  const root = mailboxRoot(runDir);
  const dir = ackDirectory(root, taskId);
  for (const id of new Set(messageIds)) {
    const target = join(dir, id);
    if (existsSync(target)) {
      const info = lstatSync(target);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("ack marker must be a regular file");
      continue;
    }
    try { atomicPrivateWrite(target, "ack\n"); } catch (e) {
      // A concurrent acknowledgement is already equivalent; verify safe marker.
      if (!existsSync(target)) throw e;
      const info = lstatSync(target);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("ack marker must be a regular file", { cause: e });
    }
  }
}
