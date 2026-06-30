# knitbrain v0.7.0 — the onboard release

The brain stops waking up blank. **34 MCP tools** (was 33). Backward-compatible.

## Highlights

- **`knitbrain onboard` — the front door.** The CLI scans the repo into the
  knowledge graph and imports this project's past Claude sessions into the wiki
  (pages + spine) + mines learnings. The new **`knitbrain_onboard`** MCP tool
  runs the agent-driven intent interview: it returns 5 questions, the agent asks
  them, then writes a **Project Charter** — a claim-lined wiki page surfaced
  every session — plus a constraints skill whose guardrails propagate to spawned
  agents. The loop is shaped to your project, not generic. (Fixes the old silent
  `onboard` no-op.)
- **Honest context meter.** The window is configurable
  (`KNITBRAIN_WINDOW_TOKENS`) and auto-heals: on a large-context model the meter
  no longer pins to a false 100% / "save a handoff now." The token count was
  always real; now the percentage is too.
- **Terse brain-writes (opt-in).** `KNITBRAIN_TERSE_STORE=1` (default off):
  learning summaries and skill bodies are terse-rewritten before persist,
  **reusing** the existing `compressProse` — one transform, not two — and never
  touching code, paths, numbers, or `claim:` lines. Output-side terse stays the
  separate prompt-level mode.
- **Cross-platform + cleanup.** `projectTranscriptDir` strips the Windows drive
  colon; `fan` worktree creation drops a unix-only redirect; a dead test export
  removed.

## Verified (Phase 4 full audit, captured)

- Gate chain green: typecheck · lint · test **358** · build · consistency
  (**34 tools**) · bench (floors held).
- production-audit **50/50** · e2e (all 34 tools live) · evals **100%** (2514
  real blocks: round-trip + identifier + error + summary + never-expand).
- 4-layer coherence (every tool through the one `dispatch()` chokepoint) ·
  onboard path live (Charter + constraints + load_session surfaces intent) ·
  adherence HARD · cso clean · cross-platform.

## Install

```bash
npm install -g knitbrain
knitbrain setup      # wire MCP + hooks
knitbrain onboard    # import history + scan the repo
```

Full changelog: `CHANGELOG.md`.
