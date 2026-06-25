/**
 * Closed-loop orchestrator (P3): goal → judge → iterate → grade → review →
 * repeat until met. The GAN-style inner loop that sits on top of the outer
 * loop (loop.ts/fan.ts):
 *
 *   judge   — is the goal/spec clear enough to attempt? (don't burn cycles on a
 *             vague goal)
 *   iterate — orchestrate the right skills+agents for one pass (the work)
 *   grade   — verify-gate: a REAL test/eval run, exit 0 or not. No false green.
 *   review  — an evaluator scores the result against a rubric
 *   repeat  — until met, or a hard max-iteration cap (no runaway spend)
 *
 * Pure controller: every step is injected, so the invariants (stops on met,
 * stops on max, NEVER reports met on a failing grade) are unit-testable without
 * spawning a real agent. The CLI composes the real steps (spawn + verify + wiki
 * audit + live token meter).
 */

export interface CycleRecord {
  iter: number;
  graded: { pass: boolean; detail: string };
  reviewed: { score: number; met: boolean; notes: string };
  /** met = graded.pass AND reviewed.met (a failing grade can never be met). */
  met: boolean;
  /** Live token reading at this cycle (null if no meter injected). */
  tokens: number | null;
}

export interface ClosedLoopResult {
  met: boolean;
  reason: string;
  cycles: CycleRecord[];
}

export interface ClosedLoopSteps {
  /** Is the goal clear enough to attempt? */
  judge: () => { clear: boolean; reason: string };
  /** Run one orchestrated pass (the agent does the work). */
  iterate: (iter: number) => void;
  /** Verify-gate: a real test/eval run. pass = exit 0. */
  grade: () => { pass: boolean; detail: string };
  /** Score the result vs a rubric; met = goal satisfied. */
  review: (gradePass: boolean) => { score: number; met: boolean; notes: string };
  /** Optional audit sink (one record per cycle → the wiki). */
  onCycle?: (record: CycleRecord) => void;
  /** Optional live token reading (current-window probe — real, not pre-counted). */
  meter?: () => number;
}

export function runClosedLoop(steps: ClosedLoopSteps, maxIterations = 6): ClosedLoopResult {
  const cycles: CycleRecord[] = [];

  // Don't spend cycles on a vague goal.
  const j = steps.judge();
  if (!j.clear) return { met: false, reason: `goal unclear — ${j.reason}`, cycles };

  for (let iter = 1; iter <= maxIterations; iter += 1) {
    steps.iterate(iter);
    const graded = steps.grade();
    const reviewed = steps.review(graded.pass);
    // INVARIANT (no false green): "met" REQUIRES a passing grade. A high review
    // score on a failing verify is never accepted.
    const met = graded.pass && reviewed.met;
    const record: CycleRecord = { iter, graded, reviewed, met, tokens: steps.meter ? steps.meter() : null };
    cycles.push(record);
    steps.onCycle?.(record);
    if (met) return { met: true, reason: `met in ${iter} cycle(s)`, cycles };
  }
  return { met: false, reason: `hit max ${maxIterations} cycle(s) without meeting the goal`, cycles };
}

// ── default step factories (used by the CLI; tests inject their own) ──

/** A goal is attemptable if it carries actionable content (a task or a brief). */
export function defaultJudge(goalText: string): { clear: boolean; reason: string } {
  const trimmed = goalText.trim();
  if (trimmed.length === 0) return { clear: false, reason: "empty goal" };
  const hasTask = /- \[[ xX]\]\s+\S/.test(goalText);
  const hasBrief = trimmed.split(/\s+/).length >= 3;
  return hasTask || hasBrief
    ? { clear: true, reason: hasTask ? "goal has checkbox tasks" : "goal has an actionable brief" }
    : { clear: false, reason: "goal too vague to attempt" };
}

/** Grade = run the verify command (real). Empty verify → vacuously passes. */
export function makeGrade(verifyCmd: string, run: (cmd: string) => boolean): () => { pass: boolean; detail: string } {
  return () => {
    if (!verifyCmd) return { pass: true, detail: "no verify command (vacuous pass)" };
    const pass = run(verifyCmd);
    return { pass, detail: pass ? `verify passed: ${verifyCmd}` : `verify FAILED: ${verifyCmd}` };
  };
}

/**
 * Review against a rubric of boolean checks. met = grade passed AND every rubric
 * check passes. score = fraction of (grade + rubric) checks that pass.
 */
export function makeReview(rubric: Array<{ name: string; check: () => boolean }> = []): (gradePass: boolean) => { score: number; met: boolean; notes: string } {
  return (gradePass) => {
    const results = rubric.map((r) => ({ name: r.name, ok: r.check() }));
    const passed = (gradePass ? 1 : 0) + results.filter((r) => r.ok).length;
    const total = 1 + results.length;
    const met = gradePass && results.every((r) => r.ok);
    const notes = [`grade=${gradePass}`, ...results.map((r) => `${r.name}=${r.ok}`)].join(" · ");
    return { score: passed / total, met, notes };
  };
}
