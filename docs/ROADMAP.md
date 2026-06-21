# knitbrain roadmap — (b) live agent CRM · (c) parallel orchestration

Context: v1 (this branch) ships compression + memory + workflow + autonomous loop +
parity visibility, all gated. These two are the bigger v2 builds, planned so they're
executed cleanly. Both follow Matt Pocock's framing: it's a **queue with workers +
human-in-loop checkpoints**, not magic — and knitbrain stays the *substrate*, never
spawning host agents it can't control.

---

## (b) CRM for AI agents — live activity stream

**Goal:** the dashboard shows agents working in real time — a per-agent rollup + a
live action feed — not just state snapshots.

**Source of truth:** the MCP dispatch chokepoint. Every tool call is an event.

**Design**
- `src/engine/activity.ts` (new): bounded append-only log (ring buffer, last ~200
  events) on disk via `writeAtomic`. `record({ts, agent, tool, summary})` +
  `recent(n)`. Bounded so it never grows unbounded (the staleness lesson).
- **Agent identity** (honest limit): MCP gives no stable agent id. Label by host id
  (`src/mcp/host.ts` handshake) + a per-process session id; if joined to a hub, use
  the member name. Best-effort, documented.
- **Wire:** in the MCP dispatch (`src/mcp/handlers.ts`/`tools.ts`), after each tool
  runs, `activity.record(...)`. Cheap, non-blocking, never throws (must not break a
  tool call).
- **Dashboard:** new "Agents (live)" card — table `agent · last action · when` +
  a recent-events feed. Reuse the 2s poll; upgrade to SSE only if instant matters.

**Scope/risk:** ~1 session. Low risk (additive, read-only view). Honest limit: agent
identity is best-effort, not cryptographic.

**Verify:** activity.record/recent unit test (bounded eviction); dashboard `/api/state`
exposes `activity`; e2e — run a few MCP tools, see them in the feed.

---

## (c) Multi-agent parallel orchestration — queue + N workers

**Goal:** fan a goal's tasks to N workers in parallel, isolated, coordinated, merged.
The parallel version of the loop driver (which is the single-worker case).

**Design** — `knitbrain fan <goalfile> --workers N [--agent cmd] [--verify cmd] [--max M]`
- **Queue:** the `- [ ]` checkbox tasks (same shape as `loop`).
- **Claim atomicity:** a worker claims the next task by atomically marking it
  `- [~] (worker-k)` (write-if-unchanged via a lock file or compare-and-set on the
  goalfile) so two workers never grab the same task.
- **Isolation:** each worker runs its agent in its own **git worktree**
  (`git worktree add`), so parallel edits don't collide on disk.
- **Coordinate:** workers post progress/findings to the existing **team board**.
- **Merge:** each worker commits in its worktree; a merge step brings branches back.
  **v1 simplification:** require tasks to name disjoint domains/files → no merge
  conflicts by construction; defer automatic conflict resolution to v2.
- **Safety:** global `--max` iteration cap; **never auto-merge to main / never push**;
  human gate at merge. Re-read goalfile before marking (the loop's stale-write fix).

**Scope/risk:** ~2 sessions. Hard parts: claim atomicity, worktree lifecycle, merge.
Honest: ship v1 = N workers on disjoint domains (conflict-free), defer conflict-merge.

**Verify:** mock agents (cross-platform `node -e`); assert N workers drain the queue
with no double-claim, each in its own worktree, `--max` respected, nothing pushed.

---

## Positioning note (from the value-prop check)
Lead the README/launch with the **closed autonomous loop** (the loop-engineering
wedge), not just "compression + memory" — that's what differentiates knitbrain from
Headroom (compress-only) and caveman (output-only).
