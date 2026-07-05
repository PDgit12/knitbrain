# Changelog

## 0.16.0

The loop-engineering release: knitbrain turns any platform into a closed loop,
and the brain now sees + orchestrates the user's whole toolkit. Backward-compatible
except the terse-storage default (see below). **37 MCP tools**, 492 tests.

- **Whole-toolkit awareness** — the host scan now enumerates the user's
  slash-**commands** and **hooks** (project, global, and plugin), not just skills
  and agents. `knitbrain_run` surfaces the user's own commands + active hooks so
  the loop mixes and matches the whole toolkit, plugins included.
- **Goal-loop is the default** — every actionable prompt is steered toward a
  checkable gate (`GOAL_LOOP_NUDGE`, injected each turn), and the **Stop hook now
  enforces** it: an unmet in-progress goal blocks the first stop and pushes
  continuation (once — a deliberate second stop is never trapped).
- **Resume detection** — onboarding diffs git + `goal.md` + last intent so a
  resumed session continues the work instead of re-asking what to do.
- **Anti-\* cleanse layer** — every brain write (learnings, handoff, skill bodies)
  is scrubbed of credentials and terse-stored through one source (`engine/cleanse.ts`);
  the hub and transcript-mining share the same secret detection.
- **Terse brain-storage is now default-ON** (opt out with `KNITBRAIN_TERSE_STORE=0`).
  The handoff is terse-stored too, so the recurring per-session re-injection costs
  fewer tokens. Byte-preserves code, URLs, and paths — only filler is dropped.
- **Honest context meter** — reads the running model from the transcript to get
  the REAL window proactively, killing a false "clear now" that fired near 200k on
  a 1M-window model. `load_session` flags a session that did not actually reset,
  and the advice is tailored to the billing surface (api vs subscription).
- **Generated agents replicate your frontmatter scheme** — exact field set + order,
  not a fixed template.
- **Per-segment tiers** — a multi-part task ("refactor X and fix a typo") is split
  so the loop plans the complex parts and builds the trivial ones.
- Security: skill bodies and wiki titles hardened; full vulnerability sweep.

## 0.7.0

The onboard release: the brain stops waking up blank. **34 MCP tools** (was 33).
Backward-compatible.

- **`knitbrain onboard`** — the front door. The CLI scans the repo + imports this
  project's past Claude sessions into the wiki (pages + spine) and mines
  learnings. The new **`knitbrain_onboard`** MCP tool adds the agent-driven
  intent interview: it returns 5 questions; the agent asks them, then writes a
  **Project Charter** (claim-lined wiki page surfaced every session) + a
  constraints skill whose guardrails propagate to spawned agents — so the loop
  is shaped to your project, not generic. (Fixes the old silent `onboard` no-op.)
- **Honest context meter** — the window is now configurable
  (`KNITBRAIN_WINDOW_TOKENS`) and auto-heals: on a large-context model the meter
  no longer pins to a false 100% / handoff. The token count was always real;
  now the % is too.
- **Terse brain-writes** — opt-in (`KNITBRAIN_TERSE_STORE=1`, default off): learning
  summaries and skill bodies are terse-rewritten before persist, **reusing** the
  existing `compressProse` (no second transform), and never touching code, paths,
  or `claim:` lines. Output-side terse stays the separate prompt-level mode.
- Cross-platform fix: `projectTranscriptDir` now strips the Windows drive colon;
  `fan` worktree creation no longer uses a unix-only redirect. Removed a dead
  test export.

## 0.6.0

The brain release: the 4-layer brain (CAPTURE → PROTECT → BRAIN ← FETCH) wired
end to end. 33 MCP tools (was 31). Backward-compatible.

- **Wiki spine** — the close-the-loop tools (record_learning, skill_save,
  compose_skill, team_post, create_agent, save_handoff, record_false_positive)
  also drop a line into the wiki log, so the brain has one unified timeline.
