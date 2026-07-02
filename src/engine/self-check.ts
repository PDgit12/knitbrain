/**
 * Self gap-check (Gap F) — the keystone auditor. Assembles the results of the
 * EXISTING anti-* detectors (graph scan, wiki lint/resolve, stored workflow,
 * session adherence) into ONE invariant pass with a PASS/FAIL table, the
 * auto-fixes that were applied, and the residual gaps a human must close.
 *
 * PURE: it reimplements NO detector — the caller runs the real ones and feeds
 * their results here. That keeps the invariant logic testable and guarantees a
 * single source of truth per detector (no duplicate lint/stale engine).
 */

export interface Invariant {
  name: string;
  pass: boolean;
  detail: string;
  /** True when this invariant was auto-fixed during the check. */
  fixed?: boolean;
}

export interface SelfCheckReport {
  invariants: Invariant[];
  allPass: boolean;
  fixesApplied: string[];
  residualGaps: string[];
}

export interface SelfCheckInput {
  /** Files in the graph after the anti-stale re-scan (the heal). */
  graphFiles: number;
  /** Wiki contradictions before the Gap-E resolve pass. */
  wikiContradictionsBefore: number;
  /** Wiki contradictions after resolve (should be 0 if auto-heal worked). */
  wikiContradictionsAfter: number;
  /** How many stale claims resolve() superseded. */
  wikiResolvedCount: number;
  /** A stored workflow exists (Gap D anti-drift driver). */
  workflowExists: boolean;
  /** A classifier ran this session (adherence write-gate open). */
  classified: boolean;
  /** A learning was recorded this session. */
  learned: boolean;
  /** A verify_claim ran this session (anti-sycophancy fact-gate). */
  verified: boolean;
  /** Host context-hygiene findings (dead rules, archive dirs, duplicate MCPs).
   * Undefined = scan not run (invariant omitted); empty = scanned clean. */
  hygieneFindings?: string[];
}

export function runSelfCheck(x: SelfCheckInput): SelfCheckReport {
  const invariants: Invariant[] = [];
  const fixesApplied: string[] = [];
  const residualGaps: string[] = [];

  // 1. anti-stale (graph): the re-scan IS the heal (knitbrain self-heals on read).
  invariants.push({ name: "anti-stale:graph", pass: true, detail: `graph re-scanned (${x.graphFiles} files)`, fixed: true });
  fixesApplied.push(`graph re-scanned (${x.graphFiles} files)`);

  // 2. anti-stale (wiki): contradictions must be 0; Gap-E resolve auto-heals.
  if (x.wikiContradictionsBefore === 0) {
    invariants.push({ name: "anti-stale:wiki", pass: true, detail: "no wiki contradictions" });
  } else if (x.wikiContradictionsAfter === 0) {
    invariants.push({ name: "anti-stale:wiki", pass: true, detail: `resolved ${x.wikiResolvedCount} stale claim(s); wiki now clean`, fixed: true });
    fixesApplied.push(`wiki auto-heal superseded ${x.wikiResolvedCount} stale claim(s)`);
  } else {
    invariants.push({ name: "anti-stale:wiki", pass: false, detail: `${x.wikiContradictionsAfter} contradiction(s) remain after resolve` });
    residualGaps.push("wiki contradictions unresolved — inspect knitbrain_wiki_lint");
  }

  // 3. anti-drift: a stored workflow must exist (Gap D). Not auto-fixable — needs
  // the onboard charter — so an absent one is a residual gap, not a silent heal.
  if (x.workflowExists) {
    invariants.push({ name: "anti-drift:workflow", pass: true, detail: "workflow stored + surfaced by load_session" });
  } else {
    invariants.push({ name: "anti-drift:workflow", pass: false, detail: "no stored workflow — run knitbrain_onboard with answers" });
    residualGaps.push("no workflow driver — onboard to compose one (anti-drift)");
  }

  // 4. anti-sycophancy: a learning this session with NO verify_claim behind it is
  // unverified "done". Fact-gate, not a flattery detector.
  if (!x.learned || x.verified) {
    invariants.push({ name: "anti-sycophancy:verified", pass: true, detail: x.learned ? "a verify_claim backed this session's learnings" : "no learnings recorded yet" });
  } else {
    invariants.push({ name: "anti-sycophancy:verified", pass: false, detail: "learnings recorded with NO verify_claim this session — unverified 'done'" });
    residualGaps.push("call knitbrain_verify_claim before recording learnings (anti-sycophancy)");
  }

  // 5. adherence: did a classifier run (write-gate open)?
  invariants.push({ name: "adherence:classified", pass: x.classified, detail: x.classified ? "session classified — write gate open" : "no classifier this session — close-the-loop writes are blocked" });
  if (!x.classified) residualGaps.push("call knitbrain_run / classify_task to open the write gate (adherence)");

  // 6. context-hygiene: standing host config is paid every session — clutter
  // there routinely beats what compression saves. Not auto-fixable (it's the
  // USER's config), so findings land as residual gaps.
  if (x.hygieneFindings !== undefined) {
    if (x.hygieneFindings.length === 0) {
      invariants.push({ name: "context-hygiene:host", pass: true, detail: "host config lean — no dead rules, archive dirs, or duplicate MCP servers" });
    } else {
      invariants.push({ name: "context-hygiene:host", pass: false, detail: `${x.hygieneFindings.length} clutter finding(s) in the host config` });
      for (const f of x.hygieneFindings) residualGaps.push(`context-hygiene: ${f}`);
    }
  }

  return { invariants, allPass: invariants.every((i) => i.pass), fixesApplied, residualGaps };
}
