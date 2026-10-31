# Office, autodetection and optimization audit

Source candidate audit, 2026-10-31. The [machine-readable verification](verification.json) records local checks and the actual npm tarball hash. [Office plan](../../office/README.md), [run controls](../../office/RUNNING.md), and the [32-finding repair map](../2026-10-22/FINDINGS.md) describe ownership and outstanding acceptance.

## Result

Three real host subagents initialized the office, agreed on the shared identity and handoff contract, and implemented/reviewed their domains. The source now includes an external worker scheduler with independent goals/gates, configurable global/domain concurrency, dependencies, durable messages and acknowledgements, finite subprocess deadlines, explicit fallback profiles, fair retries, cancellation and conservative quarantine. Parent success requires integrated-tree verification. No persistent paid model office was launched.

The reported search failure was reproduced as launch-directory/project-root divergence. Scanning, relative reads, verification and stores now share a canonical root. When supported, a single MCP client root is discovered through the protocol; explicit project configuration wins. Multiple roots require selection. Broad home scans fail with an actionable project-binding message before traversing protected directories. Hooks accept a host cwd or single workspace root; setup emits native project config with root binding rather than pinning every repository through a global Codex setting.

Codex, Claude Code and Cursor detection now checks project/environment markers and actual config files. `knitbrain doctor` distinguishes app presence, readable MCP config, command resolution, root binding, hook bindings and artifact provenance. It does not turn config-file presence into a claimed live connection. The audit found/fixed Codex's generated hook wrapper, Cursor's required stdio type and supported lifecycle bindings, and an incorrect diagnostic event label.

Optimization now counts complete emitted annotations and recall handles. Nonpositive net savings return the original; structured hook replacements preserve the result shape and error fields. Unsupported host rewrite paths are skipped. Meter session savings are distinct from lifetime receipt totals; observed overflow does not invent a larger context capacity. Empty or pass-through-only eval corpora cannot establish compression acceptance.

## Observed gates

- Clean generated build was recreated after preserving the old output. `npm run verify`: exit 0, **723 passed / 1 skipped**; typecheck, lint, build, consistency and benchmark gates pass.
- `npm run e2e:tools`: exit 0, all **37 tools** exercised over real stdio, including measured full-output savings and exact recall. `npm run e2e`: exit 0.
- Office/map consistency and `git diff --check`: exit 0. These artifact checks do not establish real-model task completion.
- Actual tarball inspection: **213 package files, 70 JavaScript files**, no test/mock fixture paths, transcript files, secret filenames or test/mock imports found. Packed CLI doctor smoke passed with the checkout's existing lockfile dependencies. The exact tarball hash is in verification.json. This check is not a fresh install or a universal runtime data-provenance proof.
- Production `npm audit --omit=dev`: exit 0, **0 advisories**, after compatible lockfile updates; no forced major upgrade. The full development dependency audit still exits 1; counts are recorded in verification.json.

## Audit corrections and remaining boundaries

Peer review caught and corrected lost cancellation on concurrent resume, the parent-command pre-spawn crash window, stale integration after rework, starvation from zero-delay retries, unread-message overflow, and inconsistent root aliases. Regression tests exercise real local processes in isolated temporary fixtures. These fixtures and mock upstreams remain under tests/scripts, outside the runtime package.

Configured hook commands and files are not proof that a particular app trusted, loaded or ran them. The globally installed CLI was **0.20.0** when inspected, while this source candidate is **0.20.1**; building the checkout alone does not replace an already running MCP. Any local promotion and subsequent fresh-server checks must be reported separately. Reconnection and real goal execution in all three apps remain acceptance gates. No npm publication or main merge is implied by this audit.

Quarantined interrupted/unconfirmed processes require operator recovery; no replacement may reuse their workspace. Static model-capacity mappings, real-model task fidelity, end-to-end recall/retry cost, production customer data, and the remaining repair-map findings are not established by the synthetic benchmark or passing unit suite. The package scan found no mock payload contamination; it cannot prove arbitrary future runtime inputs are real.

Native config/hook schemas were checked against [Codex MCP](https://developers.openai.com/codex/mcp), [Codex hooks](https://developers.openai.com/codex/hooks), [Claude MCP](https://code.claude.com/docs/en/mcp), [Claude hooks](https://code.claude.com/docs/en/hooks), [Cursor MCP](https://cursor.com/docs/mcp), and [Cursor hooks](https://cursor.com/docs/hooks). Client version, policy and trust can still prevent delivery.

The first GitHub candidate (`fdecb61`, run `41244879382`) failed portability checks: equal-timestamp mailbox messages were incorrectly assumed to have insertion order, and tests assumed POSIX permission bits, paths and unescaped TOML strings on Windows. Follow-up assertions use deterministic timestamp/ID order and platform-native path/escaping semantics; acknowledgement/content behavior remains tested on Windows. POSIX mode checks are not a Windows ACL proof. The corrected candidate must have its own CI result before promotion.
