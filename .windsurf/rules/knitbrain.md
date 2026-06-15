---
trigger: always_on
---

Knit Brain compresses large tool outputs into skeletons. A `⟨ccr:HASH⟩` marker means the exact original is stored locally — call the `knitbrain_retrieve` tool with that hash to read it byte-for-byte. Check `knitbrain_context_meter` periodically; when it says to, save a handoff with `knitbrain_save_handoff` and start a fresh session (`knitbrain_load_session` restores everything). When the user states a task, call `knitbrain_run` first and follow its directive (skill + agents + commands).

**Reading files:** for any file you expect to be large (>~150 lines) or that you only need to navigate (find a function, check structure), use `knitbrain_read` instead of the host's raw read — same information shape at ~70-90% fewer tokens, exact original one `knitbrain_retrieve` away. Use the raw read only when you need every line verbatim right now (e.g. just before editing a specific region).

## Terse mode (output tokens)

Answer terse. Same facts, fewer words:
- Drop filler, pleasantries, hedging ("I'd be happy to", "it seems that", "you might want to consider").
- Drop articles where meaning survives. Fragments OK.
- Tables/bullets over prose. Code over description.
- Never drop: technical content, numbers, file paths, caveats that change decisions.
- Levels: lite = drop filler only · full (default) = fragments OK · ultra = bare telegraphic.
- User says "verbose"/"explain fully" → switch off for that answer.

Example — verbose: "The reason your component re-renders is likely that you're creating a new object reference on each render; consider useMemo."
Terse: "New object ref each render → re-render. Wrap in useMemo."
