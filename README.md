<h1 align="center">knitbrain</h1>

<p align="center"><strong>The substrate for agent loops — state, optimization, and enforcement in one local-first MCP server. The loop that can't lie, can't run away, and can't go broke.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/knitbrain"><img src="https://img.shields.io/npm/v/knitbrain?color=cb3837&logo=npm" alt="npm version"></a>
  <a href="https://github.com/PDgit12/knitbrain/actions/workflows/ci.yml"><img src="https://github.com/PDgit12/knitbrain/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/npm/l/knitbrain?color=blue" alt="MIT license"></a>
  <img src="https://img.shields.io/node/v/knitbrain?color=339933&logo=node.js" alt="Node version">
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#the-three-legs">Three legs</a> ·
  <a href="#loops">Loops</a> ·
  <a href="#the-receipt">Receipt</a> ·
  <a href="#measured-not-promised">Numbers</a> ·
  <a href="#platform-support">Platforms</a> ·
  <a href="#commands">Commands</a> ·
  <a href="#guarantees">Guarantees</a>
</p>

---

Everyone is wiring coding agents into loops — goal in, iterate until done. Every loop fails the
same three ways: the agent **lies** ("done!" with red tests), it **runs away** (iteration 47,
nothing converging), and it **goes broke** (context resent and re-derived until the window or the
bill gives out).

knitbrain is the substrate those loops run on — a local-first **MCP server (37 tools)** plus a
hook layer for Claude Code, Codex CLI, Cursor, Gemini CLI, and VS Code Copilot:

- **Can't lie** — "done" means *your* verify command exited 0. The loop's gate is a real process
  exit code, never the model's opinion. Hooks block the agent from stopping while the goal is unmet.
- **Can't run away** — every loop carries hard breaks: max iterations, wall-clock deadline, and a
  per-cycle failure history injected into the next attempt so it converges instead of thrashing.
- **Can't go broke** — lossless compression (byte-exact recall, never-expanding), function-level
  retrieval instead of whole files, persistent memory instead of re-derivation — and a session
  receipt that shows exactly what was saved and where.

Pure Node, three runtime dependencies, no Python, no ML runtime. Everything lives under
`~/.knitbrain`; the proxy, hub, and dashboard bind `127.0.0.1`. Nothing leaves your machine.

## Quick start

```bash
npx knitbrain profile      # 1. measure compression on YOUR transcripts — see the number first
npm install -g knitbrain   # 2. install
knitbrain setup            # 3. wire into your agent(s): MCP config, hooks, rules, slash commands
knitbrain onboard          # 4. scan the repo + import past sessions into the brain
```

Then open your agent and answer the 5-question interview (or just say **"onboard this project"**) —
it writes a Project Charter, a per-part workflow, and a loop-ready `goal.md`. From that point,
stating a goal in plain words is enough: the ambient frame turns it into a verify-gated loop.
Requires Node ≥ 18.

## The three legs

### STATE — one brain, every session, every tool

Learnings ranked by outcome (a learning reported wrong is discredited and sinks), an
imports/exports/dependents knowledge graph that re-scans itself on read, session handoffs that
survive `/clear`, and a compounding wiki. Onboarding scans your **whole toolkit** — skills, agents,
commands, hooks, across project, global, and plugin tiers — and composes a standing workflow (GOAL,
VERIFY, CONSTRAINTS, per-part ROUTING) that re-surfaces every session. The same brain serves every
MCP client: explain the project once, Cursor inherits what Claude Code learned.

### OPTIMIZATION — lossless, measured, felt

- **Retrieval**: `knitbrain_search_code` returns ranked, score-gated function-level chunks with
  graph context — the agent reads hits, not trees.
- **Compression**: large tool output collapses to a structure-preserving skeleton plus a
  `⟨recall:hash⟩` handle; the exact original is content-addressed on disk and one call away.
  Small or incompressible payloads pass through untouched. JSON tool responses are never
  skeletonized — machine contracts stay parseable.
