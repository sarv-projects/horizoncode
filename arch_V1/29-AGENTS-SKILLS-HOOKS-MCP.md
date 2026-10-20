# 29 — Agents, subagents, skills, hooks, MCP and extension profiles

**Status:** normative V1 target. This chapter expands the profile concepts in §§12, 15, 16 and 22 without creating a second agent/session engine.

## 29.1 Design goals

HorizonCode must allow advanced users to shape specialists as deeply as modern coding agents while remaining safe and cheap enough for local models.

The system therefore separates five concepts:

1. **Agent profile** — a named model+harness+instructions+capability policy that can own a context-bearing session.
2. **Skill** — reusable instructions/resources/scripts loaded on demand; not a security principal.
3. **Tool** — a typed capability exposed to a model or deterministic runtime.
4. **Hook** — a lifecycle reaction with bounded effects and explicit blocking/advisory semantics.
5. **Maintenance job** — a small deterministic or model-assisted job that does not deserve a child session.

The OpenCode-derived host remains the current V1 direct-session substrate. Provider transport may migrate only through A-V2-27 beneath that owner; profile resolution does not create a second session/tool runtime.

## 29.2 AgentProfileV2

```ts
type AgentContextIsolationV2 =
  | "fresh"                 // no parent conversation, only TaskPackage/explicit refs
  | "conversation_slice"    // reviewed bounded parent history selection
  | "fork"                  // immutable fork snapshot + new child history

type AgentInputModeV2 =
  | "default"
  | "read_only"
  | "careful"
  | "sandbox_auto"

type PathRuleV2 = {
  effect: "allow" | "ask" | "deny"
  operation: "read" | "write" | "execute" | "watch"
  glob: string
}

type AgentToolRuleV2 = {
  effect: "allow" | "ask" | "deny"
  toolPattern: string
  resourcePattern?: string
}

type AgentVariantV2 = {
  match: {
    providerId?: string
    modelPattern?: string
    protocol?: "responses" | "chat_completions" | "anthropic_messages" | "custom"
  }
  instructionPatchRef?: ArtifactRef
  requestOverrides?: Record<string, unknown>
  toolExposureProfile?: string
  effort?: ReasoningSelection
}

type AgentProfileV2 = {
  schemaVersion: 2
  profileId: AgentProfileId
  revision: number
  name: string
  description: string
  source: "builtin" | "user" | "project" | "plugin" | "external"
  roles: Array<"main" | "subagent">

  purpose: string
  whenToUse: string
  whenNotToUse: string

  adapter: {
    kind: "native" | "acp" | "cli" | "container" | "remote"
    adapterId: string
  }

  model: ModelSelection
  harness: string
  reasoning: ReasoningSelection
  variants: AgentVariantV2[]

  instructions: {
    baseRef?: ArtifactRef
    extraRefs: ArtifactRef[]
    maxCompiledTokens: number
  }

  tools: AgentToolRuleV2[]
  allowedSkillIds: string[]
  deniedSkillIds: string[]
  allowedMcpServers: string[]
  allowedMcpToolPatterns: string[]
  allowedSubagentIds: string[]
  deniedSubagentIds: string[]
  pathRules: PathRuleV2[]

  context: {
    isolation: AgentContextIsolationV2
    maxParentHistoryTokens?: number
    allowImages: boolean
    allowDocuments: boolean
    allowArtifacts: boolean
  }

  inputMode: AgentInputModeV2
  memoryPolicy: "none" | "project_read" | "profile_read" | "reviewed_write"
  isolation: "read_only" | "workspace" | "worktree" | "external"
  lifecycleHooks: AgentHookBindingV2[]
  capabilityCeiling: CapabilityId[]
  permissionCeilingDigest: Digest
  limits: AgentLimits
  maxParallelChildren: number
  enabled: boolean
  definitionDigest: Digest
}
```

### Rules

- Profile rules and explicit sorted, unique `capabilityCeiling` **narrow** permissions; they cannot widen accepted Task/Spec scope or current Guard policy. Missing/empty ceiling grants no managed effect scope. Never infer capability IDs from tool/path/MCP patterns.
- A child receives the intersection of parent delegation authority, child profile ceiling and current policy.
- Changing a profile creates a new immutable revision. Existing work keeps the pinned revision.
- Provider/model/harness are explicit. A variant tunes one selected model; it is not automatic model routing.
- Provider-specific profile variants may be stored as neutral metadata or convenient files such as `agent.openai.md` / `agent.anthropic.md`, but resolution must produce one versioned `AgentProfileV2`. File naming is UX, not authority.
- A missing variant falls back to the base profile only if the base requirements are supported. It never silently chooses another provider.
- `sandbox_auto` corresponds to reduced prompting only when the runtime has an enforced sandbox. Otherwise it is unavailable.

#### V1 managed profile ownership

