---
name: refine-agent
description: Run the Agent-mode Gold-supervised Skill refinement loop from a frozen requirements/trace artifact, Gold document, and active Skill snapshot.
---

# Refine Agent

The active Pi session is the Refine Agent coordinator. Call `refine_agent` once with `requirementsPath`, `goldPath`, `activeSkillPath`, `activeSkillVersion`, `rulesPath`, and `runRoot`. It only initializes the run.

Then repeatedly call `refine_agent_step` with the returned `runDirectory` and exact `nextStage`. After every call, inspect the returned status and nextStage. Stop only when status is `promoted` or `rejected`; never replace this session-owned loop with a single `refine_workflow` call.

The current Pi session does not freely select among independent subagents. It advances the fixed sequence one stage at a time; `refine_agent_step` invokes the corresponding isolated role task or deterministic tool.

The sequence is:

1. Reconstruct Description from the frozen trace and rules.
2. Generate Current Draft from Description plus Active Skill. Draft generation must never read Gold.
3. Run Reviewer-private ExPerT against Draft and Gold as auxiliary evidence. Reviewer must still compare the complete Draft and Gold for overall/content style before selecting at most five strongest reusable findings; a Finding need not bind an ExPerT gap. Gold-observed organization or expression may be abstracted, but only Description-required fields may become current-task content slots. Even when Description provides domain categories or criterion values, retain only the method of deriving and reusing a Description-defined criterion. Apply a blind-execution test, then remove domain examples and criterion values: the general method must remain complete. Every Finding states its activation condition and preserves Description-fixed sections/groups, order, enumerated members, and membership; roster-free tasks are not artificially frozen. Anything else remains an uncertainty.
4. Compile a complete, coherent Candidate Skill from Active Skill plus attributed findings. First scan the whole Skill for equivalent, conflicting, or priority-related rules and select one canonical landing point per method. Make a line-local merge into the nearest existing principle, rewrite or delete direct conflicts when necessary, and do not restate the same method in another section. Require every changed or deleted line to implement a Finding directly. Any compression, concision, or structural-unification rule must retain Description-required content slots and concrete values already supplied by Description. Preserve frontmatter, source comments, file indexes, unrelated sections, and non-conflicting text verbatim; do not perform opportunistic cleanup or generalization. Add a compact rule only if no suitable principle exists; never create one long section per Finding or mechanically append. Do not emit a detached policy delta and do not let the optimizer read Gold.
5. Generate Current and Candidate Drafts only after inventorying Description-required slots/values and freezing explicitly prescribed sections/groups, order, enumerated members, and membership. Style transforms may change presentation and remove repetition or meta narration only; they must not add, remove, merge, re-root, or generalize the frozen contract. Before delivery, verify it item by item and make one pass for canonical terminology. Candidate Draft must not read Gold, Current Draft, Review, or Expert output.
6. Compare Candidate Draft against Gold with ExPerT and an independent Judge. A Gold-only factual difference that Description did not require is background, not a standalone regression. Keep verdict and Hard Pass semantics unchanged. Judge reason separately states Description-structure/roster conformity, overall/content-style change, required-slot/value retention, surface quality, and integrated judgment; it localizes visible document differences but does not infer Skill-vs-execution cause without reading those inputs. Judge evidence is advisory: promotion is decided by attributed-Finding and deterministic Expert gates, and self-evolution triggers only when Candidate Expert `f1` is strictly lower than Current Expert `f1`.
7. Leave Active Skill unchanged. The result is an isolated Candidate Skill and a machine-readable decision. If Review returns no attributed findings, stop as a no-op rejection; do not regenerate an identical Candidate Draft.

There is no `baseline` business input and no independent Revision Agent in this main path. Use `refine_agent_cards` to inspect the Agent-only pinned identities and contracts.

Harness self-evolution is connected only to a strict deterministic Candidate Expert `f1` regression, never to rejection or Judge opinion alone.
