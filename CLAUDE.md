<!-- knit:start -->

# knitbrain

typescript project. Knit-powered workflow. The protocol depth is fetched on demand via `knit_get_workflow({phase})` — this file holds only project-specific facts.

---

## Session start

First action: call `knit_load_session`. One MCP call returns last sessions, handoff, learnings, false positives. If `handoff.md` exists at the repo root, resume that work first.

Protocol Guard runs in `warn` mode by default — adjust with `knit_set_protocol_strictness`.

## v0.11 tool surface (in addition to query/search/record)

- **`knit_verify_claim`** — fact-check one claim against the knowledge graph before LEARN. Stop-hook enforces on standard/complex scope.
- **`knit_index_requirements` + `knit_generate_test_cases` + `knit_list_requirements` + `knit_delete_requirements`** — long-form spec / RFC ingestion (200KB doc → relevant 5–7KB chunks per feature query).
- **`knit_get_fingerprint` + `knit_infer_domains` + `knit_compose_template`** — auto-config primitives: detected stack → ranked domains → composed CLAUDE.md sections (preview only; you paste to accept).
- **`knit_get_calibration` + tag your false-positives** (e.g. `#complex-was-trivial`) — the per-project self-healing classifier tunes thresholds after 3 same-direction FPs.
- **`knit_brain_status`** surfaces calibration / requirements / fingerprint state so you can discover all of the above from one health check.

---

## Project Map (auto-generated)

**Entry points:** `dist/lib.js`, `dist/index.js`, `dist/proxy/index.js`, `dist/hooks/index.js`, `src/index.ts`
**High-fanout (change carefully):** `src/ccr/store.ts`, `src/tokenizer.ts`, `src/engine/feedback.ts`, `src/engine/memory.ts`, `src/engine/knowledge.ts` (+22 more — `knit_find_fanout`)
**Untested:** `eslint.config.js`, `scripts/bench.ts`, `scripts/consistency.mjs` (+14 more — `knit_query_tests({filter:"untested"})`)
**Largest:** `src/mcp/tools.ts` (614), `scripts/production-audit.mjs` (345), `src/learn.ts` (328)

**Stats:** 90 files, 11,086 lines (.ts: 82, .mjs: 7, .js: 1)

---

## Domain Architecture

### Core Logic
**Files:** `src/**, lib/**, pkg/**`
**Concern:** Types, models, business rules, calculations, data transformations
**Review agents:** `knit-typescript-pro, knit-code-reviewer, knit-architect-reviewer`

### Infrastructure
**Files:** `prisma/**, drizzle/**, migrations/**`
**Concern:** Database, migrations, Docker, CI/CD, deployment, external integrations
**Review agents:** `code-reviewer, performance-optimizer`

### Quality Assurance
**Files:** `tests/**, __tests__/**, test/**`
**Concern:** Tests, test coverage, build configs, CI/CD pipelines
**Review agents:** `knit-qa-expert, knit-debugger, knit-build-engineer`

---

## Build Gates

All must pass before commit:

- `npm run typecheck`
- `npm run lint`
- `npm test`
- `npm run build`

---

## Tier vocabulary

| Tier | When |
|------|------|
| **Inquiry** | Read-only ("what", "where", "audit") — just answer. |
| **Trivial** | One-line fix — execute → verify. |
| **Standard** | Single-domain bug fix or feature — research → execute → review. |
| **Complex** | Cross-domain, touches types/auth, high-fanout, or multi-commit arc — full 6 phases + auto plan mode. |

---

## Workflow on demand

Fetch any phase via `knit_get_workflow({phase})`. Call with no phase to list available sections.

<!-- knit:end -->
