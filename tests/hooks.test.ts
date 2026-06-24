import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decidePreToolUse, READ_REDIRECT_BYTES } from "../src/hooks/pretooluse.js";
import { applyArtifacts, claudeArtifacts } from "../src/platforms.js";
import { generateConfig } from "../src/setup.js";

const io = (size: number) => ({ exists: () => true, sizeOf: () => size });

describe("PreToolUse hook (Layer 2 enforcement)", () => {
  it("redirects LARGE raw Reads to knitbrain_read with a deny+reason", () => {
    const d = decidePreToolUse(
      { tool_name: "Read", tool_input: { file_path: "/proj/big.ts" }, cwd: "/proj" },
      io(READ_REDIRECT_BYTES + 1),
    )!;
    const out = d["hookSpecificOutput"] as Record<string, string>;
    expect(out["permissionDecision"]).toBe("deny");
    expect(out["permissionDecisionReason"]).toContain("knitbrain_read");
    expect(out["permissionDecisionReason"]).toContain("big.ts");
  });

  it("lets small files through untouched", () => {
    expect(
      decidePreToolUse(
        { tool_name: "Read", tool_input: { file_path: "/proj/small.ts" }, cwd: "/proj" },
        io(500),
      ),
    ).toBeNull();
  });

  it("ignores non-Read tools and reads outside the project", () => {
    expect(decidePreToolUse({ tool_name: "Bash", tool_input: {} }, io(99999))).toBeNull();
    expect(
      decidePreToolUse(
        { tool_name: "Read", tool_input: { file_path: "/etc/hosts" }, cwd: "/proj" },
        io(99999),
      ),
    ).toBeNull(); // outside project → knitbrain_read couldn't serve it anyway
  });

  it("never throws on malformed input (hooks must not break the host)", () => {
    expect(decidePreToolUse({}, io(0))).toBeNull();
    expect(decidePreToolUse({ tool_name: "Read" }, io(0))).toBeNull();
  });
});

describe("settings.json hooks wiring (non-clobbering)", () => {
  it("setup writes PreToolUse + PreCompact hooks and preserves user hooks", () => {
    const root = mkdtempSync(join(tmpdir(), "knitbrain-hooks-"));
    try {
      mkdirSync(join(root, ".claude"), { recursive: true });
      writeFileSync(
        join(root, ".claude/settings.json"),
        JSON.stringify({ hooks: { Stop: [{ matcher: "", hooks: [{ type: "command", command: "my-own-hook" }] }] } }),
      );
      applyArtifacts(root, claudeArtifacts(generateConfig()), generateConfig());
      const parsed = JSON.parse(readFileSync(join(root, ".claude/settings.json"), "utf8"));
      const flat = JSON.stringify(parsed.hooks);
      expect(flat).toContain("knitbrain-hook pretooluse");
      expect(flat).toContain("knitbrain-hook precompact");
      expect(flat).toContain("my-own-hook"); // user's hook preserved
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("running setup twice does not duplicate hook entries", () => {
    const root = mkdtempSync(join(tmpdir(), "knitbrain-hooks2-"));
    try {
      const cfg = generateConfig();
      applyArtifacts(root, claudeArtifacts(cfg), cfg);
      applyArtifacts(root, claudeArtifacts(cfg), cfg);
      const parsed = JSON.parse(readFileSync(join(root, ".claude/settings.json"), "utf8"));
      const count = JSON.stringify(parsed.hooks).split("knitbrain-hook pretooluse").length - 1;
      expect(count).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

import { buildSessionStartContext, sessionStartOutput } from "../src/hooks/sessionstart.js";
import { KNITBRAIN_HOOKS } from "../src/platforms.js";

describe("SessionStart hook (auto protocol + memory injection)", () => {
  it("injects the full operating protocol so load_session isn't agent-dependent", () => {
    const ctx = buildSessionStartContext({ handoff: null, topLearnings: [] });
    expect(ctx).toContain("ENTER YOUR HOST'S PLAN MODE"); // protocol present
    expect(ctx).toContain("knitbrain_load_session");
    expect(ctx).toContain("no yes-man"); // anti-sycophancy ground rule rides along
  });

  it("resumes a prior handoff and surfaces proven learnings", () => {
    const ctx = buildSessionStartContext({
      handoff: "goal: ship 0.4.0; next: audit",
      topLearnings: [{ summary: "validation lives in src/lib.ts" }, { summary: "use uv run python" }],
    });
    expect(ctx).toContain("RESUMABLE HANDOFF");
    expect(ctx).toContain("ship 0.4.0");
    expect(ctx).toContain("TOP PROJECT LEARNINGS");
    expect(ctx).toContain("validation lives in src/lib.ts");
  });

  it("emits valid Claude Code SessionStart hook JSON", () => {
    const parsed = JSON.parse(sessionStartOutput({ handoff: null, topLearnings: [] })) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(parsed.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(parsed.hookSpecificOutput.additionalContext.length).toBeGreaterThan(100);
  });

  it("setup wires all lifecycle hooks (incl. per-turn UserPromptSubmit anti-drift)", () => {
    expect(Object.keys(KNITBRAIN_HOOKS).sort()).toEqual([
      "PreCompact",
      "PreToolUse",
      "SessionStart",
      "Stop",
      "UserPromptSubmit",
    ]);
    expect(KNITBRAIN_HOOKS.SessionStart[0]!.hooks[0]!.command).toBe("knitbrain-hook sessionstart");
    expect(KNITBRAIN_HOOKS.Stop[0]!.hooks[0]!.command).toBe("knitbrain-hook stop");
    expect(KNITBRAIN_HOOKS.UserPromptSubmit[0]!.hooks[0]!.command).toBe("knitbrain-hook userpromptsubmit");
  });
});
