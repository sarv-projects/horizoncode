# Developer experience research

Research date: 2026-10-01. This document records qualitative inputs to HorizonCode's blueprint. It is not a representative survey, a product ranking, or evidence of HorizonCode product market fit.

## Method and limits

The review searched public Reddit discussions, Product Hunt reviews, Hacker News, developer forums, public X posts, GitHub issue reports and official product documentation. Search terms deliberately included both praise and complaints about memory, permissions, speed, context, review, quotas and terminal interaction. This introduces selection bias. Authors' experience, model, plan, platform, repository size and enabled features differ; a complaint is not proof of a reproducible product defect. Replies often disagree with the original post.

The discussion ledger contains 24 distinct Reddit threads, plus Hacker News, Product Hunt and vendor-community discussions. Cross-posted copies of the same memory announcement and self-promotion posts were excluded from the count. Entries summarize accessible search-extracted discussion text; the review does not claim to have read every comment. The Cursor Stop/Undo discussion, Product Hunt pages and Hacker News discussion were also opened directly. Dates below are exact where the retrieved text exposed them; otherwise they are marked unavailable rather than inferred from relative search ages. All URLs were accessed or searched on the research date.

X search exposed two public post snippets, but opening one returned an internal error. They are discovery leads, not independently verified user-sentiment evidence. Product Hunt returned differently cached review counts for the same product; counts and aggregate ratings are therefore not used. Some Product Hunt summaries are explicitly AI-generated; the review uses visible individual reviews where available and labels summaries separately. No inaccessible social-media text is invented.

Official documentation establishes published behavior, not whether users like it. Mutable documentation and community URLs must be rechecked before implementation uses them as protocol or tool contracts. This research samples feature families; it is not an exhaustive census of every coding-agent feature.

## Community discussion ledger

