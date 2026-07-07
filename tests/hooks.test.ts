import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decidePreToolUse, decideRepeatReadRecall, READ_REDIRECT_BYTES } from "../src/hooks/pretooluse.js";
import { decideLoopStop } from "../src/hooks/stop.js";
import { applyArtifacts, claudeArtifacts } from "../src/platforms.js";
import { generateConfig } from "../src/setup.js";
import { adaptOutput } from "../src/hooks/adapters.js";

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

describe("PreToolUse hook — workflow CONSTRAINTS denial (brain→body enforcement)", () => {
  const ioWith = (workflowText: string | null) => ({ ...io(0), readWorkflow: () => workflowText });

  it("denies a Bash command matching a CONSTRAINTS-line forbidden literal", () => {
    const d = decidePreToolUse(
      { tool_name: "Bash", tool_input: { command: "npm publish" } },
      ioWith("GOAL: ship it\nCONSTRAINTS: no publish without OK\n"),
    )!;
    expect(d).not.toBeNull();
    const out = d["hookSpecificOutput"] as Record<string, string>;
    expect(out["permissionDecision"]).toBe("deny");
    expect(out["permissionDecisionReason"]).toContain("CONSTRAINTS: no publish without OK");
  });

  it("readWorkflow absent → null (fail-open, old 2-field io objects still work)", () => {
    expect(
      decidePreToolUse({ tool_name: "Bash", tool_input: { command: "npm publish" } }, io(0)),
    ).toBeNull();
  });

  it("a non-matching command is not denied", () => {
    expect(
      decidePreToolUse(
        { tool_name: "Bash", tool_input: { command: "npm test" } },
        ioWith("CONSTRAINTS: no publish without OK"),
      ),
    ).toBeNull();
  });

  it("no CONSTRAINTS line, or readWorkflow returning null → fail open", () => {
    expect(
      decidePreToolUse({ tool_name: "Bash", tool_input: { command: "npm publish" } }, ioWith(null)),
    ).toBeNull();
    expect(
      decidePreToolUse(
        { tool_name: "Bash", tool_input: { command: "npm publish" } },
        ioWith("GOAL: ship it\n"),
      ),
    ).toBeNull();
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
import { decidePostToolUse, POSTTOOL_MIN_CHARS } from "../src/hooks/posttooluse.js";
import { createFileCCRStore } from "../src/ccr/store.js";

describe("PostToolUse hook (subscription auto-compression of host tool output)", () => {
  const withStore = <T>(fn: (ccr: ReturnType<typeof createFileCCRStore>) => T): T => {
    const root = mkdtempSync(join(tmpdir(), "knitbrain-ccr-"));
    try {
      return fn(createFileCCRStore(root));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };

  it("skeletonizes large Bash output and round-trips the exact original via CCR", () => {
    withStore((ccr) => {
      // A big, compressible build log (repeated lines → high redundancy).
      const original = Array.from({ length: 400 }, (_, i) => `  at frame ${i} module/path/file-${i}.ts:${i}:10`).join("\n");
      let saved = 0;
      const d = decidePostToolUse({ tool_name: "Bash", tool_response: { stdout: original } }, ccr, (n) => (saved += n))!;
      expect(d).not.toBeNull();
      const out = (d["hookSpecificOutput"] as Record<string, string>)["updatedToolOutput"]!;
      expect(out).toContain("knitbrain: Bash output");
      expect(out).toContain("⟨recall:");
      expect(saved).toBeGreaterThan(0);
      // Lossless: the handle in the skeleton restores the exact original bytes.
      const handle = out.match(/⟨recall:([a-f0-9]+)⟩/)![1]!;
      expect(ccr.get(handle)).toBe(original);
    });
  });

  it("passes small output through untouched (never-expand)", () => {
    withStore((ccr) => {
      expect(decidePostToolUse({ tool_name: "Bash", tool_response: { stdout: "ok" } }, ccr)).toBeNull();
      expect(decidePostToolUse({ tool_name: "Bash", tool_response: "x".repeat(POSTTOOL_MIN_CHARS - 1) }, ccr)).toBeNull();
    });
  });

  it("ignores non-target tools and already-compressed output", () => {
    withStore((ccr) => {
      const big = "y".repeat(POSTTOOL_MIN_CHARS + 500);
      expect(decidePostToolUse({ tool_name: "Read", tool_response: big }, ccr)).toBeNull();
      expect(decidePostToolUse({ tool_name: "Edit", tool_response: big }, ccr)).toBeNull();
      expect(decidePostToolUse({ tool_name: "Bash", tool_response: `${big} ⟨recall:abc⟩` }, ccr)).toBeNull();
    });
  });

  it("never throws on unknown response shapes (hooks must not break the host)", () => {
    withStore((ccr) => {
      expect(decidePostToolUse({ tool_name: "Bash", tool_response: { weird: 1 } }, ccr)).toBeNull();
      expect(decidePostToolUse({ tool_name: "Bash" }, ccr)).toBeNull();
      expect(decidePostToolUse({}, ccr)).toBeNull();
    });
  });
});

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
      "PostToolUse",
      "PreCompact",
      "PreToolUse",
      "SessionStart",
      "Stop",
      "UserPromptSubmit",
    ]);
    expect(KNITBRAIN_HOOKS.PostToolUse[0]!.hooks[0]!.command).toBe("knitbrain-hook posttooluse");
    expect(KNITBRAIN_HOOKS.PostToolUse[0]!.matcher).toBe("Bash|Grep|Glob|WebFetch|WebSearch");
    expect(KNITBRAIN_HOOKS.SessionStart[0]!.hooks[0]!.command).toBe("knitbrain-hook sessionstart");
    expect(KNITBRAIN_HOOKS.Stop[0]!.hooks[0]!.command).toBe("knitbrain-hook stop");
    expect(KNITBRAIN_HOOKS.UserPromptSubmit[0]!.hooks[0]!.command).toBe("knitbrain-hook userpromptsubmit");
  });
});

