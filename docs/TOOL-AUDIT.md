# knitbrain — 37-Tool Deep Audit

> Architectural audit: every MCP tool, what it *mechanically* does (real source, file:line),
> the data it touches, an honest **DEFENSIBLE vs COMMODITY** verdict (can a plain `.md`/`CLAUDE.md`
> approximate it?), and how everything interconnects. No sycophancy — commodity tools are named as such.
>
> Source of truth: `src/mcp/tools.ts` (TOOLS array) + `src/engine/*`. Verdicts cite code.

## Verdict legend
- **DEFENSIBLE** — real systems work; a static document cannot reproduce it (derived/live/computed/self-correcting).
- **COMMODITY** — a hand-maintained `.md` approximates it; storage/lookup only.
- Many tools are *thin wrappers over a defensible substrate* — the wrapper is trivial, the graph/store beneath is not.

---

## Subsystem checklist (37 tools)

```
ORCHESTRATION / ADHERENCE (5)   [x] run  [x] classify_task  [x] self_check  [x] record_false_positive  [x] context_meter
SESSION / HANDOFF (3)           [x] load_session  [x] save_handoff  [x] ping
OPTIMIZATION (4)                [x] optimize  [x] retrieve  [x] read  [x] metrics
RETRIEVAL / GRAPH (5)           [x] search_code  [x] query_imports  [x] query_exports  [x] query_dependents  [x] scan
BRAIN — memory/learnings (6)    [x] brain_search  [x] record_learning  [x] get_learning  [x] search_learnings  [x] learning_outcome  [x] verify_claim
BRAIN — wiki (3)                [x] wiki_ingest  [x] wiki_query  [x] wiki_lint
SKILLS + LOOP (5)               [x] compose_skill  [x] skill_save  [x] skill_outcome  [x] run_loop  [x] onboard
AGENTS / TEAM (6)               [x] propose_agents  [x] create_agent  [x] team_post  [x] team_get  [x] team_board  [x] team_clear
```
All 37 audited. Verdict tally: **~24 DEFENSIBLE · ~8 partly-commodity · ~5 COMMODITY** (detail per tool + thesis at the end).

---

## RETRIEVAL / GRAPH (5) — the defensible core

### knitbrain_search_code
- **Source:** handler `src/mcp/tools.ts:399`; backing `searchCode` `src/engine/retrieval.ts:145` (scoring `scoreChunk:115`, chunking `chunkSource:79`).
- **Does:** tokenize query → `knowledge.scan()` (self-heal) → for each graph file, split into decl-level chunks (regex matchers, 8 language families), score each: name-subtoken +3, signature +2, body term-freq with BM25 saturation `tf/(tf+1.2)` × term-coverage `matched/terms`, + bounded recency boost (<7d). Adaptive gate `floor = max(topScore*0.35, 0.75)`; top-k (default 8).
- **Stores/data:** in-memory graph file list (graph.json cache) + live `readFileSync` of each source; index rebuilt per call, no persistent write.
- **Why-not-.md:** **DEFENSIBLE** — per-call chunking + BM25-ish ranking + graph-neighbor expansion (`related` = dependents+imports of the hit) + adaptive floor. No static file approximates ranked function-level retrieval over live source.
- **Wires-to:** consumes `knowledge`; feeds `brain_search`; directive → `knitbrain_read` only the hits.

### knitbrain_query_imports
- **Source:** handler `src/mcp/tools.ts:427`; backing `knowledge.queryImports` `src/engine/knowledge.ts:347`.
- **Does:** `ensure()` (lazy scan if empty) → `graph.get(norm(file))?.imports`. Imports parsed at scan by `parseImports` (knowledge.ts:58), per-language regex after comment-strip.
- **Stores/data:** in-memory `graph` Map + `graph.json`.
- **Why-not-.md:** **DEFENSIBLE** (thin wrapper, defensible substrate) — a hand-written imports list rots on the next edit; this regenerates from source via `scan`.
- **Wires-to:** built by `scan`; consumed by `search_code`, `brain_search`, `verify_claim`.

### knitbrain_query_exports
- **Source:** handler `src/mcp/tools.ts:439`; backing `knowledge.queryExports` `src/engine/knowledge.ts:351`.
- **Does:** `ensure()` → `graph.get(norm(file))?.exports`. `parseExports` (knowledge.ts:137): JS decl/list/default; Go/Ruby capitalization; Rust `pub`; Java visibility; Python top-level def/class.
- **Stores/data:** in-memory graph + graph.json.
- **Why-not-.md:** **DEFENSIBLE** (same basis as imports) — regenerated per-language symbol list, never stale.
- **Wires-to:** `verify_claim` (exports clause), `brain_search` neighbor scoring.

