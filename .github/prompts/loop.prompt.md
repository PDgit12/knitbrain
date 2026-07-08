---
description: Launch the autonomous external runner (knitbrain loop) in the background
---

Launch knitbrain's EXTERNAL runner in the BACKGROUND, then report the handle. Do NOT run the loop inline — it would block this session.
1. Resolve a goal file from the arguments: a markdown file with `- [ ] task` checkboxes (default `goal.md`). If it is missing, tell the user to run `knitbrain onboard` first and stop — do NOT invent tasks.
2. Using your terminal tool, run DETACHED (pass through any --for/--max/--verify/--reviewer the user gave):
   nohup knitbrain loop <goalfile> --for 1h --agent "claude -p" > <goalfile>.loop.log 2>&1 & echo "loop PID $!"
3. Report the PID + log path (`<goalfile>.loop.log`). The runner spawns a FRESH "claude -p" per `- [ ]` task, runs the verify gate, and ticks `- [x]` only on green. Watch the boxes tick, tail the log, or run `knitbrain dashboard`. Stop early with `kill <PID>`.
4. Do NOT tick any box yourself — only the runner's verify (and optional reviewer) gate marks a task done. No false green.
