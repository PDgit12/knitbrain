import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_DOCTOR_FILE_BYTES = 256 * 1024;
const PACKAGE_MODULE_PATH = fileURLToPath(import.meta.url);

export type DoctorFileStatus = "missing" | "readable" | "unreadable" | "malformed" | "too-large";
export type DoctorHost = "claude-code" | "codex" | "cursor";

export interface DoctorConfigCheck {
  path: string;
  status: DoctorFileStatus;
  /** null means the config could not be inspected reliably. */
  knitbrainEntry: boolean | null;
  command: string | null;
  /** null when no command string was safely available. */
  commandResolved: boolean | null;
  configuredProjectRoot: string | null;
  projectRootStatus: "matches-doctor-cwd" | "mismatch" | "unset" | "unknown";
}

export interface DoctorHookCheck {
  path: string;
  status: DoctorFileStatus;
  bindings: Array<{ event: string; command: string; commandResolved: boolean }>;
  supportedEventsNote: string;
}

export interface DoctorHostReport {
  app: { status: "present" | "not-detected"; evidence: string[] };
  configs: DoctorConfigCheck[];
  hooks: DoctorHookCheck[];
}

export interface DoctorReport {
  runtime: {
    modulePath: string;
    packageRoot: string;
    packageVersion: string | null;
    sourceTreePresent: boolean;
    distPresent: boolean;
    mode: "source-checkout" | "installed-package" | "unknown";
  };
  hosts: Record<DoctorHost, DoctorHostReport>;
  connection: {
    verified: false;
    status: "not-observable";
    reason: string;
  };
}

interface BoundedRead {
  status: Exclude<DoctorFileStatus, "malformed">;
  content?: string;
}

export interface DoctorOptions {
  cwd?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
  readText?: (path: string, maxBytes: number) => BoundedRead;
  resolveCommand?: (command: string, env: NodeJS.ProcessEnv) => string | null;
  /** Injection seam for tests; defaults to this loaded module's path. */
  modulePath?: string;
}

function readBounded(path: string, maxBytes: number): BoundedRead {
  try {
    const info = statSync(path);
    if (!info.isFile()) return { status: "unreadable" };
    if (info.size > maxBytes) return { status: "too-large" };
    const content = readFileSync(path, "utf8");
    if (Buffer.byteLength(content, "utf8") > maxBytes) return { status: "too-large" };
    return { status: "readable", content };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { status: code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unreadable" };
  }
}

function resolveOnPath(command: string, env: NodeJS.ProcessEnv): string | null {
  const hasPath = command.includes("/") || command.includes("\\");
  const pathEntries = hasPath ? [""] : (env["PATH"] ?? "").split(delimiter).filter(Boolean);
  const suffixes = process.platform === "win32"
    ? (env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];
  for (const base of pathEntries) {
    for (const suffix of suffixes) {
      const candidate = hasPath
        ? command
        : join(base, `${command}${command.includes(".") ? "" : suffix}`);
      try {
        if (process.platform === "win32") {
          if (existsSync(candidate)) return candidate;
        } else {
          accessSync(candidate, constants.X_OK);
          return candidate;
        }
      } catch {
        // Keep walking PATH; command discovery is diagnostic only.
      }
    }
  }
  return null;
}

function parseJsonConfig(text: string): { entry: boolean | null; command: string | null; projectRoot: string | null; malformed: boolean } {
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) return { entry: false, command: null, projectRoot: null, malformed: false };
    const root = value as Record<string, unknown>;
    const servers = root["mcpServers"];
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) return { entry: false, command: null, projectRoot: null, malformed: false };
    const server = (servers as Record<string, unknown>)["knitbrain"];
    if (server === undefined) return { entry: false, command: null, projectRoot: null, malformed: false };
    if (!server || typeof server !== "object" || Array.isArray(server)) return { entry: true, command: null, projectRoot: null, malformed: false };
    const record = server as Record<string, unknown>;
    const command = record["command"];
    const env = record["env"] && typeof record["env"] === "object" && !Array.isArray(record["env"])
      ? record["env"] as Record<string, unknown>
      : {};
    return { entry: true, command: typeof command === "string" && command.trim() ? command.trim() : null,
      projectRoot: typeof env["KNITBRAIN_PROJECT_DIR"] === "string" ? env["KNITBRAIN_PROJECT_DIR"] : null, malformed: false };
  } catch {
    return { entry: null, command: null, projectRoot: null, malformed: true };
  }
}

