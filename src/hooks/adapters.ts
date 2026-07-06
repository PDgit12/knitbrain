/**
 * Cross-platform hook adapters — translate host-native payloads/outputs to and
 * from the claude-internal shape the existing decide* functions expect.
 *
 * decide* functions (pretooluse.ts / posttooluse.ts / stop.ts) stay pure
 * claude-internal and unchanged; this module is the ONLY place platform
 * dialects are known about. index.ts wires: detect → normalizeEventName →
 * normalizeInput → decide*() → adaptOutput → stdout.
 *
 * CAPABILITY MATRIX (what each host CAN do — drives adaptOutput):
 *   claude/codex : full parity — deny, block-stop, additionalContext, rewrite output.
 *   cursor       : deny (different keys) · stop CANNOT block (only followup_message,
 *                  which injects a follow-up turn, weaker than a true block) ·
 *                  sessionStart context via additional_context (beforeSubmitPrompt
 *                  CANNOT inject context at all) · postToolUse rewrite ONLY for MCP
 *                  tool outputs (updated_mcp_tool_output).
 *   gemini       : deny · AfterAgent {decision:"deny",reason} blocks completion and
 *                  RETRIES with reason as the next prompt (closest to a real block) ·
 *                  additionalContext supported · CANNOT rewrite tool output at all.
 *   vscode       : reads .claude/settings.json directly, same PascalCase events +
 *                  deny schema as claude (near-identity) EXCEPT Stop uses
 *                  {continue:false, stopReason} instead of {decision:"block",reason};
 *                  tool_input arrives camelCase and tool names differ
 *                  (create_file/read_file/run_in_terminal) — normalizeInput maps
 *                  both back to the internal snake_case Read/Bash/Write shape.
 *
 * Where a host cannot perform the requested action (rewrite output on
 * codex/gemini, or context-inject on cursor's beforeSubmitPrompt), we never
 * silently drop the decision — we degrade to an additionalContext pointer so
 * the model still sees a hint (the recall handle / reason), matching the
 * "never expand, never silently lose information" contract elsewhere in the
 * codebase.
 */

export type HookPlatform = "claude" | "codex" | "cursor" | "gemini" | "vscode";

/** VS Code Copilot agent tool names → the internal name decide* matches on. */
const VSCODE_TOOL_NAME_MAP: Record<string, string> = {
  create_file: "Write",
  read_file: "Read",
  run_in_terminal: "Bash",
  replace_string_in_file: "Write",
};
export type HookMode = "pretooluse" | "posttooluse" | "stop" | "userpromptsubmit" | "sessionstart" | "precompact";

/**
 * Detect which host produced this payload. Payload shape is the primary
 * signal (per the verified schema discriminators); env vars are a fallback
 * for ambiguous/empty payloads.
 */
export function detectHookPlatform(payload: Record<string, unknown>, env: Record<string, string | undefined> = process.env): HookPlatform {
  if (typeof payload["turn_id"] !== "undefined") return "codex";
  if (typeof payload["conversation_id"] !== "undefined" || typeof payload["workspace_roots"] !== "undefined") return "cursor";

  // VS Code shares gemini's collision-prone discriminators (timestamp +
  // PascalCase event + session_id/transcript_path) — resolve it BEFORE the
  // gemini check via env signal or VS Code-specific tool_name/camelCase keys.
  if (env["TERM_PROGRAM"] === "vscode" || Object.keys(env).some((k) => k.startsWith("VSCODE_"))) return "vscode";
  const toolName = payload["tool_name"];
  if (typeof toolName === "string" && toolName in VSCODE_TOOL_NAME_MAP) return "vscode";
  const toolInput = payload["tool_input"];
  if (toolInput && typeof toolInput === "object" && "filePath" in (toolInput as Record<string, unknown>)) return "vscode";

  const rawEvent = payload["hook_event_name"];
  if (typeof rawEvent === "string") {
    // camelCase (cursor) vs PascalCase (gemini/vscode/claude)
    if (/^[a-z]/.test(rawEvent)) return "cursor";
    if (/^(BeforeTool|AfterTool|BeforeAgent|AfterAgent|PreCompress)$/.test(rawEvent)) return "gemini"; // gemini-only names, never appear in VS Code
    if (rawEvent === "SessionStart" && typeof payload["timestamp"] !== "undefined") {
      // Shared PascalCase event + timestamp with no gemini/vscode signal above
      // → ambiguous; default to claude (safe: claude shape works for vscode
      // everywhere except Stop, handled defensively in adaptOutput).
      return "claude";
    }
  }
  if (env["CURSOR_TRACE_ID"] || env["CURSOR_WORKSPACE"]) return "cursor";
  if (env["GEMINI_CLI"] || env["GEMINI_SESSION_ID"]) return "gemini";
  if (env["CODEX_SESSION_ID"] || env["CODEX_HOME"]) return "codex";
  return "claude";
}

