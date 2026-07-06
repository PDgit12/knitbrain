# knitbrain

TypeScript project (Node ≥18, ESM, vitest). This repo IS the knitbrain product — if a `knitbrain` MCP server is connected while developing here, note it runs the globally installed build, not your working tree; rebuild + reinstall (`npm run build && npm install -g .`) and reconnect to test local changes.

---

## Session start

First action: call `knitbrain_load_session` — returns last handoff, top learnings, false positives. If it reports unfinished work, resume that first.

Adherence gate: close-the-loop writes (`knitbrain_record_learning`, `knitbrain_skill_save`, `knitbrain_save_handoff`) are blocked until `knitbrain_classify_task`/`knitbrain_run` ran this session (`KNITBRAIN_STRICTNESS`, default `block`).

## Tool surface highlights (37 tools)

- **`knitbrain_verify_claim`** — settle a codebase claim before LEARN. Caveat: the session MCP roots at the launch cwd — settle knit-brain facts by source + tests + built dist when the root is elsewhere.
- **`knitbrain_self_check`** — keystone: audits all four invariants (anti-sycophancy, anti-stale, anti-drift, adherence) in one PASS/FAIL pass.
- **`knitbrain_run_loop`** — one judge→iterate cycle per call; your `verify_cmd` is the hard gate.
- **`knitbrain_search_code`** — retrieval layer: query → ranked function-level chunks + graph-related files, score-gated. Search BEFORE reading; knitbrain_read only the hits.
- **`knitbrain_read` / `knitbrain_optimize` / `knitbrain_retrieve`** — compression loop; exact original always one retrieve away. Data-tool JSON responses are never skeletonized (machine contract).
- **Note:** big tool responses may come back skeletonized with a trailing `⟨recall:hash⟩` — strip it before JSON-parsing a tool result.

---

## Project Map

**Entry points:** `dist/lib.js`, `dist/index.js`, `dist/proxy/index.js`, `dist/hooks/index.js`, `src/index.ts`
**High-fanout (change carefully):** `src/ccr/store.ts`, `src/tokenizer.ts`, `src/engine/feedback.ts`, `src/engine/memory.ts`, `src/engine/knowledge.ts` — check `knitbrain_query_dependents` before touching.
**Largest:** `src/mcp/tools.ts`, `scripts/production-audit.mjs`, `src/learn.ts`

Binding product map (gaps, kill-list, UX law, build order, platform ledger): `docs/LOOP-ENGINEERING.md` (internal, gitignored).

---

## Build Gates

All must pass before commit (`npm run verify` runs them in order — build BEFORE test):

- `npm run typecheck`
- `npm run lint`
- `npm run build`
- `npm test`
- `npm run consistency`
- `npm run bench`

Always `rm -rf dist && npm run verify` before claiming green — stale dist masks build-order bugs. Local rebuild note: `build` re-chmods the three dist entrypoints (a globally symlinked install breaks otherwise).

---

## Tier vocabulary

| Tier | When |
|------|------|
| **Inquiry** | Read-only ("what", "where", "audit") — just answer. |
| **Trivial** | One-line fix — execute → verify. |
| **Standard** | Single-domain bug fix or feature — research → execute → review. |
| **Complex** | Cross-domain, touches types/auth, high-fanout, or multi-commit arc — full phases + auto plan mode. |

---

## Hard constraints

- NO npm publish / release / version bump without explicit human OK.
- NO force-push, NO `--no-verify`, no destructive git without consent.
- Branch off main; squash-merge PRs; conventional commits.
- No yes-man: every PASS backed by pasted output + exit code.
