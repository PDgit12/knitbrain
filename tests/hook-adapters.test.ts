import { describe, it, expect } from "vitest";
import { detectHookPlatform, normalizeEventName, normalizeInput, adaptOutput } from "../src/hooks/adapters.js";

const noEnv = {} as Record<string, string | undefined>;

describe("detectHookPlatform — per-platform fixture discriminators", () => {
  it("codex: turn_id discriminator wins first", () => {
    expect(detectHookPlatform({ turn_id: "t1", hook_event_name: "PreToolUse" }, noEnv)).toBe("codex");
  });

  it("cursor: conversation_id / workspace_roots / camelCase hook_event_name", () => {
    expect(detectHookPlatform({ conversation_id: "c1" }, noEnv)).toBe("cursor");
    expect(detectHookPlatform({ workspace_roots: ["/proj"] }, noEnv)).toBe("cursor");
    expect(detectHookPlatform({ hook_event_name: "beforeShellExecution" }, noEnv)).toBe("cursor");
  });

  it("gemini: BeforeTool / AfterAgent / PreCompress PascalCase event names", () => {
    expect(detectHookPlatform({ hook_event_name: "BeforeTool" }, noEnv)).toBe("gemini");
    expect(detectHookPlatform({ hook_event_name: "AfterAgent" }, noEnv)).toBe("gemini");
    expect(detectHookPlatform({ hook_event_name: "PreCompress" }, noEnv)).toBe("gemini");
  });

  it("vscode: TERM_PROGRAM=vscode env signal", () => {
    expect(detectHookPlatform({ hook_event_name: "PreToolUse" }, { TERM_PROGRAM: "vscode" })).toBe("vscode");
  });

  it("vscode: VS Code-specific tool_name (create_file / run_in_terminal)", () => {
    expect(detectHookPlatform({ tool_name: "create_file" }, noEnv)).toBe("vscode");
    expect(detectHookPlatform({ tool_name: "run_in_terminal" }, noEnv)).toBe("vscode");
  });

  it("vscode: camelCase filePath key in tool_input", () => {
    expect(detectHookPlatform({ tool_input: { filePath: "/proj/x.ts" } }, noEnv)).toBe("vscode");
  });

  it("claude: fallback for plain tool_name/tool_input with no other signal", () => {
    expect(detectHookPlatform({ tool_name: "Read", tool_input: { file_path: "/proj/a.ts" } }, noEnv)).toBe("claude");
  });

  it("vscode wins over gemini on the ambiguous SessionStart+timestamp+PascalCase shape when a vscode signal is present", () => {
    // Bare timestamp+PascalCase (no vscode signal) resolves to claude (documented default) —
    // adding a vscode env signal must flip it to vscode BEFORE the ambiguous-claude fallback runs.
    const ambiguous = { hook_event_name: "SessionStart", timestamp: 123 };
    expect(detectHookPlatform(ambiguous, noEnv)).toBe("claude"); // documented default absent any vscode signal
    expect(detectHookPlatform(ambiguous, { TERM_PROGRAM: "vscode" })).toBe("vscode"); // vscode signal wins
  });
});

describe("normalizeEventName — per-platform raw event → HookMode", () => {
  it("cursor event names", () => {
    expect(normalizeEventName("cursor", "beforeShellExecution")).toBe("pretooluse");
    expect(normalizeEventName("cursor", "beforeReadFile")).toBe("pretooluse");
    expect(normalizeEventName("cursor", "stop")).toBe("stop");
    expect(normalizeEventName("cursor", "sessionStart")).toBe("sessionstart");
  });

  it("gemini event names", () => {
    expect(normalizeEventName("gemini", "BeforeTool")).toBe("pretooluse");
    expect(normalizeEventName("gemini", "AfterAgent")).toBe("stop");
    expect(normalizeEventName("gemini", "PreCompress")).toBe("precompact");
  });

  it("claude/codex/vscode PascalCase event names", () => {
    expect(normalizeEventName("claude", "PreToolUse")).toBe("pretooluse");
    expect(normalizeEventName("codex", "Stop")).toBe("stop");
    expect(normalizeEventName("vscode", "PreCompact")).toBe("precompact");
  });

  it("unmapped event names → null", () => {
    expect(normalizeEventName("claude", "TotallyUnknownEvent")).toBeNull();
    expect(normalizeEventName("cursor", "beforeSomethingUnknown")).toBeNull();
    expect(normalizeEventName("gemini", "Unknown")).toBeNull();
  });
});