/** Map a platform-native raw event name → the internal HookMode. Null if unmapped. */
export function normalizeEventName(platform: HookPlatform, rawEvent: string): HookMode | null {
  if (platform === "claude" || platform === "codex" || platform === "vscode") {
    // vscode adds SubagentStart/SubagentStop — no internal HookMode equivalent
    // yet, so they fall through to the default `null` (unmapped, ignored).
    switch (rawEvent) {
      case "PreToolUse":
        return "pretooluse";
      case "PostToolUse":
        return "posttooluse";
      case "Stop":
        return "stop";
      case "UserPromptSubmit":
        return "userpromptsubmit";
      case "SessionStart":
        return "sessionstart";
      case "PreCompact":
        return "precompact";
      default:
        return null;
    }
  }
  if (platform === "cursor") {
    switch (rawEvent) {
      case "beforeShellExecution":
      case "beforeMCPExecution":
      case "beforeReadFile":
        return "pretooluse";
      case "afterFileEdit":
        return "posttooluse";
      case "stop":
        return "stop";
      case "beforeSubmitPrompt":
        return "userpromptsubmit";
      case "sessionStart":
        return "sessionstart";
      default:
        return null;
    }
  }
  if (platform === "gemini") {
    switch (rawEvent) {
      case "BeforeTool":
        return "pretooluse";
      case "AfterTool":
        return "posttooluse";
      case "AfterAgent":
        return "stop";
      case "BeforeAgent":
        return "userpromptsubmit";
      case "SessionStart":
        return "sessionstart";
      case "PreCompress":
        return "precompact";
      default:
        return null;
    }
  }
  return null;
}

/** Translate a platform payload → the claude-internal input shape decide* expects. */
export function normalizeInput(platform: HookPlatform, mode: HookMode, payload: Record<string, unknown>): Record<string, unknown> {
  if (platform === "claude" || platform === "codex") return payload; // identical shape

  if (platform === "vscode") {
    if (mode !== "pretooluse" && mode !== "posttooluse") return payload; // stop/sessionstart/etc. already claude-shaped
    const rawToolName = payload["tool_name"];
    const toolName = typeof rawToolName === "string" ? (VSCODE_TOOL_NAME_MAP[rawToolName] ?? rawToolName) : rawToolName;
    const rawToolInput = (payload["tool_input"] as Record<string, unknown> | undefined) ?? {};
    // camelCase → snake_case for the handful of keys decide* reads; unknown
    // keys pass through untouched (conservative, no silent field loss).
    const toolInput: Record<string, unknown> = { ...rawToolInput };
    if ("filePath" in rawToolInput && !("file_path" in toolInput)) toolInput.file_path = rawToolInput["filePath"];
    return { ...payload, tool_name: toolName, tool_input: toolInput };
  }

  if (platform === "gemini") {
    // Gemini fields already snake_case-ish and pass straight through for the
    // fields decide* reads (tool_name/tool_input/prompt/cwd).
    return payload;
  }

  if (platform === "cursor") {
    if (mode !== "pretooluse") return payload; // other modes: cursor is already snake_case-compatible enough
    const rawEvent = payload["hook_event_name"];
    if (rawEvent === "beforeReadFile") {
      return { tool_name: "Read", tool_input: { file_path: payload["file_path"] }, cwd: payload["cwd"] };
    }
    if (rawEvent === "beforeShellExecution") {
      return { tool_name: "Bash", tool_input: { command: payload["command"] }, cwd: payload["cwd"] };
    }
    if (rawEvent === "beforeMCPExecution") {
      const toolName = (payload["tool_name"] as string | undefined) ?? (payload["mcp_tool_name"] as string | undefined) ?? "MCP";
      return { tool_name: toolName, tool_input: payload["tool_input"] ?? payload["arguments"] ?? {}, cwd: payload["cwd"] };
    }
    return payload;
  }

  return payload;
}

