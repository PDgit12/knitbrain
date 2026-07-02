import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
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
