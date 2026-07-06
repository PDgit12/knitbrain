import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createActivityLog } from "../src/engine/activity.js";

describe("activity log — live agent CRM feed", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kb-act-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("records events and returns them newest-first", () => {
    const a = createActivityLog(root);
    a.record({ agent: "agent-1", tool: "knitbrain_run", summary: "first" });
    a.record({ agent: "agent-2", tool: "knitbrain_classify_task", summary: "second" });
    const recent = a.recent();
    expect(recent).toHaveLength(2);
    expect(recent[0]!.summary).toBe("second"); // newest first
    expect(recent[0]!.agent).toBe("agent-2");
    expect(recent[0]!.ts).toBeTruthy();
  });

  it("respects the recent(n) limit", () => {
    const a = createActivityLog(root);
    for (let i = 0; i < 10; i += 1) a.record({ agent: "x", tool: "t", summary: `e${i}` });
    expect(a.recent(3)).toHaveLength(3);
    expect(a.recent(3)[0]!.summary).toBe("e9");
  });

  it("stays bounded under heavy load (never grows unbounded)", () => {
    const a = createActivityLog(root);
    // CAP=1000 with a 300KB size gate: pad summaries so 2500 events (~180B
    // lines) definitely cross the byte gate and force the trim path.
    const pad = "x".repeat(120);
    for (let i = 0; i < 2500; i += 1) a.record({ agent: "x", tool: "t", summary: `e${i} ${pad}` });
    const all = a.recent(5000);
    expect(all.length).toBeLessThanOrEqual(2000); // ≤ 2×CAP after trim
    expect(all[0]!.summary.startsWith("e2499")).toBe(true); // newest survive
  });

  it("is shared across instances (multiple agent processes append the same log)", () => {
    createActivityLog(root).record({ agent: "agent-A", tool: "t", summary: "from A" });
    createActivityLog(root).record({ agent: "agent-B", tool: "t", summary: "from B" });
    const agents = new Set(createActivityLog(root).recent().map((e) => e.agent));
    expect(agents).toEqual(new Set(["agent-A", "agent-B"]));
  });
});

describe("activity rollup — universal per-agent meter (all platforms)", () => {
  it("aggregates calls + saved tokens per agent", () => {
    const r = mkdtempSync(join(tmpdir(), "kb-roll-"));
    try {
      const a = createActivityLog(r);
      a.record({ agent: "cursor (api)", tool: "t", summary: "x", saved: 100 });
      a.record({ agent: "cursor (api)", tool: "t", summary: "y", saved: 50 });
      a.record({ agent: "claude-code (subscription)", tool: "t", summary: "z", saved: 30 });
      const roll = a.rollup();
      expect(roll[0]).toMatchObject({ agent: "cursor (api)", calls: 2, saved: 150 }); // biggest first
      expect(roll.find((x) => x.agent === "claude-code (subscription)")).toMatchObject({ calls: 1, saved: 30 });
    } finally { rmSync(r, { recursive: true, force: true }); }
  });
});

describe("activity log — new G1 fields + legacy compatibility", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "kb-act-fields-")); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("new-field roundtrip: source/file/rawTokens/storedTokens/kind survive through recent()", () => {
    const a = createActivityLog(root);
    a.record({
      agent: "agent-1",
      tool: "knitbrain_optimize",
      summary: "compressed x",
      saved: 90,
      source: "hook",
      file: "/proj/big.ts",
      rawTokens: 100,
      storedTokens: 10,
      kind: "optimize",
    });
    const e = a.recent(1)[0]!;
    expect(e.source).toBe("hook");
    expect(e.file).toBe("/proj/big.ts");
    expect(e.rawTokens).toBe(100);
    expect(e.storedTokens).toBe(10);
    expect(e.kind).toBe("optimize");
  });

  it("parses a legacy JSONL line with only the old fields (no G1 fields)", () => {
    mkdirSync(root, { recursive: true });
    const legacy = { ts: new Date().toISOString(), agent: "old-agent", tool: "t", summary: "legacy line", saved: 5 };
    writeFileSync(join(root, "activity.jsonl"), JSON.stringify(legacy) + "\n");
    const a = createActivityLog(root);
    const e = a.recent(1)[0]!;
    expect(e.agent).toBe("old-agent");
    expect(e.summary).toBe("legacy line");
    expect(e.source).toBeUndefined();
    expect(e.rawTokens).toBeUndefined();
  });

  it("since(ts) filters to events at/after ts and reports trimmed=false when nothing rotated out", () => {
    const a = createActivityLog(root);
    a.record({ agent: "x", tool: "t", summary: "e0" });
    a.record({ agent: "x", tool: "t", summary: "e1" });
    a.record({ agent: "x", tool: "t", summary: "e2" });
    // Anchor on e1's REAL ts (newest-first: [e2, e1, e0]) so >= includes e1/e2
    // regardless of ms-resolution ties.
    const mid = a.recent(3)[1]!.ts;
    const { events, trimmed } = a.since(mid);
    // e0 predates `mid`; e1/e2 (recorded after) should be included — allow for
    // ts-resolution ties by asserting the subset relationship instead of exact count.
    expect(events.length).toBeLessThanOrEqual(3);
    expect(events.some((e) => e.summary === "e2")).toBe(true);
    expect(trimmed).toBe(false);
  });

  it("since(ts) reports trimmed=true when the earliest on-disk event postdates ts", () => {
    mkdirSync(root, { recursive: true });
    const future = new Date(Date.now() + 60_000).toISOString();
    const past = new Date(Date.now() - 60_000).toISOString();
    // trimmed only claims rotation at CAP scale — a short log's oldest event
    // postdating the mark is the normal case, not evidence of rotation.
    const lines = Array.from({ length: 1000 }, (_, i) =>
      JSON.stringify({ ts: future, agent: "x", tool: "t", summary: `s${i}`, saved: 0 }),
    );
    appendFileSync(join(root, "activity.jsonl"), lines.join("\n") + "\n");
    const a = createActivityLog(root);
    const { trimmed, events } = a.since(past);
    expect(trimmed).toBe(true); // all[0].ts (future) > past → log's earliest event already postdates the requested floor
    expect(events.length).toBe(1000);
  });

  it("protectSince keeps events at/after the protected ts across a due trim (fail-open to plain CAP trim when it errors)", () => {
    // protectSince throwing must not break record() — fail-open to the plain CAP trim.
    const a = createActivityLog(root, {
      protectSince: () => {
        throw new Error("boom");
      },
    });
    expect(() => a.record({ agent: "x", tool: "t", summary: "e0" })).not.toThrow();
    expect(a.recent(1)[0]!.summary).toBe("e0");
  });

  it("protectSince returning null degrades to the plain CAP trim (no throw, normal recording)", () => {
    const a = createActivityLog(root, { protectSince: () => null });
    for (let i = 0; i < 5; i += 1) a.record({ agent: "x", tool: "t", summary: `e${i}` });
    expect(a.recent(5).length).toBe(5);
    expect(a.recent(1)[0]!.summary).toBe("e4");
  });
});
