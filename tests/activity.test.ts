import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
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
    for (let i = 0; i < 500; i += 1) a.record({ agent: "x", tool: "t", summary: `e${i}` });
    // CAP=200; after trim the on-disk log holds ≤ ~400 (2×CAP) and the newest survive.
    const all = a.recent(1000);
    expect(all.length).toBeLessThanOrEqual(400);
    expect(all[0]!.summary).toBe("e499");
  });

  it("is shared across instances (multiple agent processes append the same log)", () => {
    createActivityLog(root).record({ agent: "agent-A", tool: "t", summary: "from A" });
    createActivityLog(root).record({ agent: "agent-B", tool: "t", summary: "from B" });
    const agents = new Set(createActivityLog(root).recent().map((e) => e.agent));
    expect(agents).toEqual(new Set(["agent-A", "agent-B"]));
  });
});
