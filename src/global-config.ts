import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

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
): { content: string; changed: boolean } {
  // Codex uses TOML. No TOML dep — append a single table block if absent,
  // never reformat the rest of the user's file.
  if (kind === "codex") {
    if (existing && /^\s*\[mcp_servers\.knitbrain\]/m.test(existing)) {
      return { content: existing, changed: false };
    }
    const block = '[mcp_servers.knitbrain]\ncommand = "knitbrain"\n';
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
    if (servers["knitbrain"]) return { content: existing ?? "", changed: false };
    servers["knitbrain"] = { command: { path: "knitbrain" } };
    return { content: JSON.stringify({ ...parsed, context_servers: servers }, null, 2) + "\n", changed: true };
  }

  // windsurf + copilot-cli both use the standard "mcpServers" key.
  const servers = { ...((parsed["mcpServers"] as Record<string, unknown>) ?? {}) };
  if (servers["knitbrain"]) return { content: existing ?? "", changed: false };
  servers["knitbrain"] =
    kind === "copilot-cli"
      ? { type: "local", command: "knitbrain", tools: ["*"] }
      : { command: "knitbrain" };
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
    const tmp = `${p}.${process.pid}.tmp`;
    writeFileSync(tmp, data, "utf8");
    renameSync(tmp, p);
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
): { path: string; status: GlobalConfigStatus } {
  const full = join(home, ...GLOBAL_CONFIG_PATHS[kind]);
  const existed = io.exists(full);
  const existing = existed ? io.read(full) : null;
  const { content, changed } = mergeGlobalConfig(kind, existing);
  if (!changed) return { path: full, status: "present" };
  io.mkdirp(dirname(full));
  if (existed && existing !== null) io.write(`${full}.bak-${Date.now()}`, existing);
  io.write(full, content);
  return { path: full, status: existed ? "written" : "created" };
}
