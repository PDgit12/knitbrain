# Contributing

Branch from current `main`, keep changes focused, and open a pull request. Use conventional commit titles. Do not force-push main or bypass checks. Versions and npm releases require explicit maintainer approval.

The [end-to-end repair map](docs/audits/2026-10-22/README.md) tracks current correctness, optimization and delivery work. Cite the finding ID, reproduce the defect before changing it, then add a regression that checks the observable contract. Label hypotheses separately from reproduced failures.

## Validation

Use the runtime versions declared in the CI matrix. Install with `npm ci`. Start from a clean generated `dist` (move an old build aside if preserving it), then run:

```bash
npm run verify
npm run e2e:tools
node scripts/verify-audit-map.mjs
```

The suite needs localhost sockets. Distinguish sandbox failures from product failures and record command exit codes. Test setup disables some governance checks by default; changes to governance must also test the product's default strictness through the MCP transport.

Changes to packaging/setup need a packed-package consumer test. Optimizer changes need final emitted token counts, exact recall and task-fidelity checks; an internal skeleton saving alone is insufficient. The diagnostic `scripts/audit-probes.mjs` reports known defects and must not be treated as a green acceptance gate.

## Review and release boundaries

Preserve unrelated local changes and host configuration. A source build, packed install, running MCP and npm release are different artifacts: state which was tested. Do not claim a host is updated without a reconnect/provenance check. Do not merge or release while required acceptance checks for that scope remain open.

For security reports, follow [SECURITY.md](SECURITY.md). Do not disclose an unfixed novel vulnerability in a public issue or PR. Public upstream dependency advisories may be referenced without implying proven exploitability in this application.
