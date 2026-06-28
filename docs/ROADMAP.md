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

## Gap register

| # | Gap | Layer | Fix | Hardness | Phase |
|---|-----|-------|-----|----------|-------|
| 1 | Wiki is a silo — most tools write their own store, not the brain timeline | BRAIN | significant tool events also `wiki.log(...)` → one unified spine | mechanical | A |
| 2 | Meter is tool-throughput, not live conversation-relative | FETCH | show savings as `saved / (liveWindow + saved)`, surfaced each turn | mechanical | A |
| 3 | Dashboard wiki panel is a counts table, not browsable | FETCH/view | page list → click → md→HTML render + `[[links]]` + backlinks + SVG link graph (mechanical render, zero agent tokens; no new dep) | mechanical | A |
| 4 | **Adherence** — nothing enforces classify-before-learn | PROTECT | soft-gate at `dispatch()`: `record_learning`/`skill_save`/`save_handoff` blocked unless `classify_task`/`run` ran this session; strictness off\|warn\|**block** (default block); NEVER gate loop-entry or exact-recovery | **HARD** | B |
| 5 | No hard claim-checking (anti-hallucination on the claim side) | PROTECT | add `verify_claim`: parse a stated codebase fact, check against the knowledge graph → verified/contradicted | **HARD** (claim side) | B |
| 6 | CAPTURE is scattered (hooks + dispatch + posttooluse), not a named layer | CAPTURE | consolidate the existing entry points into one `capture` path; delete the scattered bits | refactor | B |
| 7 | PROTECT not consolidated (staleness/drift/sycophancy logic scattered) | PROTECT | name the layer; route every brain read/write through the one gate; delete duplicates | refactor | B |
| 8 | No brain facade (unified read/write over typed stores) | BRAIN | thin `brain` interface: read = search across stores; write = route to store + log spine | medium | C |

## Released / verified (done)

- `knitbrain --version`/`-v` — fixed in 0.5.1 (was unhandled). Tagged + GitHub release.
- PostToolUse host-apply — **live-verified** in a restarted Claude Code session (`ping → v0.5.1`, wiki/compose tools work in-session).
- Full ship audit green: gate chain (330 tests) + production-audit 50/50 + e2e + evals 100% + the 3 review skills (ponytail/cso/mcp). CI `e2e` lane added.
- **OPEN (user action):** `npm publish` for 0.5.1 — registry is still 0.5.0; local global is 0.5.1.

## Ceilings — NOT gaps (physics; do not try to "fix")

| Ceiling | Why | Consequence |
|---|---|---|
| Subscription can't see the assistant's prose | no hook fires on assistant messages; OAuth wire can't be intercepted | capture = prompts (hook) + tool output (PostToolUse, the big lever) + tool I/O; assistant prose is uncapturable on subscription (small + low-value). Full transcript only via the proxy on API-key. |
| Can't post-edit the model's output | nothing lets an MCP rewrite an assistant sentence mid-generation | anti-drift / no-sycophancy / anti-hallucination on the **prose** side are steer-only (re-inject + nudge). The **brain** side goes hard: gate the writes/claims so bad output never enters the brain. |

The principle: **hard-gate everything at the brain boundary; steer everything on the
model-behaviour side.** The model can say anything; the brain stays clean by force.

## Phasing

- **A (additive, low-risk):** wiki spine (#1) + live meter (#2) + browsable dashboard-wiki (#3).
- **B (consolidation — removes scatter):** adherence gate (#4, hard) + verify_claim (#5, hard) + name/consolidate CAPTURE (#6) and PROTECT (#7). This phase deletes more than it adds.
- **C:** the brain facade (#8).