- **Attribution**: every optimization event — MCP tool, hook, or proxy — lands in one ledger, so
  the session receipt can tell you which door saved what.

### ENFORCEMENT — the workflow is not advice

All five major agent platforms now ship hook systems. knitbrain's one hook binary auto-detects the
calling platform from the payload itself and speaks its dialect:

| Enforcement | Claude Code | Codex CLI | Cursor | Gemini CLI | VS Code Copilot |
|---|---|---|---|---|---|
| Deny a violating tool call | ✅ | ✅ | ✅ | ✅ | ✅ |
| Block stop while goal unmet | ✅ | ✅ reason becomes next prompt | ➖ follow-up injection | ✅ deny + auto-retry | ✅ |
| Inject the goal frame | ✅ every prompt | ✅ every prompt | session start only | ✅ | ✅ |
| Rewrite oversized reads | ✅ | context pointer | ✅ (MCP outputs) | context pointer | ✅ |

Your Project Charter's CONSTRAINTS line is enforced *physically*: write "NEVER npm publish without
OK" during onboarding and the PreToolUse hook denies `npm publish` at the tool boundary — on every
platform above. The differences in the table are each host's documented API ceilings, stated
honestly, not gaps we hide.

## Loops

One engine, three ways in — the headless loop is the front door:

- **Headless (the front door)**: `knitbrain loop goal.md` drives a checkbox goal file outside any
  editor — survives laptop-close, ticks a box only when the verify command exits 0, and never
  commits/pushes/deploys. Point any scheduler at it (see Triggers below). Add an independent
  reviewer with `--reviewer "<cmd>"` or a `REVIEWER:` line in the goal file — **writer≠judge**:
  both verify AND reviewer must exit 0 before a box ticks, and reviewer rejections feed the next
  attempt's prompt. `knitbrain fan` runs N workers in parallel, each in its own git worktree,
  draining the same queue.
- **Ambient** (after onboarding): say what you're working on; the injected frame classifies it —
  actionable requests become goals driven through `knitbrain_run_loop` until the verify gate
  passes; questions get answered directly.
- **Two slash front doors, on every host that has a slash surface** (Claude Code, Codex, Gemini,
  VS Code Copilot, Windsurf — Cursor via terminal):
  - **`/goal-knitbrain <done-means>`** drives the gate **with you, in this session** — `knitbrain_run`
    orchestrates a skill + agents, then `knitbrain_run_loop` runs your verify command each cycle
    until it exits 0. Single context, interactive.
  - **`/loop-knitbrain goal.md --for 2h`** hands off to the **external runner** (`knitbrain loop`): it
    *launches detached*, spawns a fresh agent per checkbox, and owns the loop itself — surviving
    your context window, not depending on any model choosing to continue. A slash command can't
    *be* an hour-long loop, so it launches the runner and hands back a watch handle.

**Self-healing:** each failed cycle's verify output is persisted (`failures[]`, last 3) and
injected into the next directive — "previous failures — iter 1: …. Address the ROOT CAUSE" — so
loops converge in fewer iterations without shortcuts. An adherence gate blocks memory writes until
a task was classified: unverified "done" cannot enter the brain.

### Triggers

knitbrain is the *target* of triggers, never the scheduler — your host (cron, launchd, CI,
Claude Code `/schedule`, Codex schedules) owns when; the loop owns honest-until-done. Exit codes
are scheduler-friendly: **0** = goal done or clean stop, **1** = gate still red or infra failure —
alert on 1.

```cron
# weekdays 9am: drive the goal for up to 2h, lint as the independent reviewer
0 9 * * 1-5  cd /path/to/repo && knitbrain loop goal.md --for 2h --reviewer "npm run lint" >> ~/.knitbrain/loop-knitbrain.log 2>&1
```