Core Config is the single mutable owner of `AgentProfileV2` definitions and immutable revisions. For the first managed V1 vertical, accept only built-in and explicitly user-owned profiles; project/plugin/external profile trust resolution remains unavailable until its source and trust rules are implemented. Core resolves a user-owned profile only within the authenticated ServerAuth subject's namespace. Authenticated Core ingress supplies the selected canonical profile ID, revision and strict digest-free definition to HostKernel; HostKernel validates the accepted Task/Spec selection, derives and persists the Task's profile owner binding from the authenticated envelope (never a body owner), recomputes canonical digests and mints the opaque typed proof. Attempt admission must match the Task-pinned revision and owner. A request body or model cannot construct this proof or supply a trusted digest.

The Core `ContextService` is the single owner that compiles bounded model context. `ContextLedgerV2` remains a read-only projection; a task-specific `ContextSelectionV1` records the selected mode, bounded source/artifact refs, revisions, trust/inclusion provenance, and exact digest. It never copies the canonical transcript into managed state. Rust managed control stores only the immutable per-Attempt profile/context refs and digests in `DelegationBindingV1`; it does not create a second global profile registry or transcript owner. Rust computes the effective capability ceiling by intersecting accepted Task/Spec scope, the profile ceiling, and current Guard policy. Missing or stale proofs deny admission before preparation.

This same profile authority applies to V1 direct-session children. Core Config resolves the
trusted `AgentProfileV2` revision; the resolved profile must drive the child's actual model,
harness, instructions, tool exposure and effective permission scope before Core pins the
profile revision/digest and scope digest to the child Session and Direct Attempt. The legacy
`Agent` configuration may be migrated into versioned profiles or retained as a stable
selector alias only after that mapping resolves to an immutable profile revision. It cannot
remain an independent authority or be hashed as though it were the profile while its values
still drive execution. Until profile resolution and runtime projection are complete, direct
Task dispatch and resume remain unavailable; they must not inherit an unpinned parent model
or silently advance to a newer profile revision.

Core Config owns the explicit `agent_profile_selectors` mapping for Task-compatible selectors:
each entry is exactly `{ selector, profileId, revision }` and targets one immutable profile
revision. V1 reads it only from the global user-owned `opencode.json`/`.jsonc`; project config
cannot define or override child selectors. Both canonical IDs and compatibility aliases resolve
through this table; selector names or profile display names are never implicit aliases. Reject
duplicate declarations (even identical ones), conflicting selectors, missing or disabled target
revisions, and owner-namespace mismatches. Updating a profile does not retarget an existing
selector automatically; the user-owned mapping must be changed deliberately. A child Session
resumes its pinned revision and is rejected if a changed mapping no longer names that same
revision. The selector is lookup metadata, never authority from a Task request or model output.
### HarnessProfileV1 — provider/model is not the harness

`harness` is a first-class, versioned request-shaping profile independent from the selected
provider/model. It exists because small/open models often perform materially better when the
system prompt, tool vocabulary, message lowering and response parser match the harness they
were trained or tuned against.

```ts
type HarnessProfileV1 = {
  harnessId: string
  revision: number
  displayName: string
  source: "builtin" | "user" | "project" | "plugin"
  supportedWireApis: Array<"responses" | "chat_completions" | "anthropic_messages" | "custom">
  systemPromptRef: ArtifactRef
  toolProjection: "native_rich" | "minimal" | "bash_only" | "compatibility" | string
  messageCodecId: string
  responseCodecId: string
  structuredCallPolicyId: string
  contextPolicyId: string
  outputPolicyId: string
  capabilityRequirements: string[]
  definitionDigest: Digest
}
```

Rules:
- the user-visible provider/model selection and harness selection are separate;
- selecting/changing a harness **never** changes provider/model, incurs a paid fallback, or
  silently routes to another endpoint;
- HorizonCode may recommend a harness from observed provider/model capabilities, but an
  already-pinned harness never changes without an explicit user/profile revision;
- incompatibility is reported as `UNAVAILABLE` with the missing capability/wire API, not fixed
  by silently changing model or provider;
- `minimal`/`bash_only` profiles intentionally support models with weak function calling or
  very small context windows; their shell effects still cross Guard/ExecutionHost;
- compatibility profiles may emulate another harness's prompt/tool/message surface while
  executing through HorizonCode's native runtime. External CLIs are used only through an
  explicit external-agent adapter;
- every harness has recorded prompt/tool-schema/context overhead and can be benchmarked
  independently from model quality.

V1 built-in harness families should include at least:
`native-rich`, `native-minimal`, `bash-only`, and a compatibility-profile mechanism. Specific
Claude/Kimi/Qwen/SWE-style profiles are optional/versioned compatibility assets, not architectural
dependencies and not grounds for copying proprietary prompts.

## 29.3 Built-in context-bearing specialists

V1 ships a deliberately small set. Users may replace or add profiles.

