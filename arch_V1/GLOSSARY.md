# HorizonCode V1 glossary

Status: normative terminology only. Ownership is defined by 01/02/17.

| Term | Meaning |
|---|---|
| Session | Durable conversation identity owned by its selected backend: HorizonCode Core for direct Sessions, or official OpenCode for explicitly native OpenCode Sessions. |
| SessionLink | Bounded Rust correlation to a backend-owned Session/source cursor/epoch; never a second transcript. |
| Direct Session | Ordinary pair-coding flow without mandatory Goal/Run/Task. Effects still use Guard. |
| Goal | Durable managed objective. |
| SpecVersion | Immutable reviewed scope/constraints/acceptance/budget for a managed Run. |
| Run | Rust-owned managed execution against one accepted SpecVersion. |
| Task | Dependency-scoped managed work unit with acceptance criteria. |
| Attempt | One bounded execution strategy for a Task. |
| WorkerExecution | Concrete leased process/agent/workspace incarnation; not correctness evidence. |
| ToolBatchControl | Rust authorization/control facts for the complete local tool-call set in one owning provider response. |
| EffectIntent | Durable exact intended mutation with target/args/source/policy bindings. |
| ExecutionLease | One-use authority for exactly one prepared effect. |
| EffectReceipt | Target observation/outcome for an effect, including FAILED/UNKNOWN. |
| Guard | Canonical policy/approval decision boundary for effects. |
| ExecutionHost | Canonical supervised operation/process execution boundary consuming exact leases. |
| UNKNOWN | Operation may have affected the target but authoritative outcome is not known; never blindly retried. |
| NeedsYou | User-facing unresolved approval/decision/recovery requirement; not an authority store. |
| Evidence | Revision/source-bound observation used for verification. |
| Verification | Independent acceptance decision over current criteria/evidence/final revision. |
| Workspace | Revisioned source area with lease/fencing semantics. |
| Worktree lease | Bounded ownership of a Git worktree; dirty/ambiguous trees are quarantined. |
| Checkpoint | Reviewable restore reference; not permission to overwrite later user changes. |
| ContextLedger | Model-visible context projection with source/trust/token/protection/provenance. |
| Trim | Deterministic reduction of expendable model-visible payload without deleting canonical history. |
| Prune | Relevance-based removal from active context view under protection rules. |
| Compact | Bounded summary/reference of older history while originals remain retrievable. |
| Clear | New active context view/epoch; not deletion of canonical conversation. |
| RepoIntel | Derived repository-intelligence service/index; source files/Git remain canonical. |
| RepoIndexGeneration | Rebuildable index snapshot bound to repository/workspace revision. |
| LanguageServiceBroker | Normalized LSP source selection/lifecycle with generation/provenance. |
| DebugAdapterBroker | Supervised DAP session service; attach/control/evaluate obey Guard. |
| ReplBroker | Bounded persistent Python/JavaScript worker service; tool callbacks re-enter Guard. |
| BrowserBackend | Managed/attached browser observation/action service with generation-bound refs. |
| DesktopActionService | OS display/window/AX/screenshot/input service with capability matrix and Guarded mutations. |
| WebSearchBroker | Provider-routed direct or grounded search service with auth/cost/source provenance. |
| AgentProfile | Versioned agent behavior/capability/context/delegation policy. |
| HarnessProfile | Model/provider-independent prompt/tool/message/response shaping profile. |
| Skill | Versioned instruction/resource capability package; cannot self-grant tools. |
| Hook | Versioned event contribution; effectful callbacks use canonical actions/Guard. |
| MCP profile | Versioned external tool-server registration with explicit transport/auth/capability scope. |
| ActionDescriptor | One presentation/argument/effect description projected to slash/menu/keybinding/API/model surfaces. |
| Capability ID | Stable canonical operation identifier from 33. Aliases never change effect class. |
| SourceArtifact | Durable content-addressed artifact metadata/bytes with FULL/SAMPLE/FAILED fidelity. |
| FigureBlock | Derived SVG/Mermaid/chart render state tied to source/theme/geometry generation. |
| UiEventMux | Bounded derived presentation stream; not canonical state. |
| Automation | Durable schedule/action definition whose occurrence still invokes normal authorization. |
| RuntimeObservation | Measured/estimated/unknown performance/usage/cost/cache observation. |
| SecretBroker | Credential-reference/delivery owner; raw secrets are not general model/plugin data. |
| Owner epoch | Generation fencing stale process/service ownership. |
| Source digest | Digest binding a contract/action/evidence item to exact input/source bytes. |
| Metric provenance | Label identifying value as measured, estimated or unknown plus its source/freshness. |
| DESIGNED/CODE_PRESENT/WIRED/TESTED/VERIFIED/RELEASED | Distinct implementation-status levels; never collapse them into one “implemented” label. |

Do not reintroduce historical Rust conversation-owner terms into active architecture. Their provenance is in docs/architecture-archive.

## A-V2-30 resource and execution terms (2026-10-15)

| Term | Meaning |
|---|---|
| PSS (proportional set size) | Linux process memory usage charged proportionally for shared mapped pages; aggregate full confirmed process tree to compare multi-process architectures. Not equivalent to RSS/Windows working set. |
| RSS | Resident pages visible to a process; summing RSS of processes may double-count shared pages. |
| USS/private memory | Process-private pages or native-platform private bytes; method/platform must be attached to each measurement. |
| Process-tree footprint | Resource sample over the host, supervised Rust kernel(s) and every confirmed owned child/worker; local inference included or excluded explicitly. |
| VirtualSessionAttachment | Proposed revocable authenticated link between host-owned Session and shared Rust SessionLink projection with isolated scopes/cursor/epoch. Not a new transcript. |
| ResourceSampler | Proposed OS/process-tree measurement adapter returning scope-bound, unit-labeled measured/estimated/unknown observations. Does not grant leases. |
| ResourceReservation | Rust-owned bounded capacity/worker lease tied to existing Attempt/owner epoch. Not a detached second scheduler. |
| ResourcePressure | Derived soft/hard operational state that controls *new* work/cache shedding; not authority to kill unowned processes or change model. |
| FileTouch | Derived peer read/write observation keyed by workspace/revision; advisory only, never a substitute for exact digest and Guard lease. |
| Provider Doctor | Proposed offline, network-catalog, consented full inference test over the existing selected provider and credential/transport owner. |
| Headless worker | Lightweight agent worker/client without unnecessary TUI/full host; effectful actions still run through supervised OS-isolated ExecutionHost. |
| Task DAG | Rust-owned directed acyclic Task dependency graph; dependent READY requires predecessor independent PASS on a compatible source revision. |
| ToolTailView | Bounded replaceable presentation of active tool output; canonical result or artifact stores complete/sampled data separately. |
| CacheLedger | Per-family measured byte/count/generation/TTL accounting over rebuildable caches, not a second conversation source. |
| Session import | Explicit historical snapshot or selected native backend resume with provenance, no dual live transcript authority or credential copy. |
| Steering | User-origin next-turn/queue/cancel-and-replace action with turn epoch and idempotency; cannot alter prepared effect arguments. |
| Experimental | User-visible dev-testing stability class, independent of code readiness and feature availability; off unless eligible and opted in. |