| ID | Product / date visible in retrieved text | Discussion and URL | Observed signal | Design implication to test |
|---|---|---|---|---|
| DX-01 | Claude Code / 2026-06-17 | [Auto Memory remembers corrections](https://www.reddit.com/r/ClaudeAI/comments/1u7y3ek/claude_codes_auto_memory_remembers_your/) | Praise for retaining corrections; confusion about storage location and distinction from user rules. A reply reserves operating rules for explicit instructions. | Make remembered corrections easy to inspect; distinguish advisory memory from enforced policy. |
| DX-02 | Claude Code / 2026-02-08 | [How Auto-Memory works](https://www.reddit.com/r/ClaudeCode/comments/1qzmofn/how_claude_code_automemory_works_official_feature/) | Users want to inspect saved notes because unexpected behavior can otherwise be difficult to explain. | Provide source, scope and last-use visibility. |
| DX-03 | Claude Code / 2026-02-05 | [Undocumented persistent memory](https://www.reddit.com/r/ClaudeAI/comments/1qw9hr4/claude_code_has_an_undocumented_persistent_memory/) | Feature discovery and memory location were unclear. Some posted technical explanations are user interpretations. | Expose memory controls in onboarding and settings without demanding per-note review. |
| DX-04 | Claude Code / 2026-02-16 | [Auto Memory is good; check whether enabled](https://www.reddit.com/r/ClaudeAI/comments/1r6j36u/claude_codes_auto_memory_is_so_good_make_sure_you/) | Original post praises continuity; a prominent reply prefers explicit rules and rejects accidental conversation becoming permanent instruction. | Default ambient hints must remain correctable and subordinate to explicit user intent. Offer off and manual modes. |
| DX-05 | Claude Code / 2026-05-19 | [Auto-memory and drift hypothesis](https://www.reddit.com/r/ClaudeAI/comments/1thyy3k/if_youre_not_having_usage_or_drift_issues_have/) | Author suspects memory volume causes drift and usage issues. Their causal and loading claims are not independently verified. | Bound retrieval and show actual included tokens; do not equate stored bytes with prompt tokens. |
| DX-06 | Claude Code / date unavailable | [Old library recalled after deletion](https://www.reddit.com/r/ClaudeCode/comments/1s2gagt/claude_code_was_getting_worse_at_its_job_then_i/) | Stale remembered architecture can reintroduce removed dependencies. | Verify repository-derived assertions against current source; retire contradicted notes. |
| DX-07 | Claude Code / date unavailable | [Memory drift and context bloat](https://www.reddit.com/r/ClaudeAI/comments/1tdtmr6/memory_drift_context_bloat_a_claude_code_skill_i/) | Long-running memory needs maintenance rather than unlimited accumulation. | Deduplicate, cap context and make maintenance observable and reversible. |
| DX-08 | Claude Code / 2026-04-05 | [Permissions setup repeatedly breaks](https://www.reddit.com/r/ClaudeCode/comments/1scpx8y/claude_code_is_always_changing_and_breaking/) | Repeated prompts and surface differences interrupt established workflows. | Show effective rule and source; preserve supported permission semantics across updates. |
| DX-09 | Claude Code / date unavailable | [Subagent permission chaos](https://www.reddit.com/r/ClaudeAI/comments/1roz5bc/subagent_permission_chaos/) | Child permissions can strand long tasks and be difficult to diagnose. | Route child blockers into a durable attention inbox; do not silently wait behind scrollback. |
| DX-10 | Claude Code / date unavailable | [Image chip visible but image not received](https://www.reddit.com/r/ClaudeCode/comments/1vgdurz/annoying_bug_on_macos_claude_unable_to_see_any/) | Attachment presentation can disagree with actual model input. | Admit actual validated bytes, check model compatibility, and surface a failed attachment before send. |
| DX-11 | Codex / 2026-06-10 | [Slowness traced to orphan processes](https://www.reddit.com/r/codex/comments/1u28zn8/has_codex_been_painfully_slow_for_anyone_else/) | One author reports accumulated background processes rather than slow repository operations. This is an anecdotal diagnosis. | Process ownership, cancellation/reaping and diagnostics matter to perceived speed. |
| DX-12 | Codex / 2026-07-14 | [Agents still thinking](https://www.reddit.com/r/codex/comments/1uvtehw/my_agents_are_still_thinking/) | Waiting can dominate the workday even for users who otherwise like the agent. | Show useful activity and waiting reason; avoid artificial animation implying progress. |
| DX-13 | Codex / date unavailable | [Why is Codex slow?](https://www.reddit.com/r/codex/comments/1qlwrot/why_is_codex_so_slow/) | Some respondents accept longer waits for better results; others find latency unacceptable. | Separate rapid pair work from deeper managed work; expose effort and cost tradeoffs. |
| DX-14 | Cursor / date unavailable | [Indexing on large projects](https://www.reddit.com/r/cursor/comments/1rfkgfv/cursors_indexing_gets_painfully_slow_on_large/) | Reports differ markedly by repository; explicit file context and concise instructions are discussed as workarounds. | Make indexing readiness and selected context visible; benchmark multiple repository sizes. |
| DX-15 | Cursor / date unavailable | [Layout and UI feedback megathread](https://www.reddit.com/r/cursor/comments/1ppbcvv/megathread_cursor_layout_and_ui_feedback/) | Changed sidebar positions, changed shortcuts and inconvenient review navigation annoy some users; others barely notice. | Preserve chosen layout and keymaps; mode changes must not force navigation churn. |
| DX-16 | Cursor / date unavailable | [Stop changes into Undo](https://www.reddit.com/r/cursor/comments/1rhg6y3/swapping_stop_for_undo_dynamically_in_the/) | A control changing meaning under the pointer can cause unintended rollback; overlapping review and undo controls are criticized. | Stable action locations and identities; cancel and destructive restoration are separate actions. |
| DX-17 | Cursor / date unavailable | [What happened to Keep All?](https://www.reddit.com/r/cursor/comments/1ssq0lb/what_happened_to_keep_all/) | Users dislike repetitive per-file clicks and moving controls. | Offer bounded bulk review actions with clear scope and stable controls. |
| DX-18 | Cursor / date unavailable | [Rejected changes reappear](https://www.reddit.com/r/cursor/comments/1j1p8kd/) | A rejected change can return in a later unrelated request; replies suggest stale indexing as one possible cause. | Rejection receipts and freshness must inform later context; do not silently restore rejected edits. |
| DX-19 | OpenCode / 2026-04-08 | [Terminal selection and copy frustration](https://www.reddit.com/r/opencodeCLI/comments/1sfka5i/how_to_make_opencode_behave_like_a_terminal/) | Author likes the product but expects ordinary select/copy/middle-click semantics; web UI solved their problem. | Test clipboard success and terminal-native selection; offer explicit copy/raw paths and capability fallbacks. |
| DX-20 | OpenCode / 2026-06-17 | [Loved Desktop app](https://www.reddit.com/r/opencode/comments/1u8hxkl/loved_opencode_desktop_app/) | Praise for speed and choice; replies prefer terminal/web and criticize unfamiliar hotkeys. | Support different interaction preferences; avoid claiming one surface is universally best. |
| DX-21 | Aider versus Claude Code / 2025-07-23 | [Using Aider versus Claude Code](https://www.reddit.com/r/ChatGPTCoding/comments/1m7gq38/using_aider_vs_claude_code/) | Users value model choice, speed, explicit context and rollback, but acknowledge more manual work and a learning curve. | Keep a fast direct workflow, selectable context and safe restoration alongside autonomous Runs. |
| DX-22 | Aider / 2025-06-08 | [Aider and DeepSeek R1](https://www.reddit.com/r/ChatGPTCoding/comments/1l6i30m/) | Praise for useful output with steering; longer reasoning waits and automatic context gathering are tradeoffs. | Measure time to usable verified change and intervention burden, not only first token. |
| DX-23 | Antigravity / 2026-02-10 | [Am I crazy for liking Antigravity?](https://www.reddit.com/r/google_antigravity/comments/1r0m262/am_i_crazy_for_liking_antigravity/) | Productivity praise coexists with quota frustration and expectations of real IDE functionality. | Explain quotas without inventing provider data; integrate semantic tools where supported. |
| DX-24 | Cline versus Cursor / date unavailable | [Cline versus Cursor](https://www.reddit.com/r/ClaudeAI/comments/1i1scoa/) | Checkpoint comparisons/restoration and predictable pricing are valued. | Make restoration scope explicit; distinguish provider quota, estimates and Horizon budget. |

## Additional platforms and primary references

| Source | Evidence class and observed content | Appropriate use |
|---|---|---|
| [Claude Code Product Hunt reviews](https://www.producthunt.com/products/claude-code/reviews?feed=single&filter=all) | Self-selected reviews. Visible reviewers praise completing multi-file tasks, learning corrections and independent review; request clearer spending, compaction visibility and supervision. Page also contains an AI-generated aggregate summary. | Hypotheses for deliverable review, continuity, explainable context transitions and accessible onboarding. Do not adopt rating or productivity percentages as benchmarks. |
| [OpenCode Product Hunt](https://www.producthunt.com/products/opencode?launch=opencode) | Product positioning and retrieved review text favor model flexibility and a terminal interface; configuration and context polish concerns appear. Cached pages differed. | Test straightforward setup and model interchangeability with real supported capabilities. |
| [Claude Code SDK discussion on Hacker News](https://news.ycombinator.com/item?id=44032777) | Discussion includes liking the harness UX while wanting different models and less ecosystem lock-in. | Preserve generic provider contracts and expose unavailable capabilities honestly. |
| [Cursor rules ignored](https://forum.cursor.com/t/agent-ignoring-rules-set-in-cursor-settings/148825) | User issue report, not universal behavior. | Show which instructions were selected and their origin; deterministic policy cannot depend on model obedience. |
| [Cursor background tasks](https://forum.cursor.com/t/disable-background-tasks/163448) | User objects to proliferation of background work for a small request. | Bound delegation, show children and spending, and preserve a simple direct-turn path. |
| [Antigravity quota forum](https://discuss.ai.google.dev/t/quota-on-ultra-are-you-serious-2hrs-and-locked-out/135077) | User reports quota display and lockout disagreement. | Display timestamped provider facts, reset information where supplied, and uncertainty where absent. |
| [Claude repeated approvals issue](https://github.com/anthropics/claude-code/issues/11380) | Reproduction and comments report repeated prompts despite allow settings. | Regression tests for scope matching, rule provenance and child permission routing. |
| [Cline context spike issue](https://github.com/cline/cline/issues/7373) | Author reports unexpectedly large input and cost; causal explanation unverified. | Account for assembled prompt components and provider usage separately; test context bounds. |
| [Oikon public X post](https://x.com/oikon48/status/2029950885292642698) | Search snippet presents a conceptual map of Claude features; direct page failed to load. | Discovery lead only. No sentiment conclusion. |
| [Claude Code Log public X post](https://x.com/ClaudeCodeLog/status/2043835992235257951) | Search snippet discusses configuration routing. Full content was not reviewed. | Discovery lead only; verify behavior through official documentation. |
| [Anthropic memory documentation](https://code.claude.com/docs/en/memory) | Published contract distinguishes user instruction files from automatically learned notes; auto memory is enabled by default and can be disabled, edited and inspected. Loading is bounded, repository scoped and machine local. | Confirms an auto-memory product pattern. It does not justify automatically treating inferred notes as policy or universally preferred behavior. |
| [Anthropic auto-mode engineering](https://www.anthropic.com/engineering/claude-code-auto-mode) | Vendor describes approval fatigue and an automatic classification approach. | Evidence that friction matters, not permission to copy its policy model or remove Horizon authorization. |
| [OpenCode TUI documentation](https://opencode.ai/docs/tui/) | Published command and interaction surface, including sessions and editor/context workflows. | Validate navigation and familiar interaction patterns through product-specific tests. |
| [Antigravity changelog](https://antigravity.google/docs/changelog) | Vendor documents scroll-event coalescing, replay optimization and stream-error handling, among many changes. | Supports engineering patterns for smoothness and truthful errors; does not establish achieved Horizon latency. |
| [Cursor rules documentation](https://prod.cursor.com/help/customization/rules) | Published persistent instruction and scope mechanisms. | Useful source for modular instruction discovery; claims of automatic style inference require separate evidence. |
| [Aider Git integration](https://aider.chat/docs/git.html) | Published change/commit/undo integration. | Inform explicit restoration contracts; workspace rollback must not imply reversal of external effects. |
| [Codex security documentation](https://developers.openai.com/codex/security) | Official URL currently redirects to the OpenAI security documentation surface. | Verify selected published authorization and isolation behavior before comparing implementations. |
| [Cline blog](https://cline.bot/blog) | Official product publication index, not an independent user sample. | Discovery of specific current feature documentation; no unsupported sentiment claim. |

## Findings that affect HorizonCode

### Continuity with correctability

The evidence supports a demand for less repetition, but does not support the statement that every developer requires silent memory. Positive and negative replies in DX-04 directly contradict that universal claim. A useful design combines scoped automatic low-risk hints, explicit preferences saved without a second approval when the user requests remembering, and easy inspection, correction, forget and disable controls. Inferred notes must remain advisory. No remembered assertion grants tool authority, accepts requirements, establishes evidence or changes security configuration.

Staleness needs a distinction between a preference and a repository fact. A user's response-format preference need not expire because a source file changes. A note claiming a particular API or dependency still exists requires current verification before use. Soft relevance decay is appropriate for advisory patterns; a known contradicted fact must not be fed back as current truth. A confidence score is a retrieval aid, not a calibrated probability unless a calibration procedure exists. Repeated use must not inflate confidence by itself.

### Fast work and serious work

Users differ in their tolerance for latency and manual context selection. Offer a direct pair path and a managed long-horizon path using common authority and evidence contracts. Background discovery should not block optional features' unrelated work. Required policy and project instructions still have to be available before dispatch. Delegation is justified by task independence and cost, not by turning every file read into a child agent.

First-token speed does not capture usefulness. Track framework latency, provider latency, time to first meaningful result, time to independently verified change, correction count, review effort and spend. Display waiting reasons and known progress without invented percentages. Reap owned processes; avoid idle animation work and history-replay animations.

### Predictable review and familiar interaction

Do not replace Stop with Undo in the same active control, move controls during streaming, or let a second click acquire a destructive meaning. Bulk review should show exact scope. Restore operates against explicit revisions and preserves unrelated user work; concurrent changes require reconciliation. Cancelling a process is distinct from restoring files.

A rich TUI still needs normal selection, clipboard, multiline paste, images, raw output and configurable keymaps. Input focus, draft, scroll position and selection survive mode changes. Image chips must reflect actual admitted attachments. Motion should communicate state changes with reduced-motion support; it cannot substitute for process progress or delay user control.

### Explainability without administration burden

Users should see the objective, next step, blocker, changed files and verification outcome before internal identifiers and traces. Diagnostics, instruction sources, context components and detailed cost remain available in Details. Permission prompts should state the action, scope and reason once, respect applicable existing grants, and aggregate identical unresolved challenges without broadening authority. The attention inbox persists blockers when a child or client disconnects.

Budget displays distinguish actual provider usage, estimates, Horizon reservations and unknown external-worker usage. A provider percentage without a trustworthy reset clock is incomplete information, not an invitation to fabricate a reset time.

## Design thinking and product validation plan

These are recommended blueprint additions, not completed usability studies.

1. **Understand the job.** Recruit experienced terminal developers, IDE-oriented developers and people supervising long tasks. Observe a small bug fix, a multi-file feature, an interrupted Run and review of a finished deliverable. Record where they repeat context, lose control or distrust completion. Do not ask only whether they like an animation.
2. **Define the friction.** Separate input errors, unclear state, model quality, framework latency, approval repetition, evidence gaps and pricing uncertainty. Ask participants what they expected and where the product violated that expectation.
3. **Explore alternatives.** Compare compact versus expanded progress, passive memory receipts versus per-note approval, and quick review versus detailed evidence. Keep task correctness and permission semantics equal between alternatives.
4. **Prototype realistic failure states.** Include a stale memory, denied permission, lost stream, quota exhaustion, changed workspace during review and an attachment failure. Test keyboard, mouse, reduced motion and limited terminal capabilities.
5. **Evaluate and iterate.** Measure task completion, intervention count, time to find a blocker, time to inspect evidence, accidental actions, recovery success and willingness to continue using the tool. Record participant mix and uncertainty. Test revised designs with new participants rather than declaring market fit from enthusiastic anecdotes.

## Recommended acceptance scenarios

| Scenario | Observable outcome |
|---|---|
| First successful pair task | A new user can connect a supported provider, submit a bounded task and inspect the actual result without learning controller internals. Setup can be skipped and resumed. |
| Return to a repository | A useful explicit preference survives restart; retrieval shows its scope and source. An unrelated repository receives none of it. |
| Correct ambient memory | The user forgets or edits a retrieved hint from its receipt; the next applicable request uses the changed retrieval generation. Forgotten content does not regenerate from the same old observation. |
| New request contradicts memory | Explicit new user intent wins; outdated memory cannot silently restore the old library or style. |
| Repository changes | A preference remains available; a deleted dependency assertion is excluded until refreshed. A relevance decay score never authorizes using contradicted facts. |
| Long work blocked in a child | The blocker appears in Needs You with affected tasks and scope; user action resumes only the appropriate work. Closing an overlay does not dismiss the blocker. |
| Stream completes under the pointer | Stop remains Stop or becomes disabled; it never becomes an enabled Undo action under the same pending click. |
| Review while output streams | Focus, selection and scroll position remain stable; latest-output navigation is explicit. Bulk actions describe their scope. |
| Failed image or large paste | Original text remains byte accurate; an image unsupported by the selected model is identified before admission. Failed sending preserves the draft. |
| Context pressure | The user can inspect selected components and compaction boundary; canonical logs and task evidence remain available. Token estimates are labelled. |
| Quota or cost uncertainty | Unknown provider facts remain unknown; spend displays distinguish estimates, provider receipts and reserved verification budget. |
| Cancel and restore | Cancellation responds promptly; workspace restoration is a separate revision-bound action. Uncertain external effects are reconciled before retry. |
| Completed long-horizon task | The user can inspect changed files, required checks, exact evidence revision, limitations and unresolved findings. Worker success text cannot produce PASS. |
| Slow environment | UI remains responsive under indexing and child load; diagnostics distinguish local framework delay from provider delay. No fabricated benchmark superiority claim appears. |
| Terminal accessibility | All primary actions work by keyboard; color is redundant with labels/glyphs; reduced motion suppresses transitions; clipboard failures have explicit fallbacks. |

These scenarios are represented by `ACC-PRODUCT-01..15` in the canonical [acceptance matrix](../../ARCH/acceptance/ACCEPTANCE-MATRIX.md), with subsystem links there. Research recommendations do not create a second state owner, scheduler, memory store or permission engine.
