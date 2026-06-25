# ADR 0002 — Two compression paths: API proxy vs subscription hooks

- Status: accepted
- Date: 2026-06-25

## Context

knitbrain must compress tool output regardless of how the user pays for their
agent. There are two billing modes (`src/mcp/host.ts` `detectBilling`):

- **API key** — traffic is plain HTTPS to the provider; interceptable.
- **Subscription / OAuth** (Claude Pro/Max, etc.) — traffic is OAuth-bound and
  cannot be intercepted on the wire. This is true of every tool in this space,
  not a knitbrain limitation.

A single mechanism cannot cover both. Claiming "compression runs identically
either way" would be dishonest — the realized coverage differs.

## Decision

Pick the mechanism per billing mode; keep the optimizer identical across both.

- **API key → loopback proxy** (`knitbrain wrap claude`, `src/proxy/`). The proxy
  rewrites every request on the wire, compressing all older-turn tool results
  automatically, no agent cooperation.
- **Subscription → MCP + hooks**:
  - `knitbrain_read` returns file reads as skeletons.
  - A `PreToolUse` hook denies large raw `Read`s and redirects to
    `knitbrain_read`.
  - A `PostToolUse` hook (`src/hooks/posttooluse.ts`) skeletonizes the output of
    the host tools `PreToolUse` cannot redirect (Bash/Grep/Glob/WebFetch) by
    replacing it inline via Claude Code's `updatedToolOutput`, original kept in
    the recall store.

`updatedToolOutput` is Claude-Code-specific; hosts that lack it simply never
fire the hook, and the universal `knitbrain_read` path still applies.

## Honesty constraint

Published numbers (README) are labelled as the **optimizer ceiling** measured
offline (`knitbrain profile`) — what you save when output flows through the
optimizer. The **realized** number is the live dashboard meter, which counts
only what actually passed through. Ceiling ≠ realized; the README says so.

## Alternatives considered

- **Proxy for everyone.** Rejected: OAuth traffic can't be MITM'd; the proxy is
  a no-op on a subscription.
- **MCP-only for everyone.** Rejected: leaves the API-key user's wire traffic
  uncompressed when the proxy could cover it fully.

## Consequences

Subscription coverage depends on the host's hook support (full on Claude Code,
narrower elsewhere). This is surfaced honestly rather than hidden behind an
averaged headline number.
