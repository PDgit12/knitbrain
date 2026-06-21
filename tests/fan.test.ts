import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTasks, markDone, runFan } from "../src/fan.js";

const OK = `node -e ""`;
const FAIL = `node -e "process.exit(1)"`;

describe("fan — queue parsing + marking (pure)", () => {
  it("parses open tasks and ignores done ones", () => {
    expect(parseTasks("- [ ] a\n- [x] b\n- [ ] c\n")).toEqual(["a", "c"]);
  });
  it("marks a single task done without touching others", () => {
    const out = markDone("- [ ] a\n- [ ] b\n", "a");
    expect(out).toContain("- [x] a");
    expect(out).toContain("- [ ] b");
  });
});

describe("fan — parallel orchestration (--no-isolate, mock agents)", () => {
  let dir: string;
  let goal: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kb-fan-"));
    goal = join(dir, "goal.md");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("N workers drain the whole queue, each task marked exactly once", async () => {
    writeFileSync(goal, "# goal\n" + Array.from({ length: 6 }, (_, i) => `- [ ] task ${i}`).join("\n") + "\n");
    const code = await runFan([goal, "--workers", "3", "--agent", OK, "--verify", OK, "--max", "50", "--no-isolate"]);
    expect(code).toBe(0);
    const out = readFileSync(goal, "utf8");
    expect((out.match(/- \[x\]/g) ?? []).length).toBe(6); // all done
    expect(out).not.toContain("- [ ]"); // none left
  });

  it("respects --max across workers", async () => {
    writeFileSync(goal, Array.from({ length: 10 }, (_, i) => `- [ ] t${i}`).join("\n") + "\n");
    await runFan([goal, "--workers", "4", "--agent", OK, "--verify", OK, "--max", "3", "--no-isolate"]);
    const done = (readFileSync(goal, "utf8").match(/- \[x\]/g) ?? []).length;
    expect(done).toBeLessThanOrEqual(3 + 4); // cap respected (allow in-flight slack across workers)
    expect(done).toBeGreaterThanOrEqual(3);
  });

  it("verify-fail leaves tasks unmarked and exits 1 (no false green)", async () => {
    writeFileSync(goal, "- [ ] risky\n");
    const code = await runFan([goal, "--workers", "2", "--agent", OK, "--verify", FAIL, "--max", "10", "--no-isolate"]);
    expect(code).toBe(1);
    expect(readFileSync(goal, "utf8")).toContain("- [ ] risky");
  });
});
