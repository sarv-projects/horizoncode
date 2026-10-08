# HorizonCode v1 architecture glossary

This glossary defines domain terms only. Identity/overview is in [`02-DOMAIN.md`](02-DOMAIN.md),
canonical states/transitions are in [`11-LIFECYCLE.md`](11-LIFECYCLE.md), wire schemas
are in [`12-DOMAIN-SCHEMAS.md`](12-DOMAIN-SCHEMAS.md), and persistence/recovery is in
[`04-STATE-EVENTS.md`](04-STATE-EVENTS.md).

| Term | Meaning |
|---|---|
| **Thread** | Durable conversation identity and history for direct or managed interaction. |
| **Input** | User-authored content durably admitted to a Thread but not necessarily shown to a model yet. |
| **Turn** | One bounded interaction from promoted input through provider/tool continuation to a terminal or uncertain outcome. |
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
| **ToolBatch** | The complete set of tool calls returned by one provider response and validated/admitted as a unit before execution. |
| **Post-tool barrier** | Thread-owned result/control bookkeeping preventing dependent calls until required post-hooks settle; it is neither a callback event stream nor a new execution owner. |
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
