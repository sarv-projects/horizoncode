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

OpenCode remains the V1 session/provider substrate. HorizonCode profile resolution adapts to it and to external adapters; it does not fork a second provider stack.

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
  permissionCeilingDigest: Digest
  limits: AgentLimits
  maxParallelChildren: number
  enabled: boolean
  definitionDigest: Digest
}
```

### Rules

- Profile rules **narrow** permissions; they cannot widen Guard policy.
- A child receives the intersection of parent delegation authority, child profile ceiling and current policy.
- Changing a profile creates a new immutable revision. Existing work keeps the pinned revision.
- Provider/model/harness are explicit. A variant tunes one selected model; it is not automatic model routing.
- Provider-specific profile variants may be stored as neutral metadata or convenient files such as `agent.openai.md` / `agent.anthropic.md`, but resolution must produce one versioned `AgentProfileV2`. File naming is UX, not authority.
- A missing variant falls back to the base profile only if the base requirements are supported. It never silently chooses another provider.
- `sandbox_auto` corresponds to reduced prompting only when the runtime has an enforced sandbox. Otherwise it is unavailable.
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

## 29.17 OMP provider/model/extension UI cross-reference (research only)

[§39](39-OMP-TUI-SLASH-MODEL-SETTINGS-AUDIT.md) and [§40](40-HORIZONCODE-OMP-INSPIRED-UI-PROPOSAL.md) identify OMP's dynamic command registry, semantic icons, 15 workload role slots, provider auth/model hub, plugin marketplace, CLI/TUI configuration UI and all UI settings. Horizon should adopt only the interaction conventions compatible with this document's sealed AgentProfile, HarnessProfile, capability registry, plugin provenance and typed commands. No OMP-native plugin, OAuth or key mechanism is installed by these documents.

## 29.18 OMP extraction provenance for plugin/skill/action UI

A-V2-24 makes immutable source references/ownership mandatory for any third-party code or learned plugin behavior; [source provenance §42](42-EXTERNAL-SOURCE-PROVENANCE-REGISTER.md) SRC-009/017. User-visible slash/skill/MCP/marketplace actions route through ONE owned ActionDescriptor/Guard; plugin code is not a privilege tier. Complete register, origin trust, auth/cost provenance, namespace collision, rollback and uninstallation tests as in [source-to-LLD §43](43-IMPLEMENTATION-SOURCE-LLD-PLAYBOOK.md) and [converged implementation plan](../docs/superpowers/plans/2026-10-11-horizoncode-converged-implementation.md). No mandate to copy OMP 85 commands.
