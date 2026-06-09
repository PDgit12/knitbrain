# Knit Brain

> Local-first MCP server that gives any AI coding agent **per-project memory**, **workflow intelligence**, and **always-on, lossless token & context optimization** — entirely on your machine, zero cloud.

Knit Brain is the **Governor + Optimizer** for AI coding agents:

- **Governor** — per-project memory across sessions, a knowledge graph (imports/exports/tests), a tier-routed workflow protocol, and a self-correcting classifier.
- **Optimizer** — every payload the agent sends or receives is compressed structure-preservingly (JSON schemas kept, code signatures kept, bodies/values elided) with the **pristine original always recoverable** from a local content-addressed store. You pay for skeletons; you page in originals only when needed.

One pure-TypeScript process. No Python. No native binaries. No network.

---

## Why

Coding agents burn context on bulk they rarely re-read in full — large files, logs, JSON, stale tool output, old turns. Knit Brain shrinks that bulk to a navigable skeleton while keeping the exact original one lookup away, so:

- your context window lasts dramatically longer,
- nothing is ever lost (compression is **lossless via CCR**),
- and your governance/instructions are **never** touched (protected verbatim).

## Architecture (at a glance)

- **Two doors, one substrate.** An **MCP server** optimizes everything Knit controls (memory, knowledge, tool outputs); a **local proxy** transparently compresses the full LLM request (prompts + history). Both feed one lossless, content-addressed **CCR** store.
- **Reversible by design.** Compressed payloads carry a `⟨ccr:hash⟩` handle; the agent retrieves the exact original on demand. A round-trip test (`retrieve == original`, byte-for-byte) gates every release.
- **Self-correcting.** A feedback loop watches retrieval rates and tunes compression aggressiveness per content kind — over-compress and the worst case is *slower*, never *wrong*.

## Status

🚧 **Early development.** Building smallest → biggest, one gated rung at a time. Currently: **Rung 0 — scaffold** (MCP server skeleton + the five quality gates).

## Development

```bash
npm install
npm run verify   # typecheck → lint → test → build → bench (all must pass)
npm run dev      # run the MCP server locally over stdio
```

All five gates must be green before any commit.

## License

MIT
