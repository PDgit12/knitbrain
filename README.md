<h1 align="center">knitbrain</h1>

<p align="center"><strong>The local-first brain for coding agents.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/knitbrain"><img src="https://img.shields.io/npm/v/knitbrain?color=cb3837&logo=npm" alt="npm version"></a>
  <a href="https://github.com/PDgit12/knitbrain/actions/workflows/ci.yml"><img src="https://github.com/PDgit12/knitbrain/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/npm/l/knitbrain?color=blue" alt="MIT license"></a>
  <img src="https://img.shields.io/node/v/knitbrain?color=339933&logo=node.js" alt="Node version">
</p>

<p align="center">
Per-project memory · lossless context compression · tier-routed workflow · an autonomous build loop —
for <em>any</em> MCP-speaking agent, with or without an API key.
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#the-numbers">Numbers</a> ·
  <a href="#what-you-get">What you get</a> ·
  <a href="#loop-engineering">Loop engineering</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#commands">Commands</a>
</p>

---

Most tools in this space pick one axis. Compression layers shrink tokens but remember nothing.
Memory layers remember but burn your context window. knitbrain is **one substrate** that does both —
plus the workflow layer that makes an agent actually use them, and an autonomous loop that runs the
whole thing across fresh contexts.

It ships as an **MCP server** (27 tools), so it works in every MCP client (Claude Code, Cursor, Codex,
Copilot, Windsurf, Cline, and more) with one config line. **Pure Node, three dependencies, no Python, no ML
runtime, nothing leaves your machine.**

## Install

```bash
npm install -g knitbrain      # or: npx knitbrain <command>

knitbrain profile             # measure savings on YOUR transcripts — before installing anything
knitbrain setup               # wire it into your agent(s) — writes native config + AGENTS.md
```

Requires Node ≥ 18.

## The numbers

We publish the number most tools won't: the **all-inclusive average** over real coding sessions —
every tool-result token, *including* the small outputs that pass through uncompressed.

- **~46% saved** across ~3M real tool-result tokens (≈55% counting only blocks ≥ 400 chars).
- **68%** on the weighted real-shape benchmark mix (code 67% · logs 97% · JSON 97% · diffs 71% · prose 80%).
- **Lossless.** Every elision carries a `⟨recall:HASH⟩` handle that restores the exact original
  byte-for-byte. An answer-preservation suite (`knitbrain evals`) gates it: round-trip **100%**,
  identifier-fidelity **100%**, error/summary lines never dropped.

All three are reproducible on your own machine — `knitbrain profile`, `knitbrain evals`, `npm run bench`.
The exact percentage moves with your workload; run `profile` for yours.

## What you get

- **Lossless context compression.** Tool results (code, logs, diffs, JSON, prose) are routed to a
  structure-preserving skeletonizer (tree-sitter AST + deterministic handlers), the original kept in a
  content-addressed recall store. Never expands output; passes small payloads through untouched.
- **Per-project memory + knowledge graph.** Learnings ranked by outcome (a learning reported wrong is
  discredited and sinks), an imports/exports/dependents graph, session handoffs — all kept fresh
  (stale handoffs auto-clear, deleted files drop from the graph, classifier signals decay).
- **Tier-routed workflow.** A deterministic classifier sizes each task (inquiry → trivial → standard →
  complex) and routes the right depth — including plan-mode for complex work — with a self-healing
  false-positive loop.
- **An autonomous loop.** Drive an agent through a task queue solo (`loop`) or fan work out to N
  isolated parallel workers (`fan`) — verify-gated, never auto-merging. See below.
- **A live dashboard — zero setup.** Watch every connected agent work in real time, **auto-detected by
  platform and plan** (from the MCP handshake + env — nothing to configure). A per-agent optimization
  meter works on *any* MCP client (Cursor, VS Code, Codex, Copilot, Claude, …) because it measures
  knitbrain's own throughput; native usage windows show where the provider exposes them (Claude OAuth,
  Copilot quota).

