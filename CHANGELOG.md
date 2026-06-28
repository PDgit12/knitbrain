# Changelog

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
