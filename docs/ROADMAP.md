# knitbrain roadmap — the brain architecture + gap register

Target: knitbrain is a **closed-loop orchestrator powered by one brain**, organized as 4
layers — **CAPTURE → PROTECT → BRAIN ← FETCH** + behaviour steering. The loop is the
frame; PROTECT is where the protections execute; the brain is the substrate. This file
is the canonical list of what's done, what's a real gap to fix, and what's a physics
ceiling (so no one tries to "fix" the impossible). See `ARCHITECTURE.md` for the full map.

Design decision (locked): **Model B** — the brain is one *interface* over typed backends
(memory=BM25, knowledge=graph, ccr=content-addressed, skills, team) + the **wiki as the
human-readable spine/timeline**. Do NOT flatten the typed stores into markdown.

Anti-stale discipline (standing rule): consolidate, don't duplicate; every new module has
a caller + a test before it lands (0 dead exports); each phase ships only when
typecheck/lint/test/build/consistency/bench + e2e + production-audit are green with
captured real-data proof. No half-built layer in the tree.

---

## Gap register — ALL 8 FIXED (Phases A–C shipped + merged to main)

| # | Gap | Layer | Fix | Phase | Status |
|---|-----|-------|-----|-------|--------|
| 1 | Wiki is a silo — most tools write their own store, not the brain timeline | BRAIN | 7 capture tools also `wiki.log(...)` → one unified spine | A | ✅ FIXED (#7) |
| 2 | Meter is tool-throughput, not live conversation-relative | FETCH | `MeterReading.optimizationPct = saved / (liveWindow + saved)`, surfaced in the per-turn hook line | A | ✅ FIXED (#7) |
| 3 | Dashboard wiki panel is a counts table, not browsable | FETCH/view | hand-rolled md→HTML (`renderMarkdown`, no new dep) + `[[links]]` + backlinks + SVG link graph; `listPages()`/`wikiState()` | A | ✅ FIXED (#7) |
| 4 | **Adherence** — nothing enforces classify-before-learn | PROTECT | hard-gate at `dispatch()`: `record_learning`/`skill_save`/`save_handoff` blocked unless `classify_task`/`run` ran; `KNITBRAIN_STRICTNESS` off\|warn\|**block** (default block); loop-entry + exact-recovery never gated | B | ✅ FIXED (#8) |
| 5 | No hard claim-checking (anti-hallucination on the claim side) | PROTECT | `knitbrain_verify_claim`: parse a codebase fact, check the knowledge graph → verified/contradicted/unparseable | B | ✅ FIXED (#8) |
| 6 | CAPTURE is scattered, not a named layer | CAPTURE | named `capture()` seam in `dispatch()` (compress+meter); prompts+tool-output+spine all reach the brain | B | ✅ FIXED (#8) |
| 7 | PROTECT not consolidated | PROTECT | `dispatch()` is the one named gate (`protectGate` pre + `capture` post); every tool routes through it (server.ts:74) | B | ✅ FIXED (#8) |
| 8 | No brain facade (unified read/write over typed stores) | BRAIN | `src/engine/brain.ts` — read fans across stores (sourced ranked hits) + `knitbrain_brain_search`; write routes to store + logs spine | C | ✅ FIXED (#9) |

## Released / verified (done)

- **Onboard arc (v0.7.0)** — the dogfood audit found `setup` wired the FUTURE (hooks) but the brain woke up blank+generic. Fixed across 4 phases (PRs #12–#14 + this audit), all merged: (1) honest context meter — configurable + auto-healing window, no false 100% on large-context models; (2) `knitbrain onboard` CLI — scan repo + import past sessions into wiki+learnings (fixes the silent no-op); (3) `knitbrain_onboard` MCP tool — agent-driven 5-question intent interview → Project Charter (claim-lined, surfaced every session) + constraints skill (guardrails propagate to agents); terse brain-writes reusing `compressProse` (no duplicate, default off). **34 tools.** Cross-platform fix: Windows drive-colon in `projectTranscriptDir`, unix-only redirect in `fan`.
- **Phase 4 full audit (v0.7.0 ship-readiness) — all green, captured:** gate chain (test **358** + consistency **34 tools** + bench) · production-audit **50/50** · e2e (all 34 live) · evals **100%** (2514 real blocks) · 4-layer coherence (every tool through the one `dispatch()` chokepoint, server.ts:74) · onboard path live (Charter + constraints + load_session surfaces intent) · adherence HARD · ts-prune (2 dead exports removed, 2 justified: `ContentType` public API, `setTokenizer` intentional knob) · cso clean (onboard reads only the user's own ~/.claude; env parses safe) · cross-platform.
- Gaps #1–#8 — shipped across Phases A (PR #7), B (PR #8), C (PR #9), all merged to main. Phase D audit verified the full architecture below.
- **Phase D full audit (ship-readiness) — all green, captured:** gate chain (typecheck+lint+test **348**+build+consistency **33 tools**+bench) · production-audit **50/50** · e2e (per-tool, all 33 live) · evals **100%** (2524 real blocks: round-trip/identifier/error/summary/never-expand) · 4-layer coherence (every tool through the one `dispatch()` chokepoint) · adherence proven HARD (block→`protocol_required`; retrieve/team_get byte-exact under block) · ponytail-audit (lean) · cso (renderMarkdown XSS-safe, dashboard loopback-only) · mcp-server-patterns (schemas/errors/idempotency) · cross-platform (no unix-only shell).
- `knitbrain --version`/`-v` — fixed in 0.5.1 (was unhandled). Tagged + GitHub release.
- **OPEN (user action):** `npm publish` for the current version — registry is still 0.5.0; local is ahead.

## Ceilings — NOT gaps (physics; do not try to "fix")

| Ceiling | Why | Consequence |
|---|---|---|
| Subscription can't see the assistant's prose | no hook fires on assistant messages; OAuth wire can't be intercepted | capture = prompts (hook) + tool output (PostToolUse, the big lever) + tool I/O; assistant prose is uncapturable on subscription (small + low-value). Full transcript only via the proxy on API-key. |
| Can't post-edit the model's output | nothing lets an MCP rewrite an assistant sentence mid-generation | anti-drift / no-sycophancy / anti-hallucination on the **prose** side are steer-only (re-inject + nudge). The **brain** side goes hard: gate the writes/claims so bad output never enters the brain. |

The principle: **hard-gate everything at the brain boundary; steer everything on the
model-behaviour side.** The model can say anything; the brain stays clean by force.

## Phasing — COMPLETE

- **A (additive, low-risk):** wiki spine (#1) + live meter (#2) + browsable dashboard-wiki (#3). ✅ shipped (PR #7).
- **B (consolidation — removes scatter):** adherence gate (#4, hard) + verify_claim (#5, hard) + named CAPTURE (#6) and PROTECT (#7). ✅ shipped (PR #8).
- **C:** the brain facade (#8). ✅ shipped (PR #9).
- **D:** full-architecture ship-readiness audit + this doc updated. ✅ done — all gates green, gaps marked fixed above.
