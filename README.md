<h1 align="center">knitbrain</h1>

<p align="center"><strong>The local-first brain for coding agents — retrieval, lossless compression, persistent memory, and a verify-gated closed loop, in one MCP server.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/knitbrain"><img src="https://img.shields.io/npm/v/knitbrain?color=cb3837&logo=npm" alt="npm version"></a>
  <a href="https://github.com/PDgit12/knitbrain/actions/workflows/ci.yml"><img src="https://github.com/PDgit12/knitbrain/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/npm/l/knitbrain?color=blue" alt="MIT license"></a>
  <img src="https://img.shields.io/node/v/knitbrain?color=339933&logo=node.js" alt="Node version">
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#what-it-does">What it does</a> ·
  <a href="#measured-not-promised">Numbers</a> ·
  <a href="#how-it-reaches-your-traffic">How it works</a> ·
  <a href="#how-it-compares">Comparison</a> ·
  <a href="#commands">Commands</a> ·
  <a href="#guarantees">Guarantees</a>
</p>

---

Coding agents burn most of their tokens on context — files they didn't need, logs resent every
turn, knowledge re-derived every session. knitbrain is a local-first **MCP server (37 tools)**
that attacks all three leaks at once, for any agent that speaks MCP: Claude Code, Cursor, Copilot,
Codex, Windsurf, Cline, and others.

- **Send less** — a retrieval layer returns ranked, score-gated function-level chunks instead of whole files.
- **Shrink what's sent, losslessly** — large tool output collapses to a skeleton with a `⟨recall:hash⟩` handle; the exact original is always one call away.
- **Stop re-deriving** — per-project memory, a knowledge graph, and a compounding wiki survive `/clear`, restarts, and even switching tools.
- **Finish what you start** — a closed loop where "done" means your verify command exited 0, never the model's opinion.

Pure Node, three runtime dependencies, no Python, no ML runtime. Everything lives under
`~/.knitbrain`; the proxy, hub, and dashboard bind `127.0.0.1`. Nothing leaves your machine.

## Quick start

```bash
npx knitbrain profile      # 1. measure compression on YOUR transcripts — see the number first
npm install -g knitbrain   # 2. install
knitbrain setup            # 3. wire into your agent(s): MCP config, rules, hooks, slash commands
```

Then open your agent in a project and say **"onboard this project"** — a 5-question interview
writes a Project Charter, a per-part workflow, and a loop-ready `goal.md`. Requires Node ≥ 18.

## What it does

### 1. Retrieval — send only the code that matters

`knitbrain_search_code` turns "find the auth middleware" into ranked function/class-level chunks:
name- and signature-boosted keyword ranking, knowledge-graph expansion (what imports / depends on
each hit), and an adaptive score gate — an empty result beats confidently-wrong context. The agent
reads only the hits, not the tree.

### 2. Compression — lossless, never-expanding

Tool results (code, logs, diffs, JSON, prose) route through a structure-preserving skeletonizer
(tree-sitter AST + deterministic handlers). The exact original lands in a content-addressed recall
store; the agent sees a skeleton plus a `⟨recall:hash⟩` handle and pages the original back on
demand. Small or incompressible payloads pass through untouched. JSON tool responses are never
skeletonized — machine contracts stay parseable.

### 3. Memory — one brain, every session, every tool

Learnings ranked by outcome (a learning reported wrong is discredited and sinks), an
imports/exports/dependents knowledge graph that re-scans itself on read, session handoffs that
survive `/clear`, and a small interlinked wiki the agent maintains instead of re-reading the
codebase every morning. The same brain serves every MCP tool you use — explain the project once,
Cursor inherits what Claude Code learned.

### 4. The closed loop — goal until verified done

```
goal → judge → iterate → grade (your verify command, exit 0 or not) → review → repeat
```

