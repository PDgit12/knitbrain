# knitbrain — Architecture Map & Audit Charter

> Self-contained brief for a cold-start reviewer (human or agent). It states what
> knitbrain **is**, how it **should** behave (the invariants), the full **map**, and
> the **audit procedure** to prove it holds. No prior context required.

---

## 0. The idea

knitbrain is a **local-first MCP server** (npm: `knitbrain`, v0.7.0) that turns any
coding agent (Claude Code, Cursor, Codex) into one with a persistent brain:

- **Per-project memory** — learnings + session handoffs that survive `/clear`, ranked by BM25.
- **Tier-routed workflow** — a classifier (inquiry / trivial / standard / complex) that
  decides ceremony: plan-mode, phases, which tools to call.
- **Lossless context compression** — big tool outputs collapse to skeletons with a
  `⟨recall:hash⟩`; the exact original is one `retrieve` away. Byte-for-byte recoverable.
- **Knowledge graph** — imports / exports / dependents, so a stated code fact is settled
  by the graph, not by assertion.
- **Wiki-brain** — a compounding page/index/log store that auto-heals stale contradictions.
- **Team coordination** — a shared board + token-auth hub for multi-agent work.

TypeScript, Node, ESM, vitest. Three shipped binaries. 36 MCP tools. 18 CLI subcommands.

---

## 1. Invariants — how it *should* behave

The whole product exists to uphold four invariants. Everything else is plumbing. An audit
is really asking: **do these still hold, and does the brain self-check them?**

| invariant | meaning | enforced by |
|---|---|---|
| **anti-sycophancy** | "done" is a claim backed by output, never a vibe. A learning recorded with no `verify_claim` behind it is unverified. | `mcp/instructions.ts` ground-rule + `verify_claim` + `self_check` fact-gate |
| **anti-stale** | memory + graph never serve outdated truth. Graph re-scans on read; wiki supersedes older contradicting claims (newest wins, originals recoverable). | `engine/knowledge.ts` lazy self-heal · `engine/wiki.ts` resolve() |
| **anti-drift** | a stored per-project workflow re-surfaces every session so behavior doesn't wander. | `engine/workflow.ts` + `load_session` re-injection |
| **adherence** | close-the-loop writes (record_learning, skill_save, save_handoff) are gated until a classifier ran this session. | `mcp/tools.ts` GATED_WRITES + session state |

The **keystone**: `knitbrain_self_check` composes all four into ONE PASS/FAIL pass +
auto-fixes applied + residual gaps a human must close. It reimplements no detector — it
runs the real ones and reports.