describe("normalizeInput — translate platform payload → claude-internal shape", () => {
  it("cursor beforeReadFile → Read tool_input {file_path}", () => {
    const out = normalizeInput("cursor", "pretooluse", {
      hook_event_name: "beforeReadFile",
      file_path: "/proj/a.ts",
      cwd: "/proj",
    });
    expect(out["tool_name"]).toBe("Read");
    expect((out["tool_input"] as Record<string, unknown>)["file_path"]).toBe("/proj/a.ts");
  });

  it("cursor beforeShellExecution → Bash tool_input {command}", () => {
    const out = normalizeInput("cursor", "pretooluse", {
      hook_event_name: "beforeShellExecution",
      command: "npm test",
      cwd: "/proj",
    });
    expect(out["tool_name"]).toBe("Bash");
    expect((out["tool_input"] as Record<string, unknown>)["command"]).toBe("npm test");
  });

  it("vscode create_file/read_file/run_in_terminal map to Write/Read/Bash", () => {
    const write = normalizeInput("vscode", "pretooluse", { tool_name: "create_file", tool_input: {} });
    expect(write["tool_name"]).toBe("Write");
    const read = normalizeInput("vscode", "pretooluse", { tool_name: "read_file", tool_input: {} });
    expect(read["tool_name"]).toBe("Read");
    const bash = normalizeInput("vscode", "pretooluse", { tool_name: "run_in_terminal", tool_input: {} });
    expect(bash["tool_name"]).toBe("Bash");
  });

  it("vscode camelCase filePath → snake_case file_path (unknown keys preserved)", () => {
    const out = normalizeInput("vscode", "pretooluse", {
      tool_name: "read_file",
      tool_input: { filePath: "/proj/a.ts", other: 1 },
    });
    const toolInput = out["tool_input"] as Record<string, unknown>;
    expect(toolInput["file_path"]).toBe("/proj/a.ts");
    expect(toolInput["filePath"]).toBe("/proj/a.ts"); // original key kept, not deleted
    expect(toolInput["other"]).toBe(1); // unknown keys pass through untouched
  });

  it("claude/codex/gemini pass through unchanged (identical/compatible shape)", () => {
    const payload = { tool_name: "Bash", tool_input: { command: "ls" } };
    expect(normalizeInput("claude", "pretooluse", payload)).toBe(payload);
    expect(normalizeInput("codex", "pretooluse", payload)).toBe(payload);
    expect(normalizeInput("gemini", "pretooluse", payload)).toBe(payload);
  });

  it("non-pretooluse vscode/cursor modes pass through untouched", () => {
    const payload = { decision: "block" };
    expect(normalizeInput("vscode", "stop", payload)).toBe(payload);
    expect(normalizeInput("cursor", "stop", payload)).toBe(payload);
  });
});

describe("adaptOutput — claude-internal decision → platform-native dialect", () => {
  it("null decision always passes through as null regardless of platform", () => {
    expect(adaptOutput("claude", "pretooluse", null)).toBeNull();
    expect(adaptOutput("cursor", "pretooluse", null)).toBeNull();
    expect(adaptOutput("gemini", "stop", null)).toBeNull();
    expect(adaptOutput("vscode", "stop", null)).toBeNull();
  });

  it("claude/codex: identity passthrough (full parity)", () => {
    const decision = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "no" } };
    expect(adaptOutput("claude", "pretooluse", decision)).toBe(decision);
    expect(adaptOutput("codex", "pretooluse", decision)).toBe(decision);
  });

  it("deny decision on cursor → {permission:'deny', user_message}", () => {
    const decision = {
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "blocked reason" },
    };
    const out = adaptOutput("cursor", "pretooluse", decision)!;
    expect(out["permission"]).toBe("deny");
    expect(out["user_message"]).toBe("blocked reason");
  });

  it("deny decision on gemini → {decision:'deny', reason}", () => {
    const decision = {
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "blocked reason" },
    };
    const out = adaptOutput("gemini", "pretooluse", decision)!;
    expect(out["decision"]).toBe("deny");
    expect(out["reason"]).toBe("blocked reason");
  });

  it("Stop block on cursor → degrades to {followup_message} (cannot truly block)", () => {
    const decision = { decision: "block", reason: "goal unmet" };
    const out = adaptOutput("cursor", "stop", decision)!;
    expect(out["followup_message"]).toBe("goal unmet");
  });

  it("Stop block on gemini → {decision:'deny', reason} (closest to a real block/retry)", () => {
    const decision = { decision: "block", reason: "goal unmet" };
    const out = adaptOutput("gemini", "stop", decision)!;
    expect(out["decision"]).toBe("deny");
    expect(out["reason"]).toBe("goal unmet");
  });

  it("Stop block on vscode → merged shape contains continue:false + stopReason", () => {
    const decision = { decision: "block", reason: "goal unmet" };
    const out = adaptOutput("vscode", "stop", decision)!;
    expect(out["continue"]).toBe(false);
    expect(out["stopReason"]).toBe("goal unmet");
    // Merge, not replace — the original decision/reason keys ride along too
    // (unknown keys are ignored by whichever host reads this; see adapters.ts comment).
    expect(out["decision"]).toBe("block");
    expect(out["reason"]).toBe("goal unmet");
  });
});