| ID | Role | Default authority | Typical model strategy |
|---|---|---|---|
| `builtin.build` | primary implementation | scoped edit/test/tool access | user-selected main |
| `builtin.plan` | primary planning | read + plans only | user-selected, often cheaper |
| `builtin.explorer` | repository discovery | read/index/LSP only | fast/small preferred |
| `builtin.architect` | deep design/impact analysis | read + plan artifacts | stronger reasoning if user selects |
| `builtin.librarian` | docs/web/source research | read/web/docs, no code write | fast research model |
| `builtin.looker` | image/PDF/UI inspection | read media/browser snapshot | vision-capable selected model |
| `builtin.reviewer` | code review | read/diff/test evidence | independent from author when possible |
| `builtin.test-debugger` | test/runtime diagnosis | test/terminal + scoped edits | selected coding model |
| `builtin.system-operator` | bounded local/system operations, service/process/environment diagnosis | terminal/process/resource tools under Guard; no implicit production/admin authority | fast/reliable selected model or deterministic workflow |
| `builtin.browser-qa` | browser/DOM functional and visual verification | browser/DOM/console/network read + scoped interactions; no source write unless explicitly delegated | vision/tool-capable selected model |
| `builtin.history-search` | prior conversation/artifact retrieval | history/search read only | small/fast model or retrieval-only |
| `builtin.verifier` | acceptance verification | verification permit, read-only subject | separate execution; model optional |

`builtin.verifier` cannot award PASS by itself. VerificationService validates its evidence.

## 29.4 Jobs that should not be full agents by default

These are typed maintenance jobs and may use deterministic code or a tiny selected model:

- generate thread title;
- generate commit/PR summary;
- rewrite a repository search query;
- summarize a bounded conversation range;
- propose stale context entries to prune;
- trim old tool-result payloads;
- classify artifacts for retention;
- detect language/framework manifests;
- generate a concise progress recap.

They have input/output schemas, token/time ceilings and provenance but no worktree, nested children or independent permission authority.

## 29.5 Subagent dispatch and messaging

A parent may spawn a child only when:

1. the requested child ID is allowed by profile and Guard;
2. the objective can be separated from the parent's immediate critical section;
3. the expected benefit exceeds spawn/context/integration cost;
4. the scheduler can allocate required filesystem/runtime/data resources;
5. concurrency limits and budgets allow it.

Typed request:

```ts
type SubagentRequestV2 = {
  requestId: Id<"SubagentRequestId">
  parentExecutionId: WorkerExecutionId
  profileRevision: ProfileRevisionRef
  objective: string
  outputContract: ArtifactRef
  contextMode: AgentContextIsolationV2
  contextRefs: ArtifactRef[]
  workspaceRequest?: WorkspaceRequestV1
  deadline?: Timestamp
  limits: AgentLimits
  replyMode: "blocking" | "background"
}
```

Typed reply:

```ts
type SubagentReplyV2 = {
  requestId: Id<"SubagentRequestId">
  childExecutionId: WorkerExecutionId
  status: "completed" | "blocked" | "failed" | "cancelled" | "unknown"
  resultRef?: ArtifactRef
  evidenceRefs: ArtifactRef[]
  changedRevision?: RevisionSetV1
  limitations: string[]
}
```

**Two execution lanes.** Direct-session delegation creates/resumes a linked Core child
Session and does not require Goal/Task/Attempt. Managed delegation is a Rust-owned Task
Attempt under an accepted SpecVersion and requires the immutable `DelegationBindingV1` and
independent verification. The same child/profile abstractions may serve both lanes, but a
direct child result cannot be promoted into managed evidence without the managed Attempt,
receipt, artifact and revision checks. The direct parent Core Session and each child Core
Session remain the only transcript owners for their respective conversations.

**Lifecycle operations and ordering.** The canonical `agents.*` surface in §33.12 consists
of `spawn`, `message`, `result`, `wait`, `inspect`, `list`, `capabilities`, `cancel` and
`graph`; a compact model-facing Task tool may project only the operations useful to its
profile. Spawn resolves a trusted profile revision, validates context/scope and reserves
bounded runtime/resource capacity before process/session creation. Persist the parent-child
lineage and request identity before reporting a successful spawn. A failed reservation or
creation releases only reservations that have not crossed the durable launch boundary; a
launch whose outcome cannot be observed is reported UNKNOWN and reconciled under the same
identity.

`message` enqueues bounded data for the identified child and does not imply that a turn was
started. `followup` is a message with an explicit wake/turn trigger; it cannot mutate an
already-running request or splice into an in-flight model token stream. Both use stable
request/message IDs, bounded payload refs, ownership checks and explicit queued/delivered/
acknowledged/expired/unknown outcomes. `wait` observes a named child or bounded subtree until
new activity, terminal state or deadline; timeout reports the still-current child state and
does not cancel it. `cancel` fences future child admissions before requesting cancellation
of owned work, then reports cancelled/still-running/unknown from observed lifecycle state.
`result` is an idempotent bounded read of the terminal delivery and its evidence refs.
`inspect/list/graph` are projections and never grant control over a child owned by another
parent. In direct mode, Core persists parent/child Session linkage and owns message and
turn-delivery state; the Rust resource owner persists only its own capacity/lease facts. In
managed mode, Rust persists Task/Attempt lineage and delivery/effect/evidence cursors. The
same logical delivery ID may correlate these projections, but the stores are not merged.