The **closed loop** (never a false green): classify → work → **verify** (run the test/build,
don't assert) → record signal (skill_outcome / learning_outcome / record_learning). Failing
skills and discredited learnings are demoted automatically. Next session starts smarter.

---

## 2. Architecture map

**Size:** 9,625 LOC src · 60 src files · 60 test files · v0.7.0.

### 3 binaries (`package.json` "bin")
| bin | entry | role |
|---|---|---|
| `knitbrain` | `dist/index.js` | CLI router + stdio MCP server (`buildServer`) |
| `knitbrain-proxy` | `dist/proxy/index.js` | wire-level request compressor (API-key setups) |
| `knitbrain-hook` | `dist/hooks/index.js` | Claude Code hook (Pre/Post/SessionStart) |

Package entry: `main`/`exports "."` → `dist/lib.js` (`createOptimizer`, the programmatic API).

### Data flow
```
knitbrain (index.ts)
  ├─ 18 CLI subcommands (version, setup, hub, dashboard, loop, fan, …)
  ├─ bare no-arg  → buildServer() → stdio MCP server   (the host entrypoint)
  └─ unknown arg  → "unknown command: X" + exit 1        (typo guard)

server.ts builds ctx { ccr, memory, knowledge, feedback, team, meter,
                       skills, calibration, activity, wiki }
   └─> mcp/tools.ts  (36 tools · dispatch · adherence gate · per-session state)

knitbrain-proxy  →  optimize-request → optimizer/router → cache-aligner
knitbrain-hook   →  pre/post/sessionstart
```

### Domains (every file belongs to exactly one)
- **engine/ (18)** — core intelligence. `brain` · `knowledge`(import/export/dependents graph,
  lazy stale self-heal) · `memory`(BM25 learnings+sessions) · `wiki`(pages/index/log +
  auto-heal supersede) · `skills` · `teams` · `calibration`(FP self-tune) · `meter`(token
  window) · `closed-loop`(run_loop engine) · `self-check`(keystone) · `host-scan`(global
  skill/agent scan) · `onboard`(adaptive) · `workflow`(stored driver) · `agents` · `activity`
  · `feedback`(TOIN) · `quota` · `usage`.
- **optimizer/ (8)** — compression. `router`(dispatcher) imports all of: `ast`(tree-sitter),
  `code`, `json`, `text`, `structured`, `params`, `types`.
- **mcp/ (3)** — tool surface. `tools`(36 + dispatch + gate) · `handlers` · `instructions`
  (handshake protocol).
- **proxy/ (4)** — `server` · `optimize-request` · `cache-aligner` · `index`.
- **hooks/ (4)** — `index` · `pretooluse` · `posttooluse` · `sessionstart`.
- **hub/ (2)** — `server`(token-auth store, board.json→board migration) · `client`.
- **ccr/ (1)** — `store` (content-addressed recall, `⟨recall:hash⟩`).
- **top-level (20)** — `index`(router) · `setup` · `dashboard` · `paths` · `platforms` ·
  `profile` · `tokenizer` · `learn` · `loop` · `fan` · `orchestrate` · `measure` · `evals`
  · `wrap` · `compress-file` · `global-config` · `atomic`(writeAtomic — does NOT mkdir
  parent) · `lib`(pkg entry) · `version`.

### Storage
`~/.knitbrain/projects/<sha256(cwd)[:16]>/{memory, knowledge, wiki, team, meter, skills,
calibration, activity, host-index.json, workflow.md, loop-state.json}`.
Override home with `KNITBRAIN_HOME` (tests do this).

### The 36 MCP tools
```
obs           ping · metrics
compression   optimize · retrieve · read · context_meter
memory        record_learning · search_learnings · get_learning · learning_outcome
session       save_handoff · load_session · run
graph         scan · query_imports · query_exports · query_dependents · verify_claim
classifier    classify_task · record_false_positive
skills        compose_skill · skill_save · skill_outcome
agents        propose_agents · create_agent
team          team_post · team_board · team_get · team_clear
wiki          wiki_ingest · wiki_query · wiki_lint · brain_search
onboard/auto  onboard · run_loop
keystone      self_check
```

### The 18 CLI subcommands + 2 router behaviors
```
version help prompt statusline terse profile evals onboard learn
compress wrap loop fan orchestrate setup hub join dashboard
+ bare no-arg  → start stdio MCP server (exit 0)
+ unknown arg  → "unknown command: X" + exit 1
```
Expected: pure cmds exit 0 + output; compress/wrap/loop/fan/orchestrate/join need args →
exit 1 + usage; hub/dashboard are servers (timeout-guard = PASS); profile/evals are slow
~12s (not hung).

---

## 3. Caveats a cold reviewer WILL trip on

1. **MCP root ≠ knit-brain.** The connected knitbrain MCP roots at Claude Code's launch cwd
   (often `/Users/piyushdua/engram`, a different product). So `verify_claim` / `query_imports`
   on knit-brain paths return `unparseable`/`contradicted`. **Settle knit-brain facts by
   source + tests + built dist**, never by the MCP graph tools.
2. **The session MCP is a pinned process.** It runs the global bin that existed at session
   start. "Tool absent from this session" ≠ "tool broken" — check
   `grep -c 'name: "knitbrain_' /opt/homebrew/lib/node_modules/knitbrain/dist/mcp/tools.js`.
   Fix a stale global with `npm run build && npm install -g /Users/piyushdua/knit-brain`
   (a local install, NOT a publish; needs `/mcp` reconnect to take effect in-session).
   `scripts/e2e-tools.mjs` (spawns fresh dist) is the authoritative live-36 check.
3. **`verify` order is build-before-test.** Tests that spawn `dist/index.js` need dist to
   exist; `tests/index-cli.test.ts` self-builds as a fallback (Windows-safe via `shell:true`).
4. **Stale artifacts lie.** Always `rm -rf dist && npm run verify` before claiming green — a
   leftover dist masks build-order bugs. Then `gh run list` — CI's Windows matrix catches
   spawn/path bugs local macOS runs miss.
5. **Versioning smell.** `run_loop`(#35) + `self_check`(#36) were added post-0.7.0-publish
   with no bump — main and npm both read 0.7.0 but ship different tool sets. Flag it; a bump
   needs explicit human OK.

---

## 4. Audit procedure

- **Step 0 — orient:** `git log --oneline -5`; `git status`; on main + clean; `gh run list --limit 3` green.
- **Step 1 — over-engineering:** `/ponytail-audit` on `src/`. `npx ts-prune | grep -v "used in module"`
  MUST be empty. Runtime deps must stay 3 (`@modelcontextprotocol/sdk`, `@vscode/tree-sitter-wasm`,
  `gpt-tokenizer`). Legacy migration paths (board.json, undated handoffs, `ccr:` prefix) are
  justified — do not cut. Apply only safe cuts; log the rest.
- **Step 2 — 36 tools live:** `node scripts/e2e-tools.mjs` (advertises 36 + exercises) ·
  `node scripts/production-audit.mjs` (50 cold-start checks). For `self_check`/`run_loop` behavior
  (e2e-tools only asserts they're advertised): `npx vitest run tests/self-check.test.ts tests/closed-loop.test.ts`.
- **Step 2b — CLI surface:** `npm run build`, then spawn `node dist/index.js <cmd>` for the 18
  subcommands + bare no-arg + `bogus`. Paste exit + first line each. Verify the 2 router behaviors.
- **Step 3 — cross-gap integration:** `npx vitest run tests/onboard.test.ts tests/workflow.test.ts
  tests/closed-loop.test.ts tests/wiki.test.ts tests/self-check.test.ts` — all pass. Proves:
  global-scan→adaptive-onboard composes only real gaps; workflow surfaces verbatim in load_session;
  run_loop stops at met=true AND max-iter; wiki auto-heal (newest wins, recoverable, lint clean);
  self_check composes all into one table.
- **Step 4 — all gates (paste each exit code):** `rm -rf dist && npm run verify` (typecheck·lint·
  build·test·consistency·bench) · `npm run e2e` · `node scripts/production-audit.mjs` (50/50) ·
  confirm bench floors held. If you push: watch `gh run` to green (Windows matrix included).
- **Step 5 — MCP freshness:** confirm the global bin ships 36 (caveat #2); reinstall if stale.

**Deliverable:** ONE PASS/FAIL table over 36 tools + 18 CLI subcommands + 2 router behaviors, plus a
ranked gap list (severity + repro). Clean → say so WITH evidence. Not clean → failures with repro.

---

## 5. Constraints (hard)

- NO npm publish / NO GitHub release / NO version bump without explicit human OK.
- NO force-push. NO `--no-verify`. NO delete/hard-reset without consent.
- Branch off main for any change; squash-merge PRs; conventional commits.
- NO yes-man: every PASS backed by pasted output + exit code; failures are the deliverable.

**Known-good baseline** (main `eabd80d`): all gates green · production-audit 50/50 · e2e-tools 36
live · ts-prune empty · CI 5 jobs green. Open items to re-check: versioning smell (§3.5), e2e-tools
doesn't behaviorally invoke `self_check`/`run_loop` (test files cover behavior).
```
