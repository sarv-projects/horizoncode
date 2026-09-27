# Aider — source architecture and schema map

> INTERNAL RESEARCH — source snapshot: latest listed Aider release v0.86.0, commit **a4be6ccd87ebaa59b361f3f028d116ce1761b626**, released 2025-08-09. The release page still lists v0.86.0 as latest when checked 2026-09-27. This is a materially older release than the other pinned systems; verify current status before selecting it. This map follows core Python runtime paths rather than every module and test.

## Evidence boundary and HLD

Aider is a terminal-first, Git-aware pair-programming tool. It combines a Python CLI/chat loop, model API integration through LiteLLM, edit-format-specific coding strategies, repository map retrieval, file/command/Git helpers and optional lint/test feedback.

    CLI / interactive commands / config
                      │
             Coder turn controller
       prompt ↔ model ↔ edit parser ↔ repo
          │            │             │
     repo map       LiteLLM      file/Git/shell
          │                         │
   tree-sitter tags              lint/tests
          │
   Markdown chat history · Git commits · SQLite tag cache

Primary evidence: pinned [base coder](https://github.com/Aider-AI/aider/blob/a4be6ccd87ebaa59b361f3f028d116ce1761b626/aider/coders/base_coder.py), [repo map](https://github.com/Aider-AI/aider/blob/a4be6ccd87ebaa59b361f3f028d116ce1761b626/aider/repomap.py), [commands](https://github.com/Aider-AI/aider/blob/a4be6ccd87ebaa59b361f3f028d116ce1761b626/aider/commands.py), [repository/Git](https://github.com/Aider-AI/aider/blob/a4be6ccd87ebaa59b361f3f028d116ce1761b626/aider/repo.py), [argument/config surface](https://github.com/Aider-AI/aider/blob/a4be6ccd87ebaa59b361f3f028d116ce1761b626/aider/args.py), [release history](https://github.com/Aider-AI/aider/releases), [repo-map design note](https://aider.chat/docs/repomap.html).

## Source map

| Area | Source paths | Responsibility |
|---|---|---|
| Entrypoint and options | aider/main.py, aider/args.py, aider/commands.py | CLI, config resolution, interactive commands and execution. |
| Turn control | aider/coders/base_coder.py | Conversation state, prompting, model call, edit parse/apply, reflection, lint/test feedback and commits. |
| Edit strategies | aider/coders/*_coder.py and related prompt modules | Whole-file, search/replace, diff, architect/editor and other model-specific edit formats. |
| Models and API | aider/models.py, aider/sendchat.py | Model metadata/settings, capability handling and LiteLLM request path. |
| File scope and repo context | aider/repomap.py, aider/repomap_tags.py, aider/wholefile.py | Tree-sitter symbol extraction, ranking, map caching and file-edit representation. |
| Git integration | aider/repo.py | Changed files, repository operations, commit/undo integration and ignore rules. |
| Local commands | aider/commands.py | User slash commands and configured lint/test/shell interactions. |
| History/config | aider/io.py, aider/website/docs/config/*, aider/coders/base_coder.py | Interactive I/O, YAML config, Markdown chat history and context summarization. |

## Main coding turn

1. CLI resolves model, edit format, repo root, writable/read-only files, instructions/config, chat history and command options.
2. Coder builds the message history and a file/repository context. The repo map is generated from symbol/import tags and token-budgeted; selected files may be included in full while other files are represented by relevant identifiers.
3. The selected model receives an edit-format-specific prompt. The architect mode can ask one model for a solution and pass it to an editor coder; changing edit formats may summarize history because old-format assistant messages can confuse the new coder.
4. Response parsing applies requested edits to the selected working files. Invalid or incomplete edits may trigger bounded reflection/repair behavior.
5. If enabled, lint runs after edits; tests run when auto-test and a test command are configured. Result text is supplied to later model turns.
6. With auto-commit enabled, Git commits changes through the repo helper; undo uses Git history.
7. Chat history is saved as Markdown and can be summarized when context limits require it. The local tag cache supports map recomputation.

This design is efficient for a human-in-the-loop edit session. “Aider says the change is done” is not the same as task completion backed by independent acceptance evidence.

## State and schema inventory

Aider does not expose one normalized relational schema for work plans, task attempts and evidence. Its state is spread across configuration, Python objects, Markdown history, Git and a repository-map cache.

| State surface | Structure / purpose | Long-horizon implication |
|---|---|---|
| YAML configuration | Model, edit format, file filters, auto-commit, lint/test and other CLI settings; precedence also includes command-line options and environment/provider configuration. | Configuration is durable but is not a versioned per-run user-approved specification. |
| Coder memory | In-process message list, selected files, read-only files, model/editor state, costs, lint/test outcome and commit references. | Process restart needs transcript/config reconstruction; no general task/attempt lease or transactional resume record. |
| Chat history | Markdown transcript/history files under project or configured locations. | Human-readable context, not canonical task state, acceptance evidence or an append-only typed event log. |
| Git repository | Working-tree diff and optional Aider commits; undo via repository history. | Strong code checkpoint primitive, but no transaction joining a commit with task status, evaluator result or external effect. |
| Repo map tag cache | SQLite-backed tag cache, versioned cache directory such as .aider.tags.cache.vN; tree-sitter-derived file/symbol/import data. | Derived retrieval state should be invalidated/rebuilt against source revision; it is not workflow state. |
| Prompt/edit formats | Typed-by-convention message payloads and edit parsers, selected by model/edit-format behavior. | Provider/API compatibility and parser correctness are model-specific; tool protocol is not a universal agent contract. |

The map defaults to roughly 1,024 tokens in the pinned source and expands the map budget when no files are already in chat, bounded by context window. It ranks tags/identifiers against mentioned files and symbols. This improves targeted context but can omit relevant behavior; it is not a proof of complete architectural discovery.

## Permissions and side effects

Aider's interactive workflow lets the user add files, set files read-only, approve edits/architect output, configure auto-commit and opt into shell commands. Lint and test commands are configured execution. Treat shell/test hooks, file writes and Git commits as effects under the host process's authority: the CLI's interaction model is not an OS sandbox or a least-privilege policy engine.

For an autonomous wrapper, run Aider in a controlled worktree/container; record exact commands, environment, output and commit; enforce policy outside its prompts; and verify the final diff on a known revision. Avoid running arbitrary repository-provided commands without a policy decision.

## Testing, debugging, PR support and development workflow

- Testing/debugging: optional lint/test commands feed diagnostics into the coding conversation. Auto-test defaults off in the pinned base coder; setting a test command alone is not evidence that it ran.
- Git workflow: repo-aware edits, commits, undo and diffs are first-class strengths.
- PR support: Git state and generated changes can be used to prepare a PR, but the core architecture is not a persistent PR review/approval/merge orchestrator.
- Repository understanding: tree-sitter repo map plus explicit files is lightweight and useful. It is not a full call graph, test-impact analyzer or persistent architecture map.
- Team/parallel execution: this release's core is a single interactive coder loop; no built-in durable multi-agent task graph or external child-agent event registry is established by these paths.

## Strengths, limits, and HorizonCode lessons

**Useful patterns:** low-complexity terminal workflow; selectable edit formats; tree-sitter symbol map with a strict context budget; Git-native undo/checkpoints; optional diagnostics feedback; Markdown history that is inspectable by humans.

**Limits:** latest listed release is Aug 2025 as of this review; model and edit-format assumptions have aged; no first-class intent/specification versioning, project task DAG, task attempt leases, external side-effect receipt log, independent evaluator, approval ledger or multi-agent lifecycle tracking is evident in the examined core paths.

**HorizonCode lessons:** preserve a cheap semantic repo map as one retrieval signal, but source-stamp/invalidate it; keep chat transcript separate from canonical workflow records; make lint/test evidence explicit and commit-bound; use Git for code checkpoints without treating it as the task database.

## Coverage limits

This is a source-path map of Aider v0.86.0, not a line-by-line account of every coder subtype, model adapter, prompt, platform branch or test. The release age makes current compatibility and security claims especially dependent on a fresh build and evaluation.
