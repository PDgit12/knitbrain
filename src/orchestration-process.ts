import { spawn, type ChildProcess } from "node:child_process";
import { platform } from "node:os";

export interface CommandOptions {
  cwd: string;
  input?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
  maxOutputBytes?: number;
  /** Synchronous hook for durable PID registration before command completion. */
  onSpawn?: (pid: number) => void;
}

export interface CommandResult {
  ok: boolean;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  cancelled: boolean;
  terminationConfirmed: boolean;
  output: string;
}

const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_TIMEOUT_MS = 2_147_483_647;
const TERMINATION_GRACE_MS = 200;
const TERMINATION_CONFIRM_MS = 5_000;
const TASKKILL_TIMEOUT_MS = 2_000;
const GROUP_POLL_MS = 40;

/** Fixed-size ring buffer retaining only the newest bytes from one stream. */
class ByteTail {
  private readonly bytes: Buffer;
  private start = 0;
  private length = 0;

  constructor(private readonly capacity: number) {
    this.bytes = Buffer.alloc(Math.max(0, capacity));
  }

  append(chunk: Buffer): void {
    const cap = this.capacity;
    if (cap === 0 || chunk.length === 0) return;
    if (chunk.length >= cap) {
      chunk.copy(this.bytes, 0, chunk.length - cap);
      this.start = 0;
      this.length = cap;
      return;
    }

    const overflow = Math.max(0, this.length + chunk.length - cap);
    this.start = (this.start + overflow) % cap;
    this.length -= overflow;
    const end = (this.start + this.length) % cap;
    const first = Math.min(chunk.length, cap - end);
    chunk.copy(this.bytes, end, 0, first);
    if (first < chunk.length) chunk.copy(this.bytes, 0, first);
    this.length += chunk.length;
  }

  text(): string {
    if (this.length === 0) return "";
    const end = this.start + this.length;
    if (end <= this.capacity) return this.bytes.toString("utf8", this.start, end);
    return Buffer.concat([
      this.bytes.subarray(this.start),
      this.bytes.subarray(0, end - this.capacity),
    ]).toString("utf8");
  }
}

function safeOutputLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_OUTPUT_BYTES;
  if (!Number.isFinite(value)) return DEFAULT_MAX_OUTPUT_BYTES;
  return Math.min(MAX_OUTPUT_BYTES, Math.max(0, Math.floor(value)));
}

function clipOutput(output: string, maxBytes: number): string {
  const bytes = Buffer.from(output);
  if (bytes.length <= maxBytes) return bytes.toString("utf8");
  if (maxBytes === 0) return "";
  return bytes.subarray(bytes.length - maxBytes).toString("utf8");
}

function clipOutputHead(output: string, maxBytes: number): string {
  const bytes = Buffer.from(output);
  if (bytes.length <= maxBytes) return bytes.toString("utf8");
  return bytes.subarray(0, maxBytes).toString("utf8");
}

function makeOutput(stdout: ByteTail, stderr: ByteTail, note: string, maxBytes: number): string {
  const out = stdout.text();
  const err = stderr.text();
  if (maxBytes === 0) return "";
  const hasOut = out.length > 0;
  const hasErr = err.length > 0;
  const labels = (hasOut ? "[stdout]\n" : "").length + (hasErr ? "[stderr]\n" : "").length;
  const noteLimit = Math.min(512, Math.floor(maxBytes / 4));
  const noteText = note ? clipOutput(`[runner] ${note}`, noteLimit) : "";
  const separators = Number(hasOut && hasErr) + Number((hasOut || hasErr) && !!noteText);
  const payloadBudget = Math.max(0, maxBytes - labels - Buffer.byteLength(noteText) - separators);
  const streams = Number(hasOut) + Number(hasErr);
  const perStream = streams === 0 ? 0 : Math.floor(payloadBudget / streams);
  const parts: string[] = [];
  if (hasOut) parts.push(`[stdout]\n${clipOutput(out, perStream)}`);
  if (hasErr) parts.push(`[stderr]\n${clipOutput(err, perStream)}`);
  if (noteText) parts.push(noteText);
  return clipOutput(parts.join("\n"), maxBytes);
}

function immediateFailure(output: string, maxBytes: number, fields: Partial<CommandResult> = {}): CommandResult {
  return {
    ok: false,
    exitCode: null,
    signal: null,
    timedOut: false,
    cancelled: false,
    terminationConfirmed: true,
    output: clipOutputHead(output, maxBytes),
    ...fields,
  };
}

interface KillResult {
  confirmed: boolean;
  detail?: string;
}

function signalPosixGroup(pid: number, signal: NodeJS.Signals): KillResult {
  try {
    process.kill(-pid, signal);
    return { confirmed: true };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return { confirmed: true };
    return { confirmed: false, detail: `process-group ${signal} failed (${code ?? "unknown error"})` };
  }
}

function posixGroupExists(pid: number): "yes" | "no" | "unknown" {
  try {
    process.kill(-pid, 0);
    return "yes";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "no";
    return "unknown";
  }
}