### knitbrain_query_dependents
- **Source:** handler `src/mcp/tools.ts:451`; backing `knowledge.queryDependents` `src/engine/knowledge.ts:359`.
- **Does:** `ensure()` → `[...dependents.get(norm(file))]`. Reverse adjacency index built once (`buildReverseIndex` knowledge.ts:235) by resolving every import edge (`resolveEdge` knowledge.ts:274 — relative-path + longest-suffix module match per language). O(1) lookup.
- **Stores/data:** in-memory `dependents` Map (derived), graph.json.
- **Why-not-.md:** **DEFENSIBLE** — computed blast radius across 7 languages; "who imports X, kept correct" is not something a `.md` can compute. The genuinely non-commodity graph query.
- **Wires-to:** `verify_claim`, `search_code` related, `brain_search`.

### knitbrain_scan
- **Source:** handler `src/mcp/tools.ts:418`; backing `doScan` `src/engine/knowledge.ts:217`.
- **Does:** `walk` project (skips node_modules/.git/dist/build + dotfiles), read each `SOURCE_EXT` file, strip comments, parse imports+exports per language, rebuild forward graph + reverse `dependents`, atomically write `graph.json`. Returns `{files}`.
- **Stores/data:** writes `graph.json`; rebuilds both Maps.
- **Why-not-.md:** **DEFENSIBLE** — the indexer itself; the build step producing the graph everything queries.
- **Wires-to:** upstream of ALL query_* / search_code / verify_claim / brain_search; `search_code` calls it every run; `load_session` relies on lazy self-heal.

---

## BRAIN — memory / learnings (6)

### knitbrain_brain_search
- **Source:** handler `src/mcp/tools.ts:889`; backing `createBrain(...).read` `src/engine/brain.ts:57` (facade `brainOf` tools.ts:108).
- **Does:** fan one query across 4 typed stores — memory (BM25 `searchLearnings`), wiki (token overlap over title+body of every page), knowledge (query-token → file-path match, scored `1+dependents`), skills (best `find`). Then **per-store max-normalize to [0,1]** (brain.ts:98) → merge → sort → slice.
- **Stores/data:** reads memory, wiki, graph, skills; no writes.
- **Why-not-.md:** **DEFENSIBLE** — cross-store fan-out + rank fusion (normalizing BM25 vs overlap-count vs graph-degree onto one scale). A `.md` can't query four live indexes and rank-fuse.
- **Wires-to:** unifies `search_learnings` + `wiki_query` + `query_*`; directs to typed drill-down tools.

### knitbrain_record_learning
- **Source:** handler `src/mcp/tools.ts:278`; `brainOf.write` → `brain.ts:106` → `memory.recordLearning` `src/engine/memory.ts:95`.
- **Does:** trim summary, **dedup by bidirectional substring** on existing summaries (memory.ts:99), else hash `summary+Date.now()` → 12-char id, store `{date,summary,lesson,tags,helpful:0,unhelpful:0}`, persist; on non-dup drop a wiki spine line. summary/lesson pass through `terseStore` (compression, default off).
- **Stores/data:** `learnings.json` (append), wiki `log.md`.
- **Why-not-.md:** **COMMODITY (mostly)** — plain-text append + substring dedup is what a NOTES.md does by hand. Differentiators are marginal (the helpful/unhelpful fields, only meaningful via `learning_outcome`; auto spine line). Storage itself is commodity.
- **Wires-to:** read back by `learning_outcome`/`search_learnings`/`get_learning`; surfaced by `load_session`; **adherence-gated** by classify/run.

### knitbrain_get_learning
- **Source:** handler `src/mcp/tools.ts:302`; backing `memory.getLearning` `src/engine/memory.ts:144`.
- **Does:** `load().find(l => l.id === id)` → full record (incl. folded corrections) or not-found.
- **Stores/data:** reads `learnings.json`.
- **Why-not-.md:** **COMMODITY** — id lookup; equivalent to grepping a heading in notes.md.
- **Wires-to:** drill-down after `search_learnings` / `brain_search`.

### knitbrain_search_learnings
- **Source:** handler `src/mcp/tools.ts:294`; backing `memory.searchLearnings` `src/engine/memory.ts:121`.
- **Does:** tokenize; score summary/tag +2, lesson +1; filter `score>0`; **re-order by `score + helpful − 2·unhelpful`** (memory.ts:139) so proven rise, discredited sink. Term match gates relevance; outcome only re-ranks.
- **Stores/data:** reads `learnings.json`.
- **Why-not-.md:** **COMMODITY-leaning DEFENSIBLE** — keyword scoring is basic (grep approximates recall); the **outcome-weighted re-ranking** (proven up / discredited down) is a real feedback mechanism a static `.md` can't do.
- **Wires-to:** feeds `brain_search` memory leg; pairs with `get_learning`; ranking driven by `learning_outcome`.

