import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLoop, goalVerify } from "../src/loop.js";

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

  // Gap 3: the goal.md `VERIFY:` line onboarding writes must actually gate the
  // loop when no --verify is passed (it was decorative before).
  it("goalVerify reads the VERIFY: line, ignoring (unspecified)", () => {
    writeFileSync(goal, "# g\nVERIFY: cargo test\n\n- [ ] a\n");
    expect(goalVerify(goal)).toBe("cargo test");
    writeFileSync(goal, "# g\nVERIFY: (unspecified)\n- [ ] a\n");
    expect(goalVerify(goal)).toBe("");
    writeFileSync(goal, "# g\n- [ ] a\n");
    expect(goalVerify(goal)).toBe("");
  });

  it("uses the goal.md VERIFY: gate when --verify is omitted (no false green)", async () => {
    writeFileSync(goal, `# g\nVERIFY: ${FAIL}\n\n- [ ] risky\n`);
    const code = await runLoop([goal, "--agent", OK, "--max", "2"]);
    expect(code).toBe(1);
    expect(readFileSync(goal, "utf8")).toContain("- [ ] risky"); // gate failed → untouched
  });

  it("--verify overrides the goal.md VERIFY: line", async () => {
    writeFileSync(goal, `# g\nVERIFY: ${FAIL}\n\n- [ ] ok\n`);
    const code = await runLoop([goal, "--agent", OK, "--verify", OK, "--max", "1"]);
    expect(code).toBe(0);
    expect(readFileSync(goal, "utf8")).toContain("- [x] ok"); // explicit --verify wins
  });

  // The crux of the vision: ONE command drives a task until the gate is met,
  // re-attempting across cycles (not a one-shot checklist walk).
  it("retries a failing task across cycles until the gate passes, then completes", async () => {
    writeFileSync(goal, "# g\n- [ ] make it green\n");
    const counter = join(dir, "n.txt");
    // Agent appends a line each cycle; gate passes only once the file has >= 3 lines.
    const agent = `node -e "require('fs').appendFileSync('${counter.replace(/\\/g, "\\\\")}','x\\n')"`;
    const gate = `node -e "process.exit((require('fs').existsSync('${counter.replace(/\\/g, "\\\\")}')?require('fs').readFileSync('${counter.replace(/\\/g, "\\\\")}','utf8').trim().split('\\n').length:0)>=3?0:1)"`;
    const code = await runLoop([goal, "--agent", agent, "--verify", gate, "--max", "6"]);
    expect(code).toBe(0);
    expect(readFileSync(goal, "utf8")).toContain("- [x] make it green");
  });

  it("hits --max with the gate still red → exit 1, no false green", async () => {
    writeFileSync(goal, "# g\n- [ ] impossible\n");
    const code = await runLoop([goal, "--agent", OK, "--verify", FAIL, "--max", "3"]);
    expect(code).toBe(1);
    expect(readFileSync(goal, "utf8")).toContain("- [ ] impossible"); // never ticked
  });
});
