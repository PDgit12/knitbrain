import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The compiled CLI entry (built by `npm run build`; the Stop hook builds too).
const CLI = join(process.cwd(), "dist", "index.js");

// Spawn the CLI with stdin already closed (input: "") so the no-arg MCP-server
// path can't block the test; a short timeout kills it if it stays serving.
const run = (args: string[]) =>
  spawnSync("node", [CLI, ...args], { input: "", timeout: 4000, encoding: "utf8" });

describe("CLI router — unknown-command guard (G3)", () => {
  // Build dist/ if a direct `vitest` run hasn't (verify builds first, but a
  // standalone run may not) — keeps the spawn test order-independent.
  beforeAll(() => {
    if (!existsSync(CLI)) {
      // shell:true so Windows resolves npm.cmd (bare "npm" is ENOENT there).
      const b = spawnSync("npm run build", { shell: true, encoding: "utf8", timeout: 120000 });
      if (b.status !== 0) throw new Error(`build failed: ${b.stderr ?? b.stdout}`);
    }
  }, 120000);

  it("an unknown subcommand exits 1 with an 'unknown command' message", () => {
    const r = run(["bogus"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("unknown command");
    expect(r.stderr).toContain("bogus");
  });

  it("a real subcommand is NOT treated as unknown (version prints + exits 0)", () => {
    const r = run(["version"]);
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain("unknown command");
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/); // semver
  });

  it("bare no-arg reaches the MCP-server path (NOT exit 1, NOT unknown-command)", () => {
    const r = run([]);
    // Server either exits cleanly on the closed stdin (status 0) or is still
    // serving when the timeout kills it (status null + a signal). Both mean it
    // took the buildServer() branch — the ONE thing it must never do is exit 1
    // as an unknown command.
    expect(r.status).not.toBe(1);
    expect(r.stderr).not.toContain("unknown command");
  });
});

describe("CLI statusline — loop badge (◎ goal iter N/M)", () => {
  let home: string;
  let projectDir: string;
  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
  });

  const seedLoopState = (state: Record<string, unknown> | null) => {
    home = mkdtempSync(join(tmpdir(), "kb-statusline-home-"));
    projectDir = mkdtempSync(join(tmpdir(), "kb-statusline-proj-"));
    const id = createHash("sha256").update(projectDir).digest("hex").slice(0, 16);
    if (state) {
      const projRoot = join(home, "projects", id);
      mkdirSync(projRoot, { recursive: true });
      writeFileSync(join(projRoot, "loop-state.json"), JSON.stringify(state));
    }
  };

  const runStatusline = () =>
    spawnSync("node", [CLI, "statusline"], {
      input: "",
      timeout: 4000,
      encoding: "utf8",
      env: { ...process.env, KNITBRAIN_HOME: home, KNITBRAIN_PROJECT_DIR: projectDir },
    });

  it("with seeded loop-state → badge shows ◎ and iter N/M", () => {
    if (!existsSync(CLI)) return; // dist not built in this run — see index-cli.test.ts build guard above
    seedLoopState({ goal: "ship the parser", iter: 3, maxIters: 6 });
    const r = runStatusline();
    expect(r.stdout).toContain("◎");
    expect(r.stdout).toContain("iter 3/6");
    expect(r.stdout).toContain("ship the parser");
  });

  it("without loop-state → no ◎ badge", () => {
    if (!existsSync(CLI)) return;
    seedLoopState(null);
    const r = runStatusline();
    expect(r.stdout).not.toContain("◎");
  });
});
