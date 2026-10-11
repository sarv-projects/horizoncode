# HorizonCode v1 architecture glossary


> **Authoritative integration amendment, 2026-10-10:** This chapter is read with the v2 decisions in `17-GOVERNANCE-DECISIONS.md` and source-backed integration chapters 19–26. Older designs of a competing Rust canonical Session, automatic model selection or unconstrained agents are superseded **only where explicitly contradicted**. Existing code does not become implemented by this edit.

## 2026-10-10 OpenCode-first reconciliation
### v2 additions
- **OpenCode substrate**: pinned upstream modules kept for provider, session and coding tool behavior.
- **Session foreign link**: stable identifier from OpenCode Session to kernel managed Run/Attempt. It is not a new conversation owner.
- **Pinned model**: explicit provider/model/harness configuration; changes only by user action or explicit reviewed fallback.
- **Effect broker**: kernel authorization and idempotency gateway for real tool side effects.
- **Evidence gate**: independent checks bound to final revision required before terminal success.
- **Warm worktree**: cleaned and validated reusable Git workspace with no active lease.
- **Fenced lease**: generation-bound authorization preventing stale workers from publishing side effects.
- **Healer**: bounded recovery strategy engine; L3 learned patterns advisory, L4 policy proposals never automatically privileged.
- **Universal perspective**: Create/Develop/Delegate/Operate UI on the same underlying project/run.

---

This glossary defines domain terms only. Identity/overview is in [`02-DOMAIN.md`](02-DOMAIN.md),
canonical states/transitions are in [`11-LIFECYCLE.md`](11-LIFECYCLE.md), wire schemas
are in [`12-DOMAIN-SCHEMAS.md`](12-DOMAIN-SCHEMAS.md), and persistence/recovery is in
[`04-STATE-EVENTS.md`](04-STATE-EVENTS.md).

