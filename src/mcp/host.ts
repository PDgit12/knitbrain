/**
 * Zero-setup host detection. The platform comes from the MCP `initialize`
 * handshake (`clientInfo.name` — "claude-code", "cursor", "Codex", …); the
 * billing mode from the env knitbrain inherits as the host's subprocess (an
 * API key present ⇒ pay-as-you-go, absent ⇒ subscription/OAuth). Nothing the
 * user configures — full autonomy.
 */

export type Billing = "api" | "subscription";

/** API key in env ⇒ proxyable pay-as-you-go; none ⇒ subscription/OAuth. */
export function detectBilling(env: NodeJS.ProcessEnv): Billing {
  return env["ANTHROPIC_API_KEY"] || env["OPENAI_API_KEY"] ? "api" : "subscription";
}

/** Normalize the MCP client name; fall back to env signals, then "agent". */
export function normalizeHost(clientName: string | undefined, env: NodeJS.ProcessEnv): string {
  if (clientName && clientName.trim()) return clientName.trim().toLowerCase().replace(/\s+/g, "-");
  if (env["CURSOR_TRACE_ID"]) return "cursor";
  if (env["CLAUDECODE"] || env["CLAUDE_CODE"]) return "claude-code";
  if (env["TERM_PROGRAM"] === "vscode") return "vscode";
  return "agent";
}

/** The agent label shown in the dashboard: "<platform> (<billing>)". */
export function agentLabel(clientName: string | undefined, env: NodeJS.ProcessEnv): string {
  return `${normalizeHost(clientName, env)} (${detectBilling(env)})`;
}
