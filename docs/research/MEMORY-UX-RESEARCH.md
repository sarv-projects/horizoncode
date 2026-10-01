# Memory experience research

Research date: 2026-10-01. This is a source and design-disposition record, not proof of market fit or runtime delivery.

## Read coverage

Archived original `docs/history/architecture/original-ARCH-2026-10-01/33-MEMORY.md`: all 348 lines read in one untruncated output. Relevant REQ-MEM-001..007, historical DEC-067 (lines 1503–1523) and DEC-072 (1644–1688) inspected. The consolidated target is `ARCH/product/MEMORY.md`; coordinated requirement/config/command/context/acceptance updates are part of the same refactor.

## Verified product behavior

[Anthropic memory documentation](https://code.claude.com/docs/en/memory) describes automatic local memory, a user toggle, bounded initial selection and inspection/editing. It distinguishes learned context from user instruction files. Documentation is mutable; retrieved 2026-10-01. No exact proprietary executor source is claimed.

[Cursor's archived memory documentation](https://docs.cursor.com/en/context/memories) previously described passive extraction with approval for background notes and separate agent writes. The URL now redirects to the general documentation landing page. The historical search extract is insufficient to establish the feature's availability or behavior in today's build. The assertion that Cursor proves universal approval-free memory is unsupported. [Current rules documentation](https://cursor.com/docs/rules) is a rules reference, not proof of current automatic-memory behavior.

[Cline's official rules release](https://cline.bot/blog/cline-3-13-toggleable-clinerules-slash-commands-previous-message-editing) presents toggled rule files and a memory-bank recipe. [Official memory-bank prompt](https://github.com/cline/prompts/blob/main/.clinerules/memory-bank.md) is a convention/recipe; it does not establish a native persistent database or silent analysis default. These sources support scope controls and inspectable durable context, not claims that all code style is silently inferred.

## Developer evidence and its limits

The sample contains both favorable and unfavorable experiences. Threads are self-selected, may contain promotional replies and have no representative sampling frame. Votes are not market share or usability measurements.

- [February 16 auto-memory discussion](https://www.reddit.com/r/ClaudeAI/comments/1r6j36u/claude_codes_auto_memory_is_so_good_make_sure_you/): a user reports better continuity; comments prefer explicit instructions and fear accidental statements becoming rules.
- [June 17 corrections and auto-memory discussion](https://www.reddit.com/r/ClaudeAI/comments/1u7y3ek/claude_codes_auto_memory_remembers_your/): useful retention of preferences, alongside a comment disabling it after faulty interpretations accumulated.
- [February 8 memory inspection discussion](https://www.reddit.com/r/ClaudeCode/comments/1qzmofn/how_claude_code_automemory_works_official_feature/): inspectability and conflicts matter; some initial explanations are model-generated and are not authoritative product contracts.
- [September 29 cleanup discussion](https://www.reddit.com/r/ClaudeCode/comments/1wt52gf/clean_up_claude_memory_with_the_next_prompt/): complaints about bloat, obsolete decisions and contradictions support revalidation, deduplication and easy correction.
- [May 27 cross-session continuity discussion](https://www.reddit.com/r/ClaudeAI/comments/1tp9uba/how_do_you_keep_claude_code_from_forgetting_your/): repeated explanation and stale manual files are pain points; the post also promotes the author's solution.
- [May 11 structural-memory discussion](https://www.reddit.com/r/ClaudeCode/comments/1ta0d3k/i_got_tired_of_claude_codes_amnesia_so_i_built_an/): forgotten decisions are costly; this promotional implementation report does not prove its claimed freshness or latency.
- [September 29 memory/context discussion](https://www.reddit.com/r/ClaudeCode/comments/1wt2gtj/memory_problems_and_solutions_how_to/): replies favor bounded initial context and query-based detail over injecting everything.
- [Cursor memory/privacy setting discussion](https://forum.cursor.com/t/memories-setting-is-disabled/101166): availability and privacy expectations can conflict; historical forum behavior is not a current feature contract.

The requested broad claims “zero-friction is non-negotiable” and “users overwhelmingly prefer correction over prevention” are not established by this evidence. A reasonable product direction is automatic advisory assistance with conspicuous controls and an explicit mode for users who prefer predictability. The supplied secondary articles/Instagram quote were not independently validated here and are not treated as requirements.

## Design disposition

Remove redundant approval for an explicit save request: user intent already authorizes that save. Keep provenance and CAS storage without putting database machinery in the UI. Enable local project advisory capture by default for a new installation, disclosed through passive onboarding and settings; preserve the existing effective mode on upgrade. Never label inferred observations as confirmed user preferences. Keep global automatic inference off and do not grant authority from memory.

Replace binary “changed file means forgotten” with applicability-aware revalidation. Retain changed observations as leads, but do not rely on them as present code/config truth. Explicit preferences are independent of file digests. Confidence decay is ranking only; retrieval frequency is not factual corroboration.

Provide passive Saved/Used indicators, Edit/Forget/Dismiss actions, searchable scope controls, generation fencing against late captures and one shared deletion path. Repository learning is bounded read-only analysis; exporting instruction files is explicit Preview/Apply. Memory is not a new scheduler, rules engine, proof store or secret manager.

## Selected design disposition

The user-authorized target is recorded in [DEC-096](../history/architecture/decisions/DEC-096-MEMORY-CAPTURE.md) and specified in the canonical [Memory design](../../ARCH/product/MEMORY.md), [requirements](../../ARCH/02-REQUIREMENTS.md), settings/commands, context packet, and `ACC-MEM-02`. It distinguishes advisory observations from confirmed facts, saves exact explicitly requested content without redundant approval, keeps child observations scoped advisory, and distinguishes new-install defaults from upgrade migration. DEC-067/072 remain unchanged as historical decisions.

The authored target in `/tmp/hz-refactor-memory.md` includes HLD, ownership, contracts, V2 records/receipts, transitions, user/ambient/retrieval/correction flows, profile/privacy rules, finite bounds, UI, failure recovery and acceptance. It contains no runtime-status or reconciliation sections. Root integration owns canonical placement and cross-document changes.

## Product validation

Compare no-memory, explicit and ambient conditions on repeated repository tasks. Measure correctness, repeated correction count, harmful stale use, time to understand/edit/forget an incorrect note, extra context cost and foreground responsiveness. Recruit users with both automatic and explicit preferences. A successful design reduces repeated explanation without increasing incorrect changes or losing user control. No numerical satisfaction or market-fit result is asserted before those studies.
