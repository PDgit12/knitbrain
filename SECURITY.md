# Security Policy

## Supported versions

knitbrain is published on npm as `knitbrain`. Security fixes land on the latest
released version. Please run the latest before reporting.

## Reporting a vulnerability

Report security issues privately — **do not open a public GitHub issue** for an
unfixed vulnerability.

- Preferred: open a [GitHub private security advisory](https://github.com/PDgit12/knitbrain/security/advisories/new).
- Or email: **dua14@purdue.edu** with subject `knitbrain security`.

Please include: affected version, a description, and a minimal reproduction.
You'll get an acknowledgement within 72 hours.

## Scope

knitbrain is local-first: memory, the recall (CCR) store, and the optional
proxy/hub all run on your machine. Network services bind to `127.0.0.1` by
default; the team hub binds loopback unless you explicitly set
`KNITBRAIN_HUB_HOST=0.0.0.0`, and is protected by a per-team bearer token.

In scope: the MCP server, the optimizer/recall store, the loopback proxy, the
team hub auth, and the lifecycle hooks. Out of scope: vulnerabilities in the
host AI agent (Claude Code, Cursor, …) or in your own goal/verify scripts.

## Disclosure

Once a fix is released, the advisory is published with credit to the reporter
(unless you prefer to remain anonymous).