/** Windows has no process-group signal; taskkill /T is the native tree kill. */
function killWindowsTree(pid: number): Promise<KillResult> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined = undefined;
    let killer: ChildProcess;
    const finish = (result: KillResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    try {
      killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
    } catch (error) {
      finish({ confirmed: false, detail: `taskkill launch failed (${errorMessage(error)})` });
      return;
    }

    timer = setTimeout(() => {
      try {
        killer.kill();
      } catch {
        // The bounded timeout below is the fallback if taskkill itself wedges.
      }
      finish({ confirmed: false, detail: "taskkill timed out; process-tree termination unconfirmed" });
    }, TASKKILL_TIMEOUT_MS);
    killer.once("error", (error) => finish({ confirmed: false, detail: `taskkill failed (${errorMessage(error)})` }));
    killer.once("close", (code) =>
      finish(code === 0
        ? { confirmed: true }
        : { confirmed: false, detail: `taskkill exited ${code ?? "without an exit code"}; process-tree termination unconfirmed` }),
    );
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Run one shell command asynchronously, retaining bounded stdout/stderr tails.
 * On timeout or abort, terminate the process tree and await the child close
 * event. If tree termination or close cannot be confirmed within a fixed
 * bound, the result is failed with `terminationConfirmed: false`; callers must
 * not launch a fallback worker against the same workspace in that case.
 */
export async function runCommand(command: string, options: CommandOptions): Promise<CommandResult> {
  const maxBytes = safeOutputLimit(options.maxOutputBytes);
  if (!command.trim()) return immediateFailure("[runner] blank command; nothing was launched", maxBytes);
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0 || options.timeoutMs > MAX_TIMEOUT_MS) {
    return immediateFailure("[runner] invalid timeoutMs; nothing was launched", maxBytes);
  }
  if (options.signal?.aborted) {
    return immediateFailure("[runner] cancelled before launch", maxBytes, { cancelled: true });
  }

  const stdout = new ByteTail(Math.ceil(maxBytes / 2));
  const stderr = new ByteTail(Math.floor(maxBytes / 2));
  const isWindows = platform() === "win32";
  let child: ChildProcess;
  try {
    child = spawn(command, {
      shell: true,
      cwd: options.cwd,
      env: options.env,
      detached: !isWindows,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (error) {
    return immediateFailure(`[runner] launch failed: ${errorMessage(error)}`, maxBytes);
  }

  return new Promise<CommandResult>((resolve) => {
    let settled = false;
    let closeSeen = false;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let timedOut = false;
    let cancelled = false;
    let terminationConfirmed = true;
    let terminationStarted = false;
    let terminationFinished = false;
    let leakedDescendants = false;
    let inputErrorDetail = "";
    let note = "";
    let terminationDetail = "";
    let timeoutTimer: NodeJS.Timeout | undefined;
    let graceTimer: NodeJS.Timeout | undefined;
    let confirmationTimer: NodeJS.Timeout | undefined;
    let groupPollTimer: NodeJS.Timeout | undefined;
    const abortListener = () => startTermination("abort");

    const cleanup = (): void => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (graceTimer) clearTimeout(graceTimer);
      if (confirmationTimer) clearTimeout(confirmationTimer);
      if (groupPollTimer) clearTimeout(groupPollTimer);
      if (abortListener) options.signal?.removeEventListener("abort", abortListener);
    };

    const finish = (forceUnconfirmed = false): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (forceUnconfirmed) terminationConfirmed = false;
      if (terminationDetail) note = note ? `${note}; ${terminationDetail}` : terminationDetail;
      if (inputErrorDetail) note = note ? `${note}; ${inputErrorDetail}` : inputErrorDetail;
      const ok = closeSeen && exitCode === 0 && !timedOut && !cancelled && !leakedDescendants && !inputErrorDetail && terminationConfirmed;
      resolve({
        ok,
        exitCode,
        signal: exitSignal,
        timedOut,
        cancelled,
        terminationConfirmed,
        output: makeOutput(stdout, stderr, note, maxBytes),
      });
    };

    const maybeFinish = (): void => {
      if (closeSeen && (!terminationStarted || terminationFinished)) finish();
    };

    const abortChildHandle = (): void => {
      try {
        child.kill("SIGKILL");
      } catch (error) {
        terminationDetail = `direct child kill failed (${errorMessage(error)})`;
      }
    };

    const startTermination = (kind: "timeout" | "abort" | "callback" | "descendants", detail = ""): void => {
      if (terminationStarted || settled) return;
      terminationStarted = true;
      timedOut = kind === "timeout";
      cancelled = kind === "abort";
      if (kind === "timeout") note = `timed out after ${options.timeoutMs}ms`;
      else if (kind === "abort") note = "cancelled by abort signal";
      else if (kind === "callback") note = `onSpawn callback failed${detail ? `: ${detail}` : ""}`;
      else note = `descendant process remained after command exit${detail ? `: ${detail}` : ""}`;

      confirmationTimer = setTimeout(() => {
        if (terminationFinished && closeSeen) return;
        terminationDetail = terminationDetail
          ? `${terminationDetail}; process-tree termination was not confirmed within ${TERMINATION_CONFIRM_MS}ms`
          : `process-tree termination was not confirmed within ${TERMINATION_CONFIRM_MS}ms; a process may still be running`;
        abortChildHandle();
        // A caller can now make a safe decision from terminationConfirmed=false.
        // Do not keep the orchestration loop blocked forever if OS termination failed.
        finish(true);
      }, TERMINATION_CONFIRM_MS);

      if (isWindows) {
        const pid = child.pid;
        if (pid === undefined) {
          terminationConfirmed = false;
          terminationDetail = "child PID unavailable; process-tree termination unconfirmed";
          terminationFinished = true;
          maybeFinish();
          return;
        }
        void killWindowsTree(pid).then((result) => {
          terminationConfirmed = result.confirmed;
          if (result.detail) terminationDetail = result.detail;
          if (!result.confirmed) abortChildHandle();
          terminationFinished = true;
          maybeFinish();
        });
        return;
      }

      const pid = child.pid;
      if (pid === undefined) {
        terminationConfirmed = false;
        terminationDetail = "child PID unavailable; process-group termination unconfirmed";
        abortChildHandle();
        terminationFinished = true;
        maybeFinish();
        return;
      }

      const term = signalPosixGroup(pid, "SIGTERM");
      if (term.detail) terminationDetail = term.detail;
      graceTimer = setTimeout(() => {
        const force = signalPosixGroup(pid, "SIGKILL");
        if (force.detail) terminationDetail = terminationDetail
          ? `${terminationDetail}; ${force.detail}`
          : force.detail;
        if (!force.confirmed) abortChildHandle();
        const deadline = Date.now() + TERMINATION_CONFIRM_MS - TERMINATION_GRACE_MS;
        const poll = (): void => {
          const group = posixGroupExists(pid);
          if (group === "no") {
            terminationConfirmed = true;
            terminationFinished = true;
            maybeFinish();
            return;
          }
          if (Date.now() >= deadline) {
            terminationConfirmed = false;
            terminationDetail = terminationDetail
              ? `${terminationDetail}; process group still exists after SIGKILL`
              : "process group still exists after SIGKILL";
            terminationFinished = true;
            maybeFinish();
            return;
          }
          groupPollTimer = setTimeout(poll, GROUP_POLL_MS);
        };
        poll();
      }, TERMINATION_GRACE_MS);
    };

    child.stdout?.on("data", (chunk: Buffer | string) => stdout.append(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    child.stderr?.on("data", (chunk: Buffer | string) => stderr.append(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    child.stdin?.on("error", (error) => { inputErrorDetail = `stdin write failed: ${errorMessage(error)}`; });
    child.once("error", (error) => {
      terminationDetail = `launch failed: ${errorMessage(error)}`;
      terminationConfirmed = true;
      if (!child.pid) {
        exitCode = null;
        closeSeen = true;
        terminationFinished = true;
        note = terminationDetail;
        maybeFinish();
      }
    });
    child.once("close", (code, signal) => {
      closeSeen = true;
      exitCode = code;
      exitSignal = signal;
      if (!isWindows && !terminationStarted && child.pid !== undefined) {
        const group = posixGroupExists(child.pid);
        if (group !== "no") {
          leakedDescendants = true;
          terminationConfirmed = group === "yes";
          startTermination("descendants", group === "unknown" ? "process-group state is unknown" : "process group still exists");
          return;
        }
      }
      maybeFinish();
    });

    options.signal?.addEventListener("abort", abortListener, { once: true });
    if (child.pid !== undefined && options.onSpawn) {
      try {
        const result: unknown = options.onSpawn(child.pid);
        if (result && typeof (result as PromiseLike<unknown>).then === "function") {
          // The contract is synchronous so PID persistence is complete before
          // the parent can hand out the workspace. Attach a rejection handler
          // anyway: a mistakenly async callback must never create an unhandled
          // rejection while the worker is being terminated.
          void Promise.resolve(result).then(
            () => startTermination("callback", "callback returned a promise; callback must be synchronous"),
            (error: unknown) => startTermination("callback", errorMessage(error)),
          );
          startTermination("callback", "callback must be synchronous");
        }
      } catch (error) {
        startTermination("callback", errorMessage(error));
      }
    }
    if (!terminationStarted) {
      if (options.signal?.aborted) startTermination("abort");
      else {
        // Always close stdin so commands that read to EOF cannot hang. Defer
        // task delivery until durable PID registration has returned.
        try {
          child.stdin?.end(options.input ?? "");
        } catch (error) {
          inputErrorDetail = `stdin write failed: ${errorMessage(error)}`;
          startTermination("callback", inputErrorDetail);
        }
        if (!terminationStarted) timeoutTimer = setTimeout(() => startTermination("timeout"), options.timeoutMs);
      }
    }
  });
}