### knitbrain_learning_outcome
- **Source:** handler `src/mcp/tools.ts:329`; backing `memory.learningOutcome` `src/engine/memory.ts:148`; health `learningHealth` `memory.ts:35`.
- **Does:** increment `helpful`/`unhelpful`; if unhelpful + note, **fold the correction into the lesson** (`- correction (date): …` memory.ts:157) so future recall carries the fix; persist. Health = discredited (`unhelpful≥2 && unhelpful>helpful`) / proven (`helpful≥2`) / unproven.
- **Stores/data:** mutates + persists `learnings.json`.
- **Why-not-.md:** **DEFENSIBLE** — the compounding-feedback loop; turns a static log into a self-correcting store; drives ranking everywhere. The one genuinely non-commodity piece of the memory subsystem.
- **Wires-to:** re-ranks `search_learnings`, `brain_search`, `load_session` ordering.

### knitbrain_verify_claim
- **Source:** handler `src/mcp/tools.ts:864`; backing `verifyClaim` `src/mcp/tools.ts:1202`.
- **Does:** regex-parse claim into 3 shapes, settle against the **graph, not assertion**: "A imports B" → A's import edges OR `dependents(B) ∋ A` (tolerates relative→file mismatch); "A exports B" → A's exports; "A depends on B" → `dependents(B) ∋ A`. `hit()` tolerates JS-ext swaps. Returns verified | contradicted | unparseable + actual edges.
- **Stores/data:** reads graph only.
- **Why-not-.md:** **DEFENSIBLE** — anti-hallucination adjudication; settles a stated fact by graph traversal, returns real edge list on contradiction. Output `verbatim` (never skeletonized). No document can adjudicate a claim.
- **Wires-to:** consumes graph; LEARN-gate anti-hallucination step; complements `self_check`.

---

## BRAIN — wiki (3)

### knitbrain_wiki_ingest
- **Source:** handler `src/mcp/tools.ts:829`; backing `wiki.ingest` `src/engine/wiki.ts:240`.
- **Does:** slugify title, write frontmatter'd `pages/<slug>.md`, **stub any linked page that doesn't exist** (wiki.ts:249), rebuild `index.md` from all frontmatter, append `log.md`, then `runResolve()` auto-heal: newest page (mtime) wins a contradicted `claim: key=value`; older holders rewritten to `superseded@date` (value preserved → recoverable, wiki.ts:198).
- **Stores/data:** writes `pages/<slug>.md`, `index.md`, `log.md`.
- **Why-not-.md:** **COMMODITY-leaning DEFENSIBLE** — it *is* markdown files (a human-maintained wiki/ approximates content). The **auto-stub cross-refs + index rebuild + mtime-based claim supersession** are self-maintenance a static `.md` can't perform.
- **Wires-to:** `wiki_query`/`wiki_lint`/`resolve`; `brain_search` wiki leg; `load_session` recent log; spine sink for `record_learning`/`save_handoff`.

### knitbrain_wiki_query
- **Source:** handler `src/mcp/tools.ts:848`; backing `wiki.index` `src/engine/wiki.ts:285` + `recentLog` `wiki.ts:268`.
- **Does:** return `index.md` catalog + last 10 `## [` log lines. No search/ranking — a catalog dump to drill via `knitbrain_read`.
- **Stores/data:** reads `index.md`, `log.md`.
- **Why-not-.md:** **COMMODITY** — literally returns two markdown files; `cat index.md; tail log.md` is exact-equivalent.
- **Wires-to:** reads what `wiki_ingest` maintains.

### knitbrain_wiki_lint
- **Source:** handler `src/mcp/tools.ts:858`; backing `wiki.lint` `src/engine/wiki.ts:289`.
- **Does:** parse every page's `- claim: key = value`; flag **contradictions** (same key, >1 value, with holder slugs) and **orphans** (unlinked pages). Read-only report (auto-fix is `resolve`, run by ingest/load_session).
- **Stores/data:** reads all `pages/*.md`.
- **Why-not-.md:** **DEFENSIBLE (modestly)** — mechanical cross-page contradiction + orphan detection; genuine linting, not commodity storage (value bounded by authors writing `claim:` lines).
- **Wires-to:** shares claim/link parsing with `resolve`; operates on `wiki_ingest` output.

---

## Cross-cutting notes — graph, brain, anti-hallucination

**Graph build + anti-stale.** `createKnowledge` (knowledge.ts:182) owns the graph. On load it reads `graph.json` and **ghost-prunes** nodes whose file no longer exists (knowledge.ts:197). `doScan` walks source, strips comments, regex-parses imports/exports per 7 languages, builds a **reverse adjacency index** (`resolveEdge` longest-suffix match) → `queryDependents` O(1). Freshness enforced 3 ways: (1) lazy `ensure()` self-scans an empty graph; (2) `search_code` calls `scan()` every run (retrieval.ts:153); (3) explicit `knitbrain_scan`. Retrieval chunk index rebuilt per call.