describe("Stop hook (Gap 6b — enforce the loop, block once)", () => {
  let dir: string;
  let p: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "kb-stop-")); p = join(dir, "loop-state.json"); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("no loop-state → allow stop (null)", () => {
    expect(decideLoopStop(p)).toBeNull();
  });

  it("unmet goal → blocks the FIRST stop, then allows the second (no trap)", () => {
    writeFileSync(p, JSON.stringify({ goal: "ship X", iter: 2 }));
    const first = decideLoopStop(p);
    expect(first?.decision).toBe("block");
    expect(first?.reason).toContain("ship X");
    expect(first?.reason).toMatch(/UNMET/);
    // marker persisted → second stop is not trapped
    expect(JSON.parse(readFileSync(p, "utf8")).stopNudged).toBe(true);
    expect(decideLoopStop(p)).toBeNull();
  });

  it("malformed loop-state → allow stop, never throw", () => {
    writeFileSync(p, "{ broken");
    expect(() => decideLoopStop(p)).not.toThrow();
    expect(decideLoopStop(p)).toBeNull();
  });
});

describe("adaptOutput — G1 receipt (non-blocking Stop systemMessage) per platform", () => {
  const receipt = { systemMessage: "r" };

  it("claude/codex/vscode pass the systemMessage through untouched", () => {
    expect(adaptOutput("claude", "stop", receipt)).toEqual(receipt);
    expect(adaptOutput("codex", "stop", receipt)).toEqual(receipt);
    expect(adaptOutput("vscode", "stop", receipt)).toEqual(receipt);
  });

  it("cursor and gemini degrade to null (no lever for a passive receipt)", () => {
    expect(adaptOutput("cursor", "stop", receipt)).toBeNull();
    expect(adaptOutput("gemini", "stop", receipt)).toBeNull();
  });

  it("regression: a loop-block stop decision still adapts per-platform as before", () => {
    const block = { decision: "block", reason: "goal unmet" };
    expect(adaptOutput("claude", "stop", block)).toEqual(block);
    expect(adaptOutput("cursor", "stop", block)).toEqual({ followup_message: "goal unmet" });
    expect(adaptOutput("gemini", "stop", block)).toEqual({ decision: "deny", reason: "goal unmet" });
    const vscodeOut = adaptOutput("vscode", "stop", block) as Record<string, unknown>;
    expect(vscodeOut["continue"]).toBe(false);
    expect(vscodeOut["stopReason"]).toBe("goal unmet");
  });
});