- **In your agent:** `knitbrain_run_loop` runs the verify gate each cycle and hands back "not met —
  smallest fix, go again" until it passes. An adherence gate blocks memory writes until a task was
  classified — unverified "done" cannot enter the brain.
- **Around an agent:** `knitbrain loop | fan | orchestrate` drive a checkbox goal file headlessly —
  `fan` runs N workers in isolated git worktrees. The loop never commits, pushes, or deploys.

### 5. Workflow — every part of the project has an owner

Onboarding scans your existing skills, agents, and plugins (project + global), asks what's missing,
scaffolds scoped agents for uncovered parts, and bakes a standing workflow — GOAL, VERIFY,
CONSTRAINTS, TOOLKIT, per-part ROUTING — that re-surfaces verbatim every session. A deterministic
classifier sizes each task (inquiry → trivial → standard → complex) and routes plan-mode for
complex work. `knitbrain_self_check` audits seven invariants (anti-stale, anti-drift,
anti-sycophancy, adherence, context-hygiene…) in one pass.

## Measured, not promised

Run these on your own data — every number below is reproducible with one command.

| Measurement | Result | Reproduce |
|---|---|---|
| Average reduction over ~3M real tool-result tokens | ~46% (≈55% on blocks ≥ 400 chars) | `knitbrain profile` |
| Weighted real-shape benchmark (code · logs · JSON · diffs · prose) | 68% | `npm run bench` |
| Answer preservation (round-trip · identifiers · error/summary lines) | 100% | `knitbrain evals` |

These are the **ceiling** — what you save when output flows through the optimizer. Your **realized**
number is the live meter (`knitbrain dashboard`), which counts only what actually passed through.
Honest expectations: 60–70% on code/JSON/logs, ~18% on prose, ~48% all-inclusive on measured real
sessions — less inside an already-lean harness, more on raw API traffic.

## How it reaches your traffic

The optimizer is identical everywhere; what differs is reach:

- **API key** — a loopback proxy (`knitbrain wrap <agent>`) compresses every request on the wire,
  keeps the provider's prompt-cache discount intact (CacheAligner: stable prefix, volatile lines
  moved to a marked tail), detects the model's context window, and can inject a terse-output
  directive (`KNITBRAIN_TERSE=1`).
- **Subscription (OAuth)** — the wire can't be intercepted (true for every tool in this space), so
  knitbrain works through the MCP + hook surface instead: `knitbrain_read` for files, and on Claude
  Code a PostToolUse hook that skeletonizes Bash/Grep/Glob/WebFetch output in place. Assistant
  prose lands on disk in the host's transcripts — SessionStart mines new ones into the brain
  automatically.

## How it compares

Token burn has three taps: **input** (what the model reads), **output** (what it writes), and
**memory** (what gets re-derived every session). Single-tap tools close one; knitbrain closes all
three from one install — and states plainly where the standard criticisms apply:

| Common criticism of single-tap tools | knitbrain's answer |
|---|---|
| "Compression retrieval is a second call; small payloads can cost more" | **Never-expand is build-gated**: small/incompressible payloads pass through. Retrieval is on-demand, not speculative. |
| "Compressing context breaks the provider's cache discount" | The **CacheAligner** exists for exactly this — stable prefix bytes, `cache_control` added only when the client set none. |
| "Lossy compression makes models confidently wrong" | Compression here is **lossless** — 100% round-trip, 100% identifier fidelity, error lines never elided, gated in CI, byte-for-byte recovery always available. |
| "Inside a lean harness there's little left to squeeze" | True, and measured honestly — that's why the MCP + hook path exists (works *inside* Claude Code) and why `knitbrain profile` measures **your** transcripts first. |
| "Terse output degrades multi-turn quality" | Terse mode never drops technical content, numbers, paths, or decision-changing caveats — and it's opt-in at every layer. |
| "The real fix is discipline, not tools" | Agreed — that's the third tap: tier routing, verify-before-done, self-check invariants, and memory that stops the most expensive burn of all: re-deriving context. |

