# ADR 0001 — Lossless compression via a content-addressed recall store

- Status: accepted
- Date: 2026-06-25

## Context

knitbrain shrinks large tool outputs (code, logs, diffs, JSON, prose) into
skeletons so an agent's context window lasts longer. Compression is only
acceptable if it never loses information the agent might need: a skeleton that
drops a stack frame or mangles an identifier corrupts the work downstream.

## Decision

Every compressed payload is paired with its exact original in a
content-addressed store (`src/ccr/store.ts`). The handle is the SHA-256 of the
original (`sha256(text)`), so storage is deduplicated and tamper-evident. The
skeleton carries a `⟨recall:HASH⟩` marker; `knitbrain_retrieve(HASH)` returns
the original byte-for-byte. Reads re-hash and compare (`CCRIntegrityError` on
mismatch). Handles are hard-validated `^[0-9a-f]{64}$` before any filesystem
access, so a handle can never become a path-traversal vector.

Two invariants gate the build (`knitbrain evals`, `npm run bench`):
- **Round-trip lossless** — retrieve(compress(x)) === x, 100%.
- **Never-expand** — skeleton tokens ≤ original tokens, always.

## Alternatives considered

- **Lossy summarization** (LLM or heuristic). Rejected: unrecoverable, and the
  agent can't tell what was dropped.
- **Store originals by random id.** Rejected: no dedup, no integrity check.

## Consequences

The store grows with unique outputs (tiered hot→cold gzip mitigates this). Every
elision is reversible, which is what lets compression run automatically without
the agent losing the ability to read the exact bytes when it needs them.
