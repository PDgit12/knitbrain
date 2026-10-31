import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { writeAtomic } from "./atomic.js";
import { dirname, join } from "node:path";
import type { SetupConfig } from "./setup.js";

/**
 * Writers for platforms whose MCP config lives in a GLOBAL file (not the
 * project) — Codex, Windsurf, Zed, Copilot CLI. `knitbrain setup --yes`
 * merges knitbrain into these files instead of printing a snippet to paste,
 * turning "follow these instructions" into one command. Always non-clobbering
 * (existing config preserved) and always backs up the original first.
 */
export type GlobalConfigKind = "codex" | "windsurf" | "zed" | "copilot-cli";

/** Home-relative path of each platform's global MCP config. */
export const GLOBAL_CONFIG_PATHS: Record<GlobalConfigKind, string[]> = {
  codex: [".codex", "config.toml"],
  windsurf: [".codeium", "windsurf", "mcp_config.json"],
  zed: [".config", "zed", "settings.json"],
  "copilot-cli": [".copilot", "mcp-config.json"],
};

/**
 * Pure merge: given the existing file content (or null if absent), return the
 * new content and whether anything changed. knitbrain already present →
 * changed:false (idempotent). Existing config is never dropped.
 */
export function mergeGlobalConfig(
  kind: GlobalConfigKind,
  existing: string | null,
  config?: SetupConfig,
): { content: string; changed: boolean } {
  // Codex uses TOML. No TOML dep — append a single table block if absent,
  // never reformat the rest of the user's file.
  if (kind === "codex") {
    const env = config?.mcpServers.knitbrain?.env;
    if (existing && /^\s*\[mcp_servers\.knitbrain\]/m.test(existing)) {
      // Preserve unknown TOML fields and user env while updating only the
      // managed project-root setting. Avoid rewriting an existing table.
      if (!env?.KNITBRAIN_PROJECT_DIR) return { content: existing, changed: false };
      const nestedEnvHeader = /^\s*\[mcp_servers\.knitbrain\.env\]\s*(?:#.*)?\r?$/m.exec(existing);
      if (nestedEnvHeader?.index !== undefined) {
        const nestedStart = nestedEnvHeader.index + nestedEnvHeader[0].length;
        const nestedEndMatch = /^\s*\[[^\]]+\]\s*(?:#.*)?\r?$/m.exec(existing.slice(nestedStart));
        const nestedEnd = nestedEndMatch?.index === undefined ? existing.length : nestedStart + nestedEndMatch.index;
        const nestedBody = existing.slice(nestedStart, nestedEnd);
        const assignment = /^\s*KNITBRAIN_PROJECT_DIR\s*=.*$/m;
        const replacement = `KNITBRAIN_PROJECT_DIR = ${JSON.stringify(env.KNITBRAIN_PROJECT_DIR)}`;
        const updatedNested = assignment.test(nestedBody)
          ? nestedBody.replace(assignment, replacement)
          : `${nestedBody.replace(/\s*$/, "\n")}${replacement}\n`;
        const content = existing.slice(0, nestedStart) + updatedNested + existing.slice(nestedEnd);
        return { content, changed: content !== existing };
      }
      const header = /^\s*\[mcp_servers\.knitbrain\]\s*(?:#.*)?\r?$/m.exec(existing);
      if (!header || header.index === undefined) return { content: existing, changed: false };
      const headerEnd = header.index + header[0].length;
      const headerNewline = existing.startsWith("\r\n", headerEnd) ? "\r\n" : existing[headerEnd] === "\n" ? "\n" : "";
      const bodyStart = headerEnd + headerNewline.length;
      const nextTable = /^\s*\[[^\]]+\]\s*(?:#.*)?\r?$/m.exec(existing.slice(bodyStart));
      const bodyEnd = nextTable?.index === undefined ? existing.length : bodyStart + nextTable.index;
      const body = existing.slice(bodyStart, bodyEnd);
      const envInline = /^\s*env\s*=\s*\{([^}]*)\}/m;
      const inlineMatch = body.match(envInline);
      let updatedBody: string;
      if (inlineMatch) {
        const assignments = (inlineMatch[1] ?? "").split(",").map((part) => part.trim()).filter(Boolean)
          .filter((part) => !/^KNITBRAIN_PROJECT_DIR\s*=/.test(part));
        assignments.push(`KNITBRAIN_PROJECT_DIR = ${JSON.stringify(env.KNITBRAIN_PROJECT_DIR)}`);
        updatedBody = body.replace(envInline, `env = { ${assignments.join(", ")} }`);
      } else if (/^\s*env\s*=\s*\{/m.test(body)) {
        // Multiline/complex inline TOML is not safely editable without a TOML parser.
        return { content: existing, changed: false };
      } else {
        updatedBody = `${body.replace(/\s*$/, "\n")}env = { KNITBRAIN_PROJECT_DIR = ${JSON.stringify(env.KNITBRAIN_PROJECT_DIR)} }\n`;
      }
      const content = existing.slice(0, bodyStart) + updatedBody + existing.slice(bodyEnd);
      return { content, changed: content !== existing };
    }
    const block = `[mcp_servers.knitbrain]\ncommand = "knitbrain"${env?.KNITBRAIN_PROJECT_DIR ? `\nenv = { KNITBRAIN_PROJECT_DIR = ${JSON.stringify(env.KNITBRAIN_PROJECT_DIR)} }` : ""}\n`;
    const base = existing ? existing.replace(/\n*$/, "\n\n") : "";
    return { content: base + block, changed: true };
  }

  // JSON kinds: parse (treat malformed as empty — it's backed up first), merge.
  let parsed: Record<string, unknown> = {};
  if (existing) {
    try {
      parsed = JSON.parse(existing) as Record<string, unknown>;
    } catch {
      parsed = {};
    }
  }

  if (kind === "zed") {
    const servers = { ...((parsed["context_servers"] as Record<string, unknown>) ?? {}) };
    const prior = servers["knitbrain"] && typeof servers["knitbrain"] === "object" ? servers["knitbrain"] as Record<string, unknown> : {};
    servers["knitbrain"] = { ...prior, command: { path: "knitbrain" }, ...(config?.mcpServers.knitbrain?.env ? { env: { ...((prior["env"] as Record<string, unknown>) ?? {}), ...config.mcpServers.knitbrain.env } } : {}) };
    if (existing && JSON.stringify(JSON.parse(existing)) === JSON.stringify({ ...parsed, context_servers: servers })) return { content: existing, changed: false };
    return { content: JSON.stringify({ ...parsed, context_servers: servers }, null, 2) + "\n", changed: true };
  }

  // windsurf + copilot-cli both use the standard "mcpServers" key.
  const servers = { ...((parsed["mcpServers"] as Record<string, unknown>) ?? {}) };
  const prior = servers["knitbrain"] && typeof servers["knitbrain"] === "object" ? servers["knitbrain"] as Record<string, unknown> : {};
  const generated = config?.mcpServers.knitbrain ?? (kind === "copilot-cli"
    ? { type: "local", command: "knitbrain", tools: ["*"] }
    : { command: "knitbrain" });
  servers["knitbrain"] = {
    ...prior,
    ...generated,
    ...(generated.env || prior["env"] ? { env: { ...((prior["env"] as Record<string, unknown>) ?? {}), ...(generated.env ?? {}) } } : {}),
    ...(kind === "copilot-cli" && !generated.type ? { type: "local", tools: ["*"] } : {}),
  };
  if (existing) {
    try {
      if (JSON.stringify(JSON.parse(existing)) === JSON.stringify({ ...parsed, mcpServers: servers })) return { content: existing, changed: false };
    } catch { /* malformed original is backed up by applyGlobalConfig */ }
  }
  return { content: JSON.stringify({ ...parsed, mcpServers: servers }, null, 2) + "\n", changed: true };
}

export interface GlobalConfigIO {
  exists: (p: string) => boolean;
  read: (p: string) => string;
  write: (p: string, data: string) => void;
  mkdirp: (dir: string) => void;
}

const defaultIO: GlobalConfigIO = {
  exists: existsSync,
  read: (p) => readFileSync(p, "utf8"),
  write: (p, data) => {
    writeAtomic(p, data);
  },
  mkdirp: (dir) => mkdirSync(dir, { recursive: true }),
};

export type GlobalConfigStatus = "written" | "present" | "created";

/**
 * Apply the knitbrain block to a global config file. Backs up the original to
 * `<file>.bak-<ts>` before writing. Returns the path + what happened.
 */
export function applyGlobalConfig(
  kind: GlobalConfigKind,
  home: string,
  io: GlobalConfigIO = defaultIO,
  options: { config?: SetupConfig; codexHome?: string } = {},
): { path: string; status: GlobalConfigStatus } {
  const full = join(kind === "codex" && options.codexHome ? options.codexHome : home, ...(kind === "codex" && options.codexHome ? ["config.toml"] : GLOBAL_CONFIG_PATHS[kind]));
  const existed = io.exists(full);
  const existing = existed ? io.read(full) : null;
  const { content, changed } = mergeGlobalConfig(kind, existing, options.config);
  if (!changed) return { path: full, status: "present" };
  io.mkdirp(dirname(full));
  if (existed && existing !== null) io.write(`${full}.bak-${Date.now()}`, existing);
  io.write(full, content);
  return { path: full, status: existed ? "written" : "created" };
}

/** Apply Codex config to one project so workspace selection stays project-scoped. */
export function applyProjectCodexConfig(
  projectRoot: string,
  config: SetupConfig,
  io: GlobalConfigIO = defaultIO,
): { path: string; status: GlobalConfigStatus } {
  const full = join(projectRoot, ".codex", "config.toml");
  const existed = io.exists(full);
  const existing = existed ? io.read(full) : null;
  const { content, changed } = mergeGlobalConfig("codex", existing, config);
  if (!changed) return { path: full, status: "present" };
  io.mkdirp(dirname(full));
  if (existed && existing !== null) io.write(`${full}.bak-${Date.now()}`, existing);
  io.write(full, content);
  return { path: full, status: existed ? "written" : "created" };
}
