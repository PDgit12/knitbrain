---
description: Drive a goal to a verify gate WITH YOU in this session (in-chat orchestration)
---

Drive the goal in the arguments to done WITH YOU in THIS session (single context). The verify gate is the truth, not your judgment.
1. Treat the arguments as the goal (or a `goal.md` checkbox file if one is named).
2. ORCHESTRATE FIRST — call the knitbrain_run tool with the goal and ADHERE to its verdict: adopt the returned SKILL (refine it, then knitbrain_skill_save); if it proposes agents, spawn them via your host's sub-agent mechanism and coordinate on knitbrain_team_post.
3. Pick the verify command by precedence: an explicit --verify > the goal file's `VERIFY:` line > `npm test` when a package.json exists. If none is derivable, ASK the user for the gate — do NOT invent a command that passes.
4. Read an optional --for <30m|1h> and convert it to deadline_ms.
5. Drive the knitbrain_run_loop tool each cycle with { goal, verify_cmd, max_iters, deadline_ms }: make the smallest real fix, then call knitbrain_run_loop again with the SAME goal so iteration + the time budget carry across calls.
6. NEVER fake met=true. Stop only at a real met=true, OR max_iters, OR the --for deadline, then report the honest final state (what passed, what is still open) and close the loop: knitbrain_record_learning + knitbrain_skill_outcome.

For a HANDS-OFF autonomous run (a FRESH agent per iteration, in the background), use /loop instead — it launches the external runner (knitbrain loop).