At dispatch, freeze the profile revision, selected provider/model/harness policy, context
selection digest, parent capability ceiling, workspace/source revision, budget/deadline and
resource lease refs. A child may have a separately configured selection only when the user
or accepted managed policy explicitly permits it; quota, failure or capacity pressure never
silently changes provider/model. Every later child action re-resolves the live parent/child
lineage, owner epoch, lease and Guard policy. A child profile can only reduce inherited
authority. Late messages/results from an old epoch are retained as stale/unknown evidence or
rejected; they cannot replace a newer child execution or Task result.

For the first managed Task in a Run, Rust persists a logical root-coordinator
`WorkerExecutionId` bound to the authenticated top-level Core Session. It is a lineage record
for the existing Core coordinator, not a new worker process/runtime. HostKernel derives its
principal, Session/Location, OwnerLog and transport/process-incarnation binding from authenticated
owners. The child Attempt owns the P8 resource/budget lease; the root record does not claim a
separate worker quota, and shared Core process measurements are counted once. Nested managed
children require the existing active claimed parent WorkerExecution. P8 pins the child lease to
immutable Task/Attempt/profile/context/Spec/workspace facts before admission, then P1's atomic
DelegationBinding append supplies a digest that P8 persists on the still-RESERVED lease before
claim/dispatch. Missing incarnation or any mismatch keeps admission closed (VEO-021).

This adapts OpenCode's Task profile resolution, parent permission propagation and
foreground/background cancellation, plus Codex's root-owned agent tree, pre-spawn
reservation, persisted lineage, message/follow-up/wait/interrupt tools, queue-only mailbox,
completion reporting and resume ownership checks. In direct mode, parent/child Session
linkage and transcript remain Core-owned while Rust owns resource and effect facts. In
managed mode, Rust owns Task/Attempt/effect authority. Neither source runtime is copied as a
second scheduler or authority plane. Source pins and exact inspected paths are in §42.12.

Agent-to-agent text is data, never authority. Messages cannot directly grant tools, rewrite another Goal, change another workspace fence or mark a Task passed.

Parallel siblings never share an unmediated mutable process/database/worktree.

## 29.6 SkillManifestV2

A skill is progressively disclosed:

1. catalog entry: ID/name/short description/when-to-use;
2. selected manifest;
3. `SKILL.md` body;
4. only referenced resources/scripts needed for the invocation.

```ts
type SkillManifestV2 = {
  schemaVersion: 2
  id: string
  version: string
  name: string
  description: string
  whenToUse?: string
  argumentHint?: string
  userInvocable: boolean
  modelInvocable: boolean

  execution: "inline_guidance" | "forked_job" | "deterministic"
  requestedAgentId?: string
  requestedModel?: ModelSelection
  requestedEffort?: ReasoningSelection

  allowedToolPatterns: string[]
  requestedPermissions: string[]
  inputSchema?: ArtifactRef
  outputSchema?: ArtifactRef

  resources: Array<{
    kind: "script" | "reference" | "asset" | "template"
    path: string
    digest: Digest
  }>

  maxBodyTokens: number
  provenance: ArtifactRef
}
```

A skill's `allowedToolPatterns` is a ceiling/hint, not a grant. Scripts execute through the ordinary effect path.

### Skill identity and shadowing

`SkillManifestV2.id` is the authority identity; display/name aliases are UX. Governed HorizonCode
must not use a bare skill name as the sole identity of a sealed built-in.

- product built-ins use reserved stable IDs such as `builtin.horizon-docs`;
- user/project skills use separate namespaces/revisions and may share a display name without
  replacing a built-in;
- a project/user/plugin skill cannot shadow, replace or mutate a sealed built-in by defining the
  same `name`;
- duplicate aliases are disambiguated in UI and model guidance by source/ID;
- compatibility adapters that currently expose name-keyed OpenCode skills must resolve into the
  versioned Horizon SkillRegistry before governed use;
- explicit user replacement of a *replaceable* built-in is a Profile/Composition decision with
  a pinned replacement ID/digest, never accidental filesystem precedence.

The current OpenCode name-keyed loader is therefore a reuse substrate, not the final governed
identity boundary.

### Required built-in skill: HorizonCode Docs

`builtin.horizon-docs` provides targeted retrieval over the exact installed HorizonCode architecture, API/config and user documentation. It is invoked when an implementation/runtime question requires product-specific truth.

**Ownership:** the canonical product asset is Horizon-owned under
`packages/core/src/horizon/skills/horizon-docs/SKILL.md` (or its post-P10 renamed package
equivalent). Product registration uses an embedded/bundled `SkillV2` source. A project-local
`.opencode/skills/horizon-docs/SKILL.md` may exist during migration/development only as a
compatibility shim; it is never the canonical product copy and HorizonCode must not require
`.opencode/` to expose its own built-ins.