/** Parse only the canonical Codex MCP table; never claim absence for unknown TOML shapes. */
function parseCodexToml(text: string): { entry: boolean | null; command: string | null; projectRoot: string | null } {
  if (!text.includes("knitbrain")) return { entry: false, command: null, projectRoot: null };
  const lines = text.split(/\r?\n/);
  const section = /^\s*\[mcp_servers\.knitbrain\]\s*(?:#.*)?$/;
  const start = lines.findIndex((line) => section.test(line));
  if (start < 0) return { entry: null, command: null, projectRoot: null };
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s*\[/.test(lines[i]!)) { end = i; break; }
  }
  let projectRoot: string | null = null;
  let commandValue: string | null = null;
  for (const line of lines.slice(start + 1, end)) {
    const match = /^\s*command\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*(?:#.*)?$/.exec(line);
    const rootMatch = /^\s*KNITBRAIN_PROJECT_DIR\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*(?:#.*)?$/.exec(line);
    if (rootMatch) projectRoot = rootMatch[1]!.startsWith('"') ? (() => { try { return JSON.parse(rootMatch[1]!) as string; } catch { return null; } })() : rootMatch[1]!.slice(1, -1);
    const envInline = /^\s*env\s*=\s*\{([^}]*)\}/.exec(line);
    const inlineRoot = envInline?.[1]?.match(/KNITBRAIN_PROJECT_DIR\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')/);
    if (inlineRoot) projectRoot = inlineRoot[1]!.startsWith('"') ? (() => { try { return JSON.parse(inlineRoot[1]!) as string; } catch { return null; } })() : inlineRoot[1]!.slice(1, -1);
    if (match) {
      const raw = match[1]!;
      const command = raw.startsWith('"') ? (() => { try { return JSON.parse(raw) as string; } catch { return null; } })() : raw.slice(1, -1);
      commandValue = typeof command === "string" && command.trim() ? command.trim() : null;
    }
  }
  return { entry: true, command: commandValue, projectRoot };
}

function configCheck(
  path: string,
  kind: "json" | "codex-toml",
  readText: DoctorOptions["readText"],
  resolveCommand: NonNullable<DoctorOptions["resolveCommand"]>,
  env: NodeJS.ProcessEnv,
  cwd: string,
): DoctorConfigCheck {
  const result = readText!(path, MAX_DOCTOR_FILE_BYTES);
  if (result.status !== "readable") {
    return { path, status: result.status, knitbrainEntry: null, command: null, commandResolved: null, configuredProjectRoot: null, projectRootStatus: "unknown" };
  }
  const parsed = kind === "json" ? parseJsonConfig(result.content ?? "") : parseCodexToml(result.content ?? "");
  if ("malformed" in parsed && parsed.malformed) {
    return { path, status: "malformed", knitbrainEntry: null, command: null, commandResolved: null, configuredProjectRoot: null, projectRootStatus: "unknown" };
  }
  const command = parsed.command;
  const configuredProjectRoot = parsed.projectRoot;
  return {
    path,
    status: "readable",
    knitbrainEntry: parsed.entry,
    command,
    commandResolved: command ? resolveCommand(command, env) !== null : null,
    configuredProjectRoot,
    projectRootStatus: !parsed.entry || parsed.entry === null ? "unknown" : !configuredProjectRoot ? "unset" : resolve(configuredProjectRoot) === cwd ? "matches-doctor-cwd" : "mismatch",
  };
}

function hookCheck(path: string, readText: DoctorOptions["readText"], resolveCommand: NonNullable<DoctorOptions["resolveCommand"]>, env: NodeJS.ProcessEnv, host: DoctorHost): DoctorHookCheck {
  const result = readText!(path, MAX_DOCTOR_FILE_BYTES);
  const supportedEventsNote = host === "cursor"
    ? "Cursor documents subagentStart, subagentStop, and preCompact; listed bindings show configuration only, not event delivery."
    : host === "codex"
      ? "Codex hook event support depends on the installed CLI version; this check reports configured bindings only."
      : "Claude Code hook event support depends on the installed CLI version; this check reports configured bindings only.";
  if (result.status !== "readable") return { path, status: result.status, bindings: [], supportedEventsNote };
  try {
    const root: unknown = JSON.parse(result.content ?? "");
    if (!root || typeof root !== "object" || Array.isArray(root)) throw new Error("invalid hook config shape");
    const bindings: DoctorHookCheck["bindings"] = [];
    const visit = (value: unknown, trail: string[]): void => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) { value.forEach((item, index) => visit(item, [...trail, String(index)])); return; }
      const record = value as Record<string, unknown>;
      if (typeof record["command"] === "string" && record["command"].includes("knitbrain-hook")) {
        const event = [...trail].reverse().find((part) => /^(pretooluse|posttooluse|permissionrequest|userpromptsubmit|sessionstart|sessionend|subagentstart|subagentstop|precompact|postcompact|stop|interrupt)$/i.test(part))
          ?? trail.filter((part) => !/^\d+$/.test(part)).at(-1)
          ?? "unknown";
        bindings.push({ event, command: record["command"], commandResolved: resolveCommand(record["command"].split(/\s+/)[0]!, env) !== null });
      }
      for (const [key, child] of Object.entries(record)) visit(child, [...trail, key]);
    };
    visit(root, []);
    return { path, status: "readable", bindings, supportedEventsNote };
  } catch {
    return { path, status: "malformed", bindings: [], supportedEventsNote };
  }
}