/**
 * Translate a claude-shaped decision (whatever decide* returned) → the
 * platform's native output dialect. `null` decisions always pass through as
 * `null` (allow / no-op) regardless of platform.
 */
export function adaptOutput(platform: HookPlatform, mode: HookMode, decision: Record<string, unknown> | null): Record<string, unknown> | null {
  if (decision === null) return null;
  if (platform === "claude" || platform === "codex") return decision; // full parity — identity

  if (platform === "vscode") {
    if (mode === "stop" && decision["decision"] === "block") {
      const reason = decision["reason"] as string | undefined;
      // VS Code's Stop block shape is {continue:false, stopReason} — NOT
      // {decision:"block",reason}. Merge both sets of keys: unknown keys are
      // ignored by whichever host reads this, and detection can't always
      // disambiguate vscode-vs-claude at Stop time (no tool_name/camelCase
      // signal present in a Stop payload), so this stays safe either way.
      return { ...decision, continue: false, stopReason: reason };
    }
    return decision; // everything else (deny, additionalContext) is identity with claude
  }

  const hso = decision["hookSpecificOutput"] as Record<string, unknown> | undefined;
  const permissionDecision = hso?.["permissionDecision"];
  const reason = (hso?.["permissionDecisionReason"] as string | undefined) ?? (decision["reason"] as string | undefined);
  const additionalContext = hso?.["additionalContext"] as string | undefined;
  const updatedToolOutput = hso?.["updatedToolOutput"] as string | undefined;

  if (platform === "cursor") {
    if (mode === "pretooluse" && permissionDecision === "deny") {
      return { permission: "deny", user_message: reason, agent_message: reason };
    }
    if (mode === "stop" && decision["decision"] === "block") {
      // Cursor's stop cannot truly block — degrade to a follow-up nudge.
      return { followup_message: reason ?? (decision["reason"] as string | undefined) };
    }
    if (mode === "sessionstart" && additionalContext) {
      return { additional_context: additionalContext };
    }
    if (mode === "posttooluse" && updatedToolOutput) {
      // Rewrite only works for MCP tool outputs on cursor; degrade to a
      // context pointer otherwise rather than silently dropping the skeleton.
      return { updated_mcp_tool_output: updatedToolOutput, additional_context: updatedToolOutput };
    }
    if (mode === "userpromptsubmit" && additionalContext) {
      // beforeSubmitPrompt CANNOT inject context — degrade to a user_message.
      return { continue: true, user_message: additionalContext };
    }
    return decision;
  }

  if (platform === "gemini") {
    if (mode === "pretooluse" && permissionDecision === "deny") {
      return { decision: "deny", reason };
    }
    if (mode === "stop" && decision["decision"] === "block") {
      return { decision: "deny", reason: reason ?? (decision["reason"] as string | undefined) };
    }
    if (additionalContext) {
      return { hookSpecificOutput: { additionalContext } };
    }
    if (mode === "posttooluse" && updatedToolOutput) {
      // Gemini cannot rewrite tool output — degrade to a context pointer.
      return { hookSpecificOutput: { additionalContext: updatedToolOutput } };
    }
    return decision;
  }

  return decision;
}
