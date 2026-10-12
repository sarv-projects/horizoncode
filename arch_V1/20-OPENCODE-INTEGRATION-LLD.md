# 20. OpenCode integration LLD

Status: normative source-placement map. Always inspect the live source before editing.

## 20.1 Existing local roots

| Root | Preserve/use |
|---|---|
| packages/core/src/session | canonical Session/input/event/store/provider-turn behavior |
| packages/core/src/tool | canonical host tool definitions/registry |
| packages/core/src/horizon | Horizon host integration/services |
| packages/llm/src | current provider/model/protocol transport; replaceable only through A-V2-27 |
| packages/opencode/src | compatibility/legacy OpenCode features that must be audited for bypass |
| packages/schema/src | shared OpenCode/Horizon host types where already established |
| packages/server/src | public API composition |
| packages/tui/src | terminal UI |
| packages/app/src | Solid app |
| packages/desktop/src | Electron desktop shell |
| kernel/src | Rust managed control, private protocol and future effect host |
| indexd/src | derived repository intelligence |

Do not invent a parallel direct-session/provider runtime, second Session store or general process supervisor. Provider transport may migrate only through A-V2-27, and the separately sanctioned native OpenCode adapter keeps its own explicit backend ownership.

## 20.2 Canonical integration seams

### Session/provider

Keep the existing SessionV2/direct continuation owner. `packages/llm` is the current provider transport, not a permanent authority: A-V2-27 may replace transport/catalog beneath the same Session owner. Horizon adds observation/correlation and guarded tool execution, never another direct transcript.

The provider runner must:
- pin tool registry per request;
- collect the complete local tool batch;
- validate all local inputs before dispatch;
- route effects to kernel;
- record returned conversational results in OpenCode.

### Session observer

Existing supervisor/projection code is adapted to SessionLinkV1:
- authenticated private startup;
- source cursor/epoch;
- bounded redacted pages;
- exact ACK;
- restart/resnapshot;
- no message writes.

### Tool/Action registry

Use one canonical capability ID namespace from 33.

Existing ToolRegistry remains the host tool source; ActionDescriptor adds human/API presentation metadata. Aliases resolve to one canonical target before permission/effect classification.

### Guard bridge

Logical host interface:
- preflightBatch(proposedBatch, turnSnapshot)
- requestApproval(decision)
- executeAdmittedBatch(batchId, leases)
- reconcile(batchId/effectId)
- cancel(scope)

The actual function names should follow existing package conventions rather than creating a parallel framework.

## 20.3 Service placement

| Logical service | Placement |
|---|---|
| AgentProfile/Harness registry | packages/core/src/horizon or existing config composition |
| ContextService | packages/core/src/horizon integrated with Session/context code |
| RepoIntelService | host adapter over indexd/LSP/parser |
| ToolCatalog/ActionDescriptor projection | host over ToolRegistry + capability registry |
| Skill/Hook/MCP registry | host config/extension layer |
| Delegation adapter | host + Rust managed child lifecycle |
| BrowserBackend | packages/app/desktop/browser integration or supervised worker |
| DesktopAction backend | supervised OS worker invoked through Rust effect path |
| WebSearchBroker | host provider/service adapter with auth/cost policy |
| LanguageServiceBroker | reuse packages/opencode LSP where appropriate plus supervised service |
| DebugAdapterBroker | supervised worker; no new host authority |
| ReplBroker | supervised bounded Python/JS worker |
| Artifact service/renderers | existing host/TUI/app + durable store |
| UiEventMux | derived host/TUI/app stream |
| Automation | Rust durable schedule/control + host action dispatch |

All proposed services must first locate/reuse an existing compatible implementation before a new module is created.

## 20.4 Existing versus proposed truth

Architecture labels:
- EXISTING: source path and tests observed;
- ADAPT: existing path remains owner but needs Horizon behavior;
- PROPOSED: no production implementation claim;
- DISABLED: intentionally unavailable pending a gate.

Do not convert PROPOSED to EXISTING because a schema/research source exists.

## 20.5 Upstream compatibility

Horizon patches should be narrow and source-owned.

For a pinned OpenCode upgrade:
1. diff exact upstream range;
2. classify touched Horizon seams;
3. run parity/contract/security tests;
4. regenerate generated files with pinned generators;
5. update 42 pin only after acceptance.

No blind merge/main tracking.

## 20.6 External source extraction

Use 42 only for a specific missing/optimized algorithm.

Preferred adaptation:
- Hashline logic inside existing files.patch;
- native walker/grep/AST behind existing RepoIntel/search;
- OMP browser/desktop lifecycle ideas behind Horizon Guard;
- OMP UI/render ideas inside existing TUI/app owners.

Never copy OMP AgentSession/history/tool authority, unrestricted Eval, unbounded queues or hidden paid routing. Direct inference transport/catalog may be selectively adapted only through A-V2-27.

## 20.7 Required implementation evidence

Each integration slice records:
- exact existing file/functions/callers;
- modified files and source revision;
- owner and capability IDs;
- schema/wire changes;
- positive + negative/restart tests;
- performance/platform result;
- known unsupported paths.

Current progress belongs in HANDOFF.md.

## 20.8 OMP transport vs native OpenCode adapter

Keep one canonical owner per conversation. The direct Core session may call a selective OMP pi-ai/pi-catalog transport, but must never import OMP AgentSession or a second tool executor. The native OpenCode adapter is an independent process/client for the official upstream binary, with version probe, health, session linking, event stream, cancellation, approval, restart and error handling. Test both modes without dual ownership. No free-Zen client impersonation. See decision A-V2-27 and session/Guard acceptance gates before enabling effects.