**brain_search fan-out (brain.ts).** Facade owns no storage; fans across memory (BM25), wiki (token overlap), knowledge (token→path, scored `1+dependents`), skills (best). Scores live on incompatible scales → **per-source max-normalize to [0,1]** (brain.ts:98) before merge — real rank fusion. Writes route to the typed store + one spine line (no double-log, brain.ts:117).

**verify_claim anti-hallucination (tools.ts:1202).** Stated fact → regex shape → adjudicated by graph traversal, returns `verified|contradicted|unparseable` + actual edges. Robustness trick: "A imports B" checked both as A's outgoing edges AND `A ∈ dependents(B)`, so a natural file-path claim still verifies though the raw specifier differed. Output `verbatim` — it's a governance check.

**Honest tier verdict.** Retrieval/graph tier = **defensible** (live multi-language graph, reverse index, BM25 ranking, rank fusion). Memory/wiki tier = **partly commodity**: raw storage/lookup is what a hand-maintained learnings.md / wiki folder does; what lifts them is the **feedback + self-maintenance machinery** — `learning_outcome`'s discredit/demote re-ranking and the wiki's mtime claim-supersession + auto-stub + lint. A static `.md` cannot perform those on itself.

---

## ORCHESTRATION / ADHERENCE (5)

Every tool result flows through one `dispatch()` chokepoint (`tools.ts:1291`): `protectGate` (adherence) → `tool.run` → `capture` (compress+meter) → meter advisory appended (except exact-output tools). Post-run it sets session flags: CLASSIFIERS→`classified`, verify_claim→`verified`, record_learning→`learned` (`tools.ts:1306`).

### knitbrain_run
- **Source:** `tools.ts:578`; backing `classifyTask` (workflow.ts:32), `scanHost`, `proposeAgents`, `writeAgent`, `skills.find/draft`, `team.post`, `loadWorkflow`, `meter.read`.
- **Does:** classify task (with self-calibrating `scopeAdjust`) → scan `.claude` host dir → find-or-draft SKILL (with `project-constraints` guardrails) → on `tier==="complex"` **writes up to 4 pre-briefed agent `.md` files** to `.claude/agents/` (deduped vs existing host agents), posts each to team board + hub → lists host slash-commands → returns `{classification, skill, agents, workflow_routing, meter, directive}` (PLAN_GATE prefix when complex).
- **Stores/data:** calibration, skills, memory, knowledge, team board, hub, workflow file, meter; **writes real agent files**.
- **Why-not-.md:** **DEFENSIBLE** — real side effects a doc can't: deterministic tier classification, generating guardrailed agent files, posting to a cross-process board, reading the live token meter, deduping vs the user's toolkit. Marks session `classified` (opens the write-gate).
- **Wires-to:** classify_task, calibration, skills, team/hub, knowledge, meter, workflow/onboard, host-scan.

### knitbrain_classify_task
- **Source:** `tools.ts:471`; backing `classifyTask` (workflow.ts:32).
- **Does:** `fileCount` + regex intent tests → tier ∈ {inquiry,trivial,standard,complex} + phases + `autoPlanMode`. Complex threshold `max(2, 4+scopeAdjust)` (calibrated). Appends imperative `directive` (PLAN_GATE when autoPlanMode).
- **Stores/data:** reads `calibration.scopeAdjust`; else pure. Marks session `classified`.
- **Why-not-.md:** **DEFENSIBLE (thin)** — the regex heuristic itself is simple (a prose rubric approximates the *decision*), but it's a **stateful adherence gate** + self-calibrating threshold, which a `.md` can't hold.
- **Wires-to:** calibration (in/out), run (same fn), protectGate.

### knitbrain_self_check
- **Source:** `tools.ts:1166`; backing `runSelfCheck` (self-check.ts:52, pure aggregator over real detectors).
- **Does:** re-scans graph (the re-scan IS the anti-stale heal) → lints wiki + Gap-E `resolve()` → checks stored workflow exists (anti-drift) → reads session `classified/learned/verified` (adherence + anti-sycophancy) → context-hygiene + ROUTING-stale domains. Returns PASS/FAIL table + `fixesApplied` + `residualGaps`.
- **Stores/data:** knowledge, wiki, workflow, session WeakMap, host scan.
- **Why-not-.md:** **DEFENSIBLE** — it *executes and auto-heals* (graph scan, wiki supersession, live adherence flags). A markdown checklist is inert.
- **Wires-to:** knowledge, wiki, workflow, verify_claim + record_learning (flags it audits).

### knitbrain_record_false_positive
- **Source:** `tools.ts:497`; backing `calibration.recordFalsePositive` (calibration.ts:79).
- **Does:** record claimed-vs-actual tier; at **3 same-direction votes** shift `scopeAdjust` ±1 (clamp ±2), reset counter; 30-day decay ages incomplete runs but keeps learned adjust. Atomic-write `calibration.json`, re-read before each op.
- **Stores/data:** `calibration.json`, wiki log.
- **Why-not-.md:** **DEFENSIBLE** — deterministic stateful vote counter with threshold/clamp/decay/cross-process re-read; mutates the classifier's numeric threshold. A `.md` can't accumulate votes.
- **Wires-to:** calibration → classify_task/run.

