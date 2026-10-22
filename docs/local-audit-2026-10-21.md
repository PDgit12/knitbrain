# Local correctness fixes — 21 October 2026

## Scope

Two defects reproduced with failing regression tests before source changes:

1. A nested `readdirSync` error aborted the entire source scan, including readable
   sibling files. The macOS host exhibited `EPERM` at `Library/Accounts`.
2. Generic skill triggers such as `review`, `build`, and `data` caused a résumé
   skill to beat or substitute for a pipeline/code-specific skill.

## Changes

- Source scanning skips protected/disappearing children (`EPERM`, `EACCES`,
  `ENOENT`, `ENOTDIR`) and continues readable siblings. Unexpected disk failures
  still throw; an inaccessible project root still throws. Symlinks are not
  followed, preventing cycles and traversal outside the requested tree.
- Reads that disappear or become inaccessible between discovery and reading are
  skipped using the same restricted error set. Scanning remains best effort;
  its file count describes indexed readable files, not a proof of exhaustive
  coverage. Callers should select a bounded project root rather than a home tree.
- Skill matching ignores generic task words and counts normalized distinct
  trigger tokens. Domain-specific triggers and names still select relevant
  skills; a weak generic-only match returns no skill instead of an unrelated one.

This is a deterministic keyword improvement, not semantic understanding or a
complete fix for every routing/classification case.

## Evidence

Initial focused baseline: 21 tests passed. Added regressions: five failed before
fixes (three protected-child cases, two irrelevant-skill cases). Added tests also
cover symlink cycles, inaccessible roots, and unexpected disk errors.

Final full `npm run verify`, run with localhost access, exited 0:
- typecheck, lint, build
- 67 test files passed, 1 skipped
- 626 tests passed, 1 skipped
- consistency checks and benchmark gates passed

Restricted sandbox run failed 26 HTTP tests with `listen EPERM 127.0.0.1`.
The localhost-enabled run passed those cases; no failures were relabelled as
passing inside the restricted run. The inherited skipped test remains skipped.

## Deployment boundary

Changes are local on `audit/mcp-correctness-optimization`. No npm publish,
release, commit, push or managed-MCP restart was performed. The host's already
running MCP server may still use its previously loaded module. Rebuild/restart
or deployment must be checked separately before claiming the active service is
fixed. The source checkout and its tests are the verified deliverable here.
