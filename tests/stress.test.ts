import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compress } from "../src/optimizer/router.js";
import { createFileCCRStore } from "../src/ccr/store.js";
import { createKnowledge } from "../src/engine/knowledge.js";
import { runLoop } from "../src/loop.js";
import { createMemory } from "../src/engine/memory.js";
import { createFeedback } from "../src/engine/feedback.js";
import { createTeamBoard } from "../src/engine/teams.js";
import { createMeter } from "../src/engine/meter.js";
import { createSkillsStore } from "../src/engine/skills.js";
import { createCalibration } from "../src/engine/calibration.js";
import { TOOLS, dispatch, type ToolContext } from "../src/mcp/tools.js";

// Heavy-workflow robustness: prove the hardening holds under load and that big
// inputs stay LOSSLESS + bounded. These double as regression guards.
describe("stress / production robustness", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "kb-stress-")); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const ccr = () => createFileCCRStore(join(root, "ccr-" + Math.random().toString(36).slice(2)));

  it("large repetitive payload compresses and recovers byte-for-byte", () => {
    const store = ccr();
    const big = "line of log output number\n".repeat(60_000); // ~1.6 MB
    const r = compress(big, store);
    expect(r.compressed).toBe(true);
    expect(store.get(r.handle)).toBe(big); // lossless
  });

  it("ENORMOUS payload (>MAX_DEEP_PARSE) still lossless via the cheap path", () => {
    const store = ccr();
    const huge = "x".repeat(9_000_000) + "\nMARKER\n"; // >8 MB → line handler, no parser/tokenizer stall
    const r = compress(huge, store);
    // Lossless either way: compressed → recoverable from CCR; incompressible → passed through unchanged.
    expect(r.compressed ? store.get(r.handle) : r.skeleton).toBe(huge);
  });

  it("concurrent compress calls on one store stay independent + lossless", async () => {
    const store = ccr();
    const payloads = Array.from({ length: 24 }, (_, i) => `payload ${i}\n`.repeat(2000));
    const results = await Promise.all(payloads.map((p) => Promise.resolve(compress(p, store))));
    results.forEach((r, i) => {
      if (r.compressed) expect(store.get(r.handle)).toBe(payloads[i]);
    });
  });

  it("big knowledge graph (200 files) scans and resolves in bounded time", () => {
    mkdirSync(join(root, "src"), { recursive: true });
    for (let i = 0; i < 200; i++) {
      const dep = i > 0 ? `import { f${i - 1} } from "./m${i - 1}.js";\n` : "";
      writeFileSync(join(root, "src", `m${i}.ts`), `${dep}export const f${i} = ${i};\n`);
    }
    const k = createKnowledge(root, join(root, "kb"));
    const t0 = Date.now();
    expect(k.scan().files).toBe(200);
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(k.queryDependents("src/m0.ts")).toContain("src/m1.ts");
  });

  it("long loop with many checkboxes respects --max (no runaway)", async () => {
    const goal = join(root, "goal.md");
    const boxes = Array.from({ length: 30 }, (_, i) => `- [ ] task ${i}`).join("\n");
    writeFileSync(goal, `# big goal\n${boxes}\n`);
    const OK = `node -e ""`;
    await runLoop([goal, "--agent", OK, "--verify", OK, "--max", "5"]);
    const ticks = (readFileSync(goal, "utf8").match(/- \[x\]/g) ?? []).length;
    expect(ticks).toBe(5); // hard cap honored
  });

  it("complex classify returns a FORCEFUL, platform-agnostic plan gate (Part D)", () => {
    const c = createFileCCRStore(join(root, "ccr-d"));
    const ctx: ToolContext = {
      ccr: c, memory: createMemory(join(root, "mem")), knowledge: createKnowledge(root, join(root, "kb")),
      feedback: createFeedback(join(root, "fb")), team: createTeamBoard(join(root, "team"), c),
      meter: createMeter(join(root, "meter")), skills: createSkillsStore(join(root, "sk")),
      calibration: createCalibration(join(root, "cal")),
    };
    const out = dispatch(
      TOOLS.find((t) => t.name === "knitbrain_classify_task")!,
      { description: "refactor the auth system across modules and types", files: ["a.ts", "b.ts", "c.ts", "d.ts"] },
      ctx,
    );
    const j = JSON.parse(out) as { autoPlanMode: boolean; directive: string };
    expect(j.autoPlanMode).toBe(true);
    expect(j.directive).toContain("STOP"); // forceful, not a soft flag
    expect(j.directive.toLowerCase()).toContain("plan mode"); // hosts that have it
    expect(j.directive.toLowerCase()).toMatch(/approval|approved/); // hosts that don't
  });
});
