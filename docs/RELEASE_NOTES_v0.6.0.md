# knitbrain v0.6.0 — the brain release

The 4-layer brain wired end to end: **CAPTURE → PROTECT → BRAIN ← FETCH**.
**33 MCP tools** (was 31). Backward-compatible — no breaking changes.

## Highlights

- **Wiki spine** — the close-the-loop tools (record_learning, skill_save, compose_skill, team_post, create_agent, save_handoff, record_false_positive) also drop a line into the wiki log, so the brain has one unified timeline alongside the typed stores.
- **Live meter** — `optimizationPct = saved / (liveWindow + saved)` reports optimization as a fraction of the *live* conversation window, surfaced each turn.
- **Browsable dashboard wiki** — the wiki panel renders pages (hand-rolled markdown→HTML, no new dependency), `[[links]]`, backlinks, and an inline SVG link graph. Loopback-only.
- **Adherence gate (hard)** — `KNITBRAIN_STRICTNESS` = `off|warn|block` (default **block**): close-the-loop writes are blocked unless the session ran `knitbrain_run`/`knitbrain_classify_task` first. Reads, loop-entry, and exact-recovery tools are never gated.
- **`knitbrain_verify_claim`** — parse a stated codebase fact and check it against the knowledge graph → `verified | contradicted | unparseable`.
- **`knitbrain_brain_search`** — unified recall that fans a query across the typed stores (learnings/wiki/knowledge) and returns ranked hits tagged with their source store, over the new `src/engine/brain.ts` facade.

## Verified

Installed from npm and driven end to end against the published package:
- All **33 tools** live over stdio MCP · adherence gate hard (blocks before classify) · retrieve byte-exact under block · hook + dashboard binaries.
- Gate chain green (348 tests · consistency · bench) · production-audit 50/50 · evals 100% (2536 real blocks, round-trip + identifier lossless).

## Install

```bash
npm install -g knitbrain
# or per-project MCP:
npx knitbrain setup
```

Full changelog: see `CHANGELOG.md`.