function appEvidence(host: DoctorHost, home: string, env: NodeJS.ProcessEnv, exists: (path: string) => boolean): string[] {
  const evidence: string[] = [];
  if (host === "claude-code") {
    if (env["CLAUDECODE"] || env["CLAUDE_CODE"]) evidence.push("Claude Code runtime environment");
    if (env["CLAUDE_CONFIG_DIR"]) evidence.push("CLAUDE_CONFIG_DIR is set");
    for (const path of [join(home, ".claude"), join(home, ".claude.json")]) if (exists(path)) evidence.push(path);
  } else if (host === "codex") {
    if (env["CODEX_SESSION_ID"]) evidence.push("CODEX_SESSION_ID is set");
    if (env["CODEX_HOME"]) evidence.push("CODEX_HOME is set");
    if (exists(join(home, ".codex"))) evidence.push(join(home, ".codex"));
  } else {
    if (env["CURSOR_TRACE_ID"] || env["CURSOR_WORKSPACE"]) evidence.push("Cursor runtime environment");
    if (exists(join(home, ".cursor"))) evidence.push(join(home, ".cursor"));
  }
  return [...new Set(evidence)];
}

function unique(paths: string[]): string[] { return [...new Set(paths)]; }

/** Read-only diagnostics. This CLI cannot observe an active host's MCP handshake. */
export function diagnoseSetup(options: DoctorOptions = {}): DoctorReport {
  const cwd = resolve(options.cwd ?? process.cwd());
  const home = resolve(options.home ?? homedir());
  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;
  const readText = options.readText ?? readBounded;
  const resolveCommand = options.resolveCommand ?? resolveOnPath;
  const modulePath = resolve(options.modulePath ?? PACKAGE_MODULE_PATH);
  const packageRoot = resolve(dirname(modulePath), "..");
  const packageRead = readText(join(packageRoot, "package.json"), MAX_DOCTOR_FILE_BYTES);
  let packageVersion: string | null = null;
  if (packageRead.status === "readable") {
    try {
      const manifest: unknown = JSON.parse(packageRead.content ?? "");
      if (manifest && typeof manifest === "object" && typeof (manifest as Record<string, unknown>)["version"] === "string") {
        packageVersion = (manifest as Record<string, string>)["version"]!;
      }
    } catch {
      // Runtime identity remains unknown if package metadata cannot be parsed.
    }
  }
  const sourceTreePresent = exists(join(packageRoot, "src", "index.ts"));
  const distPresent = exists(join(packageRoot, "dist", "index.js"));
  const mode = sourceTreePresent ? "source-checkout" : packageVersion ? "installed-package" : "unknown";

  const codexHome = env["CODEX_HOME"]?.trim() ? resolve(env["CODEX_HOME"]!) : join(home, ".codex");
  const claudeConfigDir = env["CLAUDE_CONFIG_DIR"]?.trim() ? resolve(env["CLAUDE_CONFIG_DIR"]!) : null;
  const hostCandidates: Record<DoctorHost, string[]> = {
    "claude-code": unique([
      join(cwd, ".mcp.json"),
      join(home, ".claude.json"),
      ...(claudeConfigDir ? [join(claudeConfigDir, ".claude.json"), join(claudeConfigDir, "settings.json")] : []),
    ]),
    codex: unique([join(cwd, ".codex", "config.toml"), join(codexHome, "config.toml")]),
    cursor: unique([join(cwd, ".cursor", "mcp.json"), join(home, ".cursor", "mcp.json")]),
  };
  const hookCandidates: Record<DoctorHost, string[]> = {
    "claude-code": unique([
      join(cwd, ".claude", "settings.json"), join(home, ".claude", "settings.json"),
      ...(claudeConfigDir ? [join(claudeConfigDir, "settings.json")] : []),
    ]),
    codex: unique([join(cwd, ".codex", "hooks.json"), join(codexHome, "hooks.json")]),
    cursor: unique([join(cwd, ".cursor", "hooks.json"), join(home, ".cursor", "hooks.json")]),
  };
  const reports = {} as Record<DoctorHost, DoctorHostReport>;
  for (const host of ["claude-code", "codex", "cursor"] as const) {
    const evidence = appEvidence(host, home, env, exists);
    const configPaths = hostCandidates[host];
    reports[host] = {
      app: { status: evidence.length ? "present" : "not-detected", evidence },
      configs: configPaths.map((path) => configCheck(
        path,
        host === "codex" ? "codex-toml" : "json",
        readText,
        resolveCommand,
        env,
        cwd,
      )),
      hooks: hookCandidates[host].map((path) => hookCheck(path, readText, resolveCommand, env, host)),
    };
  }

  return {
    runtime: { modulePath, packageRoot, packageVersion, sourceTreePresent, distPresent, mode },
    hosts: reports,
    connection: {
      verified: false,
      status: "not-observable",
      reason: "Local files and environment can show app/config presence, but this doctor process cannot observe the host MCP handshake. Verify by listing/calling Knitbrain tools inside the host.",
    },
  };
}
