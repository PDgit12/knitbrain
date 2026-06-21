import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLoop } from "../src/loop.js";

// Cross-platform mock commands (CI runs a Windows matrix — avoid sh builtins).
const OK = `node -e ""`;
const FAIL = `node -e "process.exit(1)"`;

describe("runLoop — autonomous outer loop", () => {
  let dir: string;
  let goal: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kb-loop-"));
    goal = join(dir, "goal.md");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("ticks every task when agent + verify succeed, and logs progress", async () => {
    writeFileSync(goal, "# goal\n- [ ] task one\n- [ ] task two\n");
    const code = await runLoop([goal, "--agent", OK, "--verify", OK, "--max", "10"]);
    expect(code).toBe(0);
    const out = readFileSync(goal, "utf8");
    expect(out).toContain("- [x] task one");
    expect(out).toContain("- [x] task two");
    expect(existsSync(`${goal}.progress`)).toBe(true);
  });

  it("respects --max (hard runaway cap)", async () => {
    writeFileSync(goal, "- [ ] a\n- [ ] b\n- [ ] c\n");
    await runLoop([goal, "--agent", OK, "--verify", OK, "--max", "1"]);
    const ticks = (readFileSync(goal, "utf8").match(/- \[x\]/g) ?? []).length;
    expect(ticks).toBe(1);
  });

  it("stops and does NOT mark done when verify fails (no false green)", async () => {
    writeFileSync(goal, "- [ ] risky\n");
    const code = await runLoop([goal, "--agent", OK, "--verify", FAIL, "--max", "3"]);
    expect(code).toBe(1);
    expect(readFileSync(goal, "utf8")).toContain("- [ ] risky"); // untouched
  });

  it("fails closed when the agent command errors", async () => {
    writeFileSync(goal, "- [ ] x\n");
    expect(await runLoop([goal, "--agent", FAIL, "--verify", OK, "--max", "3"])).toBe(1);
  });

  it("usage error on a missing goal file", async () => {
    expect(await runLoop([join(dir, "nope.md"), "--agent", OK])).toBe(1);
  });
});
