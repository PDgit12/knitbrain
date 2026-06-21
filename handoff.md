# Handoff — knitbrain gap-fill build

**Written:** 2026-06-20 (from a session rooted in the *engram* repo; research + decisions done there, build to happen HERE).
**Resume rule:** you are now in `/Users/piyushdua/knit-brain` (package `knitbrain`). Good. Build here so the brain/protocol/learnings attach to the right project.

---

## 1. Verified current state (proper-and-true, all run 2026-06-16/20)

| Gate | Result |
|------|--------|
| `npm run typecheck` | clean (0 errors) |
| `npm run lint` | clean (0 errors) |
| `npm run test` | **236 passed, 1 skipped** |
| `knitbrain profile` (38 real transcripts, 2.8M tok) | **46.9% saved**, round-trip 100% lossless |
| `knitbrain evals` | **FAIL** — see Gap 0 |

- npm published = `knitbrain@0.4.0`. Local `main` is **+1 unpublished commit** (`e868142` secure subscription proxying).
- Untracked at start: `.claude/agents/*` (6 knit-* review agents), `CLAUDE.md`. Not committed — decide intentionally.
- Global Claude Code now has `caveman@caveman` + `ponytail@ponytail` plugins installed (user scope, enabled). Use ponytail's minimalism discipline while building.

## 2. What knitbrain is + the competitive map (so positioning stays clear)

knitbrain = **Headroom-class INPUT compressor, pure-Node, lossless (CCR), + works on Pro/Max subscriptions.** That last clause is the moat.

| Tool | Axis | Mechanism | Runtime |
|------|------|-----------|---------|
| **Headroom** (10k⭐, the rival) | input (tool outputs) | engine + **ML model** + Rust core | Python+Rust |
| **knitbrain** (us) | input (tool results) | deterministic engine (AST/log/diff/json) + CCR | **pure Node** |
| **caveman** | **output** (what model says) | prompt/rule injection | Node |
| **ponytail** (42k⭐) | **code written** (YAGNI) | rule injection | Node |

caveman + ponytail are **different axes — they compose, not compete.** knitbrain shrinks the *ears* (tool results in), caveman the *mouth* (output), ponytail the *hands* (code written).

## 3. Pro/Max proxy reality (the thing easily forgotten)

- API-key users → BOTH doors: wire proxy (`knitbrain wrap`) + MCP-side optimization.
- **Pro/Max subscription → proxy can't see OAuth traffic by default.** `src/wrap.ts` launches direct (no proxy) unless `--subscription` opt-in; `src/setup.ts:147-163` routes subscription users to **MCP-side optimization** (tool-result compression — the bulk of context burn). This is correct and shipped. Don't "fix" it back into a proxy-only model.

## 4. Build plan — sequenced, minimal, no clutter

> Order matters: fix the failing gate first (credibility), then add features. Classify each via `knit_classify_task` before editing. `src/mcp/tools.ts`, `src/optimizer/*`, `src/ccr/store.ts` are high-fanout.

