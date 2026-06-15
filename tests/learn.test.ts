import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseSession,
  mineSession,
  mergeLearnings,
  renderSection,
  applyToClaudeMd,
  projectSlug,
} from "../src/learn.js";

/** Build a transcript line containing a tool_use (assistant side). */
const use = (id: string, name: string, input: Record<string, unknown>): string =>
  JSON.stringify({ message: { content: [{ type: "tool_use", id, name, input }] } });
/** Build a transcript line containing the matching tool_result (user side). */
const result = (id: string, content: string, isError = false): string =>
  JSON.stringify({ message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] } });

describe("knitbrain learn — failure mining with success correlation", () => {
  let root: string;
  beforeEach(() => (root = mkdtempSync(join(tmpdir(), "knitbrain-learn-"))));
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("correlates a failed Read with the later success on the same basename", async () => {
    const f = join(root, "s.jsonl");
    writeFileSync(
      f,
      [
        use("1", "Read", { file_path: "/repo/src/utils/Config.ts" }),
        result("1", "Error: File does not exist.", true),
        use("2", "Read", { file_path: "/repo/src/core/Config.ts" }),
        result("2", "export const config = {};"),
      ].join("\n"),
    );
    const learnings = mineSession(await parseSession(f));
    expect(learnings).toHaveLength(1);
    expect(learnings[0]!.category).toBe("paths");
    expect(learnings[0]!.text).toContain("/repo/src/utils/Config.ts");
    expect(learnings[0]!.text).toContain("actually at `/repo/src/core/Config.ts`");
  });

  it("correlates a failed command with the working variant on the same target", async () => {
    const f = join(root, "s.jsonl");
    writeFileSync(
      f,
      [
        use("1", "Bash", { command: "python3 scripts/train.py" }),
        result("1", "ModuleNotFoundError: No module named 'torch'", true),
        use("2", "Bash", { command: "uv run python scripts/train.py" }),
        result("2", "epoch 1 …"),
      ].join("\n"),
    );
    const learnings = mineSession(await parseSession(f));
    expect(learnings.some((l) => l.category === "commands" && l.text.includes("uv run python scripts/train.py"))).toBe(true);
  });

  it("flags runners that fail repeatedly and never succeed", async () => {
    const f = join(root, "s.jsonl");
    const lines: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      lines.push(use(`${i}`, "Bash", { command: `gradle build${i > 0 ? ` -p mod${i}` : ""}` }));
      lines.push(result(`${i}`, "command not found: gradle", true));
    }
    writeFileSync(f, lines.join("\n"));
    const learnings = mineSession(await parseSession(f));
    expect(learnings.some((l) => l.category === "environment" && l.text.includes("`gradle` failed 3×"))).toBe(true);
  });

  it("merges duplicates across sessions with evidence counts", () => {
    const merged = mergeLearnings([
      { category: "paths", text: "a → b", count: 1 },
      { category: "paths", text: "a → b", count: 1 },
      { category: "commands", text: "c", count: 1 },
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[0]!.count).toBe(2); // sorted by evidence
  });

  it("applyToClaudeMd writes and REPLACES the marker section (idempotent)", () => {
    const section1 = renderSection([{ category: "paths", text: "`a` → actually at `b`", count: 2 }]);
    writeFileSync(join(root, "CLAUDE.md"), "# My project\n\nHand-written notes.\n");
    applyToClaudeMd(root, section1);
    const after1 = readFileSync(join(root, "CLAUDE.md"), "utf8");
    expect(after1).toContain("Hand-written notes."); // never clobbers user content
    expect(after1).toContain("`a` → actually at `b` (seen 2×)");

    const section2 = renderSection([{ category: "paths", text: "`x` → actually at `y`", count: 1 }]);
    applyToClaudeMd(root, section2);
    const after2 = readFileSync(join(root, "CLAUDE.md"), "utf8");
    expect(after2).toContain("`x` → actually at `y`");
    expect(after2).not.toContain("`a` → actually at `b`"); // old section replaced
    expect(after2.match(/knitbrain:learn:start/g)).toHaveLength(1);
  });

  it("projectSlug matches Claude Code's transcript directory naming", () => {
    // The exact Unix encoding (resolve() keeps POSIX paths as-is).
    if (process.platform !== "win32") {
      expect(projectSlug("/Users/dev/my.project")).toBe("-Users-dev-my-project");
    }
    // Portable property (holds on every OS): no raw path separators survive.
    const slug = projectSlug("/Users/dev/my.project");
    expect(slug).not.toMatch(/[/.\\:]/);
    expect(slug).toContain("Users-dev-my-project");
  });
});