describe("decidePostToolUse — onSaved info callback", () => {
  it("passes {rawTokens, storedTokens} alongside the saved-tokens delta", () => {
    const root = mkdtempSync(join(tmpdir(), "knitbrain-ccr-info-"));
    try {
      const ccr = createFileCCRStore(root);
      const original = Array.from({ length: 400 }, (_, i) => `  at frame ${i} module/path/file-${i}.ts:${i}:10`).join("\n");
      let capturedInfo: { rawTokens: number; storedTokens: number } | undefined;
      let capturedSaved = 0;
      decidePostToolUse(
        { tool_name: "Bash", tool_response: { stdout: original } },
        ccr,
        (n, info) => {
          capturedSaved = n;
          capturedInfo = info;
        },
      );
      expect(capturedInfo).toBeDefined();
      expect(capturedInfo!.rawTokens).toBeGreaterThan(capturedInfo!.storedTokens);
      expect(capturedSaved).toBe(capturedInfo!.rawTokens - capturedInfo!.storedTokens);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("G4 repeat-read recall (writer never re-reads unchanged content)", () => {
  const H = "a".repeat(64);
  const read = (fp: string) => ({ tool_name: "Read", tool_input: { file_path: fp } });
  const io = (over: Record<string, unknown> = {}) => ({
    exists: () => true,
    sizeOf: () => 100,
    readEntry: () => ({ count: 2, mtimeMs: 111 }),
    mtimeOf: () => 111,
    recallHandleFor: () => H,
    ...over,
  });

  it("count>=2 + same mtime + handle in CCR → deny with the exact resolvable handle", () => {
    const d = decideRepeatReadRecall(read("/p/a.ts"), io());
    const reason = (d?.["hookSpecificOutput"] as Record<string, unknown>)?.["permissionDecisionReason"] as string;
    expect(reason).toContain(`⟨recall:${H}⟩`);
    expect(reason.startsWith("unchanged since last read")).toBe(true);
  });

  it("first read (count 1) → allow", () => {
    expect(decideRepeatReadRecall(read("/p/a.ts"), io({ readEntry: () => ({ count: 1, mtimeMs: 111 }) }))).toBeNull();
  });

  it("mtime changed since the reads-map entry → allow (fresh content never blocked)", () => {
    expect(decideRepeatReadRecall(read("/p/a.ts"), io({ mtimeOf: () => 222 }))).toBeNull();
  });

  it("content not in CCR → allow", () => {
    expect(decideRepeatReadRecall(read("/p/a.ts"), io({ recallHandleFor: () => null }))).toBeNull();
  });

  it("legacy io without the G4 fns → allow (fail-open, old callers unchanged)", () => {
    expect(decideRepeatReadRecall(read("/p/a.ts"), { exists: () => true, sizeOf: () => 100 })).toBeNull();
  });

  it("throwing io → allow (fail-open)", () => {
    expect(decideRepeatReadRecall(read("/p/a.ts"), io({ readEntry: () => { throw new Error("x"); } }))).toBeNull();
  });

  it("repeat-read recall WINS over the large-file redirect via decidePreToolUse", () => {
    const d = decidePreToolUse(read("/p/big.ts"), io({ sizeOf: () => READ_REDIRECT_BYTES + 1 }));
    const reason = (d?.["hookSpecificOutput"] as Record<string, unknown>)?.["permissionDecisionReason"] as string;
    expect(reason.startsWith("unchanged since last read")).toBe(true); // not "Large file"
  });

  it("constraint denial still WINS over repeat-read (Bash isn't a Read anyway; Write path check)", () => {
    const d = decidePreToolUse(
      { tool_name: "Bash", tool_input: { command: "npm publish" } },
      io({ readWorkflow: () => "CONSTRAINTS: never publish without OK" }),
    );
    const reason = (d?.["hookSpecificOutput"] as Record<string, unknown>)?.["permissionDecisionReason"] as string;
    expect(reason.startsWith("Blocked by project CONSTRAINTS")).toBe(true);
  });
});