Same one-liner works as a launchd `ProgramArguments`, a CI cron job step, or the command behind
your agent's scheduler.

## The receipt

Optimization you can't see is optimization you don't trust. When a session ends, the Stop hook
prints an honest receipt (also available mid-session via `/meter`):

```
— knitbrain session receipt —
consumed ~281k tok · avoided 16.0k tok (5% of what would have been)
top sinks:
  Bash: 10.0k → 2.0k tok (saved 8.0k)
  request: 9.0k → 6.0k tok (saved 3.0k)
  src/big.ts: 6.0k → 1.0k tok (saved 5.0k)
hygiene:
  re-read unchanged ×2: /proj/dup.ts
  1 oversized raw read(s) redirected to knitbrain_read
lifetime: 141.7k tok saved · 394 exact recalls
```

Honest-math rules, enforced structurally: tokens count as "saved" only when a raw output actually
existed and was replaced or redirected — redirects themselves record zero (the follow-up read
counts once). Estimates are labeled estimates. A session with no savings says so plainly instead
of inventing a number.

## Measured, not promised

Run these on your own data — every number below is reproducible with one command.

| Measurement | Result | Reproduce |
|---|---|---|
| Average reduction over ~3M real tool-result tokens | ~46% (≈55% on blocks ≥ 400 chars) | `knitbrain profile` |
| Weighted real-shape benchmark (code · logs · JSON · diffs · prose) | 68% | `npm run bench` |
| Answer preservation (round-trip · identifiers · error/summary lines) | 100% | `knitbrain evals` |

These are the **ceiling** — what you save when output flows through the optimizer. Your
**realized** number is the receipt and the live meter (`knitbrain dashboard`), which count only
what actually passed through. Honest expectations: 60–70% on code/JSON/logs, ~18% on prose, ~48%
all-inclusive on measured real sessions — less inside an already-lean harness, more on raw API
traffic. And honestly: per-request optimization cannot offset provider cache-cold re-reads or
subagent spawns — the meter warns you when a handoff + fresh session is the cheaper move.

## How it reaches your traffic

The optimizer is identical everywhere; what differs is reach:

- **API key** — a loopback proxy (`knitbrain wrap <agent>`) compresses every request on the wire,
  keeps the provider's prompt-cache discount intact (CacheAligner: stable prefix, volatile lines
  moved to a marked tail), detects the model's context window, and can inject a terse-output
  directive (`KNITBRAIN_TERSE=1`).
- **Subscription (OAuth)** — the wire can't be intercepted (true for every tool in this space), so
  knitbrain works through the MCP + hook surface instead: `knitbrain_read` for files, PreToolUse
  redirecting oversized raw reads, and PostToolUse skeletonizing Bash/Grep/Glob/WebFetch output in
  place. Assistant prose lands in the host's transcripts — SessionStart mines new ones into the
  brain automatically.

## Platform support

| Platform | MCP tools | Hook enforcement | Auto-compression | Slash commands |
|---|---|---|---|---|
| Claude Code | ✅ | ✅ full (deny · stop-block · inject · rewrite) | ✅ hooks | `/goal-knitbrain` `/loop-knitbrain` `/meter` `/handoff` `/terse` (`.claude/commands`) |
| Codex CLI | ✅ | ✅ full (`.codex/hooks.json`) | hooks + `knitbrain_read` | `/goal-knitbrain` `/loop-knitbrain` (`~/.codex/prompts`) |
| Cursor | ✅ | ✅ deny + follow-up loop (`.cursor/hooks.json`) | hooks + `knitbrain_read` | — (no slash API; documented in rules) |
| Gemini CLI | ✅ | ✅ deny + AfterAgent loop (`.gemini/settings.json`) | hooks + `knitbrain_read` | `/goal-knitbrain` `/loop-knitbrain` (`.gemini/commands/*.toml`) |
| VS Code Copilot | ✅ | ✅ full (reads `.claude/settings.json` natively) | hooks + `knitbrain_read` | `/goal-knitbrain` `/loop-knitbrain` (`.github/prompts/*.prompt.md`) |
| Windsurf | ✅ | ✅ deny-only (exit-2) (`.windsurf/hooks.json`) | hooks + `knitbrain_read` | `/goal-knitbrain` `/loop-knitbrain` (`.windsurf/workflows`) |
| Cline · any other MCP client | ✅ | — (advisory; hooks planned where APIs allow) | via `knitbrain_read` | — (runner works from any terminal) |
| Any agent, API key | ✅ | — | ✅ proxy (full wire) | — |

