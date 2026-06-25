<h1 align="center">knitbrain</h1>

<p align="center"><strong>Token optimization, a compounding wiki, and an autonomous loop — for any MCP coding agent.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/knitbrain"><img src="https://img.shields.io/npm/v/knitbrain?color=cb3837&logo=npm" alt="npm version"></a>
  <a href="https://github.com/PDgit12/knitbrain/actions/workflows/ci.yml"><img src="https://github.com/PDgit12/knitbrain/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/npm/l/knitbrain?color=blue" alt="MIT license"></a>
  <img src="https://img.shields.io/node/v/knitbrain?color=339933&logo=node.js" alt="Node version">
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#1-token-optimization">Optimization</a> ·
  <a href="#2-the-wiki">Wiki</a> ·
  <a href="#3-the-closed-loop">Closed loop</a> ·
  <a href="#also-included">More</a> ·
  <a href="#how-compression-reaches-your-traffic">How it works</a> ·
  <a href="#commands">Commands</a>
</p>

---

knitbrain is a local-first **MCP server** (31 tools) that any coding agent can connect to — Claude Code,
Cursor, Codex, Copilot, Windsurf, Cline, and others. It does three things, plus the supporting pieces
that make them work:

1. **Token optimization** — losslessly compress large tool output so your context window lasts longer.
2. **A wiki** — a compounding markdown knowledge base the agent maintains, instead of re-deriving context every session.
3. **A closed loop** — drive a goal to a verified result through repeated judge → iterate → grade → review cycles.

Pure Node, three runtime dependencies, no Python, no ML runtime. Everything runs locally under
`~/.knitbrain`; the proxy, hub, and dashboard bind `127.0.0.1`. Every number below comes from a command
you can run on your own data.

## Install

```bash
npm install -g knitbrain          # or: npx knitbrain <command>

knitbrain profile                 # measure compression on YOUR transcripts, before changing anything
knitbrain setup                   # wire it into your agent(s): MCP config, rules, AGENTS.md
```

Requires Node ≥ 18. `setup` writes native config per platform and, on Claude Code, the lifecycle hooks.

---

## 1. Token optimization

Tool results (code, logs, diffs, JSON, prose) are routed to a structure-preserving skeletonizer
(tree-sitter AST plus deterministic handlers). The exact original is kept in a content-addressed recall
store; the agent sees a skeleton plus a `⟨recall:HASH⟩` handle and pages the original back when it needs
it. Small or incompressible payloads pass through unchanged.

Two properties are enforced by the build, not asserted:

- **Lossless** — every elision recovers byte-for-byte. `knitbrain evals` gates it on real transcripts:
  round-trip 100%, identifier-fidelity 100%, error and summary lines never dropped.
- **Never-expand** — the skeleton is never larger than the input.

**Measured reach** (run `knitbrain profile` for your own numbers, `npm run bench` for the benchmark):

| Measurement | Result | Reproduce |
|---|---|---|
| Average reduction over ~3M real tool-result tokens | ~46% (≈55% on blocks ≥ 400 chars) | `knitbrain profile` |
| Weighted real-shape benchmark (code · logs · JSON · diffs · prose) | 68% | `npm run bench` |
| Answer-preservation (round-trip · identifier · summary) | 100% | `knitbrain evals` |

