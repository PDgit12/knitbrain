# Findings and acceptance gates

Generated from [findings.json](findings.json). States describe source/local evidence, not active-host or published deployment. Proposed owner areas are not assigned people.

| ID | Priority | Area | State | Evidence confidence |
|---|---|---|---|---|
| [KB-001](#kb-001) | P0 | completion | partial_local | regression-tested-local |
| [KB-002](#kb-002) | P0 | output-contract | partial_local | regression-tested-local |
| [KB-003](#kb-003) | P1 | input-contract | partial_local | regression-tested-local |
| [KB-004](#kb-004) | P1 | retrieval | open | reproduced |
| [KB-005](#kb-005) | P0 | claim-verification | open | reproduced |
| [KB-006](#kb-006) | P1 | measurement | open | reproduced |
| [KB-007](#kb-007) | P1 | measurement | open | reproduced |
| [KB-008](#kb-008) | P1 | optimization | open | reproduced |
| [KB-009](#kb-009) | P1 | routing | open | reproduced |
| [KB-010](#kb-010) | P1 | routing | partial_local | reproduced |
| [KB-011](#kb-011) | P1 | retrieval | verified_local_only | regression-tested |
| [KB-012](#kb-012) | P1 | recall | open | policy-reproduced |
| [KB-013](#kb-013) | P1 | project-scope | open | source-confirmed |
| [KB-014](#kb-014) | P1 | persistence | needs_reproduction | source-risk |
| [KB-015](#kb-015) | P1 | workers | open | source-confirmed |
| [KB-016](#kb-016) | P1 | completion | open | source-confirmed |
| [KB-017](#kb-017) | P1 | completion | open | source-confirmed |
| [KB-018](#kb-018) | P2 | documentation | partial_local | reproduced |
| [KB-019](#kb-019) | P1 | release | open | live-observed |
| [KB-020](#kb-020) | P1 | dependencies | open | registry-confirmed |
| [KB-021](#kb-021) | P1 | github | open | live-observed |
| [KB-022](#kb-022) | P2 | github | partial_local | source-confirmed |
| [KB-023](#kb-023) | P1 | testing | open | reproduced |
| [KB-024](#kb-024) | P1 | optimization | needs_evaluation | coverage-gap |
| [KB-025](#kb-025) | P2 | performance | needs_benchmark | source-risk |
| [KB-026](#kb-026) | P1 | host-integration | needs_evaluation | coverage-gap |
| [KB-027](#kb-027) | P1 | installation | needs_evaluation | live-observed |
| [KB-028](#kb-028) | P1 | privacy | needs_evaluation | source-risk |
| [KB-029](#kb-029) | P1 | governance | needs_evaluation | source-confirmed |
| [KB-030](#kb-030) | P2 | context-overhead | needs_benchmark | live-observed |
| [KB-031](#kb-031) | P2 | github | mapped_this_change | artifact-verified |
| [KB-032](#kb-032) | P2 | compatibility | open | source-confirmed |

<a id="kb-001"></a>

## KB-001 — Fail closed on missing verification gates

**P0 · partial_local · regression-tested-local**

Area: completion. Proposed owner: MCP/runner.

Source: [src/engine/closed-loop.ts](../../../src/engine/closed-loop.ts). Evidence: probes.json#KB-001.

Repair: Empty and whitespace-only gates now fail closed in MCP grading; the CLI refuses to run tasks when it cannot derive a gate. CLI clean-stop status semantics remain for follow-up.

Acceptance: Blank and whitespace-only gates return not-met; the CLI no-gate path returns exit 1 before running tasks; valid exit-zero commands can pass. Focused unit and CLI tests pass locally. Published and connected-host behavior remains unverified.

Dependencies: none.

<a id="kb-002"></a>

## KB-002 — Keep JSON parseable under meter pressure and protocol warnings

**P0 · partial_local · regression-tested-local**

Area: output-contract. Proposed owner: MCP.

Source: [src/mcp/tools.ts](../../../src/mcp/tools.ts). Evidence: probes.json#KB-002.

Repair: Dispatch now omits appended meter and protocol advisories when the tool result is valid JSON. A structured side channel for those advisories remains follow-up.

Acceptance: JSON output remains parseable during meter warn/handoff; non-JSON advisories and exact retrieval behavior retain their contracts. Focused dispatch regression passes locally. Published and connected-host behavior remains unverified.

Dependencies: KB-003.

<a id="kb-003"></a>

## KB-003 — Enforce advertised input schemas at runtime

**P1 · partial_local · regression-tested-local**

Area: input-contract. Proposed owner: MCP.

Source: [src/server.ts](../../../src/server.ts). Evidence: probes.json#KB-003.

Repair: The MCP boundary now checks required keys, primitive types, enums, array item types and additionalProperties before handler execution. Full JSON Schema constraints and payload bounds remain follow-up.

Acceptance: In-memory MCP client call with a missing required field returns isError before handler execution; unit tests cover wrong primitive types, unknown properties, invalid enums and array item types. Full JSON Schema constraints, size limits, published and connected-host behavior remain unverified.

Dependencies: none.

<a id="kb-004"></a>

## KB-004 — Invalidate graph facts after edits, additions and deletions

**P1 · open · reproduced**

Area: retrieval. Proposed owner: index/retrieval.

Source: [src/engine/knowledge.ts](../../../src/engine/knowledge.ts). Evidence: probes.json#KB-004.

Repair: Use bounded incremental invalidation shared by graph queries and search; retain reverse-index consistency and report stale/incomplete state.

Acceptance: Same-process and reopened-cache tests observe modified exports/imports, new files and deleted nodes without a manual rescan; reindex cost measured on a declared corpus.

Dependencies: KB-011.

<a id="kb-005"></a>

## KB-005 — Stop substring matches from verifying false claims

**P0 · open · reproduced**

Area: claim-verification. Proposed owner: MCP/index.

Source: [src/mcp/tools.ts](../../../src/mcp/tools.ts). Evidence: probes.json#KB-005.

Repair: Match symbol names exactly and compare resolved canonical file identities. Unsupported or ambiguous claims must be unparseable rather than verified.

Acceptance: A file exporting foobar contradicts exports foo; similarly named files/imports cannot verify each other; aliases, NodeNext paths and ambiguous module tails have explicit tests.

Dependencies: KB-004.

<a id="kb-006"></a>

## KB-006 — Separate lifetime savings, session savings and live-window occupancy

**P1 · open · reproduced**

Area: measurement. Proposed owner: meter/receipt.

Source: [src/engine/meter.ts](../../../src/engine/meter.ts). Evidence: probes.json#KB-006.

Repair: Keep lifetime totals but calculate session deltas from a session boundary. Do not present accumulated or resent savings as a measured current-context counterfactual.

Acceptance: A fresh session with no optimization reports zero session savings despite lifetime history; replayed requests and MCP-plus-proxy paths cannot double-count the same replacement.

Dependencies: KB-008.

<a id="kb-007"></a>

## KB-007 — Do not invent a larger context window when usage exceeds a configured limit

**P1 · open · reproduced**

Area: measurement. Proposed owner: meter/host.

Source: [src/engine/meter.ts](../../../src/engine/meter.ts). Evidence: probes.json#KB-007.

Repair: Respect explicit configuration and known model capacity. Surface overflow or unknown capacity instead of silently promoting a 200k window to 1M.

Acceptance: 210k observed in a configured 200k window stays overflow/handoff, not healthy at 21%; unknown models remain labelled unknown and host-specific capacities are tested.

Dependencies: none.

<a id="kb-008"></a>

## KB-008 — Apply never-expand and savings accounting to the final emitted response

**P1 · open · reproduced**

Area: optimization. Proposed owner: optimizer/MCP.

Source: [src/mcp/tools.ts](../../../src/mcp/tools.ts). Evidence: probes.json#KB-008.

Repair: Include wrapper text, handles and advisories in the final token budget; fall back when the full response expands. Measure emitted rather than internal skeleton tokens.

Acceptance: The 86-token fixture no longer emits 108 tokens while reporting a saving; sweep boundary-sized payloads, long file paths and warnings for read, optimize, hooks and proxy.

Dependencies: KB-002.

<a id="kb-009"></a>

## KB-009 — Classify polite action requests and inflected write verbs correctly

**P1 · open · reproduced**

Area: routing. Proposed owner: workflow.

Source: [src/engine/workflow.ts](../../../src/engine/workflow.ts). Evidence: probes.json#KB-009.

Repair: Prioritize mutation intent over question punctuation and read words. Recognize create/update/fixes variants; make calibration unable to remove essential intent/risk rules.

Acceptance: Can you fix the bug? and Create a complete audit report and map needed fixes are actionable; explain the architecture remains inquiry. Report confusion matrix on a versioned task corpus.

Dependencies: none.

<a id="kb-010"></a>

## KB-010 — Use domain relevance and abstention for skill selection

**P1 · partial_local · reproduced**

Area: routing. Proposed owner: skills.

Source: [src/engine/skills.ts](../../../src/engine/skills.ts). Evidence: probes.json#KB-010.

Repair: Preserve the local generic-word improvement, then add coverage/specificity thresholds, negative-domain cases, tie handling and explainable match evidence. Abstain on weak matches.

Acceptance: Local resume regressions remain green; payments-discovery no longer wins an MCP audit via map/evidence alone; domain-labelled corpus and healthy/unhealthy skill cases pass.

Dependencies: KB-009.

<a id="kb-011"></a>

## KB-011 — Promote resilient bounded scanning from local checkout to reviewed delivery

**P1 · verified_local_only · regression-tested**

Area: retrieval. Proposed owner: index/retrieval.

Source: [src/engine/knowledge.ts](../../../src/engine/knowledge.ts). Evidence: ../../local-audit-2026-10-21.md.

Repair: Review and deliver existing protected-child/symlink fixes; expose skipped-path counts and completeness. Choose a bounded root and limits rather than silently scanning a home tree.

Acceptance: EPERM/EACCES/disappearing children preserve readable siblings; inaccessible root and EIO still fail; symlink cycles stop; active-host root and coverage diagnostics verified after restart.

Dependencies: KB-013.

<a id="kb-012"></a>

## KB-012 — Make recall lifetime and purge policy explicit

**P1 · open · policy-reproduced**

Area: recall. Proposed owner: CCR.

Source: [src/ccr/store.ts](../../../src/ccr/store.ts). Evidence: probes.json#KB-012.

Repair: Document bounded retention, warn before irreversible eviction and consider pinning active-session handles. Clarify recovery availability rather than promising permanent losslessness.

Acceptance: Hot/cold round trips and corruption checks pass; eviction cannot silently remove pinned live handles; missing/expired handles return actionable errors; docs match server startup maintenance.

Dependencies: none.

<a id="kb-013"></a>

## KB-013 — Use one explicit project root for identity, queries and commands

**P1 · open · source-confirmed**

Area: project-scope. Proposed owner: server/paths.

Source: [src/server.ts](../../../src/server.ts). Evidence: src/paths.ts; src/mcp/tools.ts.

Repair: Resolve and canonicalize root once; align KNITBRAIN_PROJECT_DIR, store IDs, knowledge scanning, file reads and verification cwd. Add startup diagnostics for the selected root.

Acceptance: Server launched outside the overridden project searches and verifies the intended project; nested worktrees and two simultaneous projects cannot share the wrong state.

Dependencies: none.

<a id="kb-014"></a>

## KB-014 — Prove concurrent read-modify-write safety and crash recovery

**P1 · needs_reproduction · source-risk**

Area: persistence. Proposed owner: storage.

Source: [src/atomic.ts](../../../src/atomic.ts). Evidence: src/engine/meter.ts; src/engine/feedback.ts; src/ccr/store.ts.

Repair: Evaluate transactions/locking or append-only events for shared counters and manifests. Atomic rename prevents partial files but does not itself prevent lost updates.

Acceptance: Multiprocess increments preserve exact expected totals; interleaved manifest writes preserve all handles; injected crash and corrupt-state recovery is deterministic and observable.

Dependencies: KB-006, KB-012.

<a id="kb-015"></a>

## KB-015 — Fail closed when requested worker isolation cannot be created

**P1 · open · source-confirmed**

Area: workers. Proposed owner: runner/fan.

Source: [src/fan.ts](../../../src/fan.ts). Evidence: src/fan.ts: worktreeFor returns process.cwd on failure.

Repair: Refuse worker startup when isolation fails. Track per-task branch/artifact results separately from integration completion; keep integration review explicit.

Acceptance: Injected worktree creation failure runs zero agent commands in the shared checkout; independent-worker results cannot mark integrated acceptance met before reconciliation.

Dependencies: KB-001.

<a id="kb-016"></a>

## KB-016 — Enforce deadlines inside subprocesses and surface incomplete exit semantics

**P1 · open · source-confirmed**

Area: completion. Proposed owner: runner/MCP.

Source: [src/loop.ts](../../../src/loop.ts). Evidence: src/fan.ts; src/mcp/tools.ts.

Repair: Apply remaining wall-clock budgets to agent, verify and reviewer processes, including child-process cleanup; emit explicit met/stopped/error result distinctions.

Acceptance: Hanging child cannot outlive the declared deadline beyond bounded teardown; max/time-budget stops with unfinished tasks are machine-distinguishable from goal-met across MCP, CLI and fan.

Dependencies: KB-001.

<a id="kb-017"></a>

## KB-017 — Return useful verification failure evidence and scope success to the actual command

**P1 · open · source-confirmed**

Area: completion. Proposed owner: MCP/runner.

Source: [src/mcp/tools.ts](../../../src/mcp/tools.ts). Evidence: src/mcp/tools.ts: execSync stdio ignore; makeReview([]).

Repair: Capture bounded sanitized stderr/stdout, exit/signal/timeout and attempt metadata. Keep rubric strings explicitly advisory unless actually evaluated.

Acceptance: Distinct compile/test/timeout failures retain differentiating evidence without credentials; a passing trivial command cannot be described as full task/rubric acceptance.

Dependencies: KB-001, KB-003.

<a id="kb-018"></a>

## KB-018 — Fix the published library quickstart

**P2 · partial_local · reproduced**

Area: documentation. Proposed owner: DX/library.

Source: [README.md](../../../README.md). Evidence: probes.json#KB-018.

Repair: README now uses the actual API and handles passthrough; local documented-method/exact-recovery smoke passes. Still execute the copied example against the packed package in a fresh consumer.

Acceptance: A fresh consumer copies the README example and recovers the exact original; no missing method or undocumented option is required.

Dependencies: none.

<a id="kb-019"></a>

## KB-019 — Track source, installed binary, active MCP and npm as distinct artifacts

**P1 · open · live-observed**

Area: release. Proposed owner: release/maintainer.

Source: [package.json](../../../package.json). Evidence: repository.json.

Repair: Introduce provenance/doctor output: version, commit/build, module path, root and integration mode. Keep release gates explicit; do not bump or publish as part of this audit.

Acceptance: Document npm 0.20.0 versus main 0.20.1; packed candidate and active-host smoke each attest their own artifact. Rollback/restart instructions tested separately.

Dependencies: KB-020, KB-023, KB-027.

<a id="kb-020"></a>

## KB-020 — Triage and remediate existing upstream runtime advisories

**P1 · open · registry-confirmed**

Area: dependencies. Proposed owner: security/dependencies.

Source: [package-lock.json](../../../package-lock.json). Evidence: runtime-dependencies.json.

Repair: Inventory direct/transitive advisories, establish reachable code paths and update compatible dependencies in a dedicated reviewed change. Do not use blind force upgrades.

Acceptance: npm audit --omit=dev has zero critical/high, or a reviewed time-bounded exception with reachability evidence; lockfile install, full verify and packed-consumer tests pass. Current report is not an exploit demonstration.

Dependencies: none.

<a id="kb-021"></a>

## KB-021 — Require review and status checks on main

**P1 · open · live-observed**

Area: github. Proposed owner: repository-admin.

Source: [.github/workflows/ci.yml](../../../.github/workflows/ci.yml). Evidence: repository.json.

Repair: Maintainer activates a ruleset or branch protection with actual CI check names, pull-request review, force-push/deletion controls and an explicit bypass policy.

Acceptance: GitHub API proves the active rule targets main and requires the intended checks/review; a failing PR cannot merge via the normal path. No organization/admin settings changed by this map.

Dependencies: KB-022, KB-023.

<a id="kb-022"></a>

## KB-022 — Harden CI supply chain and reproducibility

**P2 · partial_local · source-confirmed**

Area: github. Proposed owner: CI.

Source: [.github/workflows/ci.yml](../../../.github/workflows/ci.yml). Evidence: actions use mutable v4 tags, latest OS labels and no explicit permissions.

Repair: This branch adds contents:read, run concurrency and job timeouts. Still pin reviewed external action revisions and runner/toolchain policy; add dependency review/update policy.

Acceptance: Every external action has an attested revision; untrusted PR jobs have no write token/secrets; timed-out builds terminate; required-check names are stable.

Dependencies: none.

<a id="kb-023"></a>

## KB-023 — Extend existing green tests with adversarial end-to-end contracts

**P1 · open · reproduced**

Area: testing. Proposed owner: test/CI.

Source: [tests/dispatch.test.ts](../../../tests/dispatch.test.ts). Evidence: probes.json; verification.json.

Repair: Convert each reproduced defect to a failing regression before its fix. Run schema/output/pressure/strictness and e2e:tools in CI, and verify the exact packed candidate commit.

Acceptance: Each P0/P1 fix has a red-before/green-after test; default strictness and error paths are exercised through stdio, not just direct handler calls; skipped live tests stay labelled.

Dependencies: KB-003.

<a id="kb-024"></a>

## KB-024 — Measure task fidelity and net session benefit, not just round-trip availability

**P1 · needs_evaluation · coverage-gap**

Area: optimization. Proposed owner: evals.

Source: [src/evals.ts](../../../src/evals.ts). Evidence: src/evals.ts: identifier/error-line heuristics; scripts/bench.ts.

Repair: Version a shareable held-out corpus with question/answer and decision-critical content checks. Compare no optimization, retrieval only, compression only and combined modes.

Acceptance: Report raw/emitted/recall/retry/tool-schema tokens, correctness, completion rate, latency and cost on the same tasks; no claimed universal answer preservation or provider-billed savings from token heuristics alone.

Dependencies: KB-005, KB-008, KB-006, KB-012, KB-025.

<a id="kb-025"></a>

## KB-025 — Bound full scans, repeated reads, tokenization and deep-parse work

**P2 · needs_benchmark · source-risk**

Area: performance. Proposed owner: optimizer/retrieval.

Source: [src/engine/retrieval.ts](../../../src/engine/retrieval.ts). Evidence: src/optimizer/router.ts: detect before byType size guard.

Repair: Profile cold/warm search and compression by size; cache safe unchanged chunks after freshness is correct; apply input budgets before expensive parsing and synchronous IO.

Acceptance: Publish dataset sizes, machine/runtime, cold/warm p50/p95, memory and event-loop delay; no tuning accepted if task fidelity regresses. Budgets set from measurements, not invented speedups.

Dependencies: KB-004, KB-011.

<a id="kb-026"></a>

## KB-026 — Prove enforcement in actual supported hosts

**P1 · needs_evaluation · coverage-gap**

Area: host-integration. Proposed owner: platforms.

Source: [src/hooks/adapters.ts](../../../src/hooks/adapters.ts). Evidence: tests/hook-adapters.test.ts; README.md platform table.

Repair: Maintain a host/version capability ledger separating payload-fixture tests from connected-host invocation, deny/stop/rewrite and fallback behavior.

Acceptance: For every claimed platform, record version and real lifecycle evidence or label unverified/advisory; OAuth tool-surface savings remain separate from API-proxy measurements.

Dependencies: KB-003, KB-027.

<a id="kb-027"></a>

## KB-027 — Verify setup, upgrades, reconnect and removal without clobbering host config

**P1 · needs_evaluation · live-observed**

Area: installation. Proposed owner: setup/DX.

Source: [src/setup.ts](../../../src/setup.ts). Evidence: src/global-config.ts; active host still showed old routing/search behavior.

Repair: Test idempotent config merge, scoped roots, executable resolution, backups and uninstall/rollback. Emit stale-server/build diagnostics instead of implying a rebuild changed the running process.

Acceptance: Fresh install and upgrade preserve unrelated settings; reconnect reports the expected binary/root and passes read/recall/search probes; no live configuration changed silently.

Dependencies: KB-013.

<a id="kb-028"></a>

## KB-028 — Review sensitive local retention and optional network boundaries

**P1 · needs_evaluation · source-risk**

Area: privacy. Proposed owner: storage/security.

Source: [src/ccr/store.ts](../../../src/ccr/store.ts). Evidence: src/learn.ts; src/engine/cleanse.ts; src/hub/client.ts; src/proxy/server.ts.

Repair: Define which raw outputs/transcripts enter CCR versus scrubbed memory, file modes and project isolation. Document provider/hub egress, deletion/backup policy and opt-in import behavior.

Acceptance: Synthetic secret canaries prove intended redaction and isolation; raw exact-recall storage is disclosed accurately; permissions and hub/proxy access controls tested. Novel vulnerability details stay private under SECURITY.md.

Dependencies: KB-012, KB-013, KB-020.

<a id="kb-029"></a>

## KB-029 — Bound enforcement claims to the actual permission mechanism

**P1 · needs_evaluation · source-confirmed**

Area: governance. Proposed owner: hooks/security.

Source: [src/hooks/pretooluse.ts](../../../src/hooks/pretooluse.ts). Evidence: literal constraint rules and documented fail-open behavior; src/hooks/index.ts.

Repair: Document hooks as host-dependent policy assistance rather than a sandbox. Specify behavior when config/hooks fail and distinguish arbitrary user-authorized shell execution from enforced project restrictions.

Acceptance: A versioned command/host matrix tests direct and equivalent command forms plus missing/broken hooks; unsupported constraints are labelled unenforced rather than advertised as physically guaranteed.

Dependencies: KB-003, KB-026.

<a id="kb-030"></a>

## KB-030 — Measure standing protocol/tool-schema overhead and response verbosity

**P2 · needs_benchmark · live-observed**

Area: context-overhead. Proposed owner: MCP/host.

Source: [src/mcp/instructions.ts](../../../src/mcp/instructions.ts). Evidence: src/server.ts: tools/list; repeated protocol text observed in connected tool descriptions.

Repair: Measure native tools/list and host-enriched descriptions separately. Avoid repeating instructions per tool where the host permits shared instructions; deduplicate command inventories.

Acceptance: Record cold session overhead plus per-task tool/result tokens before/after; retain required operating guidance and do not attribute host-added repetition to source without measurement.

Dependencies: KB-006, KB-024.

<a id="kb-031"></a>

## KB-031 — Keep one traceable public repair backlog and review workflow

**P2 · mapped_this_change · artifact-verified**

Area: github. Proposed owner: maintainer/DX.

Source: [docs/audits/2026-10-22/findings.json](../../../docs/audits/2026-10-22/findings.json). Evidence: scripts/verify-audit-map.mjs; .github/PULL_REQUEST_TEMPLATE.md.

Repair: Add linked audit index, machine-readable findings, reproduction evidence, dependency order, contribution instructions and issue/PR templates. Do not open dozens of speculative issues.

Acceptance: All IDs, sources, evidence fragments and dependencies validate; tool inventory covers all 37 tools; the public branch/PR identifies implemented versus open work and preserves private security disclosure.

Dependencies: none.

<a id="kb-032"></a>

## KB-032 — Align declared Node support and actual CI coverage

**P2 · open · source-confirmed**

Area: compatibility. Proposed owner: release/CI.

Source: [package.json](../../../package.json). Evidence: .github/workflows/ci.yml: Node20/22, no declared-minimum Node18 lane.

Repair: Choose and document a supported runtime policy based on dependency engines; test the minimum and current supported LTS versions on relevant operating systems, including macOS host fixtures.

Acceptance: Declared minimum can install/run the packed artifact; CI matrix matches policy; compatibility changes get explicit release notes, not an untested engine claim.

Dependencies: KB-020, KB-022.