describe("windsurf platform — detection, normalization, adaptOutput", () => {
  it("detects windsurf via trajectory_id or agent_action_name, even without turn_id", () => {
    expect(
      detectHookPlatform({ trajectory_id: "t", agent_action_name: "read_code", tool_info: { file_path: "/p/a.ts" } }, noEnv),
    ).toBe("windsurf");
    expect(detectHookPlatform({ agent_action_name: "run_command" }, noEnv)).toBe("windsurf");
  });

  it("windsurf wins over codex when both trajectory_id and turn_id are present", () => {
    expect(detectHookPlatform({ trajectory_id: "t", turn_id: "c1" }, noEnv)).toBe("windsurf");
  });

  it("normalizeEventName: pre_* windsurf events map to pretooluse; post_* are unmapped", () => {
    expect(normalizeEventName("windsurf", "pre_read_code")).toBe("pretooluse");
    expect(normalizeEventName("windsurf", "pre_run_command")).toBe("pretooluse");
    expect(normalizeEventName("windsurf", "pre_mcp_tool_use")).toBe("pretooluse");
    expect(normalizeEventName("windsurf", "post_read_code")).toBeNull();
  });

  it("normalizeInput: tool_info.file_path → Read tool_input", () => {
    const out = normalizeInput("windsurf", "pretooluse", {
      hook_event_name: "pre_read_code",
      tool_info: { file_path: "/p/a.ts" },
      cwd: "/p",
    });
    expect(out["tool_name"]).toBe("Read");
    expect((out["tool_input"] as Record<string, unknown>)["file_path"]).toBe("/p/a.ts");
  });

  it("normalizeInput: tool_info.command_line → Bash tool_input", () => {
    const out = normalizeInput("windsurf", "pretooluse", {
      hook_event_name: "pre_run_command",
      tool_info: { command_line: "npm test" },
      cwd: "/p",
    });
    expect(out["tool_name"]).toBe("Bash");
    expect((out["tool_input"] as Record<string, unknown>)["command"]).toBe("npm test");
  });

  it("adaptOutput: claude-shaped deny decision → windsurf sentinel {__exit:2, stderr}", () => {
    const decision = {
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "blocked reason" },
    };
    const out = adaptOutput("windsurf", "pretooluse", decision)!;
    expect(out["__exit"]).toBe(2);
    expect(out["stderr"]).toBe("blocked reason");
  });

  it("adaptOutput: null decision → null on windsurf", () => {
    expect(adaptOutput("windsurf", "pretooluse", null)).toBeNull();
  });

  it("adaptOutput: windsurf subagent modes always null (no start/stop equivalent)", () => {
    const decision = { hookSpecificOutput: { additionalContext: "ctx" } };
    expect(adaptOutput("windsurf", "subagentstart", decision)).toBeNull();
    expect(adaptOutput("windsurf", "subagentstop", decision)).toBeNull();
  });
});

describe("SubagentStart/SubagentStop event mapping per platform", () => {
  it("claude/codex/vscode map SubagentStart/SubagentStop to internal modes", () => {
    for (const platform of ["claude", "codex", "vscode"] as const) {
      expect(normalizeEventName(platform, "SubagentStart")).toBe("subagentstart");
      expect(normalizeEventName(platform, "SubagentStop")).toBe("subagentstop");
    }
  });

  it("cursor and gemini have no SubagentStart/SubagentStop equivalent → null", () => {
    expect(normalizeEventName("cursor", "SubagentStart")).toBeNull();
    expect(normalizeEventName("cursor", "SubagentStop")).toBeNull();
    expect(normalizeEventName("gemini", "SubagentStart")).toBeNull();
    expect(normalizeEventName("gemini", "SubagentStop")).toBeNull();
  });

  it("adaptOutput is identity for claude/codex/vscode on a context decision at subagent modes", () => {
    const decision = { hookSpecificOutput: { hookEventName: "SubagentStart", additionalContext: "ctx" } };
    expect(adaptOutput("claude", "subagentstart", decision)).toBe(decision);
    expect(adaptOutput("codex", "subagentstart", decision)).toBe(decision);
    expect(adaptOutput("vscode", "subagentstart", decision)).toBe(decision);
  });
});