### knitbrain_context_meter
- **Source:** `tools.ts:387`; backing `meter.read` (meter.ts:172).
- **Does:** compute usedTokens (max of proxy-optimized request + tool tokens vs a realUsage probe + baseline), auto-heal stale window (WINDOW_TIERS/`modelWindow`), derive usedPct, ok/warn/handoff status, cache-cold signal (5-min TTL), `optimizationPct = saved/(used+saved)`.
- **Stores/data:** `meter.json` (cross-process, reload every op), env `KNITBRAIN_WINDOW_TOKENS`.
- **Why-not-.md:** **DEFENSIBLE** — live token accounting (o200k tokenizer) over multi-process shared state; all computed numbers.
- **Wires-to:** optimize/read/retrieve (feed savings), dispatch (advisory), load_session (reset), proxy.

## SESSION / HANDOFF (3)

### knitbrain_load_session
- **Source:** `tools.ts:359`; backing `memory.loadSession` (memory.ts:173), `wiki.resolve/recentLog`, `loadWorkflow`.
- **Does:** `meter.reset()` (fresh window, savings kept) → wiki `resolve()` auto-heal → load handoff + top learnings (most-proven-first; stale/aged handoff auto-cleared) → last 8 wiki-log entries + standing workflow.
- **Stores/data:** meter.json reset, handoff.json, learnings, wiki, workflow.
- **Why-not-.md:** **DEFENSIBLE** — mutates state (meter reset, wiki resolve, age-based auto-clear) and ranks learnings by proven outcome. A `.md` read can't do those.
- **Wires-to:** save_handoff (producer), meter, wiki, learning_outcome (ranking), workflow.

### knitbrain_save_handoff
- **Source:** `tools.ts:348`; backing `memory.saveHandoff` (memory.ts:167).
- **Does:** atomically write `{state, savedAt: ISO}` to `handoff.json` + wiki log. Timestamp drives loadSession staleness/auto-clear.
- **Stores/data:** handoff.json (atomic), wiki log. **GATED_WRITE** (blocked unless classified).
- **Why-not-.md:** **COMMODITY (partial)** — core is "persist a text blob"; a human could paste into a `.md`. Only the timestamp-staleness contract + write-gate lift it. Payload is unparsed text.
- **Wires-to:** load_session (consumer), wiki, protectGate.

### knitbrain_ping
- **Source:** `tools.ts:197`. Returns `pong · knitbrain v${VERSION}`. No state.
- **Why-not-.md:** **COMMODITY** — liveness/version echo. Zero logic; its only non-`.md` value is proving the transport is live + reporting the *running build's* version.
- **Wires-to:** none (health check).

## OPTIMIZATION (4) — the lossless core

### knitbrain_optimize
- **Source:** `tools.ts:210`; backing `compress` (router.ts:147).
- **Does:** `compress(text, ccr)` → if worth it, record TOIN `onCompress`, credit `meter.onSaved`, return `skeleton + [optimized: N→M · saved X% · ⟨recall:…⟩]`; else return text unchanged (**never-expand guard**, router.ts:231).
- **Stores/data:** CCRStore (`put` byte-exact, keyed by SHA-256), feedback.json, meter.json.
- **Why-not-.md:** **DEFENSIBLE** — real compression: content-type detection, tree-sitter AST / brace-scan skeletonizing, anchor-elision fallback, declaration rescue, o200k measurement, lossless CCR storage. No `.md` compresses with byte-exact recovery.
- **Wires-to:** retrieve (inverse), CCR, feedback (TOIN), meter, read (same path), dispatch `capture`.

### knitbrain_retrieve
- **Source:** `tools.ts:229`; backing `ccr.get` (store.ts:178), `normalizeHandle` (tools.ts:134).
- **Does:** strip `⟨⟩`/`recall:`/`ccr:` → `ccr.get` returns exact original from hot(raw)/cold(gunzip), **verifying `sha256(data)===handle`** (throws CCRIntegrityError on mismatch). Records `feedback.onRetrieve` (skeleton-insufficient vote). Never gated, never gets meter advisory (EXACT_OUTPUT).
- **Stores/data:** CCR hot (`root/<hash>`) + cold (`cold/<hash>.gz`) + manifest.json; feedback.json.
- **Why-not-.md:** **DEFENSIBLE** — content-addressed byte-exact recovery with integrity verification + hot/cold tiering. The losslessness guarantee IS the product.
- **Wires-to:** optimize/read/capture (produce handles), feedback TOIN, CCR maintain.

