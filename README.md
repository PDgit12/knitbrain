# Knit Brain

> Local-first MCP server that gives any AI coding agent **per-project memory**, **workflow intelligence**, and **always-on, lossless token & context optimization** — entirely on your machine, zero cloud.

Pure TypeScript. No Python, no native binaries, no network beyond `npm install`.

```bash
npx knitbrain profile    # measure what it would save on YOUR real sessions — before installing anything
```

## The honest number

Most tools in this space quote their best workload ("up to 90%!"). We publish the number nobody else does: the **whole-session average** — every tool result from real coding sessions, *including* the blocks that don't compress.

**On 3.08M tokens of tool results from 70 real Claude Code sessions: 55.8% saved overall, lossless.** Every original recoverable byte-for-byte.

| shape | % of real burn | saved |
|---|---|---|
| code & file reads | 47% | 59.6% |
| repetitive logs | 18% | 72.3% |
| short prose (reports, summaries) | 15% | 19.5% |
| long prose | 8% | 68.7% |
| test output | 6% | 46.4% |
| JSON | 5% | 65.8% |

Measured the way others measure — single best-case workloads — we land 60–99% (import graphs 98.9%, whole files 88.8%, body-heavy code 71.6%). But that's not the number you'll feel; the whole-session average is.

**Don't take our word for any of this.** `knitbrain profile` runs the actual optimizer over your own transcripts (`~/.claude/projects` by default) and prints *your* number. Local only — nothing is uploaded.

## Why this and not a point tool

Compression-only layers shrink tokens but remember nothing. Memory-only layers remember but burn your window. Knit Brain is one substrate doing both, plus the workflow layer that makes agents use them:

- **Memory** — per-project learnings, session handoffs, a knowledge graph (imports/exports/blast-radius), on-demand skills that compound across tasks.
- **Lossless optimization** — structure-preserving skeletons (JSON keeps its schema, code keeps its signatures via tree-sitter AST), cross-turn dedup of re-sent bulk, sentence anchoring for prose — all reversible through a content-addressed store.
- **Workflow intelligence** — a deterministic tier classifier (inquiry/trivial/standard/complex) routing how much process a task deserves, with guardrailed agent generation and a shared team board.
- **Self-healing, not self-confident** — two feedback loops run continuously: TOIN backs off any compression kind that gets over-retrieved, and the classifier shifts its own thresholds after 3 wrong-verdict votes (`knitbrain_record_false_positive`). Wrong tuning costs efficiency, never correctness.

## How it works

**One brain, two doors, one lossless store:**

- **MCP server** (`knitbrain`) — 25 tools: memory (learnings, session handoff), knowledge graph (imports/exports/dependents), workflow classification with a self-healing false-positive loop (3 wrong-verdict votes shift the threshold), a `knitbrain_run` orchestrator (task → skill → agents → directive), an on-demand skills engine, project-specific agent generation, a shared team board, a **context-window meter** (warns and tells the agent to save a handoff before the window blows), and explicit `optimize`/`retrieve`. Every data payload flows through one dispatch chokepoint where it's compressed structure-preservingly and tagged with a `⟨ccr:hash⟩` handle.
- **Proxy** (`knitbrain-proxy`) — a loopback HTTP proxy in front of the LLM API (provider auto-detected per request: Anthropic `/v1/messages`, OpenAI `/v1/chat/completions`). Compresses the full request — old turns harder than recent ones, exact repeats across turns collapsed to a marker, pasted bulk inside your message compressed while your directive stays verbatim — and streams the response back.
- **CCR store** — content-addressed (SHA-256 = handle), integrity-checked on every read, atomic writes, tiered retention (hot → cold gzip archive → budgeted purge). The pristine original is always one `retrieve` away, which is what makes aggressive compression safe.
- **Live dashboard** — context meter, tokens saved, CCR tiers, self-tuning stats, knowledge graph, skills, recent learnings, team board. All stores are cross-process fresh: what the agent writes, the dashboard shows on the next tick.

## Quickstart

```bash
npm install -g knitbrain

knitbrain profile      # your savings, on your transcripts, before you commit to anything

# in your project:
knitbrain setup        # detects your platform (Claude Code / Cursor / VS Code / Codex)
                       # and writes its NATIVE integration: .mcp.json, slash commands,
                       # rules files — non-clobbering

knitbrain dashboard    # live local dashboard (127.0.0.1:8790)

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
- **Governance verbatim** — your instructions and protocol/classification text are never skeletonized.
- **Local-first** — proxy, hub, and dashboard bind `127.0.0.1` by default; nothing leaves your machine.
- **Reproducible claims** — every number in this README comes from `knitbrain profile` or `npm run bench`, both of which you can run yourself.

## Development

```bash
npm install
npm run verify       # typecheck → lint → test → build → consistency → bench (all must pass)
npm run e2e          # built-artifact E2E: stdio session + real-file compression
npm run audit:prod   # cold-start proof: clone → install → pack → installed binaries → all 25 tools
```

Current proof status: **159 tests passing**, and the production audit (`audit:prod`) passes — fresh clone, clean install, packed tarball installed into a new project, all 25 tools and both binaries verified working. One opt-in test (live LLM endpoint) requires your own API key: `KNITBRAIN_LIVE_TEST=1 ANTHROPIC_API_KEY=… npm test`.

## License

MIT © Piyush Dua