It must:
- retrieve by section/symbol rather than inject all docs;
- return file, heading, revision and bounded excerpts/references;
- prefer normative architecture over stale plans;
- label historical/superseded material;
- consume no network when local docs are sufficient.

This replaces the temptation to place the complete HorizonCode manual in every system prompt.

## 29.7 HookBindingV2

Canonical hook events:

```text
session_start
session_resume
session_stop
agent_start
agent_stop
before_model_call
after_model_response
before_tool
after_tool
tool_failure
permission_denied
before_patch_commit
file_changed
before_compaction
after_compaction
before_verification
after_verification
before_release
after_release
run_blocked
checkpoint_created
recovery_started
recovery_finished
```

```ts
type AgentHookBindingV2 = {
  hookId: HookId
  event: string
  required: boolean
  mode: "blocking" | "advisory" | "async"
  matcher?: {
    toolPattern?: string
    pathGlob?: string
    agentPattern?: string
  }
  timeoutMs: number
  maxOutputBytes: number
}
```

Handlers may be:
- a registered deterministic internal handler;
- a sandboxed shell/script effect;
- a skill invocation with fixed schema.

Blocking hook results may **deny** or request a safer rewrite. They cannot turn a Guard DENY into ALLOW. Async hooks cannot block canonical owner progress and must tolerate loss/retry according to their delivery contract.

Project hooks are disabled until the project is trusted.

## 29.8 McpServerProfileV2

```ts
type McpServerProfileV2 = {
  schemaVersion: 2
  serverId: string
  source: "user" | "project" | "plugin" | "managed"
  transport:
    | { kind: "stdio"; executableRef: ArtifactRef; args: string[] }
    | { kind: "streamable_http"; url: string }
    | { kind: "json_rpc_http"; url: string }

  auth:
    | { kind: "none" }
    | { kind: "oauth"; authProfileId: string }
    | { kind: "headers"; headerSecretRefs: Record<string, string> }

  env: Record<string, string>
  allowedToolPatterns: string[]
  deniedToolPatterns: string[]
  timeoutMs: number
  maxResponseBytes: number
  networkPolicyRef: string
  trustClass: "trusted_local" | "trusted_remote" | "untrusted"
}
```

Environment/header substitutions resolve through SecretBroker; raw secret values never enter configuration, transcript, analytics or model context.

Dynamic `tools/list_changed` creates a new toolset generation. Active provider turns keep their pinned generation.