Percentages from different taps overlap the same bill; they add, they don't multiply.

## Platform support

| Platform | MCP tools | Auto-compression | Slash commands | Notes |
|---|---|---|---|---|
| Claude Code | ✅ | ✅ hooks (deepest) | `/meter` `/handoff` `/terse` | full lifecycle hooks |
| Cursor · Windsurf · Cline | ✅ | via `knitbrain_read` | — | native config written by `setup` |
| Copilot (VS Code + CLI) | ✅ | via `knitbrain_read` | — | `.vscode/mcp.json` + `.github/instructions` |
| Codex and any MCP client | ✅ | via `knitbrain_read` | — | one universal server entry |
| Any agent, API key | ✅ | ✅ proxy (full wire) | — | `knitbrain wrap <agent>` |

## Commands

| Command | What it does |
|---|---|
| `knitbrain` *(no args)* | Start the MCP server on stdio — what your editor invokes. |
| `knitbrain setup` | Wire into your agent(s): MCP config, rules, hooks, slash commands, `AGENTS.md`. |
| `knitbrain profile` | Measure compression on your real transcripts. |
| `knitbrain evals` | Answer-preservation gates on your transcripts (exit 1 on failure). |
| `knitbrain orchestrate <goal>` | The closed loop: judge → iterate → grade → review, verify-gated. |
| `knitbrain loop <goal>` | Single-worker loop over a checkbox goal file. |
| `knitbrain fan <goal>` | Parallel loop — N workers in isolated git worktrees. |
| `knitbrain dashboard` | Live local dashboard (`127.0.0.1:8790`): meter, graph, wiki, activity, plan usage. |
| `knitbrain wrap <agent>` | Launch an agent through the optimizer proxy (API-key setups). |
| `knitbrain compress <file>` | Terse-rewrite a memory file (e.g. `CLAUDE.md`); keeps a backup. |
| `knitbrain learn` | Mine past sessions for failure → success corrections. |
| `knitbrain hub` / `join` | Optional team hub — shared findings over one URL and token. |
| `knitbrain statusline` | Tokens-saved badge for your editor's status line. |
| `knitbrain prompt` | Print the operating prompt (for non-MCP platforms). |

## Guarantees

Gated by tests and CI, not promised:

- **Lossless** — every compressed payload recovers byte-for-byte; the round-trip test gates the build.
- **Never-expand** — output tokens ≤ input tokens, always.
- **Answers survive** — error lines, result summaries, and top-level declarations are never elided (`knitbrain evals`, 100% on real transcripts).
- **Machine contracts hold** — JSON tool responses are never skeletonized.
- **No false green** — the loop marks a task done only after a real verify passes.
- **Local-first** — proxy, hub, and dashboard bind `127.0.0.1`; credentials are read locally, sent only to the provider's own endpoint, never logged or stored.
- **Reproducible** — every number in this README comes from a command you can run on your own data.

Two integration notes worth knowing up front:

- Parsing tool results programmatically? A large *non-JSON* response may carry a trailing
  `⟨recall:hash⟩` handle — strip it (or retrieve the original) before parsing.
- The adherence gate blocks close-the-loop writes until a classifier ran this session
  (`KNITBRAIN_STRICTNESS`, default `block`; set `warn` or `off` to relax).

## Use as a library

```js
import { createOptimizer } from "knitbrain";

const opt = createOptimizer();               // optional: { ccrDir, params }
const r = opt.optimize(bigToolOutput);        // { text, saved, handle, contentType }
const original = opt.retrieve(r.handle);      // exact bytes back
```

## Development

```bash
git clone https://github.com/PDgit12/knitbrain && cd knitbrain
npm install
npm run verify        # typecheck · lint · build · test · consistency · bench — all gates
npm run e2e           # end-to-end against the built artifact
```

Contributions welcome — branch off `main`, conventional commits, `npm run verify` green before any PR.

## License

[MIT](LICENSE)
