# DeepSeek-Reasonix: Go agent harness, plans, context and ACP editor bridge

> INTERNAL RESEARCH — reviewed 2026-09-27. Audited the Go `main-v2` branch at commit `29c8349c3a489546285b092b166a72c2d127ea39`. The maintainer announced this Go rewrite as the repository default on 2026-05-31; the prior TypeScript 0.x line is maintained separately on branch `v1`. The release page carries independent CLI, Desktop and Studio channels, so a release number alone does not identify the source tree this map describes. Check the release tag's target before transferring a source claim.

## HLD

Reasonix is a small Go, configuration/plugin-oriented agent harness. CLI/TUI and editor clients use the same core agent, with an ACP backend for editor integration. Provider, tool, permission and slash-command subsystems are separated; the documented dependency direction is toward the agent/plugin/config core, not back from core into UI. MCP and remote SSH extend available tools.

## LLD

Provider contract is intentionally small: provider identity plus streaming generation. Configuration identifies provider kind/name, base URL, model, credentials and provider-specific extras; a registry resolves the implementation. Tool contract supplies name, description, JSON schema and execution. A per-run tool registry combines enabled built-ins and configured MCP tools. MCP supports stdio, HTTP and legacy SSE; each server has a session supervisor and a 404 path can rebuild once. Ambiguous disconnects do not automatically replay tool side effects.

Prompt context has an immutable/stable prefix and an append-only canonical transcript. Automatic compaction uses a configurable threshold (documented default 80%), truncates bulky tool output and summarizes a bounded recent portion; older transcript content remains in JSONL and can be retrieved via BM25. Provider-facing content is bounded (documented 32 KB), while raw content is retained locally. These are branch implementation choices, not guarantees that the model retained every relevant fact.

Planning is an explicit workflow choice (plan-first/approval/goal), not an automatic classifier on every user turn. The planning model gets restricted, read-oriented research tools and emits a structured plan through `submit_plan`, including evidence, assumptions, exclusions, risks, acceptance criteria and tests. Planner failure blocks executor startup. Permission modes distinguish allow/ask/deny and user approval.

## Flows and editor

CLI/ACP request → config/provider registry → context builder → model stream → tool call → permission check → tool/MCP execution → event/transcript persistence. Plan-first adds a read-only research pass → structured plan approval → execution pass. VS Code extension starts local `reasonix acp`, contributes editor context, approval controls, model/session UI and transports ACP updates; editor-side conveniences do not replace the core's permission and transcript responsibilities.

## Risks and limits

- Local transcript storage and bounded prompt compaction are not equivalent to durable task graph, checkpointed workspace or restart-safe external-action reconciliation.
- “Read-only” tools need enforcement at execution boundaries, not only tool descriptions.
- MCP session rebuilding after 404 must distinguish safe discovery retry from ambiguous tool-call completion.
- `readOnlyHint` is advisory metadata, not sandbox containment; installed MCP servers are trusted code.
- One planner and one executor improve role separation but do not guarantee an independent evaluator or user-intent alignment.
- A 2026-09-27 Studio pre-release disclosed a long-session data-integrity defect: inline image data URLs inflated an event log past the reader's 128 MiB refusal limit, after which replay and subsequent save failed. The fix moved images into digest-addressed blobs, kept references in the event stream, made missing/corrupt blobs recoverable from checkpoints where possible, and added schema-version refusal across old Studio clients. This is a project release note, not an independent reproduction; it is a strong design/test case for any portable session store.

## Relevance to HorizonCode

Study the lean Go interfaces, append-only transcript, explicit two-model plan gate, prompt-size bounds and editor/ACP boundary. Keep task graph, verified checkpoints and approval policy in HorizonCode's controller. An ACP/editor event is execution telemetry, not acceptance evidence.

## Primary references

[Spec](https://github.com/esengine/DeepSeek-Reasonix/blob/29c8349c3a489546285b092b166a72c2d127ea39/docs/SPEC.md) · [Architecture](https://github.com/esengine/DeepSeek-Reasonix/blob/29c8349c3a489546285b092b166a72c2d127ea39/docs/ARCHITECTURE.md) · [Transcript architecture](https://github.com/esengine/DeepSeek-Reasonix/blob/29c8349c3a489546285b092b166a72c2d127ea39/docs/TRANSCRIPT_ARCHITECTURE.md) · [Session reference architecture](https://github.com/esengine/DeepSeek-Reasonix/blob/29c8349c3a489546285b092b166a72c2d127ea39/docs/SESSION_REFERENCE_ARCHITECTURE.md) · [VS Code extension](https://github.com/esengine/DeepSeek-Reasonix/tree/29c8349c3a489546285b092b166a72c2d127ea39/vscode-extension)

[Maintainer branch transition](https://github.com/esengine/DeepSeek-Reasonix/discussions/2397) · [Current per-surface release page](https://github.com/esengine/DeepSeek-Reasonix/releases)