- **Live meter** — `optimizationPct = saved / (liveWindow + saved)` shows
  optimization as a fraction of the live conversation window, surfaced each turn.
- **Browsable dashboard wiki** — the wiki panel renders pages (hand-rolled
  markdown→HTML, no new dependency), `[[links]]`, backlinks, and an SVG link
  graph; loopback-only.
- **Adherence gate (hard)** — `KNITBRAIN_STRICTNESS` (off|warn|**block**,
  default block): close-the-loop writes are blocked unless the session ran
  `knitbrain_run`/`knitbrain_classify_task` first. Reads, loop-entry, and the
  exact-recovery tools are never gated.
- **`knitbrain_verify_claim`** — parse a stated codebase fact and check it
  against the knowledge graph → verified | contradicted | unparseable.
- **`knitbrain_brain_search`** — unified recall that fans a query across the
  typed stores (learnings/wiki/knowledge) and returns ranked hits tagged with
  their source store, over the new `src/engine/brain.ts` facade.

## 0.5.1

- `knitbrain --version` / `-v` now prints the version (was unhandled — printed nothing).

## 0.5.0

The orchestrator release: knitbrain becomes a closed-loop orchestrator on top of
the memory + compression core. Six legs (skills, agents, memory, anti-sycophancy
context, wiki-brain, token optimization) wired into a goal→judge→iterate→grade→
review→repeat loop. 31 MCP tools. Backward-compatible.

### Added

- **Existing-setup scan (legs 1+2)** — `knitbrain setup` and `knitbrain_run` now
  scan the host's existing `.claude/skills` + `.claude/agents`, register skills
  (deduped), learn the composition style, and generate project-tailored
  skills/agents that mirror the user's own. New `knitbrain_compose_skill` tool.
- **Wiki-brain (leg 5) + session log (leg 3)** — a compounding markdown wiki
  (`index.md` · `log.md` · `pages/`) the agent maintains: `knitbrain_wiki_ingest`
  / `wiki_query` / `wiki_lint` (contradiction + orphan detection). The
  UserPromptSubmit hook appends each turn to the log; `knitbrain_load_session`
  surfaces prior-session context. Live dashboard panel. Ingests real transcripts.
- **Closed-loop orchestrator (P3)** — `knitbrain orchestrate <goal>`:
  judge→iterate→grade→review→repeat, verify-gated (no false green), token-metered
  per cycle, full wiki audit trail. Orchestration scales with project intensity
  (skill only for small tasks; skill + briefed agents for complex). Never
  commits/pushes/deploys.
- **Subscription auto-compression** — a PostToolUse hook skeletonizes the host's
  Bash/Grep/Glob/WebFetch output inline (Claude Code), lossless via the recall
  store. No API key, no proxy.
- Generated agents now style-match the user's existing `.claude/agents`
  frontmatter (`model:`/`triggers:` only when the user's agents use them).

### Fixed

- **Losslessness:** `knitbrain_retrieve` / `knitbrain_team_get` no longer get a
  context-meter advisory appended when the window runs hot — they return the
  original byte-for-byte (their contract). Regression test added.
- `dashboard /api/state` degrades hub/quota failures to local state instead of
  hanging the request.
- `optimizer/text.ts` guards an out-of-bounds read when `KNITBRAIN_MIN_SENTENCES`
  is swept below the structural floor.
- Stale `⟨ccr:⟩` → `⟨recall:⟩` marker in the e2e/audit scripts.

### Tooling

- Handler tests for the 14 previously-untested MCP tools (now 0 untested).
- CI gains an `e2e` lane (live per-tool e2e + cold-start production-audit) so
  marker/format drift can't slip past `npm run verify` again.
- Docs: `ARCHITECTURE.md` (6-leg orchestrator), `SECURITY.md`, ADRs.

## 0.4.6 and earlier

Compression + memory + workflow + autonomous loop + parity visibility. See git
history.