### knitbrain_read
- **Source:** `tools.ts:249`; backing `readFileSync` + `compress`.
- **Does:** resolve path → read → `compress`; return skeleton + `⟨recall:hash⟩` if compressed, else exact content. Small/incompressible pass through verbatim.
- **Stores/data:** fs read, CCR put, feedback, meter.
- **Why-not-.md:** **DEFENSIBLE** — `optimize` applied to file contents on the fly (AST/anchor engine + tokenizer). A `.md` is static, not an on-demand compressor.
- **Wires-to:** compress/CCR/feedback/meter + retrieve; complements search_code (search → read only hits).

### knitbrain_metrics
- **Source:** `tools.ts:511`.
- **Does:** `{ ccr: ccr.stats(), feedback: feedback.stats(), calibration: calibration.get() }` — hot/cold counts, per-kind TOIN rates, classifier calibration.
- **Stores/data:** reads CCR manifest+dirs, feedback.json, calibration.json (read-only).
- **Why-not-.md:** **DEFENSIBLE** — live telemetry computed off three real stores.
- **Wires-to:** read side of optimize/retrieve/false_positive.

---

## SKILLS + LOOP (5)

### knitbrain_compose_skill
- **Source:** `tools.ts:689`; backing `composeSkill` (host-scan.ts:317), `SkillsStore.draft/save` (skills.ts:100,125).
- **Does:** seed lessons (arg or `memory.searchLearnings(task,3)`) → infer `.claude` style → draft telegraphic skeleton; if `style.terse && body > 1.5×medianBodyLen`, truncate to median with honest elision marker; persist.
- **Stores/data:** skills.json; wiki log.
- **Why-not-.md:** **MOSTLY COMMODITY** — the drafted body is a static template a user could hand-write. Defensible-lite: style inference (median-len + bullet-ratio + header histogram) + auto-seed from mined memory.
- **Wires-to:** memory, host-scan, skills store, wiki.

### knitbrain_skill_save
- **Source:** `tools.ts:714`; backing `SkillsStore.save` (skills.ts:125).
- **Does:** upsert by name — existing → merge body/triggers/constraints (Set dedup) + bump `updatedAt`; new → sha256-sliced id + `uses/wins/losses=0`. Body via `terseStore()`.
- **Stores/data:** skills.json; wiki log.
- **Why-not-.md:** **DEFENSIBLE** — keyed upsert store with trigger-keyword matching, outcome counters, forward-migration; not a flat file. Compounding-across-tasks semantics.
- **Wires-to:** skills store (find/outcome/health), run (serves saved skills), agents (constraints).

### knitbrain_skill_outcome
- **Source:** `tools.ts:737`; backing `SkillsStore.outcome` (skills.ts:153), `skillHealth` (skills.ts:33).
- **Does:** increment wins/losses; on failure+note, append dated `- pitfall (...)` to body (dedup). Health: <2 = unproven; `losses≥2 && winRate<0.5` = needs-revision; else working.
- **Stores/data:** skills.json.
- **Why-not-.md:** **DEFENSIBLE** — the ADJUSTMENT signal; `needs-revision` actively changes what `run` re-serves (tools.ts:565). Folding failures into pitfalls is stateful learning.
- **Wires-to:** run (health gates re-serving), skills store.

### knitbrain_run_loop
- **Source:** `tools.ts:1052`; backing `runClosedLoop`/`defaultJudge`/`makeGrade`/`makeReview` (closed-loop.ts:50,80,92,104); `LoopState` (tools.ts:78), `loopStatePath` (paths.ts:77).
- **Does:** ONE cycle per call. Load `LoopState{goal,iter,startedAt}`; same-goal reuses both, new goal resets. Two caps at cycle START: `priorIters>=maxIters` → stop `max-iters`; `deadline_ms` set and `now-startedAt >= deadlineMs` → stop `deadline`. Else `runClosedLoop(...,1)`: `grade=makeGrade(verifyCmd, execSync-exit0)`, `iterate` = **deliberate NO-OP**, review advisory. `met` requires `graded.pass && reviewed.met`. Persist iter+startedAt; return per-cycle directive.
- **Stores/data:** `loop-state.json`; wiki log; runs `verify_cmd` via `execSync{stdio:ignore}`.
- **Why-not-.md:** **DEFENSIBLE** — executes a REAL verify gate (execSync exit code) + holds cross-call iteration + wall-clock deadline. A high review on a failing verify is never accepted (closed-loop.ts:63). A `.md` can't execute or hold state.
- **Wires-to:** closed-loop engine, meter, wiki, loopStatePath. **Distinct from CLI outer loop** (`src/loop.ts`).

