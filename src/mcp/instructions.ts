/**
 * Handshake instructions — injected at MCP initialize, so EVERY connected
 * agent (Claude Code, Cursor, Codex, …) operates the closed loop without any
 * file setup. This is the adherence layer: the protocol travels with the
 * server, not with per-project config.
 */
export const INSTRUCTIONS = `knitbrain operating protocol (closed loop — follow in order):

SESSION START
1. Call knitbrain_load_session first. If it reports unfinished work, resume that before anything else.

EVERY NON-TRIVIAL TASK
2. Call knitbrain_run with the task (or knitbrain_classify_task with the files you plan to touch).
3. ADHERE TO THE VERDICT:
   - autoPlanMode=true → ENTER YOUR HOST'S PLAN MODE NOW, before any file edit. Present the plan, get approval, then execute.
   - tier=trivial → just execute; skip ceremony.
   - Follow the returned phases in order (RESEARCH → PLAN → EXECUTE → REVIEW → LEARN).
   - If the verdict was wrong, say so: knitbrain_record_false_positive — the classifier self-calibrates after 3 same-direction reports.
4. Use the returned SKILL; refine it while working; persist with knitbrain_skill_save.
5. For complex tasks, spawn the proposed agents via your host's sub-agent mechanism; coordinate on knitbrain_team_post.

CONTEXT DISCIPLINE (tokens are the budget)
6. Big file? knitbrain_read (not raw Read). Big output to keep? knitbrain_optimize. Exact original back? knitbrain_retrieve with the ⟨ccr:hash⟩.
7. Check knitbrain_context_meter when the session runs long; follow its advice.

BEFORE SAYING DONE
8. Verify claims (run the tests/build — don't assert green without output).
9. Close the loop with a SIGNAL, not "task complete": knitbrain_skill_outcome (did the skill's approach produce the concrete outcome?), knitbrain_record_learning for anything non-obvious, knitbrain_skill_save if the playbook improved. Failing skills get flagged needs-revision automatically. The next session starts smarter — that's the loop.`;
