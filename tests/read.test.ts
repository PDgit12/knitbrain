import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileCCRStore, type CCRStore } from "../src/ccr/store.js";
import { createMemory } from "../src/engine/memory.js";
import { createKnowledge } from "../src/engine/knowledge.js";
import { createFeedback } from "../src/engine/feedback.js";
import { createTeamBoard } from "../src/engine/teams.js";
import { createMeter } from "../src/engine/meter.js";
import { createSkillsStore } from "../src/engine/skills.js";
import { createCalibration } from "../src/engine/calibration.js";
import { TOOLS, type ToolContext } from "../src/mcp/tools.js";
import { countTokens } from "../src/tokenizer.js";
import { readFileSync } from "node:fs";

describe("knitbrain_read — universal optimized read (works on every MCP platform)", () => {
  let root: string;
  let ctx: ToolContext;
  let ccr: CCRStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "knitbrain-read-"));
    ccr = createFileCCRStore(join(root, "ccr"));
    ctx = {
      ccr,
      memory: createMemory(join(root, "mem")),
      knowledge: createKnowledge(root, join(root, "kn")),
      feedback: createFeedback(join(root, "fb")),
      team: createTeamBoard(join(root, "team"), ccr),
      meter: createMeter(join(root, "meter")),
      skills: createSkillsStore(join(root, "skills")),
      calibration: createCalibration(join(root, "cal")),
    };
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const read = TOOLS.find((t) => t.name === "knitbrain_read")!;

  it("reads a real source file as a smaller skeleton with a recovery handle", () => {
    // a real, body-heavy file from THIS repo (cwd during tests)
    const path = "src/optimizer/code.ts";
    const original = readFileSync(path, "utf8");
    const out = read.run({ path }, ctx);
    expect(countTokens(out)).toBeLessThan(countTokens(original));
    const handle = out.match(/⟨recall:([0-9a-f]{64})⟩/)?.[1];
    expect(handle).toBeDefined();
    expect(ccr.get(handle!)).toBe(original); // exact original recoverable
  });

  it("returns exact content for small/incompressible files (never worse)", () => {
    const out = read.run({ path: "src/version.ts" }, ctx);
    expect(out).toBe(readFileSync("src/version.ts", "utf8"));
  });

  it("accepts ABSOLUTE paths (drop-in for the host's raw Read) and errors on a missing file", () => {
    // The host (Claude Code, etc.) passes absolute paths — these must work, or
    // the tool is useless as a raw-Read replacement (the field bug it fixes).
    const abs = join(root, "abs.ts");
    writeFileSync(abs, "export const a = 1;\n");
    expect(read.run({ path: abs }, ctx)).toContain("export const a");
    expect(read.run({ path: join(root, "nope.ts") }, ctx)).toContain("no such file");
  });

  it("reports a clean miss for nonexistent files", () => {
    expect(read.run({ path: "src/nope.ts" }, ctx)).toContain("no such file");
  });
});