## Loop engineering

The inner agent loop — load → classify → plan → build → verify → record — rides the MCP handshake.
On top of it sits the **outer loop**:

```bash
# one AFK worker drains a checkbox goal file, verify-gated:
knitbrain loop goal.md --verify "npm test"

# N workers in parallel, each isolated in its own git worktree:
knitbrain fan goal.md --workers 4 --verify "npm test"
```

A goal file is just markdown with `- [ ] task` checkboxes. Workers claim tasks atomically, run your
agent on each, and a task is marked done **only after verify passes** (no false green). It **never
commits, merges, or pushes** — parallel workers leave their branches for you to review. A queue with
workers and a human at the merge, not an infinite token loop.

## How it works

```
  any MCP agent  ──►  knitbrain MCP server  ──►  tool result
  (Claude Code,                │                      │
   Cursor, Codex,        ┌─────┴─────┐         detect → skeletonize
   Copilot, …)           │   brain   │         (AST / log / diff / json)
                         │ memory ·  │                │
                         │ graph ·   │         ⟨recall:HASH⟩ + original
                         │ classifier│              in recall store
                         └───────────┘                │
                                                 dashboard ◄─ live
```

Optional, for API-key users: a loopback proxy (`knitbrain wrap claude`) compresses the request
on the wire too. On a subscription, that wire path can't apply (OAuth traffic can't be intercepted —
true of every tool in this space) — but the main lever, tool-result compression, runs identically
either way, no API key required.

## Commands

| Command | What |
|---|---|
| `knitbrain setup` | Wire into your agent(s): MCP config, rules, slash commands, `AGENTS.md`. |
| `knitbrain profile` | Measure savings on your real transcripts. |
| `knitbrain evals` | Answer-preservation gates on your transcripts (exit 1 on failure). |
| `knitbrain loop <goal>` | Autonomous single-worker loop over a checkbox goal file. |
| `knitbrain fan <goal>` | Parallel loop — N workers in isolated git worktrees. |
| `knitbrain compress <file>` | Terse-rewrite a memory file (e.g. `CLAUDE.md`); keeps a backup. |
| `knitbrain terse [level]` | Print the terse-output guide (lite/full/ultra). |
| `knitbrain dashboard` | Live local dashboard (`127.0.0.1:8790`). |
| `knitbrain statusline` | Tokens-saved badge for your editor's status line. |
| `knitbrain wrap <agent>` | Launch an agent through the optimizer proxy (API-key setups). |
| `knitbrain learn` | Mine past sessions for failure→success corrections. |
| `knitbrain hub` / `join` | Optional team hub — shared sessions over one URL + token. |
| `knitbrain prompt` | Print the full operating prompt (for non-MCP platforms). |
| `knitbrain` *(no args)* | Start the MCP server on stdio — what your editor invokes. |

## Guarantees (enforced by gated tests, not promises)

- **Lossless** — every compressed payload recovers byte-for-byte; the round-trip test gates the build.
- **Never-expand** — output tokens ≤ input tokens, always.
- **Answers survive** — error lines, result summaries, and top-level declarations are never elided
  (`knitbrain evals` gates fidelity at 100% on real transcripts).
- **Fresh, not stale** — timestamped handoffs (flagged > 7 days, auto-cleared > 14), deleted files
  pruned from the graph, classifier votes decay; memory ranked by outcome.
- **Local-first** — proxy, hub, and dashboard bind `127.0.0.1`; nothing leaves your machine.
- **Reproducible** — every headline number comes from a command you can run on your own data.

## Use as a library

```ts
import { createOptimizer } from "knitbrain";

const kb = createOptimizer();           // recall store under ~/.knitbrain
const { skeleton, savedPct } = kb.compress(largeToolOutput);
// original always recoverable via the ⟨recall:HASH⟩ handle
```

## Development

```bash
npm run typecheck && npm run lint && npm run test && npm run build && npm run bench
```

All gates must pass before a commit or release.

## License

MIT
