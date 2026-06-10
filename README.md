# Knit Brain

> Local-first MCP server that gives any AI coding agent **per-project memory**, **workflow intelligence**, and **always-on, lossless token & context optimization** — entirely on your machine, zero cloud.

Pure TypeScript. Two runtime dependencies. No Python, no native binaries, no network beyond `npm install`.

## Why

Coding agents burn context on bulk they rarely re-read in full — large files, logs, JSON, stale tool output, old turns. Knit Brain shrinks that bulk to a navigable **skeleton** while keeping the exact original one lookup away:

- your context window lasts dramatically longer,
- **nothing is ever lost** — compression is reversible via a local content-addressed store (CCR),
- your instructions and governance text are **never** touched (protected verbatim).

**Measured, not promised:** on 3.03M tokens of tool results from 69 real coding sessions, knitbrain saves **50.2% overall** (logs 68.6% · long output 68.2% · JSON 65.8% · code 55.5% · test runs 43.1%) with **zero lossless failures** — every original recoverable byte-for-byte. On whole files: 88.8%. Short outputs pass through untouched (output is never larger than input — enforced). Reproduce on your own sessions: `node scripts/shape-profile.mjs`.

## How it works

**One brain, two doors, one lossless store:**

- **MCP server** (`knitbrain`) — 24 tools: memory (learnings, session handoff), knowledge graph (imports/exports/dependents), workflow classification, a `knitbrain_run` orchestrator (task → skill → agents → directive), an on-demand skills engine, project-specific agent generation, a shared team board, a **context-window meter** (warns and tells the agent to save a handoff before the window blows), and explicit `optimize`/`retrieve`. Every data payload flows through one dispatch chokepoint where it's compressed structure-preservingly (JSON keeps its schema, code keeps its signatures) and tagged with a `⟨ccr:hash⟩` handle.
- **Proxy** (`knitbrain-proxy`) — a loopback HTTP proxy in front of the LLM API (provider auto-detected per request: Anthropic `/v1/messages`, OpenAI `/v1/chat/completions`). Compresses the full request — old turns harder than recent ones, pasted bulk inside your message compressed while your directive stays verbatim — and streams the response back.
- **CCR store** — content-addressed (SHA-256 = handle), integrity-checked on every read, atomic writes, tiered retention (hot → cold gzip archive → budgeted purge). The pristine original is always one `retrieve` away, which is what makes aggressive compression safe.
- **Self-tuning** — a feedback loop watches which compressed payloads actually get retrieved and backs off per content-kind. A wrong tuning only costs efficiency, never correctness.

## Quickstart

```bash
npm install -g knitbrain

# in your project:
knitbrain setup        # detects your platform (Claude Code / Cursor / VS Code / Codex)
                       # and writes its NATIVE integration: .mcp.json, slash commands,
                       # rules files — non-clobbering

knitbrain dashboard    # live local dashboard (127.0.0.1:8790): context meter,
                       # tokens saved, CCR tiers, self-tuning stats, team board

# optional — route LLM requests through the optimizer (API-key setups):
knitbrain-proxy        # listens on 127.0.0.1:8788
export ANTHROPIC_BASE_URL=http://127.0.0.1:8788

# teams — shared optimized sessions (one URL + one token):
knitbrain hub                              # start the team hub (host runs this once)
knitbrain join <hub-url> <token> <name>    # everyone else; postings mirror automatically
```

## Guarantees (enforced by gated tests, not promises)

- **Lossless** — every compressed payload recovers byte-for-byte from CCR; the round-trip test gates the build.
- **Never-expand** — output tokens ≤ input tokens, always.
- **Governance verbatim** — protocol/classification text is never skeletonized.
- **Local-first** — proxy binds `127.0.0.1` only; nothing leaves your machine.

## Development

```bash
npm install
npm run verify       # typecheck → lint → test → build → bench (all must pass)
npm run e2e          # built-artifact E2E: stdio session + real-file compression
npm run audit:prod   # cold-start proof: clone → install → pack → installed binaries → all 24 tools
```

Current proof status: **122 tests passing**, and the production audit (`audit:prod`) passes — fresh clone, clean install, packed tarball installed into a new project, all 24 tools and both binaries verified working. One opt-in test (live LLM endpoint) requires your own API key: `KNITBRAIN_LIVE_TEST=1 ANTHROPIC_API_KEY=… npm test`.

## License

MIT © Piyush Dua
