# Knit Brain

[![npm](https://img.shields.io/npm/v/knitbrain)](https://www.npmjs.com/package/knitbrain)
[![ci](https://github.com/PDgit12/knitbrain/actions/workflows/ci.yml/badge.svg)](https://github.com/PDgit12/knitbrain/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](package.json)

> The local-first brain for coding agents: per-project memory, task-tier workflow routing, and lossless context compression — measured 48.7% of all tool-result tokens on real sessions, with answer-preservation gates, reproducible with one command.

Pure TypeScript. No Python, no native binaries, no network beyond `npm install`.

```bash
npx knitbrain profile    # measure what it would save on YOUR real sessions — before installing anything
npx knitbrain evals      # prove the answers survive — same corpus, deterministic judging
```

## The honest number

Most tools in this space quote their best workload ("up to 90%!"). We publish the number nobody else does: the **all-inclusive average** — every tool-result token from real coding sessions, *including* the small outputs that pass through uncompressed.

**On 3.33M tokens of tool results from 63 real Claude Code sessions: 48.7% saved overall, lossless.** That denominator includes every tool-result token — even the 0.4M tokens of small outputs that pass through untouched (counting only sizable blocks ≥400 chars, the number is 55.4%). Every original recoverable byte-for-byte.

| shape | % of real burn | saved |
|---|---|---|
| code & file reads | 47% | 60.3% |
| repetitive logs | 17% | 70.5% |
| short prose (reports, summaries) | 16% | 18.0% |
| long prose | 7% | 69.2% |
| test output | 6% | 47.4% |
| JSON | 5% | 65.1% |
| diffs | 1% | 62.7% |

Measured the way others measure — single best-case workloads — we land 60–99% (import graphs 98.9%, whole files 88.8%, body-heavy code 71.6%). But that's not the number you'll feel; the all-inclusive average is.

**Don't take our word for any of this.** `knitbrain profile` runs the actual optimizer over your own transcripts (`~/.claude/projects` by default) and prints *your* number. Local only — nothing is uploaded.

## Same answers, measured

Saving tokens is worthless if the agent loses the answer. `knitbrain evals` checks — on the same real corpus, with deterministic string-containment judging (no LLM judge to flatter us) — that the facts agents act on survive compression:

| check | result | gate |
|---|---|---|
| error-fidelity — every error/failure line survives in the skeleton | **142/142 = 100%** | 100% |
| summary-fidelity — test/build result totals survive | **189/189 = 100%** | ≥95% |
| identifier-fidelity — top-level declared names survive | **329/331 = 99.4%** | ≥99% |
| round-trip — `⟨ccr:hash⟩` recovers the original byte-for-byte | **2,369/2,369 = 100%** | 100% |
| never-expand — no compressed block got bigger | **4,567/4,567 = 100%** | 100% |

These gates shaped the product: error lines, result summaries, and declarations are *never* elided, by every handler. Holding that line costs about 1 percentage point of savings — we pay it, and publish both numbers. Run `npx knitbrain evals` (exit code 1 on any gate failure) to check on your own transcripts.

## Why this and not a point tool

Compression-only layers shrink tokens but remember nothing. Memory-only layers remember but burn your window. Knit Brain is one substrate doing both, plus the workflow layer that makes agents use them:

- **Memory** — per-project learnings, session handoffs, a knowledge graph (imports/exports/blast-radius), on-demand skills that compound across tasks, and `knitbrain learn` — offline failure mining that writes corrections from your real sessions into CLAUDE.md.
- **Lossless optimization** — structure-preserving skeletons (JSON keeps its schema; code keeps its signatures via tree-sitter AST across TypeScript/TSX/JS, Python, Go, Rust, Java, C++, C#, Ruby, PHP, Bash), dedicated handlers for search results, build/test logs, and diffs (error lines always survive), cross-turn dedup of re-sent bulk, sentence anchoring for prose — all reversible through a content-addressed store.
- **Workflow intelligence** — a deterministic tier classifier (inquiry/trivial/standard/complex) routing how much process a task deserves; complex verdicts carry an explicit ENTER-PLAN-MODE directive the agent follows before touching files; guardrailed agent generation and a shared team board.
- **Self-healing, not self-confident** — two feedback loops run continuously: TOIN backs off any compression kind that gets over-retrieved, and the classifier shifts its own thresholds after 3 wrong-verdict votes (`knitbrain_record_false_positive`). Wrong tuning costs efficiency, never correctness.
- **Closed loop, zero config** — the full operating protocol (load session → classify → plan-mode adherence → skills → agents → context discipline → record learning) rides the MCP handshake itself. Any MCP client gets it without a single file of setup; `knitbrain prompt` prints it for platforms that want it in a system prompt.

## Architecture

```
 agent (Claude Code / Cursor / Codex)              your app (API key)
            │                                            │
            ▼                                            ▼
 ┌──────────────────────────┐            ┌──────────────────────────────┐
 │  knitbrain · MCP server  │            │  knitbrain-proxy (loopback)  │
 │  26 tools                │            │  rolling window — old turns  │
 │  ├ memory: learnings,    │            │  compressed harder · exact   │
 │  │ handoffs, sessions    │            │  repeats deduped to markers  │
 │  ├ knowledge graph       │            │  · your directive verbatim   │
 │  ├ classifier + FP loop  │            │  · CacheAligner prefix       │
 │  ├ skills · agents       │            └──────────────┬───────────────┘
 │  ├ team board · meter    │                           │ smaller request
 │  └ optimize / retrieve   │                           ▼
 └────────────┬─────────────┘            LLM provider (Anthropic
              │ every data payload        /v1/messages · OpenAI
              ▼                           /v1/chat/completions)
 ┌──────────────────────────────────────────────┐
 │ optimizer router                             │
 │  json   → schema-preserving skeleton         │
 │  code   → tree-sitter AST body elision       │
 │           (TS/JS · Py · Go · Rust · Java ·   │
 │            C++ · C# · Ruby · PHP · Bash)     │
 │  search → per-file collapse + counts         │
 │  logs   → errors+summaries kept, runs        │
 │           collapsed (races template dedup)   │
 │  diffs  → headers kept, hunks → ±counts      │
 │  prose  → sentence anchor (TOIN-gated)       │
 │  errors / result lines NEVER elided          │
 └────────────────────┬─────────────────────────┘
                      ▼ skeleton + ⟨ccr:hash⟩
 ┌──────────────────────────────────────────────┐     ┌─────────────────┐
 │ CCR store — lossless, content-addressed      │◀───▶│ live dashboard  │
 │ (sha256 = handle) · integrity-checked reads  │     │ 127.0.0.1:8790  │
 │ hot → cold gzip → budgeted purge             │     └─────────────────┘
 └──────────────────────────────────────────────┘
   self-healing: TOIN backs off over-retrieved kinds ·
   classifier recalibrates after 3 wrong-verdict votes
```

**One brain, two doors, one lossless store:**

- **MCP server** (`knitbrain`) — 26 tools: memory (learnings, session handoff), knowledge graph (imports/exports/dependents), workflow classification with a self-healing false-positive loop (3 wrong-verdict votes shift the threshold), a `knitbrain_run` orchestrator (task → skill → agents → directive), an on-demand skills engine with an outcome signal (skills that keep failing are flagged needs-revision, failure notes fold into the playbook), project-specific agent generation, a shared team board, a **context-window meter** (warns and tells the agent to save a handoff before the window blows), and explicit `optimize`/`retrieve`. Every data payload flows through one dispatch chokepoint where it's compressed structure-preservingly and tagged with a `⟨ccr:hash⟩` handle.
- **Proxy** (`knitbrain-proxy`) — a loopback HTTP proxy in front of the LLM API (provider auto-detected per request: Anthropic `/v1/messages`, OpenAI `/v1/chat/completions`). Compresses the full request — old turns harder than recent ones, exact repeats across turns collapsed to a marker, pasted bulk inside your message compressed while your directive stays verbatim — and streams the response back.
- **CCR store** — content-addressed (SHA-256 = handle), integrity-checked on every read, atomic writes, tiered retention (hot → cold gzip archive → budgeted purge). The pristine original is always one `retrieve` away, which is what makes aggressive compression safe.
- **Live dashboard** — context meter, tokens saved, CCR tiers, self-tuning stats, knowledge graph, skills, recent learnings, team board. All stores are cross-process fresh: what the agent writes, the dashboard shows on the next tick.

## Quickstart

```bash
npm install -g knitbrain

knitbrain profile      # your savings, on your transcripts, before you commit to anything

# in your project — ONE command configures everything (memory, workflow,
# plan-mode adherence, skills, teams, meter, hooks; non-clobbering):
knitbrain setup        # native integration per platform: Claude Code, Cursor,
                       # VS Code + Copilot, Windsurf (+ snippets for Codex,
                       # Copilot CLI, Zed — their MCP configs are global)

knitbrain dashboard    # live local dashboard (127.0.0.1:8790)
knitbrain learn        # mine past sessions for failure→success corrections (--apply writes CLAUDE.md)
knitbrain evals        # answer-preservation gates on your own transcripts
knitbrain prompt       # full operating prompt, for platforms without MCP-instructions support

# optional — route LLM requests through the optimizer (API-key setups):
knitbrain-proxy        # listens on 127.0.0.1:8788
export ANTHROPIC_BASE_URL=http://127.0.0.1:8788

# teams — shared optimized sessions (one URL + one token):
knitbrain hub                              # start the team hub (host runs this once)
knitbrain join <hub-url> <token> <name>    # everyone else; postings mirror automatically
```

## Use as a library

The same router that powers the proxy and MCP server is importable directly — no server, no config:

```ts
import { createOptimizer } from "knitbrain";

const kb = createOptimizer();                 // CCR store under ~/.knitbrain/ccr
const r = kb.compress(bigToolOutput);          // detect → route → compress
console.log(r.savedPct, r.contentType);        // e.g. 62.4 "json"
// r.skeleton → hand to the model; kb.retrieve(r.handle) → exact original, byte-for-byte
```

`compress()` is lossless (original always recoverable via the CCR handle) and guarded — if compression doesn't save at least 5%, the original passes through untouched.

## If you pay per token

Agent loops re-send the entire conversation on every turn, so input tokens dominate the bill — usually by an order of magnitude over output. That makes context the thing worth optimizing:

- **The proxy shrinks the request itself, on the wire.** ~49% fewer tool-result tokens means a proportionally smaller input bill on the bulk of every request, every turn, compounding over a session.
- **It stacks with provider prompt caching.** CacheAligner keeps the system prefix byte-stable across turns: whitespace normalization, volatile lines ("Today's date is …") moved out of the prefix to a marked tail, and — when your client doesn't manage its own — Anthropic `cache_control` breakpoints inserted at the system prompt and the stable history boundary. Cached input reads are ~90% cheaper on Anthropic; OpenAI prefix caching needs exactly the byte-stability this provides. Compression is deterministic, so optimized history prefixes stay stable turn over turn — the two levers stack.
- **It can never make a request more expensive.** The never-expand guard is enforced by tests: output tokens ≤ input tokens, always.
- **On a subscription instead?** Same mechanics, different currency: fewer tokens per turn means the context window fills slower — fewer compactions, fewer lost-context restarts, longer useful sessions.

Run `knitbrain profile` to see the percentage on your own workload before believing any of this.

## Guarantees (enforced by gated tests, not promises)

- **Lossless** — every compressed payload recovers byte-for-byte from CCR; the round-trip test gates the build.
- **Never-expand** — output tokens ≤ input tokens, always.
- **Errors survive** — error/failure lines, result summaries, and top-level declarations are never elided; `knitbrain evals` gates this at 100%/≥95%/≥99% on real transcripts.
- **Governance verbatim** — your instructions and protocol/classification text are never skeletonized.
- **Local-first** — proxy, hub, and dashboard bind `127.0.0.1` by default; nothing leaves your machine.
- **Reproducible claims** — the headline numbers come from `knitbrain profile` and `knitbrain evals` on real transcripts, both of which you can run on yours. (`npm run bench` is a CI regression gate: a real-shape suite whose fixture mix mirrors the profiled distribution, with per-shape savings floors and fidelity checks, plus a clearly-labeled best-case suite — fixture numbers are never quoted as real-world savings.)

## Development

```bash
npm install
npm run verify       # typecheck → lint → test → build → consistency → bench (all must pass)
npm run e2e          # built-artifact E2E: stdio session + real-file compression
npm run audit:prod   # cold-start proof: clone → install → pack → installed binaries → all 26 tools
```

Current proof status: **199 tests passing**, eval gates PASS on 4,567 real blocks, and the production audit (`audit:prod`) passes — fresh clone, clean install, packed tarball installed into a new project, all 26 tools and the three binaries verified working. One opt-in test (live LLM endpoint) requires your own API key: `KNITBRAIN_LIVE_TEST=1 ANTHROPIC_API_KEY=… npm test`.

## License

MIT © Piyush Dua
