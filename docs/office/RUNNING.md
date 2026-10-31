# Running a domain office

The [office plan](README.md) establishes team ownership and recovery rules. The executable manifest below is a separate schema from the historical roster in `office.json`. Put a manifest at the root of the project to be worked on. All commands are trusted configuration; do not interpolate task text into shell commands.

```json
{
  "version": 1,
  "id": "knitbrain-correctness",
  "goal": "Repair and verify the assigned Knitbrain correctness findings",
  "workspaceMode": "serial",
  "maxConcurrency": 3,
  "domains": [{"id": "correctness", "workers": 2}, {"id": "integration", "workers": 1}],
  "commandTimeoutMs": 120000,
  "deadlineMs": 3600000,
  "retryDelayMs": 1000,
  "verify": "npm run verify",
  "tasks": [{
    "id": "retrieval-freshness",
    "domainId": "correctness",
    "goal": "Repair KB-004 graph freshness and preserve exact graph-query contracts",
    "agent": "claude -p",
    "verify": "npm run verify",
    "maxAttempts": 6
  }]
}
```

The worker command must be an installed, authorized CLI that reads its assignment from stdin. There is no fabricated native subagent API: in this session the parent used the host's real collaboration API; the autonomous runner uses explicitly configured external commands. An optional `fallbackAgents` array supplies ordered alternate commands. A fallback never replaces the verify/review gate.

```sh
knitbrain doctor
knitbrain orchestrate validate ./office-plan.json
knitbrain orchestrate start ./office-plan.json
knitbrain orchestrate status /absolute/run/directory
knitbrain orchestrate message /absolute/run/directory domain:correctness 'Question about the graph invalidation contract' --type request
knitbrain orchestrate messages /absolute/run/directory retrieval-freshness correctness
knitbrain orchestrate ack /absolute/run/directory retrieval-freshness MESSAGE_UUID
knitbrain orchestrate cancel /absolute/run/directory
knitbrain orchestrate resume ./office-plan.json
```

Start prints the run directory. Default state is outside the project under `~/.knitbrain/offices/<project-hash>/<run-id>`, or supply `--run-dir` to start/resume. Use --root to select an explicit project for an externally stored plan; otherwise KNITBRAIN_PROJECT_DIR or the plan directory supplies the root. Keep the same manifest and run directory on resume; incompatible changes are rejected. Commands run in the foreground, can be monitored separately, and SIGINT/SIGTERM request cancellation. A success exit is 0, blocked is 1, cancelled is 130. Cancel acknowledgement means the request was saved; inspect final status for actual process termination.

`workspaceMode: "serial"` uses the project root with one writer regardless of higher configured worker caps. In `isolated` mode, distinct worktrees are created per task; existing task `cwd` directories may instead be supplied, but must not overlap the canonical root. Global/per-domain caps and overlapping-workspace exclusion apply. Isolation failure blocks; it never falls back to shared concurrent writes. Worktrees and changes are retained for inspection; the runner does not commit, push or merge them automatically.

Isolated plans require an explicit `integrate` command. It receives JSON containing the run directory and task workspaces on stdin, and must integrate reviewed outputs into the canonical tree before the parent's `verify` and optional `review` run. Task dependencies represent verified prerequisites and handoffs; they do not automatically copy code between worktrees. Supply the necessary integration/artifact handoff explicitly. Reworked tasks dirty integration and force it to run again on resume.

Tasks repeat independently until their gates pass, a policy limit is reached or cancellation is requested. Omitted `maxAttempts` defaults to six; explicit `null` permits unlimited attempts. Every worker, verify, review and hook command still has a finite `commandTimeoutMs`. Optional `deadlineMs` applies across resumes from the original start time. Retries rotate fairly among eligible tasks. Use finite attempt/deadline policies for unattended paid workers unless unlimited operation is intentional.

Lifecycle command hooks can be configured by event name: `run_start`, `task_start`, `verify_start`, `fallback`, `retry`, `task_blocked`, `task_verified`, `run_succeeded`, `run_blocked`, `run_cancelled`. They receive a versioned correlated JSON event on stdin. Hook failures are recorded and runner-owned gates continue; unconfirmed hook termination quarantines the parent. Native host hooks inject assignments and append observations where supported. Missing hooks cannot manufacture or prevent a recorded gate pass.

Messages use `task:<id>`, `domain:<id>` or `all` recipients, explicit request/result/blocker/handoff/decision/ack types, reply IDs and optional artifact references. Message bodies are untrusted task data. Durable acknowledgement markers identify actual delivered messages; posting an `ack` message alone does not mark other messages read. Runner batches are bounded; overflow triggers another delivery cycle rather than silently finalizing with unread inputs. A worker failure does not establish task completion.

Snapshots, attempt events and hook observations are separate files. Interrupted or unconfirmed worker processes are quarantined on resume; the runner does not blindly restart them. Inspect the recorded PID and retained worktree, confirm orphan processes have stopped, and create a deliberately revised recovery run after preserving the original evidence. The current runtime does not automatically clear quarantine or recover a broken lock. A manual handoff is the fallback when safe automatic recovery is impossible.

`doctor` distinguishes app markers, readable MCP configurations, command resolution, hook configuration observations and the current source/dist artifact. It reports connection as unverified unless a separate MCP handshake establishes it. New source files do not modify an installed/running MCP process. Run setup from the intended project, inspect the proposed/native config, and reconnect that app after promoting a tested build. Project-root binding is explicit; the server refuses broad home-directory code scans rather than indexing unrelated projects and protected OS folders.

The integration tests use deterministic commands in temporary fixtures. They establish scheduler/process/mailbox behavior, not the ability of a real model to complete the audit. No paid model workers, global installation, host restarts or releases are launched by the verification suite.

Official schema references checked 2026-10-31: [Codex MCP](https://developers.openai.com/codex/mcp), [Claude MCP](https://code.claude.com/docs/en/mcp), [Claude hooks](https://code.claude.com/docs/en/hooks), [Cursor MCP](https://cursor.com/docs/mcp), [Cursor hooks](https://cursor.com/docs/hooks). These define config paths and supported output shapes; fixture tests do not prove a particular installed client honored them.