### Gap 0 — FIX the failing eval gate (identifier-fidelity 98.4% < 99%)
- **Symptom:** 5 of 317 top-level declarations dropped from the compressed *skeleton* (round-trip still 100% lossless — recoverable, just not inline).
- **Hypothesis (NOT yet confirmed — verify first):** `src/optimizer/ast.ts:262-283` greedily keeps the candidate grammar that "elides the most chars." On messy/mixed real-transcript snippets a mis-parse under the wrong grammar can yield an error-recovery body node spanning a real top-level declaration, eliding its signature — and because it elides MORE, it gets selected.
- **Step 1 (diagnose, don't fix blind):** write a throwaway script that replays `evalBlock` over `~/.claude/projects` and prints the 5 missing names + content-type + the chosen grammar + the snippet. Confirm the cause.
- **Step 2 (fix candidate):** mirror what the anchor path already does (`router.ts:64-71`) — after choosing elisions in `compressCodeAst`, **re-insert any line matching `DECLARATION_LINE` that fell inside an elided range** (declaration-rescue guard). Cheap, localized, enforces the documented "API surface always survives" promise. Alt: penalize candidates that elide a `DECLARATION_LINE`.
- **Note:** `DECLARATION` (evals.ts:53) and `DECLARATION_LINE` (structured.ts:27) differ only by `type` (optimizer has it, eval doesn't) — not the cause, but unify them into one shared source while here.
- **Done when:** `knitbrain evals` exits 0 with identifier-fidelity ≥99%, no regression in the other gates, `npm run test` green.

### Gap 1 — First-class output/terse mode (close the caveman overlap)
- Today terse mode is only a *rule* (`.claude/rules/knitbrain.md` notation guide). Promote to a leveled, command-toggled feature: `lite | full | ultra` (mirror caveman; skip wenyan).
- Surface: a `knitbrain terse [level]` CLI + an MCP-instruction line + a slash command. Keep it ONE source of truth (`src/platforms.ts` already emits the notation guide — extend, don't duplicate).
- This makes knitbrain cover BOTH directions (in + out), which neither caveman (out only) nor Headroom (in only) do.

### Gap 2 — Statusline savings badge
- caveman + ponytail both ship `[CAVEMAN] ⛏ 12.4k`. Add `[knitbrain] saved 12.4k` to the Claude Code statusline.
- Source the number from the existing meter/dashboard data (`src/engine/meter.ts`, `src/dashboard.ts`). Provide a statusline script + a `--silence` env var. Don't double-count proxy + MCP savings.

### Gap 3 — Compress-memory command (`knitbrain compress <file>`)
- Rewrite `CLAUDE.md`/memory into terse form, **lossless for code/URLs/paths/identifiers** (~46%/session input savings — caveman's `caveman-compress` proves the win).
- Reuse the optimizer's protected-segment idea; caveman-shrink's boundary list is a good reference (fenced code, inline code, URLs, paths, CONST_CASE, dotted.fn(), versions). Write to a `.original` sidecar so it's reversible.
- Distinct from `knitbrain learn --apply` (that writes NEW learnings; this SHRINKS existing memory).

### Gap 4 — Broader platform coverage
- caveman covers 30+ agents via `npx skills add`; knitbrain `src/setup.ts` covers ~7-8. Extend `detectPlatforms` + artifact writers to the high-value missing ones (kilo, roo, trae, qwen, amp, continue, augment, crush, goose). Keep the adapter matrix pattern already in `platforms.ts` — one writer per agent, no special-casing.

## 5. Codebase map — already read (don't re-read) vs remaining

**Read & understood:** `src/optimizer/{router,code,ast,structured}.ts`, `src/evals.ts`, `src/setup.ts`, `src/wrap.ts`, `src/platforms.ts` (skimmed).
**Read next for full context:** `src/mcp/tools.ts` (614, the surface), `src/ccr/store.ts` (lossless store), `src/proxy/{server,optimize-request}.ts`, `src/engine/{memory,knowledge,meter,feedback}.ts`, `src/dashboard.ts`, `src/hooks/*`, `src/hub/*`.

## 6. Decisions already made (don't relitigate)
- Build in this repo (knit-brain), not engram. ✓ (you're here)
- Fill all four gaps + fix Gap 0. ✓
- Install caveman + ponytail globally. ✓ done
- Use ponytail minimalism to keep the plan/code uncluttered. ✓ (reflected in this plan's "one source of truth, extend don't duplicate" notes)

## 7. First actions on resume
1. `knit_load_session` (now correctly scoped to knitbrain).
2. `knit_classify_task` on Gap 0 files (`src/optimizer/ast.ts`, `src/evals.ts`, `src/optimizer/structured.ts`).
3. Write the Gap-0 diagnostic, confirm the 5, then fix. Verify with `knitbrain evals` + `npm run test`.
4. Then Gaps 1→4 in order. Record a learning after each non-obvious fix.