### knitbrain_onboard
- **Source:** `tools.ts:893`; backing `src/engine/onboard.ts` (scanAndIngest, persistIntent, computeOnboardGaps, composeWorkflow), `scanHostAll` (host-scan.ts:402).
- **Does:** 3-phase — (no args) scan repo into graph + import transcripts to wiki + return 5 intent questions; (`create[]`) recompute gaps, resolve approved (composeSkill/writeAgent), rescan + rebuild host index; (`answers[]`) `persistIntent` writes Project Charter wiki page + intent learning + `project-constraints` skill, `composeWorkflow` builds standing driver (charter+style+domains+routing) → save, write loop-ready `goal.md` if none.
- **Stores/data:** knowledge, wiki, memory, skills.json, host-index, workflow.md, goal.md.
- **Why-not-.md:** **DEFENSIBLE** — transcript mining + charter→workflow→goal.md composition + code-graph gap detection (detected domains vs deduped toolkit). Output artifacts are markdown; their derivation isn't.
- **Wires-to:** knowledge, wiki, memory, skills, host-scan, agents, load_session (re-surfaces workflow), run_loop/CLI loop (consume goal.md).

## AGENTS / TEAM (6)

> **Do these SPAWN agents at runtime? NO — they PROPOSE + COORDINATE; the host spawns.** `run_loop.iterate` is an explicit no-op (`tools.ts:1097`); `propose_agents` returns pure data; `create_agent` writes a `.claude/agents/*.md` *definition* (no process). The only real subprocess spawn is the CLI outer loop `src/loop.ts:76` (`spawnSync(claude -p ...)`), NOT any MCP tool.

### knitbrain_propose_agents
- **Source:** `tools.ts:519`; backing `proposeAgents` (agents.ts:49). Pure read.
- **Does:** group `knowledge.listFiles()` by dir; each dir ≥2 files → `DomainProposal` with 4 guardrails: scope glob `<dir>/**`, tool allowlist (read-only `[Read,Grep,Glob]` if dir matches SENSITIVE regex `auth|security|secret|payment|billing|crypto|db|database|migration|schema`, else +Edit/Write), `reviewGate=SENSITIVE.test(dir)`, `contextBudget=8000`.
- **Stores/data:** reads knowledge graph only.
- **Why-not-.md:** **DEFENSIBLE** — derives proposals from the live file tree + auto-flags sensitive dirs for a review gate. A static list can't auto-detect domains.
- **Wires-to:** knowledge; consumed by run (complex, deduped), onboard, create_agent.

### knitbrain_create_agent
- **Source:** `tools.ts:526`; backing `writeAgent` (agents.ts:113), `generateAgentMarkdown` (agents.ts:79).
- **Does:** infer host style, write `.claude/agents/<safe-name>.md`; slugify name (`[^a-z0-9_-]→-`, **path-escape safe**), render 4 guardrails into body + style-matched `model:`/`triggers:` frontmatter + optional brief; post to board, wiki-log, hub mirror.
- **Stores/data:** agent .md (atomic), team board, wiki, hub.
- **Why-not-.md:** **PARTLY COMMODITY** — the artifact is a hand-writable instruction file. Defensible layer: safe-slug sanitization, style-matched frontmatter, auto-injected SENSITIVE review-gate guardrail.
- **Wires-to:** host-scan, team board, wiki, hub, propose_agents.