These are the **ceiling** — what you save when output flows through the optimizer. How much of your
*live* traffic that covers depends on your setup ([how compression reaches your traffic](#how-compression-reaches-your-traffic));
your **realized** number is the live meter (`knitbrain dashboard`), which counts only what actually
passed through.

## 2. The wiki

A small, local, per-project wiki — interlinked markdown notes and a session log, not an encyclopedia.
Most agent setups re-read and re-derive context every session; this is the opposite: knowledge is filed
once into linked pages and kept current rather than rebuilt on every query. knitbrain maintains the
**bookkeeping** reliably (index, cross-links, log); the depth of each page is whatever the agent writes
into it via `wiki_ingest`.

It lives at `~/.knitbrain/projects/<id>/wiki/`:

- `pages/` — one terse page per entity, concept, summary, or session.
- `index.md` — a catalog the agent reads first to find the right page.
- `log.md` — an append-only chronicle (`## [date] event | title`), which doubles as the per-session log.

Three operations, exposed as MCP tools:

- **ingest** (`knitbrain_wiki_ingest`) — write or update a page, rebuild the index, append the log, and
  stub any cross-referenced page.
- **query** (`knitbrain_wiki_query`) — read the index and recent log to find the pages to drill into.
- **lint** (`knitbrain_wiki_lint`) — flag claim contradictions across pages and orphan pages nothing links to.

On Claude Code each turn is appended to the log automatically; `knitbrain_load_session` surfaces recent
entries so a fresh session inherits what prior sessions did. A live dashboard panel renders the wiki and
its links.

## 3. The closed loop

`knitbrain orchestrate <goal>` drives a goal file to a verified result:

```
goal → judge → iterate → grade → review → repeat (until met, or a hard cycle cap)
```

- **judge** — is the goal clear enough to attempt?
- **iterate** — one orchestrated pass; the work scales with project intensity (a matched skill for small
  tasks, the skill plus briefed agent guardrails for complex ones).
- **grade** — a real verify command runs; exit 0 or not. A failing grade is never reported as met.
- **review** — the result is scored against a rubric.

Every cycle is token-metered and written to the wiki as an audit trail. The loop **never commits, pushes,
or deploys** — that stays with you. There is also a simpler outer loop for a checkbox task queue:

```bash
knitbrain loop goal.md  --verify "npm test"                 # one worker, verify-gated
knitbrain fan  goal.md  --workers 4 --verify "npm test"     # N workers, each in its own git worktree
```

A task is marked done only after verify passes (no false green), and parallel workers leave their
branches for you to review.

## Also included

These support the three pillars:

- **Per-project memory** — learnings ranked by outcome (one reported wrong is discredited and sinks), an
  imports/exports/dependents knowledge graph, and session handoffs. Kept fresh: stale handoffs auto-clear,
  deleted files drop from the graph, classifier signals decay.
- **Skills and agents from your setup** — `setup` scans your existing `.claude/skills` and `.claude/agents`,
  registers them (deduped), and can compose new ones in your own style (`knitbrain_compose_skill`,
  `knitbrain_create_agent`).
- **Tier-routed workflow** — a deterministic classifier sizes each task (inquiry → trivial → standard →
  complex) and routes the right depth, including plan-mode for complex work.
- **Live dashboard** — `knitbrain dashboard` shows the optimization meter, knowledge graph, wiki, and a
  per-agent activity feed. Zero config; auto-detects platform and plan from the MCP handshake.

## How compression reaches your traffic

The optimizer is the same in both cases; what differs is reach.

- **API key** — a loopback proxy (`knitbrain wrap <agent>`) compresses every request on the wire: all tool
  results in the transcript, automatically.
- **Subscription** (OAuth traffic can't be intercepted, which holds for any tool in this space) — knitbrain
  compresses through the MCP and hook surface instead: `knitbrain_read` for files, and on Claude Code a
  PostToolUse hook skeletonizes Bash, Grep, Glob, and WebFetch output inline (via `updatedToolOutput`),
  the original kept in the recall store. No API key, no proxy.

The proxy covers everything; the hook path covers the host tools your platform lets a hook rewrite (full
on Claude Code, narrower elsewhere). The dashboard meter shows your realized number either way.

## Commands

| Command | What it does |
|---|---|
| `knitbrain` *(no args)* | Start the MCP server on stdio — what your editor invokes. |
| `knitbrain setup` | Wire into your agent(s): MCP config, rules, slash commands, `AGENTS.md`. |
| `knitbrain profile` | Measure compression on your real transcripts. |
| `knitbrain evals` | Answer-preservation gates on your transcripts (exit 1 on failure). |
| `knitbrain orchestrate <goal>` | The closed loop: judge → iterate → grade → review → repeat, verify-gated. |
| `knitbrain loop <goal>` | Single-worker loop over a checkbox goal file. |
| `knitbrain fan <goal>` | Parallel loop — N workers in isolated git worktrees. |
| `knitbrain dashboard` | Live local dashboard (`127.0.0.1:8790`). |
| `knitbrain wrap <agent>` | Launch an agent through the optimizer proxy (API-key setups). |
| `knitbrain compress <file>` | Terse-rewrite a memory file (e.g. `CLAUDE.md`); keeps a backup. |
| `knitbrain learn` | Mine past sessions for failure → success corrections. |
| `knitbrain hub` / `join` | Optional team hub — shared sessions over one URL and token. |
| `knitbrain statusline` | Tokens-saved badge for your editor's status line. |
| `knitbrain prompt` | Print the operating prompt (for non-MCP platforms). |

## Guarantees (gated by tests, not promises)

- **Lossless** — every compressed payload recovers byte-for-byte; the round-trip test gates the build.
- **Never-expand** — output tokens ≤ input tokens, always.
- **Answers survive** — error lines, result summaries, and top-level declarations are never elided
  (`knitbrain evals`, 100% on real transcripts).
- **No false green** — the loop marks a task done only after a real verify passes.
- **Local-first** — proxy, hub, and dashboard bind `127.0.0.1`; nothing leaves your machine.
- **Reproducible** — every number above comes from a command you can run on your own data.

## Use as a library

```ts
import { createOptimizer } from "knitbrain";

const kb = createOptimizer();                 // recall store under ~/.knitbrain
const { skeleton, savedPct } = kb.compress(largeToolOutput);
// original always recoverable: kb.retrieve(handle)
```

## Development

```bash
npm run typecheck && npm run lint && npm run test && npm run build && npm run consistency && npm run bench
npm run e2e                 # all tools over a real stdio MCP session
node scripts/production-audit.mjs   # cold-start: clone → install → pack → drive everything
```

All gates pass before a commit or release.

## License

MIT
