import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { diagnoseSetup } from "../src/doctor.js";

function fixture(): { root: string; cwd: string; home: string; modulePath: string } {
  const root = mkdtempSync(join(tmpdir(), "knitbrain-doctor-"));
  const cwd = join(root, "project");
  const home = join(root, "home");
  const packageRoot = join(root, "package");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(join(packageRoot, "src"), { recursive: true });
  mkdirSync(join(packageRoot, "dist"), { recursive: true });
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "knitbrain", version: "9.8.7" }));
  writeFileSync(join(packageRoot, "src", "index.ts"), "");
  writeFileSync(join(packageRoot, "dist", "index.js"), "");
  return { root, cwd, home, modulePath: join(packageRoot, "src", "doctor.js") };
}

describe("diagnoseSetup", () => {
  it("separates app markers, readable host config, executable lookup, runtime identity, and connection proof", () => {
    const f = fixture();
    try {
      mkdirSync(join(f.cwd, ".cursor"));
      writeFileSync(join(f.cwd, ".mcp.json"), JSON.stringify({
        mcpServers: { knitbrain: { command: "knitbrain", env: { PRIVATE_TEST_VALUE: "must-not-leak" } } },
      }));
      writeFileSync(join(f.cwd, ".cursor", "mcp.json"), JSON.stringify({
        mcpServers: { knitbrain: { type: "stdio", command: "/missing/knitbrain", env: { KNITBRAIN_PROJECT_DIR: "/other/project" } } },
      }));
      mkdirSync(join(f.cwd, ".cursor"), { recursive: true });
      writeFileSync(join(f.cwd, ".cursor", "hooks.json"), JSON.stringify({
        hooks: { subagentStart: [{ command: "knitbrain-hook subagentstart" }], preCompact: [{ command: "knitbrain-hook precompact" }] },
      }));
      mkdirSync(join(f.cwd, ".claude"), { recursive: true });
      writeFileSync(join(f.cwd, ".claude", "settings.json"), JSON.stringify({ hooks: {
        UserPromptSubmit: [{ hooks: [{ command: "knitbrain-hook userpromptsubmit" }] }],
        SubagentStart: [{ hooks: [{ command: "knitbrain-hook subagentstart" }] }],
      } }));
      const customCodex = join(f.home, "codex-home");
      mkdirSync(customCodex);
      writeFileSync(join(customCodex, "config.toml"), '[mcp_servers.knitbrain]\ncommand = "knitbrain"\nenv = { KNITBRAIN_PROJECT_DIR = "/other/project" }\n');
      writeFileSync(join(customCodex, "hooks.json"), JSON.stringify({ SubagentStart: [{ hooks: [{ command: "knitbrain-hook subagentstart" }] }] }));

      const report = diagnoseSetup({
        cwd: f.cwd,
        home: f.home,
        modulePath: f.modulePath,
        env: { CODEX_HOME: customCodex, CURSOR_TRACE_ID: "trace", CLAUDE_CONFIG_DIR: join(f.home, "claude-config") },
        resolveCommand: (command) => command === "knitbrain" ? "/usr/local/bin/knitbrain" : null,
      });

      expect(report.runtime).toMatchObject({
        packageVersion: "9.8.7",
        sourceTreePresent: true,
        distPresent: true,
        mode: "source-checkout",
      });
      expect(report.hosts["claude-code"].app.status).toBe("present");
      expect(report.hosts["claude-code"].configs[0]).toMatchObject({ status: "readable", knitbrainEntry: true, command: "knitbrain", commandResolved: true });
      expect(report.hosts.codex.app.status).toBe("present");
      expect(report.hosts.codex.configs[1]).toMatchObject({ status: "readable", knitbrainEntry: true, command: "knitbrain", commandResolved: true });
      expect(report.hosts.cursor.app.status).toBe("present");
      expect(report.hosts.cursor.configs[0]).toMatchObject({ status: "readable", knitbrainEntry: true, command: "/missing/knitbrain", commandResolved: false });
      expect(report.hosts.cursor.configs[0]?.projectRootStatus).toBe("mismatch");
      expect(report.hosts.cursor.hooks[0]?.bindings).toContainEqual(expect.objectContaining({ event: "subagentStart", command: "knitbrain-hook subagentstart" }));
      expect(report.hosts.codex.configs[1]?.projectRootStatus).toBe("mismatch");
      expect(report.hosts.codex.hooks[1]?.bindings[0]?.command).toBe("knitbrain-hook subagentstart");
      expect(report.hosts["claude-code"].hooks[0]?.bindings.map((binding) => binding.command)).toContain("knitbrain-hook subagentstart");
      expect(report.hosts["claude-code"].hooks[0]?.bindings).toContainEqual(expect.objectContaining({ event: "UserPromptSubmit", command: "knitbrain-hook userpromptsubmit" }));
      expect(report.connection).toMatchObject({ verified: false, status: "not-observable" });
      expect(JSON.stringify(report)).not.toContain("must-not-leak");
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("reports absent, malformed, oversized, and unsupported TOML config honestly", () => {
    const f = fixture();
    try {
      writeFileSync(join(f.cwd, ".mcp.json"), "{bad json");
      mkdirSync(join(f.cwd, ".cursor"));
      writeFileSync(join(f.cwd, ".cursor", "mcp.json"), " ".repeat(256 * 1024 + 1));
      mkdirSync(join(f.cwd, ".codex"));
      writeFileSync(join(f.cwd, ".codex", "config.toml"), '["mcp_servers"."knitbrain"]\ncommand = "knitbrain"\n');

      const report = diagnoseSetup({ cwd: f.cwd, home: f.home, modulePath: f.modulePath, env: {} });
      expect(report.hosts["claude-code"].configs[0]).toMatchObject({ status: "malformed", knitbrainEntry: null });
      expect(report.hosts.cursor.configs[0]).toMatchObject({ status: "too-large", knitbrainEntry: null });
      expect(report.hosts.codex.configs[0]).toMatchObject({ status: "readable", knitbrainEntry: null, command: null });
      expect(report.hosts.codex.configs[1]).toMatchObject({ status: "missing", knitbrainEntry: null });
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("uses bounded reads and performs no writes", () => {
    const f = fixture();
    try {
      const calls: number[] = [];
      const report = diagnoseSetup({
        cwd: f.cwd,
        home: f.home,
        modulePath: f.modulePath,
        env: {},
        readText: (path, maxBytes) => {
          calls.push(maxBytes);
          if (path.endsWith("package.json")) return { status: "readable", content: readFileSync(join(dirname(f.modulePath), "..", "package.json"), "utf8") };
          return { status: "missing" };
        },
        exists: () => false,
      });
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.every((n) => n === 256 * 1024)).toBe(true);
      expect(report.connection.verified).toBe(false);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
});
