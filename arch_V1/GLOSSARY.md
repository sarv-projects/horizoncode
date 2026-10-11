# HorizonCode V1 glossary

Status: normative terminology only. Ownership is defined by 01/02/17.

| Term | Meaning |
|---|---|
| Session | OpenCode-owned durable conversation identity and its Input/Message/Part/provider continuation. |
| SessionLink | Bounded Rust correlation to an OpenCode Session/source cursor/epoch; never a second transcript. |
| Direct Session | Ordinary pair-coding flow without mandatory Goal/Run/Task. Effects still use Guard. |
| Goal | Durable managed objective. |
| SpecVersion | Immutable reviewed scope/constraints/acceptance/budget for a managed Run. |
| Run | Rust-owned managed execution against one accepted SpecVersion. |
| Task | Dependency-scoped managed work unit with acceptance criteria. |
| Attempt | One bounded execution strategy for a Task. |
| WorkerExecution | Concrete leased process/agent/workspace incarnation; not correctness evidence. |
| ToolBatchControl | Rust authorization/control facts for the complete tool-call set in one OpenCode provider response. |
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
