# 2. Domain model

Status: normative V1 identities and aggregates.

## 2.1 Identity law

IDs are opaque and typed by domain. Never derive a Rust aggregate ID by rewriting an OpenCode Session/message ID.

Every cross-owner reference records the exact foreign ID and, where relevant, source revision/digest/epoch.

## 2.2 Conversational domain

Owned by OpenCode:
- Session;
- Input/steer;
- Message;
- Part;
- conversational tool-call/result part;
- provider continuation/request state.

Horizon may reference/observe these through SessionLink but does not duplicate their content as Rust truth.

## 2.3 Managed control domain

Goal:
user objective and stable identity.

SpecVersion:
immutable reviewed objective/scope/constraints/criteria/budgets for a managed attempt.

Run:
one execution against one accepted SpecVersion.

Task:
dependency-scoped unit inside a Run.

Attempt:
one execution attempt for a Task.

WorkerExecution:
one leased worker/workspace execution instance.

Evidence/Verification:
independent proof and acceptance decision.

## 2.4 Effects

ToolBatchControl:
authorization/control record for one complete provider-response tool batch in the owning Session backend.

EffectIntent:
immutable intended external/local mutation with canonical target/args/source preconditions.

ExecutionLease:
one-use authorization to perform that exact prepared effect.

EffectReceipt:
observed result, including FAILED or UNKNOWN.

Approval:
user/policy decision where required.

Effects are separate from conversational tool-result messages.

## 2.5 Resource domain

Project/Workspace/RepositoryRevision:
source scope and integrated revision identity.

ResourceLease:
ports/processes/worktree/device/browser/debugger/REPL or other exclusive/shared resources.

Checkpoint:
reviewable recovery/restore reference, never permission to overwrite later user changes.

## 2.6 Context and repository intelligence

ContextLedger:
model-visible selected/retrieved/generated references with source/provenance.

RepoIndexGeneration:
derived index generation for a repository/workspace revision.

Symbol/definition/reference/diagnostic records:
derived observations that carry source/generation/confidence.

## 2.7 Agent/extension domain

AgentProfile:
behavior/tool/context/subagent limits plus model/harness policy.

HarnessProfile:
prompt/tool/message protocol shaping independent of model/provider.

SkillManifest, HookBinding, McpServerProfile:
versioned extension registrations.

ChildDispatch/SubagentDelivery:
bounded delegation request/result, not canonical Task authority.

## 2.8 Provider/service domain

ProviderAccountSnapshot:
provider/account/auth source/status without secret bytes.

ModelSnapshot:
model capabilities/context/cost/availability provenance.

SearchProviderSnapshot:
direct-search or grounded-model route, auth/cost/status/provenance.

RuntimeObservation:
measured/estimated/unknown latency/token/cache/cost/resource observation.

## 2.9 Interactive service domains

BrowserContext/Tab/Observation:
browser owner plus generation-bound DOM/ARIA/screenshot refs.

DesktopObservation:
OS/display/window/process/AX/screenshot generation.

LanguageServiceSnapshot:
workspace/language/server/source generation.

DebugSession:
adapter/process/workspace generation and debugger state.

ReplSession:
language/runtime/worker generation and bounded state.

Refs from these domains are generation-bound; stale refs cannot authorize mutation.

## 2.10 UI/artifact/automation

ActionDescriptor:
one canonical human/API presentation of a capability/action.

UiStreamEvent:
derived presentation event.

SourceArtifact:
durable bytes/metadata/fidelity.

FigureBlock:
derived source-revision render state.

Automation:
versioned schedule/action definition; occurrence execution still uses Guard.

## 2.11 Ownership summary

Each conversation has exactly one backend owner: HorizonCode direct Core or an explicitly selected native backend.
Rust owns managed control/effects/leases/evidence.
Host registries own configuration/presentation.
Derived services own rebuildable indexes/observations.
No research/source repository is a runtime owner.

## 2.9 Resource and activity projections (A-V2-30)

`ResourceSample`, `FileTouch`, `ToolTailView`, provider-doctor observations and TUI paint counters are **derived/ephemeral projections**, not new canonical Session, Run, Task, Attempt, WorkerExecution, EffectIntent or Evidence owners. Their identities bind to owner type/ID, OS process start generation, workspace/revision, observation time/source and measurement method. A PID alone is never an owner identity. Losing derived measurements must not erase a Task, receipt or accepted spec.

A proposed `VirtualSessionAttachment` is a revocable authenticated link between host-owned direct Session and shared-kernel subscriber/capability scope. It never owns message history and never confers extra actor authority. Rust scheduler/resource leases own runnable worker budgets; `FileTouch` can advise about overlap but the source digest + workspace lease + Guard enforce a write.