**Server-mode exposure and spawned-server confinement (scope, 2026-10-18).** V1 consumes MCP servers; HorizonCode does not expose itself as an MCP server to third-party clients — recorded as post-V1 candidate `DEC-V1-23` (current Codex source and the Claude Code CLI reference likewise do not expose the agent itself; their structured surfaces are Codex `app-server`/`exec-server` and Claude headless/SDK, which Horizon's CLI `run`/`serve` and future SDK cover). Spawned stdio MCP servers are Guarded effects: process start runs through ExecutionHost with an OS-confinement profile and workspace fence, and a missing confinement guarantee disables that server rather than running with ambient host access (§14.6; P1.3 origin closure).

## 29.9 Custom commands, keybindings and Quick Actions

One ActionDescriptor registry backs slash command, command palette, button, keybinding and SDK/API invocation.

Custom command:

```ts
type CustomActionV2 = {
  id: string
  description: string
  invocation:
    | { kind: "skill"; skillId: string }
    | { kind: "agent"; agentId: string }
    | { kind: "typed_command"; actionId: string; args: unknown }
  argumentSchema?: ArtifactRef
  requiredCapabilities: string[]
  iconRef?: ArtifactRef
  keybinding?: string
  scope: "user" | "project"
}
```

Quick Actions are pinned `CustomActionV2` entries; they do not contain untyped privileged shell strings.

## 29.10 Security and prompt-injection boundaries

- Agent, skill, hook and MCP descriptions are untrusted text until their source/trust is resolved.
- The model never receives raw secret values.
- Model-generated requests are parsed into typed tool intents before authorization.
- Child profile inheritance only narrows.
- Path rules use canonical paths and symlink/reparse checks at execution time.
- A project cannot override managed/user security floor.
- An MCP tool result can provide data but cannot activate another tool or grant a permission.
- Hook/skill content cannot mutate policy files unless a separate authorized edit effect explicitly targets those files.
- Provider-specific profile variants are configuration, not executable code.

## 29.11 UI requirements

Agent Library:
- Primary / Specialist / Custom / External tabs;
- effective model/provider/harness;
- context mode;
- tools/skills/MCP/subagents;
- path access;
- input/permission mode;
- hard limits;
- configured/observed/enforced capability indicators;
- revision/provenance and current consumers.

Subagent panel:
- tree/graph of parent-child relationships;
- Running / Needs Input / Idle / Errored / Complete;
- elapsed time, selected model, token/cost if known;
- workspace/resource lease;
- last meaningful progress;
- pause/cancel where enforceable;
- stream/result inspect without forcing all child content into parent context.

## 29.12 Structured Plan→Build handoff

Plan and Build may share one conversation, fork, or use distinct agent profiles, but execution
must not depend on Build reinterpreting an unstructured planning transcript.

`PlanHandoffV1` is an immutable artifact:

```ts
type PlanHandoffV1 = {
  schemaVersion: 1
  handoffId: Id<"PlanHandoffId">
  planRevision: number
  goalRef?: GoalRevisionRef
  specRef?: SpecVersionRef
  objective: string
  inScope: string[]
  outOfScope: string[]
  assumptions: Array<{ text: string; evidenceRefs: string[] }>
  decisions: Array<{ id: string; decision: string; rationale: string; evidenceRefs: string[] }>
  tasks: Array<{
    taskKey: string
    objective: string
    dependsOn: string[]
    expectedChangedScope: string[]
    acceptanceCriteria: string[]
    evidenceRefs: string[]
  }>
  importantRefs: Array<{ kind: "symbol" | "file" | "artifact" | "doc"; ref: string }>
  hazards: string[]
  unresolvedQuestions: string[]
  createdByProfileRevision: ProfileRevisionRef
  sourceContextDigest: Digest
  digest: Digest
}
```

Build pins the handoff revision when execution starts. A discovered requirement change creates a
new reviewed handoff/spec revision or a visible deviation; it never silently edits the plan's
meaning. HTML/Markdown plan renderings are presentation projections of the structured artifact.

## 29.13 Delegation depth, communication and active-work limits

Subagent configuration includes explicit:
- maximum nesting depth;
- maximum active direct children;
- maximum total children per parent/run;
- per-child context/token/tool/time budgets;
- maximum pending inter-agent messages and bytes;
- blocking-wait timeout and cancellation behavior.

Agent mail/results are delivered at safe input boundaries rather than spliced into an in-flight
model token stream. Delivery has request/message IDs and bounded queues. Overflow produces a
visible backpressure/error state rather than dropping authority-relevant results.

A parent cancellation that races a child launch must report whether the child never started,
was cancelled, or continues in background under an owned execution. Never tell the model a child
was not executed when its process may still be running.

## 29.14 Acceptance gates

- Profile variant resolution deterministic across provider/model changes.
- A child denied by parent policy cannot launch even if its own profile allows it.
- Path deny survives symlink/reparse attempts.
- A skill cannot invoke an undeclared/denied tool.
- A malicious skill/MCP description cannot change effective permission.
- Required hook timeout blocks safely; optional hook timeout is visible and follows declared policy.
- Project hooks do not run before trust.
- MCP reconnect/tool-list change never rebinds an in-flight tool call.
- Parallel child agents with disjoint tasks integrate correctly; conflicting tasks serialize or isolate.
- Maintenance jobs never allocate unnecessary worktrees/sessions.
- Horizon Docs retrieves the current normative section without injecting the entire documentation set.
- Plan→Build retains task dependencies, scope and acceptance criteria exactly across profile/thread handoff.
- nesting/fanout/message limits fail visibly and cannot be bypassed by child profiles.
- cancellation during child spawn leaves no unowned process and reports the true launch state.
- parent compaction does not lose a completed background child result; result attachment is bounded and explicit.

## 29.15 Contract convergence bindings

The operative interfaces and typed failure conventions are in §37. New machine-readable SkillManifestV2, HookBindingV2, McpServerProfileV2 and SubagentDeliveryV1 schemas are in contracts-v2. Existing AgentProfileV2/PlanHandoff/Harness schemas remain. The capability-registry-v1.json design seed resolves historical fs.*, exec.*, agent.* aliases ONLY through the current canonical ID and Guard. A project alias cannot shadow sealed Horizon IDs. Registry entries with unknown effect class must remain unavailable to execution until reviewed/classified. This is a target LLD, not implemented registration or secure external-agent delivery.

## 29.16 Implementation/source boundary

External products can inspire profile, provider, skill, hook or MCP behavior only through 42 source provenance. Their registries are not imported as competing runtime authorities.

All extension-visible actions resolve to canonical 33 capability IDs and cross 14 Guard for effects. Provider/model/harness configuration remains owned by existing OpenCode/Horizon config services. Current implementation status belongs in HANDOFF.md.
DOFF.md.

## 29.17 DAG-first coordination and shared headless specialists (A-V2-30)

Retain **one Rust managed Goal/SpecVersion/Run/Task/Attempt owner**. Represent dependencies and hierarchical ownership independently: Task `dependsOn` forms an acyclic graph, while child attempts/specialists have exactly one parent scope. Avoid copying JCode's separate swarm-plan/session authority into Horizon.

- Two scheduling styles over the same Rust DAG: lightweight bounded fan-out for precise independent research; comprehensive goal decomposition/review for ambiguous migrations and cross-file design. No mandatory graph for ordinary direct editing. Both have an explicit graph-wide total-member cap, live-worker cap, recursion/depth/repair cap, resource budget and integration collision control.
- Task handoffs use typed artifact references, current source revision, criteria, known unknowns and evidence. A model can propose new child tasks, but only the authenticated coordinator validates edges, detects cycles, guards scope changes, reserves resources and persists graph edits. “Done” by a worker does not mark a parent PASS.
- Exploration/read-only workers may be low-overhead headless attachments to a shared Core/provider infrastructure; effectful children get fenced process/workspace isolation. Avoid one new full TUI/provider host/Rust observer/worktree per small helper. SessionLink correlation is explicit and never duplicates the Core transcript.
- Critique/review is a verifiable separate step when needed; a reviewer may identify missed coverage but cannot rewrite accepted user criteria retroactively or approve its own unverified work. Source, test and integration evidence are compared to the final repository revision.
- Communication defaults to dataflow along dependency edges (immutable artifact refs/typed results); optional bounded mailbox for exceptions, not uncontrolled all-to-all model chat. Parent compaction/restart must not orphan a child receipt or accepted result.
- Backpressure from memory/FD/disk/provider limits queues READY tasks without changing user-pinned provider/model. Expired/leaked workers are fenced, settled and cleaned up only when owner/lease is known.

JCode `SWARM_TASK_GRAPH.md` is a **Being implemented** design reference and `MULTI_SESSION_CLIENT_ARCHITECTURE.md` is **Proposed**; neither is automatic implementation proof. Accepted tests in §32.32 include DAG cycle/coverage, 20-worker contention, user file collision and crash safety.

## 29.18 Exact DAG worker contract, dataflow and failure semantics

**Worker is not scheduler.** Managed coordinator owns Task identifiers, dependencies, priority, run budget, accepted specification, child depth, lease and approval; individual agents may propose a change but never commit task transitions or acceptance. Preserve the direct Session flow without mandatory DAG.

~~~ts
type TaskProposalV1 = {
  runId: string; parentTaskId?: string; expectedGraphRevision: string;
  proposedTasks: {
    tempId: string; title: string; purpose: string; deps: string[];
    criteriaIds: string[]; readScopes: string[]; writeScopes: string[];
    requiresTools: string[]; requestedProfile: string; estimatedUsage?: {tokens?:string; memoryBytes?:string};
  }[];
};
type TaskDeliveryEnvelopeV1 = {
  runId: string; taskId: string; attemptId: string; workerExecutionId: string;
  acceptedSpecDigest: string; sourceRevision: string; parentScopeDigest: string;
  taskCriteriaIds: string[]; dependencyArtifactRefs: string[];
  capabilityGrantDigest: string; providerSelectionDigest: string;
  deadlineMs: string; resourceReservationRef: string;
};
type CandidateTaskResultV1 = {
  attemptId: string; status: "PRODUCED" | "BLOCKED" | "FAILED" | "UNKNOWN";
  artifacts: {ref:string;sha256:string;mime:string;sourceRevision:string;fidelity:"FULL"|"SAMPLE"}[];
  touchedFiles: {pathRef:string;sourceRevision:string;access:"READ"|"WRITE"}[];
  toolReceiptRefs: string[]; proposedEvidenceRefs: string[];
  missingCriteriaIds: string[]; errors: {category:string;safeMessage:string}[];
};
~~~

**Plan/graph compile:** accept user-approved full SpecVersion criteria; decompose into tasks with explicit input/output artifact kinds, exact criterion ID coverage, scopes and dependency edges. Reject a graph that lacks accepted criteria unless the user explicitly defers them; no Task may secretly extend write roots or increase model spend. Topologically sort using stable ID order; every leaf must have explicit useful output or bounded inspection deliverable. Critical-file single-writer rule is a default; concurrent readers are safe only under workspace policy. Resolve parent dependencies and project sources through the same Rust Task owner.

**Scheduling and handoff:** from §21.11 READY list, reserve resources and bounded worker, then send `TaskDeliveryEnvelopeV1` with immutable task criteria/scope/dependency refs and only **minimum necessary** context. Do not clone the full parent conversation into every child; child output is typed candidate artifacts and a bounded prose summary. Child cannot directly mark task PASS, request arbitrary further privileges or silently mutate the accepted plan. Adding a dependency is a versioned graph edit that invalidates affected readiness/review; rerunning a completed task must preserve previous evidence/attempt lineage.

**Task graph invariant:** at any time exactly one authoritative Task revision exists; all edges refer to same managed Run and accepted SpecVersion; graph remains acyclic; every task has finite attempt, deadline, depth, member and cumulative token/cost bounds. Parallel write scopes either do not overlap or hold serialized workspace leases; “unknown writes” is treated conservatively as overlap. Each descendant's capability grant = intersection(parent grant, current policy, user consent, platform support, task requested subset). Never derive grant from model text.

**Result ingestion:** verify worker identity+epoch, attempt lease, artifact SHA/fidelity, actual file/source revision and ordered effect receipts. Attach candidate evidence; a separate verifier assesses criterion IDs, tests/diagnostics and source revision. Downstream Task only becomes READY after trusted PASSED verdict on required predecessors. If a task fails, classify deterministic repair, provider retry, code failure, policy denied or UNKNOWN effect; bounded healing cannot mark PASS. Dead/late child delivery cannot overwrite newer Attempt or finalization. Process exit alone is not completion.

**Reviewer and finalizer:** verifier must not self-approve the same effectful Attempt, and reviewer can report uncovered acceptance but cannot invent a new accepted criterion. Before Run SUCCEEDED, hold integration fence, re-scan source revision, compare complete criterion coverage and all required receipts; reject if user edits changed revision or any UNKNOWN required effect remains. Return `NEEDS_YOU` with actionable known evidence rather than fabricated success. Read-only parent-child delegation for direct mode remains useful without creating a managed Run.

**Controlled model budget:** separate model token/cost and process RAM budgets; no forced “small model for worker” downgrade. Optional explicitly approved specialist model/harness bindings are frozen in the delivery envelope and visible in spending observations. Resume/recovery recreates missing ephemeral queues by replaying Rust OwnerLog and canonical evidence refs, not old in-memory agent messages.

**Tests:** invalid DAG cycle/cross-Run edge, 21st child beyond configured 20 limit, parent scope escalation, random late child after cancellation, duplicate delivery, conflicting user edit, dead worker with receipts, missing artifact or wrong hash, independent reviewer source-stale, parent compaction, 20-session bounded overhead and no second transcript owner. Follow §32.33 for exact fixtures.

## 29.19 ACP/CLI/remote adapters and subagent delegation completeness

Local Rust-owned subagents and worker/DAG execution are V1 goals under A-V2-31. Outbound external ACP/CLI/remote agent integration is post-V1 and unavailable; this section defines its future adapter contract, not a V1 release gate.

`AgentProfileV2.adapter.kind` already permits `native | acp | cli | container | remote`. This field is **profile configuration**, not proof that those runtime adapters exist. The pinned OpenCode ACP agent-side server is NOT Horizon's ACP client for delegating work to another running coding agent; §37.20 owns the proposed client interface, version negotiation and bounded event protocol.

Required capability negotiation by adapter: exact protocol version, session lifecycle, stream/cancel support, external tool/permission observability, artifact result format, model/provider routing and spend reporting, OS sandbox guarantees and health/reconnect. Return UNAVAILABLE when a required feature cannot be proven, rather than blindly treating a generic CLI as privileged Horizon code. Avoid adapter-specific UI/Task stores: return candidate SubagentDelivery through existing mailbox and Rust task lease.

The parent capability intersection, user-reviewed model/account/cost policy, active Task source revision, lease epoch and selected workspace must be frozen per dispatch. A CLI child has no right to launch additional shells or mutate arbitrary paths just because its executable started successfully. For unobservable external tooling, only an explicitly trusted separate backend mode may be offered with truthful weaker safety guarantees; governed effectful delegation remains disabled until the action can be pre-authorized and target outcome reconciled.

Required errors: unsupported protocol/version, lost external process, denied tool capability, unauthorized nested delegation, spurious event replay, mismatched model selection, remote prompt/tool injection, arbitrary cwd escape, cancellation after remote effect, session ownership confusion and non-idempotent UNKNOWN. §32.35 tests and §20.13 source placement are the acceptance owner.

## 29.20 V1 child delivery evidence and bounded context (A-V2-33)

V1 uses the single lane-tagged §12.11 `SubagentDeliveryV1`. In `direct_session`, Core binds the authenticated parent/child Session lineage, trusted profile revision/digest and effective permission-scope digest. In `managed_attempt`, Rust binds its `DelegationBindingV1` digest and exact Goal/Run/Task/Attempt lineage after Attempt admission; Core passes it with bounded, provenance-bearing context refs. `authorityDigest` is domain-separated BLAKE3 over canonical MessagePack `["SubagentDeliveryV1.authority", lane, parentExecutionId, childExecutionId, ownerEpoch, authority]` and is recomputed by the canonical owner; it is never itself authorization. Child-visible text is not authority. Each result contains bounded status/summary, missing criteria, touched-file refs, settled receipt refs and immutable evidence/artifact refs. The child cannot mark Task/Run PASS, update accepted criteria, mint leases or widen provider/model/capability/resource selection.

For `direct_session`, that trusted profile reference is specifically Core Config's immutable
`AgentProfileV2` revision and its resolved definition digest; the effective permission-scope
digest is derived from the actual profile/parent intersection used to construct the child
runtime. A legacy Agent name is only a migration selector, never a profile authority. Resume
uses the exact saved revision and fails closed if it cannot be recovered.

Context selection records source, trust, generation/revision and inclusion reason. It may use existing `fresh`, `conversation_slice` or `fork` modes; it must not clone the full parent transcript by default. Summaries remain derived artifacts with source/evidence lineage and never replace canonical history, exact test output, receipts or verifier results. P2 acceptance is one real managed Attempt and its recovery/forgery cases; broader DAG/fan-out remains gated by P8.