| Term | Meaning |
|---|---|
| **Thread** | User-facing durable conversation identity. In V1 its canonical Session/Input/Message/Part/provider continuation is OpenCode-owned; Rust may keep only control-plane links/correlation to it. |
| **Input** | User-authored content durably admitted through the canonical OpenCode conversation path but not necessarily shown to a model yet. |
| **Turn** | One bounded interaction from promoted input through provider/tool continuation. Conversational message/part truth remains OpenCode-owned; Horizon control/effect facts are separately durable. |
| **Provider attempt** | One request/stream against a pinned model route within a Turn. |
| **Goal** | The durable record of a user's original managed objective. |
| **SpecVersion** | An immutable, reviewable version of requirements, scope, assumptions, exclusions and acceptance criteria. |
| **Run** | A managed execution of an approved SpecVersion and its Task graph. |
| **Task** | A dependency-ordered unit of managed work with explicit scope and acceptance criteria. |
| **Attempt** | A bounded strategy for one Task; it is not a process. |
| **WorkerExecution** | One concrete launch/incarnation performing an Attempt; it is not correctness evidence. |
| **DirectDelegation** | A bounded native child invocation owned by its parent Thread, with stable delegation lineage across process replacements; it is not a managed Task or Attempt and cannot claim PASS. |
| **Local execution** | One locally supervised process operation; it may support a direct Turn or a managed WorkerExecution. |
| **Application host** | The user-facing runtime for interaction and provider turns; it is distinct from the authority that executes effect-capable operations. |
| **ExecutionHost** | The operation/process execution boundary that consumes an exact scoped capability lease and returns bounded observations. |
| **ToolBatch** | The complete set of tool calls returned by one provider response and validated/admitted as a unit before execution. Rust owns Horizon admission/control facts; OpenCode remains canonical for conversational tool-call/result message parts. |
| **Post-tool barrier** | Horizon control-plane result/ack bookkeeping preventing dependent calls until required post-hooks settle; it references the canonical OpenCode call/result identity and is not a second transcript. |
| **UsageObservation** | An append-only, provenance-labeled record of observed or estimated provider/worker usage; estimates do not overwrite reports. |
| **Workspace** | A revisioned source area with ownership, lease and fencing semantics. |
| **CapabilityLease** | A short-lived, single-operation authority bound to an exact effect and execution scope. |
| **SecretUseLease** | A one-use authorization to make a specific secret available to an identified recipient for a pinned operation; it does not authorize the operation itself. |
| **EffectIntent** | A durable declaration and lifecycle for a requested side effect. |
| **System operation** | An autonomously initiated, durably identified operation attributed to an authenticated service; it does not itself grant authority. |
| **NeedsYou** | A unified view of an unresolved owner-owned question, approval or recovery decision; it is not an independent source of authority. |
| **Evidence** | Independent, revision-bound observations used by the RunController to decide whether acceptance criteria pass. |
| **Plugin** | A versioned extension package contributing services, actions, views, tools or data under a declared trust class. |
| **Service provider** | The selected implementation of a typed service definition in one resolved composition generation. |
| **Capability** | A bounded permission to perform a class of operation; not an implicit grant to all plugin behavior. |
| **UNKNOWN** | An outcome that may have taken effect but cannot yet be established from authoritative observation. |
| **ContextEpoch** | An immutable Thread context baseline pinning source heads, route/profile/toolset/policy and selected history; it does not rewrite the canonical transcript. |
| **ContextPacket** | One deterministic, bounded provider request context assembled from a ContextEpoch and explicit source/message ranges. |
| **Context pressure recovery** | The bounded, ordered ContextService process for reducing an oversized packet without dropping required sources or replaying an uncertain provider attempt. |
| **Semantic source set** | The selected context content and relevant generation/configuration bindings used for recovery suppression; bookkeeping-only cursor changes do not create a new set. |
| **DCP** | Deterministic Context Pruning: a policy inside the single ContextService for safe omission, extraction and compaction; not a second context owner. |
| **HookContribution** | A versioned, registered event-hook contract pinned by a CompositionGeneration; it can request only capabilities mediated by current Guard policy. |
| **MemoryCandidate** | A provenance-bearing proposal from explicit input, extraction or consolidation that MemoryService must validate before creating or superseding a canonical MemoryRecord. |
| **RepoGeneration** | A derived repository-intelligence snapshot bound to a repository/workspace revision and read policy; it is not canonical workspace truth. |
| **CompositionGeneration** | An immutable resolved set of service providers, schemas, capabilities and plugin package digests pinned by in-flight work. |
| **Retry suppression** | Owner-derived prevention of automatic repetition for the same operation, failure, relevant state and strategy; it does not reconcile or authorize uncertain effects. |
| **Guard** | The canonical authority decision owner for application-mediated effects; a prompt or profile declaration alone is not isolation. |
| **RunDurable** | The durability profile requiring event and directory-entry synchronization before commit acknowledgement; platform support must be established by its backend. |
| **ContextLedger** | Read-only projection of the exact model-visible context plan: typed entries, source/trust, token provenance, protection, cache class and inclusion reason. |
| **Trim** | Deterministic removal/artifactization of expendable model-visible payloads without deleting canonical history. |
| **Prune** | Reviewed relevance-based removal of stale context entries; protected entries cannot be removed. |
| **Compact** | Summary artifact over an older canonical history range; original history remains retrievable. |
| **Clear** | New model-visible context epoch; canonical conversation history remains available to History Search. |
| **AgentProfileV2** | Immutable rich agent profile revision pinning model/harness/reasoning, tool/skill/MCP/subagent/path/context/input controls and limits. |
| **Maintenance job** | Bounded deterministic or model-assisted helper that does not require a durable child agent/session/worktree. |
| **SymbolIndex** | Rebuildable RepoIntel projection of symbols/references bound to repository generation; source files/Git remain canonical. |
| **Local endpoint profile** | Explicit Ollama/LM Studio/LiteLLM/OpenAI-compatible provider configuration with observed capability metadata and no implicit cloud fallback. |
| **Artifact** | Immutable or revision-bound generated/workspace payload represented by metadata/digest and rendered/downloaded through bounded viewers. |
| **Mission Control** | Operational UI projection of Threads/Runs/workers/resources/approvals/usage; it is not a new state owner. |
| **Automation** | Durable scheduled or event-triggered invocation of a typed ActionDescriptor with explicit concurrency, missed-run, budget and permission policy. |
| **Metric provenance** | Required label declaring a numeric usage/performance value measured, estimated or unknown and identifying its source/method. |
| **LanguageServiceBroker** | RepoIntel routing owner for compatible editor-owned, Horizon-supervised or external language-service sources; it normalizes provenance/generation and does not imply ownership of every LSP process. |
| **PlanHandoffV1** | Immutable structured Plan→Build artifact carrying scope, decisions, task DAG, acceptance criteria, evidence refs and unresolved questions; Markdown/HTML are renderings. |
| **ContextEpochMarker** | Visible boundary created by clear/context reset, linking prior/new model-visible epochs while preserving canonical conversation/history. |
| **Cold-loading model** | Healthy reachable local/custom endpoint whose selected model has not produced a response yet because weights/queue are warming; distinct from connect/provider failure. |
| **Terminal artifact** | Bounded append-only or immutable command/process output with generation/digest and range/search retrieval, rather than an unbounded prompt payload. |
| **Runtime stage budget** | Named percentile target/measurement for one Horizon control-plane stage such as context compile, IPC, Guard, tool dispatch, index query or event fanout; excludes external model/tool work unless stated. |