### knitbrain_team_post
- **Source:** `tools.ts:759`; backing `TeamBoard.post` (teams.ts:53).
- **Does:** validate author+content → `compress(content,ccr)` → store pristine original in CCR (handle), keep skeleton as `summary`; id = sha256(...).slice(8); append `board.json`; wiki-log; hub mirror.
- **Stores/data:** board.json, CCR, wiki, hub.
- **Why-not-.md:** **DEFENSIBLE** — compressed shared-context board so N parallel agents post skeletons (context cost doesn't multiply), full original one CCR lookup away.
- **Wires-to:** CCR, wiki, hub, team_board/get/clear.

### knitbrain_team_get
- **Source:** `tools.ts:793`; backing `TeamBoard.get` (teams.ts:70).
- **Does:** find entry by id → `ccr.get(entry.handle)` byte-for-byte original.
- **Stores/data:** board.json + CCR.
- **Why-not-.md:** **DEFENSIBLE** — recall path for the compressed board; exact-original recovery, not a doc op.
- **Wires-to:** CCR, team_post.

### knitbrain_team_board
- **Source:** `tools.ts:786`; backing `TeamBoard.board` (teams.ts:67).
- **Does:** return all entries as JSON (skeleton summaries + handles), `output:"data"`.
- **Why-not-.md:** **DEFENSIBLE (thin)** — entries are skeletons-with-handles (a compression construct); value inseparable from post/get.
- **Wires-to:** board.json, team_get.

### knitbrain_team_clear
- **Source:** `tools.ts:805`; backing `TeamBoard.clear` (teams.ts:75).
- **Does:** `save([])` empties board.json; **CCR originals retained** until tiered out.
- **Why-not-.md:** **COMMODITY** — clearing an array ≈ truncating a file. Only nuance: deliberate non-purge of CCR.
- **Wires-to:** board.json.

---

## Master interconnection map

```
                       ┌────────────────── dispatch() chokepoint (tools.ts:1291) ──────────────────┐
                       │  protectGate (adherence write-gate) → tool.run → capture (compress+meter)  │
                       └───────────────────────────────────────────────────────────────────────────┘
   SESSION            ORCHESTRATION / ADHERENCE            EXECUTION                 BRAIN (stores)
 ┌───────────┐        ┌──────────────────────┐        ┌──────────────┐        ┌────────────────────────┐
 │load_session│──────▶│ run  ── classify_task │        │ run_loop     │        │ memory (learnings.json)│
 │  reset meter│       │  │        │           │        │  verify gate │        │  ↑record ↑outcome      │
 │  wiki.resolve│      │  ├ skill (skills.json)│        │  execSync    │◀──gate─│ knowledge (graph.json) │
 │  top learnings◀─────┼──┤   compose/save/    │        │  deadline_ms │        │  scan→imports/exports/ │
 └─────┬─────┘  proven │  │   outcome (health) │        └──────┬───────┘        │  dependents (reverse)  │
       │        ranking│  ├ agents (propose/   │  spawn (HOST)  │               │ wiki (pages/index/log) │
 ┌─────▼─────┐         │  │  create → .md)     │  ────────────▶ │               │  ingest/query/lint/    │
 │save_handoff│  GATED │  ├ team_post/get/     │               │               │  resolve (mtime heal)  │
 │ (timestamp)│◀───────┤  │  board (CCR-backed)│               │               │ skills (skills.json)   │
 └───────────┘         │  └ self_check ────────┼── audits ────▶ invariants      │ calibration.json       │
                       │     (anti-stale/drift/ │  anti-*        │               └───────────┬────────────┘
 CONTEXT/TOKENS        │      sycophancy/adher.)│               │                 brain_search│ fan+fuse
 ┌───────────────────┐ │  record_false_positive─┼─▶ scopeAdjust ─┘ (calibrates classify)      │
 │ optimize ⇄ retrieve│ │  context_meter ────────┼─▶ usedPct/saved/handoff advice             │
 │  CCR sha256 hot/cold│└────────────────────────┘                                            │
 │  LOSSLESS (verify   │◀──────── team_post/read/capture all store originals here ────────────┘
 │  sha256==handle)    │
 │  read · metrics(TOIN)│
 └───────────────────┘
```

**The one loop that ties it together:** `load_session` (recall proven state) → `run` (classify + skill + agents, opens write-gate) → work under `search_code`/`read`/`optimize` (cheap context) → `run_loop` (verify gate = truth, time/iter bounded) → `record_learning` + `skill_outcome` + `learning_outcome` (write-back, gated by classify) → next `load_session` starts smarter. `self_check` guards the four invariants across the whole cycle; `verify_claim` settles facts against the graph so the write-back isn't hallucinated.

---

## Why it can't be replaced by `.md` files — the honest thesis

**What a `.md`/CLAUDE.md genuinely approximates (COMMODITY — don't oversell):**
- `save_handoff` payload, `get_learning`, `wiki_query`, `team_clear`, `ping` — storage/lookup/echo.
- `record_learning` body, `compose_skill` body, `create_agent` body content — the *text* is hand-writable.

**What no `.md` can do (DEFENSIBLE — the moat):**
1. **Lossless compression + byte-exact recovery** — `optimize/retrieve/read` + CCR (SHA-256 content-addressed, hot/cold tiering, `sha256(data)===handle` integrity or it throws). This is the load-bearing differentiator; proven live (55k+ tok saved, exact roundtrip).
2. **Live multi-language code graph** — `scan/search_code/query_*` with a reverse-dependency index, BM25 chunk ranking, graph-neighbor expansion, ghost-pruning. Regenerated from source; never rots.
3. **Verify-gated loop** — `run_loop` where "done" = a real `execSync` exit 0, bounded by iters AND wall-clock, cross-call state persisted. A doc can state a goal; it can't run the gate.
4. **Self-correcting feedback** — `learning_outcome` (discredit/demote re-ranking), `skill_outcome` (needs-revision changes what `run` serves), `record_false_positive` (shifts the classifier threshold after 3 votes), TOIN (backs off over-compressed kinds). Compounding state a static file lacks.
5. **Adherence + anti-hallucination governance** — the `dispatch` write-gate (no memory write until you classified), `self_check`'s executing invariants (graph re-scan, wiki supersession, live session flags), `verify_claim` adjudicating facts against the graph.

**The real threat isn't markdown — it's the platform** (native memory + caching from the model vendor). The defense is exactly the combination above: **local-first + lossless + verify-gated + any-MCP-agent** — not any single tool. Individually several tools are commodity; the *closed loop over a lossless local substrate* is what a `.md` (or a cloud memory feature) doesn't reproduce.

