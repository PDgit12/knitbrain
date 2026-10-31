import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileCCRStore } from "../src/ccr/store.js";
import { createMemory } from "../src/engine/memory.js";
import { createKnowledge } from "../src/engine/knowledge.js";
import { createFeedback } from "../src/engine/feedback.js";
import { createTeamBoard } from "../src/engine/teams.js";
import { createMeter } from "../src/engine/meter.js";
import { createSkillsStore } from "../src/engine/skills.js";
import { createCalibration } from "../src/engine/calibration.js";
import { TOOLS, type ToolContext } from "../src/mcp/tools.js";
import { countTokens } from "../src/tokenizer.js";

describe("emitted optimization accounting", () => {
  let root = "";
  afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });

  it("never expands optimize output and meters only complete emitted savings", () => {
    root = mkdtempSync(join(tmpdir(), "kb-emitted-optimize-"));
    const ccr = createFileCCRStore(join(root, "ccr"));
    const meter = createMeter(join(root, "meter"));
    const ctx: ToolContext = {
      ccr, meter,
      memory: createMemory(join(root, "memory")),
      knowledge: createKnowledge(root, join(root, "knowledge")),
      feedback: createFeedback(join(root, "feedback")),
      team: createTeamBoard(join(root, "team"), ccr),
      skills: createSkillsStore(join(root, "skills")),
      calibration: createCalibration(join(root, "calibration")),
    };
    const optimize = TOOLS.find((tool) => tool.name === "knitbrain_optimize")!;
    for (let n = 4; n <= 100; n += 4) {
      const original = JSON.stringify({ items: Array.from({ length: n }, (_, i) => ({ id: i, value: "x".repeat(12) })) });
      const before = meter.read().sessionSavedTokens ?? 0;
      const output = optimize.run({ text: original }, ctx);
      expect(countTokens(output), `n=${n}`).toBeLessThanOrEqual(countTokens(original));
      const saved = (meter.read().sessionSavedTokens ?? 0) - before;
      expect(saved).toBe(countTokens(original) - countTokens(output));
      if (output.includes("⟨recall:")) {
        const handle = output.match(/⟨recall:([a-f0-9]{64})⟩/)![1]!;
        expect(ccr.get(handle)).toBe(original);
      }
    }
  });

  it("counts read annotations and returns full original if the emitted wrapper is not smaller", () => {
    root = mkdtempSync(join(tmpdir(), "kb-emitted-read-"));
    const deep = join(root, "a", "b", "c", "input.txt");
    mkdirSync(join(root, "a", "b", "c"), { recursive: true });
    writeFileSync(deep, Array.from({ length: 300 }, (_, i) => `row ${i}: ${"detail ".repeat(8)}`).join("\n"), { flag: "w" });
    const ccr = createFileCCRStore(join(root, "ccr"));
    const meter = createMeter(join(root, "meter"));
    const ctx: ToolContext = {
      projectRoot: root, ccr, meter,
      memory: createMemory(join(root, "memory")),
      knowledge: createKnowledge(root, join(root, "knowledge")),
      feedback: createFeedback(join(root, "feedback")),
      team: createTeamBoard(join(root, "team"), ccr),
      skills: createSkillsStore(join(root, "skills")),
      calibration: createCalibration(join(root, "calibration")),
    };
    const original = readFileSync(deep, "utf8");
    const read = TOOLS.find((tool) => tool.name === "knitbrain_read")!;
    const before = meter.read().sessionSavedTokens ?? 0;
    const output = read.run({ path: "a/b/c/input.txt" }, ctx);
    expect(countTokens(output)).toBeLessThanOrEqual(countTokens(original));
    expect((meter.read().sessionSavedTokens ?? 0) - before).toBe(countTokens(original) - countTokens(output));
    if (output.includes("⟨recall:")) {
      const handle = output.match(/⟨recall:([a-f0-9]{64})⟩/)![1]!;
      expect(ccr.get(handle)).toBe(original);
    } else {
      expect(output).toBe(original);
    }
  });
});
