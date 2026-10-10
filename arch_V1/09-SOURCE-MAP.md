# 9. Pinned source map and coverage limits

## 9.1 Baseline and inventory

Primary upstream source is [`opencode/` at pinned revision
`b1fe25ab5ecc9f9bc911a8a2e6a51565cc764322`](https://github.com/anomalyco/opencode/tree/b1fe25ab5ecc9f9bc911a8a2e6a51565cc764322).
The local source directory has no independent Git metadata. On 2026-10-10, the exact
upstream commit was fetched by object ID for verification and every local path, mode, and
Git blob hash was compared with its tree: **6,629 blobs, 0 missing, 0 extra, 0 changed**.
No remote was configured and no upstream ref was created. The initial HorizonCode
architecture/source review began at
`9fd96b07a65b3c2faf3380c4fd24069cc993598a`; the current local implementation seams
listed in §9.6 were re-inspected at commit
`5c20a65ee6c05c7771fbcbe1e2cde8fc192b8a34`. These are bounded source checks, not a
whole-repository semantic review. The mechanically generated path inventory
is [`opencode-b1fe25ab-path-inventory.jsonl`](opencode-b1fe25ab-path-inventory.jsonl).
It records tracked path, file kind, bytes and line count; it is not semantic review.

Inventory result: **6,629 tracked paths**: 6,233 text files (1,435,757 newline
records), 336 binary files and 60 symlinks. Symlink targets are not counted as
reviewed. The committed inventory was independently compared with the local snapshot:
all 6,629 paths, kinds, byte counts and text line counts matched. The inventory is tied to
the pinned revision and must be regenerated after any upstream revision change.

License-file scan of the pinned tree found four license files, all MIT: the root OpenCode
license, `packages/docs/LICENSE`, `packages/http-recorder/LICENSE`, and `packages/ui/LICENSE`.
No `NOTICE` file exists in the pinned tree. This source-file check is not a dependency,
bundled-asset, or legal redistribution review; DEC-V1-11 and the release license gate remain
open.

## 9.2 Semantic review evidence

| Scope | Review coverage preserved | What it supports | What it does not support |
|---|---|---|---|
| Core/Schema/Protocol/Server/Client/SDK/LLM contracts | 54 paths, 8,361 distinct line positions; 52 full files and 2 partial | V2 admission/coordination, prompt/API schemas, selected projections, one provider runner/tool path, LLM types and package boundaries | Whole package review, complete persistence implementation, provider adapter matrix, full sandbox/Guard/audit path, generated client correctness |
| TUI/UI/session-ui/app/codemode | Reviewer reported 57 explicitly ranged paths, 10,452 lines across assigned package scopes | Package architecture and selected prompt/message/application/runtime seams | The full path ledger is not recoverable from the report; aggregate does not imply whole-package semantic review |
| `.opencode/`, README and issue templates | 8 config/agent/tool/skill files (1,333 lines), primary README (129), all 3 issue templates (90); localized README variants inventory-only | Selected project configuration and repository-facing docs | Commands/assets/localized docs and all package code |
| Specs and perf protocol | 14 spec files (5,191 lines) plus `perf/test-suite.md` (145) reported as read | Selected design intent and performance/test constraints | Executable test pass or implementation status |
| Runtime and process/security call paths | Targeted source ranges listed below | Specific current behavior at pinned HEAD | Absence of controls outside inspected path; complete security proof |
| All other tracked paths | Inventory only unless above explicitly says otherwise | Path existence/counts | No semantic behavior claim |

The prior inventory and subagent scopes do not reconcile to an exact exhaustive
semantic-read set. One recovered core report's explicit 14-package candidate denominator
was 991 paths / 188,600 lines; only 54 paths / 8,361 line positions are in its
recoverable exact ledger. The historic 993-path package subset membership is not
available. Do not calculate or claim a whole-repository coverage percentage.

## 9.3 Bounded pinned-source observations

Paths are relative to `opencode/` and line ranges refer to the pinned checkout.

| Observation | Source ranges |
|---|---|
| V2 prompt admission is durable before advisory wake; default lane is steer | `packages/core/src/session.ts:360–385`; `packages/core/src/session/input.ts:41–81,83–168,245–288` |
| V2 coordinator serializes per Session in process memory; continuation recovery after crash is separate future work | `packages/core/src/session/run-coordinator.ts:5–104`; `packages/core/src/session/execution/local.ts:10–46`; `packages/core/src/session/runner/llm.ts:43–91,119–139` |
| Current V2 runner dispatches non-provider-executed tool calls from the streaming event handler; provider-executed calls skip local settlement | `packages/core/src/session/runner/llm.ts:241–281` (full selected file read through 441) |
| V2 Session public routes and handlers are schema-driven; generated client has separate build | `packages/protocol/src/groups/session.ts:106–223,307–357`; `packages/server/src/handlers/session.ts:19–171,333–369`; `packages/client/script/build.ts:7–30` |
| Legacy app LLM path defaults to AI SDK streamText; native `packages/llm` path is opt-in with unsupported fallback | `packages/opencode/src/session/llm.ts:224–279,357–381`; adjacent package guide identifies integration seam |
| `@opencode-ai/llm` route/protocol/provider modules are a package in the pinned repo | `packages/llm/package.json:1–52`; selected `src/schema/messages.ts:183–218,271–312`; `src/llm.ts:30–78` |
| TUI is OpenTUI/Solid and depends on Core, Plugin, SDK and UI | `packages/tui/package.json:1–72` |
| TUI/session-ui/app are coupled package layers; session-ui has a local vendored client tarball | Reviewer-selected `packages/{tui,ui,session-ui,app,codemode}` manifests and code; see reviewer summary; exact 57-path ledger not preserved |
| Permission is not sandbox proof; shell/MCP/LSP/formatter/plugin workers need separate execution-route review | `packages/opencode/src/tool/shell.ts:263–309,378–425,428–559,597–641`; `src/permission/index.ts:28–107,109–167`; `src/mcp/index.ts:212–415,492–555,666–686,806–969`; `src/lsp/server.ts:80–179`; `src/format/index.ts:31–115,130–200` |
| Plugin hooks can affect prompt, headers, permissions, tools and environment; compatibility isolation is required by adopted v1 | `packages/opencode/src/plugin` and `packages/plugin/src/index.ts:1–335` selected; not every hook implementation was reviewed |

The Core report also found the runner emits `Step.Ended` with `cost: 0` while carrying
token usage (`packages/core/src/session/runner/llm.ts:325–345`); this is not evidence
that actual cost accounting is complete. The MCP session-recovery fixture concerns a
transport reconnect, not agent-session continuation after host process death.

Pinned source links for the observations above:

- [V2 prompt admission](https://github.com/anomalyco/opencode/blob/b1fe25ab5ecc9f9bc911a8a2e6a51565cc764322/packages/core/src/session.ts#L360-L385)
- [V2 coordinator](https://github.com/anomalyco/opencode/blob/b1fe25ab5ecc9f9bc911a8a2e6a51565cc764322/packages/core/src/session/run-coordinator.ts#L1-L104)
- [V2 runner tool dispatch](https://github.com/anomalyco/opencode/blob/b1fe25ab5ecc9f9bc911a8a2e6a51565cc764322/packages/core/src/session/runner/llm.ts#L241-L281)
- [Legacy app provider runtime selection](https://github.com/anomalyco/opencode/blob/b1fe25ab5ecc9f9bc911a8a2e6a51565cc764322/packages/opencode/src/session/llm.ts#L224-L279)
- [TUI package manifest](https://github.com/anomalyco/opencode/blob/b1fe25ab5ecc9f9bc911a8a2e6a51565cc764322/packages/tui/package.json)
- [LLM package manifest](https://github.com/anomalyco/opencode/blob/b1fe25ab5ecc9f9bc911a8a2e6a51565cc764322/packages/llm/package.json)
- [Shell execution](https://github.com/anomalyco/opencode/blob/b1fe25ab5ecc9f9bc911a8a2e6a51565cc764322/packages/opencode/src/tool/shell.ts)
- [Permission implementation](https://github.com/anomalyco/opencode/blob/b1fe25ab5ecc9f9bc911a8a2e6a51565cc764322/packages/opencode/src/permission/index.ts)

## 9.4 Exact core contract ledger

The following recovered paths/ranges make the core count reproducible. The two
partials are explicit; all other entries are full-file reads in that review.

```text
packages/core/package.json 1-133
packages/core/src/session.ts 1-486
packages/core/src/session/input.ts 1-288
packages/core/src/session/run-coordinator.ts 1-104
packages/core/src/session/execution.ts 1-34
packages/core/src/session/execution/local.ts 1-46
packages/core/src/session/runner/llm.ts 1-441
packages/core/src/session/runner/publish-llm-event.ts 1-423
packages/core/src/session/sql.ts 1-176
packages/core/src/session/projector.ts 1-455
packages/core/src/session/history.ts 1-101
packages/core/src/session/message-updater.ts 1-397
packages/core/src/session/store.ts 1-63
packages/core/src/session/event.ts 1-2
packages/core/src/database/database.ts 1-57
packages/core/test/session-run-coordinator.test.ts 1-418
packages/schema/package.json 1-22
packages/schema/src/session-event.ts 1-521
packages/schema/src/session-input.ts 1-23
packages/schema/src/prompt-input.ts 1-26
packages/protocol/package.json 1-22
packages/protocol/src/groups/session.ts 1-379
packages/server/package.json 1-25
packages/server/src/handlers/session.ts 1-385
packages/httpapi-codegen/package.json 1-22
packages/httpapi-codegen/src/index.ts 1-536,538-570 (line 537 omitted)
packages/client/package.json 1-39
packages/client/script/build.ts 1-30
packages/client/src/contract.ts 1-53
packages/client/src/index.ts 1-2
packages/client/src/effect.ts 1-25
packages/sdk/js/package.json 1-36
packages/sdk-next/package.json 1-25
packages/sdk-next/src/opencode.ts 1-49
packages/sdk/js/script/build.ts 1-119
packages/sdk/js/src/v2/client.ts 1-93
packages/sdk/js/src/v2/index.ts 1-23
packages/sdk/js/src/v2/server.ts 1-134
packages/plugin/package.json 1-54
packages/plugin/src/index.ts 1-335
packages/cli/package.json 1-36
packages/cli/src/commands/handlers/api.ts 1-85
packages/cli/src/services/daemon.ts 1-192
packages/llm/package.json 1-52
packages/llm/src/schema/messages.ts 1-312
packages/llm/src/schema/events.ts 1-440 (file ends at 618; lines 441-618 not read)
packages/effect-drizzle-sqlite/package.json 1-28
packages/effect-drizzle-sqlite/src/effect-sqlite/driver.ts 1-77
packages/effect-drizzle-sqlite/src/effect-sqlite/session.ts 1-218
packages/effect-sqlite-node/package.json 1-22
packages/http-recorder/package.json 1-60
packages/http-recorder/src/recorder.ts 1-62
packages/http-recorder/src/redaction.ts 1-117
packages/http-recorder/src/effect.ts 1-25
```

## 9.5 Explicitly not verified

- No code, test, build, typecheck, generator, package install, server, browser or live
  provider was run for this architecture task.
- Full provider protocol support and upstream per-provider behavior are not audited.
- EventV2 storage durability, end-to-end effect/Guard path, OS sandboxing and complete
  audit-chain behavior are not established by the reviewed Session/LLM paths.
- Generated SDK/client outputs were not regenerated or compared.
- The selected Core V2 application-route convergence and legacy Session import contract
  are adopted target behavior; the pinned repository does not yet implement the
  Horizon ThreadStoreService adapter, kernel importer or the required Guard mediation.
- Full CLI/server/ACP/plugin/MCP/LSP/formatter/UI parity and third-party plugin isolation
  are target requirements, not checked implementation.
- Source claims in `info2.txt` tied to its older OpenCode/Horizon pins remain unverified
  unless listed against current local source above.
- `MemoryRecordV1.supersedesMemoryIds` UTF-8-bytewise ascending order is adopted
  Horizon v1 semantics from explicit user direction, not recovered upstream/OpenCode or
  historical Horizon source behavior.

## 9.6 Historical Horizon implementation seams inspected

The following historical source observations are tied to HorizonCode commit
`5c20a65ee6c05c7771fbcbe1e2cde8fc192b8a34`. This review was limited to the
event-log and sandbox seams relevant to adopted v1. It does not establish that the
new Thread/Effect/Supervisor owner model is implemented or that an OS guarantee passes
acceptance. The legacy branch/tag refs and local object database were removed during the
fresh-Git reset; these paths are not present in the current working tree. Recover and
verify the historical source before any individually mapped component is ported. This
ledger is migration evidence, not an instruction to retain or copy any old crate; the
owner/interface and tests in `arch_V1/` govern each port decision.

| Observation | Current local source | What it establishes / limit |
|---|---|---|
| Physical event record uses stream-local sequence, time, kind, object data, predecessor digest and BLAKE3 event digest | `crates/horizoncode-eventlog/src/envelope.rs:64–72,87–102,104–188`; canonical body `141–164` | Existing physical envelope differs from the adopted logical envelope; map logical fields into versioned owner payload or version/migrate the existing format, never create a second store/hash chain |
| Event log is segmented, bounded, per configured owner, with append-before-head commit and replay to the committed head | `crates/horizoncode-eventlog/src/lib.rs:1–29`; `src/log.rs:83–101,103–201,246–319,321–408` | Strong physical persistence seam; comments and unit tests do not prove target power-loss behavior |
| Committed head binds owner kind/ID, schema, generation, committed sequence/digests and durability profile; replace is staged/synced then renamed | `crates/horizoncode-eventlog/src/head.rs:24–50,71–90,93–147` | Head is authoritative for acknowledged prefix; no cross-stream/global ordering is provided |
| `run_durable` requires file and directory sync support; built-in standard backend reports support only on Unix; unsupported platforms are refused | `crates/horizoncode-eventlog/src/durability.rs:24–60,62–87,90–112`; open refusal in `src/log.rs:128–166` | Windows currently cannot meet this crate's `run_durable` contract through `std_sink`; long-horizon Windows Runs need a real accepted backend or remain unavailable |
| Windows confined sandbox backend is unavailable and refuses non-full-access requests; only explicit full-access runs bare | `crates/horizoncode-sandbox/src/windows.rs:1–10,42–72,74–110` | Confirms the adopted Windows v1 capability remains an unresolved release blocker, not an existing capability |
| Linux backend uses bubblewrap namespaces, scoped mounts, protected/deny paths and network unshared by default; host network can be shared for requested Full; allowlists fail closed | `crates/horizoncode-sandbox/src/linux.rs:1–32,81–186,199–284` | Source mechanism, not accepted distro/kernel coverage; `NetworkPolicy::Full` has no egress isolation |
| macOS Seatbelt scopes reads/writes but declares network denial best-effort because escaped descendants are not separately confined; allowlists fail closed | `crates/horizoncode-sandbox/src/macos.rs:1–14,76–137,139–184` | Must not be labeled equivalent to Linux; no release acceptance inferred |
| Shared profile has `readonly`, `workspace-write`, `full-access`, explicit roots and limits; backend plan exposes applied description and epoch | `crates/horizoncode-sandbox/src/profile.rs:6–16,44–56,70–122,124–157`; `src/provider.rs:40–69,148–205,240–260` | Reach checks and requested profiles are not a substitute for execution-time path identity/fence or OS enforcement |
| Process helper uses argv, bounded retained output and a child-wait watchdog; it kills the direct child PID, not a general process tree, and does not return a truncation receipt | `crates/horizoncode-sandbox/src/process.rs:23–85,88–118`; stdin before timer `52–59`, unbounded reader joins `78–79`, EOF readers `101–115`; result shape `src/provider.rs:213–230` | Not yet the full adopted ExecutionHost contract. Stdin can block before timeout supervision and surviving descendants can keep pipe readers blocked after child exit. Deadline-covered stdin, bounded post-exit draining, aggregate stdout+stderr bounds, process-tree termination, inherited-handle/env policy and observable truncation require implementation/acceptance under §14 |
| Sandbox tests explicitly avoid a false green when real bubblewrap is unavailable and include path-scope checks | `crates/horizoncode-sandbox/tests/sandbox.rs:1–6,16–124,127–175` | Test definitions are useful evidence design; no test was executed for this architecture task and these are not Windows acceptance |

No tests, builds, crash/power-loss drills, Windows acceptance, or sandbox escape tests
were run during this documentation pass. The source review confirms the design must
keep both Windows sandbox confinement and Windows `run_durable` storage unavailable
until their respective backend implementations and acceptance evidence exist.

The historical `horizoncode-eventlog` source and physical format were not recovered
after the fresh-Git reset. The user approved OwnerLog V2 as an explicit new physical
format on 2026-10-09. This decision does not claim source recovery or byte compatibility;
OwnerLog V2 remains the only canonical store, and unknown legacy bytes are read-only until
a verified importer exists. Windows `run_durable` remains unavailable pending DEC-V1-17
and native acceptance evidence.

## 9.7 First-pass OpenCode path-family disposition

This is an initial path-family classification against the root-relative entries in the
pinned 6,629-path inventory, not a semantic review or a claim that any disposition has
been implemented. Each counted row below matches complete inventory paths; path counts
are mechanical. The rationale is bounded by the observations in §9.3 and the target
owners in [`06-CAPABILITIES.md`](06-CAPABILITIES.md), [`01-SYSTEM.md`](01-SYSTEM.md),
and [`13-COMPOSITION-IPC.md`](13-COMPOSITION-IPC.md). A family disposition does not
override a capability gate or imply acceptance.

| Root-relative path family | Paths | Disposition | Final v1 owner/interface and rationale |
|---|---:|---|---|
| `packages/schema/src/session-*.ts`; `packages/protocol/src/groups/session.ts`; `packages/server/src/handlers/session.ts`; `packages/client/src/generated/`; `packages/client/src/generated-effect/` | 20 | ADAPT | Map the existing Session API through the OpenCode-compatible `ThreadStoreService` adapter; Rust ThreadService remains canonical. Keep generated clients generator-owned. |
| `packages/core/src/session/{input.ts,run-coordinator.ts,execution/**,runner/**}` | 9 | ADAPT | Keep Core V2 as the sole host turn runner, bound to `ThreadStoreService`; collect and validate the whole provider tool batch before the kernel `ToolExecutionCoordinator` can execute it. The pinned runner currently dispatches calls as stream events arrive (§9.3). |
| `packages/core/src/session/{projector.ts,history.ts,message-updater.ts}` | 3 | ADAPT | Use only for host projections/history selection behind ThreadService; projections are rebuildable, and ThreadService owns Context Epoch persistence. |
| `packages/core/src/session/{sql.ts,store.ts}` | 2 | REPLACE | Replace production canonical Session persistence with Rust ThreadService. Keep any necessary host-side use limited to migration, tests, or rebuildable projections; do not create two writable transcript owners. |
| `packages/core/src/session/{context-epoch.ts,compaction.ts,prompt.ts}`; `packages/core/src/system-context/` | 6 | ADAPT | One ContextService owns deterministic context and pruning; ThreadService owns Context Epoch persistence. Context text is data, not authority. |
| `packages/core/src/tool/`; `packages/opencode/src/tool/` | 63 | ADAPT | Retain useful definitions and presentation while routing effects through ThreadService-owned ToolBatch transitions, Guard/EffectService, and Rust ExecutionHost; tool schemas or permission prompts alone are not confinement (§9.3; §6). |
| `packages/llm/src/providers/`; `packages/llm/src/route/` | 24 | RETAIN | Keep the provider and route implementation in the `hzcode` host; kernel route snapshots and the SecretBroker govern selection/auth policy. DEC-V1-06 still gates real authenticated provider use. |
| `packages/llm/src/protocols/` | 18 | ADAPT | Preserve provider protocol and normalized-stream behavior, but feed the host whole-response validation boundary before any local dispatch. Provider-hosted execution is the explicit `DISABLE` exception below. |
| `packages/opencode/src/session/{llm.ts,processor.ts,prompt.ts,session.ts}`; `packages/opencode/src/session/llm/`; `packages/opencode/src/session/prompt/` | 24 | REMOVE-LATER | Migration/compatibility source only. Move needed product routes to Core V2 and retire this competing loop only after import/feature migration and the P2/P3 gates; do not preemptively delete it. The legacy path defaults to AI SDK and has an opt-in native fallback (§9.3). |
| `packages/opencode/src/storage/`; `packages/opencode/migration/` | 4 | ADAPT | Keep only as migration input or rebuildable host projection/test support; Rust ThreadService owns canonical conversation state. |
| `packages/opencode/src/permission/` | 3 | WRAP | Keep permission UX as presentation; durable Guard challenges and effect owners make every authority decision. Process-local allow/ask/deny state is not canonical authority. |
| `packages/opencode/src/mcp/` | 6 | WRAP | Preserve protocol/discovery surfaces behind ToolDefinition and Guard/EffectService/ExecutionHost; secrets are explicit per server. Audit env inheritance and resolve DEC-V1-15 before enabling governed MCP. |
| `packages/opencode/src/acp/` | 12 | WRAP | Route peers through the single AgentProfile registry and WorkerAdapter; report configured, observed, and enforced mediation separately. A peer may have hidden tools or refuse cancellation. |
| `packages/opencode/src/lsp/` | 6 | WRAP | Keep language-server definitions/client surface, but ExecutionHost owns binary installation, environment, workspace scope, output, and cancellation; review each launch path before claiming containment. |
| `packages/opencode/src/format/` | 2 | WRAP | Keep formatter registry/UX; ExecutionHost supervises formatter installation and process effects under Workspace/Guard policy. |
| `packages/opencode/src/plugin/{index.ts,install.ts,loader.ts,meta.ts}` | 4 | DISABLE | Do not enable unrestricted third-party in-process plugin activation. Supported hooks require the isolated/capability-limited compatibility worker and `HzPluginRuntime`; unsupported hooks fail visibly (§6; §17.3). This is not a disposition of the separate provider-specific plugin subtrees. |
| `packages/plugin/src/` | 37 | ADAPT | Retain only the compatibility surface that maps to declared `HzPluginRuntime` capabilities; unsupported hooks return `COMPATIBILITY_UNSUPPORTED`, and plugin code cannot replace sealed kernel owners. |
| `packages/opencode/src/skill/` | 2 | RETAIN | Preserve declarative skill discovery/format; content cannot grant capabilities or bypass AgentProfile and policy admission (§6). |
| `packages/opencode/src/worktree/` | 1 | WRAP | Reuse worktree mechanics only behind WorkspaceProvider leases, revisions, and fences; validate cross-platform behavior before relying on it (§6). |
| `packages/app/src/` | 481 | ADAPT | Keep the Solid application surface while moving Thread/Run data and mutations to typed app APIs and kernel-owned projections; UI state is not canonical Run state. |
| `packages/ui/src/` | 1,682 | RETAIN | Keep shared presentation components; they do not own canonical Thread, Run, permission, or effect state. |
| `packages/tui/src/` | 185 | RETAIN | Keep the OpenTUI/Solid terminal shell and compose Horizon views through fixed slots and typed app APIs; do not make local TUI state authoritative (§6). |
| `packages/session-ui/src/` | 114 | ADAPT | Keep session presentation behind the generated/typed client and Thread projections; remove any competing or vendored-client ownership during integration. |
| `packages/desktop/src/` | 126 | RETAIN | Keep Electron as the initial desktop shell; Horizon service state and updater controls enter only through registered actions. Packaging/signing remain separately gated (§6). |
| `packages/cli/src/`; `packages/opencode/src/cli/` | 105 | ADAPT | Make `hzcode` the composition root; headless commands use the same typed service/action contracts, not a second authority path (§6; §13). |
| `.opencode/agent/`; `.opencode/command/` | 10 | RETAIN | Keep declarative agent/command assets as repository configuration; their text cannot grant capabilities or authority. |
| Provider-hosted tool execution (`providerExecuted`) in `packages/llm/src/protocols/anthropic-messages.ts`, `packages/llm/src/protocols/openai-responses.ts`, `packages/llm/src/schema/events.ts`, and the Core V2 caller | — | DISABLE | Feature-level exception, not an additional whole-file path count: retain ordinary provider transport but reject provider-executed tools in governed v1 because Guard cannot authorize an effect after the provider has already run it. Offer mediated local equivalents (§6; §9.3). |

The counted path families above account for **2,949 of 6,629 inventory entries**. The
remaining **3,680 paths are unclassified**, not implicitly retained or removed: 3,473
are elsewhere under `packages/`, and 207 are root-level or other top-level paths. The
unclassified remainder includes package manifests/tests/build and release files,
provider-specific plugin subtrees, other Core and OpenCode subsystems, hosted/service
packages, SDK variants, repository automation, docs/specs, binaries, and symlinks. Its
mechanical kinds are 3,397 text paths, 224 binary paths, and 59 symlink paths; symlink
targets are not reviewed. The inventory is root-relative and does not account for the
adjacent `opencode/` directory tree. This pass did not independently verify the ignored
source files against the stated pin: HorizonCode's root Git history is separate from the
ignored OpenCode checkout, whose source provenance remains unverified here. Treat the
inventory's pin as its provenance claim and re-verify source contents when provenance is
re-established.

Complete P0.4 only after every inventory path has a non-overlapping disposition tied to
its final owner/interface, including explicit treatment of assets and symlink targets.
This first pass is not P0.4 completion, a whole-repository semantic coverage claim, or
permission to delete source. No architecture link/structure checker was found in the
current repository; the exact remaining inventory count is the current coverage limit.
