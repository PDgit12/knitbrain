# Knit Brain — Full Audit (2026-06-10)

## 0. PRODUCTION COLD-START PROOF — 39/39 PASS (2026-06-10)

`npm run audit:prod` reproduces this anywhere (only Node ≥18 + git required):

1. **Fresh `git clone`** of the committed state into a temp dir (no node_modules).
2. **`npm ci`** clean install.
3. **All 5 gates + full e2e** green in the clone.
4. **`npm pack`** → tarball installed into a brand-new consumer project — exactly what `npm i knitbrain` delivers.
5. **Installed `knitbrain` binary**: full MCP session over stdio — **all 20 tools exercised with assertions** (lossless optimize→retrieve, memory record/search/get/handoff/load, knowledge scan/imports/exports/dependents, classify, metrics, propose/create agent incl. file on disk, team post/board/get/clear).
6. **Installed `knitbrain-proxy` binary** over real HTTP: health ✓, old bulk compressed **on the wire**, user intent reached upstream **verbatim**, response passed through, request smaller than original.
7. **`knitbrain setup`** registers the MCP server in the consumer's `.mcp.json`.

Result: **39 checks · 39 passed · 0 failed.** Notable: the audit itself initially mis-parsed `team_board` output because data tools return *compressed* skeletons in production — i.e., the chokepoint compression is demonstrably active end-to-end in the installed package.

> Scope honesty: "anywhere" = any machine with Node ≥18 + git, no network beyond npm install. The one remaining unproven leg is the proxy against a **live** Anthropic/OpenAI endpoint (opt-in harness ready, needs a real key).

> Honest, evidence-backed assessment of everything built. No overselling — what's verified, what's heuristic, what's not done.

## 1. Snapshot (objective)

| Metric | Value |
|---|---|
| Commits | 14 (rungs 0–13, each gated) |
| Source | 24 files · 2,201 LOC (pure TypeScript) |
| Tests | 17 files · **88 passing + 1 opt-in skipped** |
| Tools | **20** MCP tools |
| Runtime deps | 2 (`@modelcontextprotocol/sdk`, `gpt-tokenizer`) — no Python, no native |
| Gates | typecheck ✅ · lint ✅ · test ✅ · build ✅ · bench ✅ · e2e ✅ |

## 2. What's DONE (verified green)

| Domain | Status | Evidence |
|---|---|---|
| **Tokenizer** | ✅ | gpt-tokenizer o200k_base, swappable interface |
| **Optimizer** | ✅ | JSON (schema-preserve), code (signature-preserve), prose; ContentRouter; **never-expand guard** |
| **CCR** | ✅ | content-addressed, integrity-checked, atomic, **tiered** (hot→cold gzip→purge), lossless round-trip is a release gate |
| **MCP server (Lever A)** | ✅ | 20 tools, dispatch chokepoint (data→compress, governance→verbatim) |
| **Proxy (Lever B)** | ✅ core | request compression, rolling window, intent-vs-payload split, provider auto-detect, SSE passthrough |
| **Memory** | ✅ | per-project learnings (record/search/get, dedup) + handoff save/load |
| **Knowledge** | ✅ | import/export graph + dependents, per-project cache |
| **Workflow** | ✅ | deterministic tier classifier (inquiry/trivial/standard/complex) |
| **create_agent** | ✅ | auto-detect domains + 4 guardrails (scope/tools/review-gate/budget) |
| **TOIN feedback** | ✅ | per-kind retrieval-rate, self-tuning back-off, metrics tool |
| **Teams** | ✅ local | shared compressed-context board (post/board/get/clear) |
| **setup CLI** | ✅ | platform detect + project .mcp.json + proxy env |

## 3. Measured savings (real numbers, honest framing)

- **Synthetic bench (favorable, homogeneous):** total 15,444 → 815 tokens (**94.7%**), all lossless. Best case.
- **Real files (mixed, via built artifact):** 106,268 → 43,623 tokens (**59%**), every file lossless + never-expanded. The realistic figure.
- Declaration-only files correctly **pass through at 0%** (never larger).

> The headline number is workload-dependent. 59% on real mixed files is the honest expectation; 90%+ only on highly redundant payloads.

## 4. Invariants held (structurally enforced)

- **Lossless** — every compressed payload recovers byte-for-byte from CCR (gated test; build goes red otherwise).
- **Never-expand** — output tokens ≤ input tokens, always (router guard + e2e per-file assertion).
- **Integrity** — every CCR read re-verifies the SHA-256.
- **Governance verbatim** — classify_task / get_workflow / protocol never skeletonized.
- **Local-first** — zero cloud; proxy binds 127.0.0.1; no telemetry leaves the machine.

## 5. Honest gaps / NOT done / risk

| Gap | Severity | Note |
|---|---|---|
| Proxy never run against a **live** Anthropic/OpenAI endpoint | medium | opt-in harness exists (`KNITBRAIN_LIVE_TEST` + key); forwarding verified only against a fake upstream |
| Code compressor is a **heuristic brace scanner**, not a real AST | low | edge cases possible; **lossless-safe via CCR** so never incorrect, only sub-optimal |
| Knowledge graph is **regex-based** (no tree-sitter) | low | misses some dynamic/re-export edges; dependents resolution best-effort |
| `create_agent` writes Claude Code subagent format **unverified against a live host** | low | format assumption; not loaded/run by an actual platform yet |
| Teams = **local board only**; networked multi-user hub NOT built | by design | deferred decision (build on top later) |
| `setup` writes project `.mcp.json` + prints env, but **doesn't verify the host picks it up** | low | conservative on purpose (no global config clobber) |
| Memory search is **BM25-lite** (keyword overlap), not full BM25 | low | adequate for headlines; can upgrade |
| No **coverage %** enforced | low | tests pass; coverage not measured/gated |
| No **LICENSE** file; package.json metadata thin (`private:true`) | ship-blocker | required before any publish |
| **Not published** to GitHub/npm | by design | local-only until explicit OK |

## 6. Production-readiness verdict

**Usable and verified locally — NOT yet a published product.**

- The engine, MCP server, memory, knowledge, workflow, agents, local teams, and proxy core are all tested, green, and work end-to-end on real input.
- Before a public release: (a) run the live-endpoint verification with a real key, (b) add LICENSE + package.json metadata + README polish, (c) optionally upgrade the heuristic code/knowledge parsers to AST, (d) verify `create_agent` output in a live host.

## 7. Remaining roadmap (post-audit)

1. Live-endpoint verification (proxy ↔ real API) + OpenAI-shape edge cases.
2. Pre-publish: LICENSE, package.json metadata, README polish, coverage gate.
3. Optional accuracy upgrades: tree-sitter AST for code + knowledge.
4. Networked team hub (multi-user shared sessions) on top of the local board.
5. Ship: GitHub repo + npm publish (only with explicit owner OK).