One hook binary serves every row: it detects the calling platform from the payload and answers in
that host's schema. Where a host's API can't do something (Cursor can't block stop; Gemini can't
rewrite output), knitbrain degrades to the nearest honest mechanism instead of claiming otherwise.
`/goal-knitbrain` and `/loop-knitbrain` ship for every host with a slash-command surface — each in that host's native
format — so both front doors are the same everywhere. Cursor has no such surface; there the runner
is a terminal command (`knitbrain loop`), documented in its always-on rules.

## Commands

| Command | What it does |
|---|---|
| `knitbrain` *(no args)* | Start the MCP server on stdio — what your editor invokes. |
| `knitbrain setup` | Wire into your agent(s): MCP config, hooks, rules, slash commands, `AGENTS.md`. |
| `knitbrain onboard` | Scan the repo + import past sessions into the brain; start the charter interview. |
| `knitbrain profile` | Measure compression on your real transcripts. |
| `knitbrain evals` | Answer-preservation gates on your transcripts (exit 1 on failure). |
| `knitbrain loop <goal>` | Headless verify-gated loop over a checkbox goal file; `--reviewer` adds an independent second gate. |
| `knitbrain fan <goal>` | Parallel loop — N workers in isolated git worktrees. |
| `knitbrain dashboard` | Live local dashboard (`127.0.0.1:8790`): meter, graph, wiki, activity, plan usage. |
| `knitbrain wrap <agent>` | Launch an agent through the optimizer proxy (API-key setups). |
| `knitbrain compress <file>` | Terse-rewrite a memory file (e.g. `CLAUDE.md`); keeps a backup. |
| `knitbrain learn` | Mine past sessions for failure → success corrections. |
| `knitbrain terse [level]` | Print the terse-output guide (lite / full / ultra). |
| `knitbrain hub` / `join` | Optional team hub — shared findings over one URL and token. |
| `knitbrain statusline` | Tokens-saved badge for your editor's status line. |
| `knitbrain prompt` | Print the operating prompt (for non-MCP platforms). |

## Guarantees

Gated by tests and CI, not promised:

- **Lossless** — every compressed payload recovers byte-for-byte; the round-trip test gates the build.
- **Never-expand** — output tokens ≤ input tokens, always.
- **Answers survive** — error lines, result summaries, and top-level declarations are never elided (`knitbrain evals`, 100% on real transcripts).
- **Machine contracts hold** — JSON tool responses are never skeletonized.
- **No false green** — the loop marks a task done only after a real verify passes; hooks block premature stops.
- **Honest receipt** — savings are counted only when a raw output was actually replaced or redirected; estimates are labeled; zero is reported as zero. Subagent burn (Claude Code Task subagents, Codex CLI's alias) is attributed to the activity ledger via `SubagentStart`/`SubagentStop`, so nested-agent token spend isn't invisible to the receipt.
- **Local-first** — proxy, hub, and dashboard bind `127.0.0.1`; credentials are read locally, sent only to the provider's own endpoint, never logged or stored.
- **Reproducible** — every number in this README comes from a command you can run on your own data.
- **Self-audited** — `knitbrain_self_check` runs seven invariants (anti-stale ×2, anti-drift ×2, anti-sycophancy, adherence, context-hygiene) in one pass.

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
