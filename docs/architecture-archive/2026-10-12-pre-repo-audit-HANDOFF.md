# Historical HANDOFF snapshot before 2026-10-12 repo-wide audit

> Historical/non-normative. This file preserves the committed HEAD version of HANDOFF at 062a00d55. Additional dirty-worktree checkpoint history remains in local CURRENT_RUN.md and the current HANDOFF records the verified final state. It is not represented as an exact byte copy of the pre-rewrite dirty HANDOFF.

# HorizonCode — implementation handoff

Updated: 2026-10-11
Workspace: /home/sarvesh/business_Dev/agentx
Observed branch/base at architecture consolidation: main / bf0399469470c6ffdcbe5421dc5c506db2d61fae.
The working tree is intentionally dirty. Re-check status/head at session start.

## Architecture entrypoint

Read:
1. AGENTS.md
2. arch_V1/README.md
3. arch_V1/17-GOVERNANCE-DECISIONS.md
4. arch_V1/10-DELIVERY.md
5. this handoff
6. current implementation plan: docs/superpowers/plans/2026-10-11-horizoncode-converged-implementation.md

Then load only the topic owner and local source/tests for the current slice.

The pre-consolidation architecture is preserved under docs/architecture-archive/2026-10-11-pre-lean-consolidation and is NON-NORMATIVE.

## Current ownership

- OpenCode Core: Session/Input/Message/Part/provider continuation and conversational tool results.
- Rust kernel: managed Goal/Run/Task/Attempt, ToolBatch authorization/control, effects/leases/receipts, evidence/verification.
- No Rust conversational transcript.
- UI/index/analytics are derived.
- Every effectful path ultimately uses Guard/ExecutionHost.

## Current runtime status observed before this documentation-only consolidation

Existing and source/test-backed:
- OpenCode provider/LLM/Session/tool substrate is locally present.
- Rust OwnerLog/protocol/transport/session projection primitives exist.
- Linux local peer authentication and host/kernel hello/readiness path exist.
- bounded Session subscription/page/ACK/replay primitives exist.
- Core can launch the Rust supervisor in existing tests.
- Core provider runner has a tested whole-response local-call staging barrier before Bun ToolRegistry dispatch.

Not complete:
- production automatic Session lifecycle/cursor consumer acceptance across all paths;
- active-turn crash-recovery/platform parity;
- universal Rust Guard/EffectService/ExecutionHost mediation of every mutation path;
- full managed Goal/Run runtime acceptance;
- browser/desktop/web-search/DAP/REPL Horizon services;
- final unified UX/artifact/platform/release acceptance.

Catalog/schema presence for a feature means DESIGNED, not WIRED.

## Last recorded runtime verification before consolidation

From the prior handoff:
- Rust kernel workspace: 148 tests passed; fmt, strict Clippy and binaries passed.
- packages/core kernel projection integration: 5 tests / 52 assertions passed.
- packages/core session runner: 91 tests / 296 assertions passed.
- recorded provider fixture: 1 test / 15 assertions passed.
- packages/opencode HTTP route fixture: 3 tests / 10 assertions passed; typechecks recorded passing.
- full Core suite had 1146 passed and one parallel timeout that passed 10/10 when isolated.

This consolidation changes architecture/docs/contracts only. Re-run relevant runtime tests after implementation changes and do not infer current pass from this historical evidence.

## First implementation dependency

### Gate P1.2-B — finish production Session observer lifecycle

Owners/source:
- packages/core/src/session/supervisor.ts
- packages/core/src/session and public SessionV2 flow
- packages/server composition
- kernel/src/session_projection.rs
- kernel/src subscription/handshake/supervisor/startup paths
- existing Bun/Rust integration tests

Required before close:
- automatic lifecycle/cursor owner for relevant Session;
- authenticated/versioned startup;
- bounded redacted pages + exact completed-page ACK;
- restart/resnapshot and retention gap;
- active-turn crash/recovery proof;
- no conversational write from Rust;
- platform support stated truthfully.

### Gate P1.3 — universal ToolBatch Guard

Immediately after P1.2-B:
- enumerate Core and legacy shell/edit/Git effects;
- plugin/skill/hook/MCP;
- LSP/DAP;
- browser/desktop;
- REPL;
- settings/auth/network/provider-hosted paths;
- external-agent effects.

Collect and validate the complete provider local-tool batch before any effect. PREPARE in Rust, issue one-use lease, execute through authorized ExecutionHost, settle receipt/UNKNOWN. Disable effect paths that cannot be pre-authorized.

Do not build effectful new OMP-inspired services before this boundary.

## Subsequent order

P2 managed control -> P3 coding/RepoIntel -> P4 LSP/DAP/REPL -> P5 browser/desktop/web search -> P6 agents/extensions/provider/settings UX -> P7 streaming/artifacts/analytics/automation -> P8 long-horizon/evaluation -> P9 release.

Exact dependency/exit criteria: arch_V1/10-DELIVERY.md.

## External source reuse

Use arch_V1/42-EXTERNAL-SOURCE-PROVENANCE-REGISTER.md.

The local Horizon base SHA above was not present on GitHub remote at audit time; do not fabricate a public tree URL. Remote main at that check was a22f810daa76f42e99a8e455af9e949bf9a4788e.

OMP/OpenCode/competitor pins in 42 are source/reference evidence only.

## Architecture consolidation note

The 2026-10-11 cleanup:
- archived the previous 46-document bodies before consolidation;
- reduced 21 duplicate/research/audit chapters to non-normative compatibility stubs;
- removed active competing conversation-owner state machines/schemas;
- established one active topic owner per area;
- added first-class desktop.*, web.search.*, debug.* and repl.* capability families;
- added their service LLD, security/test contracts and machine schemas;
- corrected first-party source provenance;
- rewrote validators to prevent stale authority from returning.

No runtime source was edited by this consolidation.

## Final architecture-consolidation verification

After the lean consolidation on 2026-10-11:
- active normative architecture: 25 owner/index/glossary documents, 6,382 lines;
- 21 duplicate/research/audit chapters are short non-normative compatibility stubs; full prior bodies preserved in docs/architecture-archive/2026-10-11-pre-lean-consolidation;
- active stale ThreadService/ThreadStoreService/Rust-canonical-conversation terms: 0;
- active normative references to compatibility stubs: 0;
- actionable broken local Markdown links in regenerated repository manifest: 0;
- JSON Schema files: 25;
- canonical machine capability registry IDs: 223; §33 fenced public capability IDs checked: 203;
- scripts/architecture/validate_convergence.py: 1,012 checks, 0 failures;
- scripts/architecture/validate_external_sources.py: 413 checks, 0 failures;
- existing Bun Core-to-Rust Session projection: 5 passed / 52 assertions;
- existing Rust authenticated RPC ABI test: 2 passed / 0 failed;
- git diff --check: passed.

The contract-test runner explicitly warns that newly added service schemas are DESIGNED, not generated/wired real TS/Rust services yet. That work begins only at the dependency gates in §10/current plan.

## Working-tree discipline

Preserve every pre-existing modification/untracked file. No commit/push/reset/cleanup has been authorized by this handoff.

## P1.2-B runtime inspection (2026-10-11)

- `SessionSupervisor.node` is registered in Core/OpenCode composition, but the only `open()` callers are in `packages/core/test/kernel-projection-live.test.ts`; production code has no automatic per-Session lifecycle/cursor owner.
- `Database.path()` and `Global.Path.state` provide existing source/state roots. No production resolver or provisioner supplies the observer executable or `hostBuildDigest`; the only observed executable is the local test build at `kernel/target/debug/session_supervisor`.
- Rust `session_supervisor` is Linux/Unix-domain specific and serves bounded pages on explicit Subscribe. Existing process tests cover authenticated startup, ACK, restart/resnapshot and source read-only behavior; they do not prove automatic host lifecycle or crash recovery during an active provider turn.
- Baseline on this work unit: `cd packages/core && bun test test/kernel-projection-live.test.ts` — 5 passed / 52 assertions; `cd kernel && cargo test -p horizoncode-kernel --test session_supervisor_process` — 8 passed.
- At this inspection point P1.2-B remained open; production wiring and verification are recorded below.


## P1.2-B production Session observer lifecycle — verified (2026-10-11)

- `SessionExecutionLocal.node` is installed as the `SessionExecution.node` replacement in HTTP SessionV2 composition. Each local provider drain starts a scoped `SessionSupervisor.watchSession` against the exact `Database.Service.path`; the watcher ACKs bounded redacted pages, survives an active-turn sidecar kill, and performs a final catch-up scan after turn completion.
- Bundled native Linux GNU packages compile the Rust observer with `--locked --offline --release`, embed the exact bytes and a SHA-256 manifest, and report unsupported package targets as unavailable. Runtime installation is owner-private and pin-verified. The host build digest is computed by the observer from the actual host executable, not a synthetic/test digest.
- Retention-gap recovery removes only validated owner-private derived projection/cursor files after the old child scope exits. The Rust sidecar reconstructs the projection from the unchanged read-only EventV2 database. A repeated gap or unsafe state file fails closed.
- SessionLink remains observational: the OpenCode Session ID owns the source stream, the configured database path selects the store, the durable cursor is `{seq,eventDigest}`, the lease/handshake bind epochs and process incarnation, and the Rust projection exposes only event/message/call identifiers. No Rust conversational writer or duplicate transcript was added.
- Verification: `cd packages/core && bun test test/kernel-projection-live.test.ts test/session-runner-recorded.test.ts` — 8 passed / 91 assertions; `cd packages/core && bun run typecheck` — passed; `cd kernel && cargo test -p horizoncode-kernel --test session_supervisor_process` — 9 passed; `cd packages/opencode && bun run typecheck` — passed; `cd packages/opencode && bun run script/build.ts --single --skip-install --skip-embed-web-ui` — package build and `opencode --version` smoke passed. The generated Linux x64 GNU manifest SHA-256 matched `kernel/target/release/session_supervisor`.
- Platform evidence is Linux x64 only. Linux arm64 is a supported build target when built natively but was not exercised; Windows, macOS, musl and cross-compiled observer targets are reported unavailable.
- The task-created `packages/opencode/dist/` output was removed after verification. `kernel/target` was retained as a reusable 599 MiB build cache. Only the primary worktree was used. Existing user changes were preserved; no commit, push, reset, or broad cleanup was performed.

The first bounded effect step is recorded below; P1.3 remains open until every active mutation origin uses the canonical Guard/ExecutionHost boundary.

## P1.3 effect-entrypoint inventory (2026-10-11)

This is an inventory of active source paths, not a claim that the P1.3 gate is implemented. “Permission” below means the existing TypeScript/OpenCode permission service, not Rust Guard. The two read-only scouts covered the independent extension and specialized-runtime slices; their findings were checked against the principal dispatch, ACP, composition and kernel sources listed here. No tests/builds were run for this inventory.

| Origin | Active entrypoints and behavior | Current boundary/status |
|---|---|---|
| Legacy model tools | `packages/opencode/src/session/tools.ts` wraps model calls, runs plugin before/after hooks, then calls `item.execute(args, ctx)`; `ctx.ask` delegates to `Permission.Service`. `tool/registry.ts` loads builtins and dynamic plugin/local `.js`/`.ts` tools. Shell (`tool/shell.ts`), write/edit/patch, Git/VCS, format and PTY paths execute in Bun/host services. | Direct OpenCode execution after existing permission asks; no Rust Guard, lease, or ExecutionHost. Tool definitions/callbacks are not a complete-batch Rust admission. |
| Plugins/hooks/workspaces | `plugin/index.ts`, `plugin/loader.ts`, `tool/registry.ts`, and plugin trigger callsites load/import arbitrary configured code; `control-plane/workspace-adapter-runtime.ts` invokes adapter callbacks. `control-plane/workspace.ts` passes `OPENCODE_AUTH_CONTENT` to workspace creation callbacks. | In-process plugin/adapter callbacks and host SDK/process/network access; no Guard/ExecutionHost. HTTP Authorization protects route ingress only. |
| MCP and code mode | `mcp/index.ts` starts configured stdio child processes or remote HTTP/SSE clients; `mcp/catalog.ts` invokes `client.callTool`. `session/tools.ts` asks existing Permission before model MCP calls; MCP resource prompt attachment and resource-list paths also call clients directly. Experimental `tool/code-mode.ts` is one-shot confined interpretation with explicit MCP child calls, not a persistent REPL. | MCP tool effects are server-defined; current paths use SDK transports and existing TypeScript permission checks, not Rust mediation. |
| Skills, subagents, ACP | Skill discovery (`skill/discovery.ts`) fetches configured remote indexes/files and writes local cache; `tool/skill.ts` loads content but does not execute skill scripts. `tool/task.ts` creates/resumes child OpenCode Sessions and background jobs; child tools reuse the legacy path. `opencode acp` accepts an external ACP client; `acp/service.ts` accepts client-provided local/remote MCP configs. `acp/permission.ts` can call the client's `writeTextFile` for an approved edit proposal before replying to Permission. | Direct host/network/cache or ACP-client effects. ACP is an ingress/Session adapter, not a separate external-agent launcher. No Rust Guard. |
| LSP and search/fetch | `tool/lsp.ts` exposes query operations behind existing permission; `lsp/lsp.ts` starts configured child servers and `lsp/server.ts` may download/install language servers on first use. Legacy web-search/fetch tools use `HttpClient` after current permission; V2 Core web tools use `PermissionV2` and direct HTTP. | Local LSP tool is read/query-only, but server startup/install has process/network/global-file effects. Search/fetch are remote reads. No Rust Guard/ExecutionHost. |
| HTTP/control plane, auth and provider network | OpenCode HTTP handlers cover session prompt/command/shell, MCP lifecycle/OAuth, provider OAuth, workspace adapters, config, project/VCS, PTY and related state changes. Shared server handlers include credentials, PTY and project-copy operations. Provider/plugin auth and integration callbacks make HTTP requests and persist credentials. Model/provider requests use TypeScript HTTP clients. | Auth middleware authenticates ingress; it is not action authorization by Guard. Effects remain in Bun/TypeScript/SDKs. No standalone named-tool HTTP execution endpoint was found in the inspected OpenCode routes. |
| Core V2 runner and builtins | `packages/core/src/location-services.ts:42-79` mounts `BuiltInTools.node`, `ToolRegistry` and `SessionRunnerLLM`; `packages/core/src/session/runner/llm.ts` waits for terminal provider/step completion and validates every local call before settling any. `ToolRegistry.settle` invokes registered callbacks directly, then `ToolOutputStore.bound` may write oversized output to `Global.data`. Builtin FS/shell/network tools execute through TypeScript services; several call `PermissionV2.assert`. | This is a production model-tool path with the complete local-call validation barrier, but no Rust Guard/ExecutionHost. Keep the existing OpenCode `PermissionV2` behavior while adding the canonical Rust boundary; do not bypass it or activate a parallel tool runtime. |
| Provider-executed tools | OpenAI Responses and Anthropic adapters decode hosted/web/file/code/computer/MCP/shell events as `providerExecuted`; Core runner skips local dispatch and persists their events/results. The inspected outbound request builders supplied ordinary request tool definitions, not hosted-tool descriptors. | Provider-side execution cannot be reversed or guarded after the returned event. Actual hosted-tool availability/configuration was not established; keep unavailable unless preauthorization is enforceable. |
| Browser, desktop, DAP, REPL, connectors, external agents | No agent-facing browser/computer-control, DAP, persistent REPL, dedicated connector invoker, or external-agent launcher was found in the inspected OpenCode/Core/runtime. UI clipboard/window IPC is user-facing, not an agent computer-use surface. CodeMode is the one-shot MCP interpreter above; Task is an OpenCode child Session. | Catalog/service contracts are design status only; no runtime effect path to claim or migrate yet. |
| Rust effect owner | `kernel/src/` currently contains protocol, owner-log, startup, artifact, Session projection and supervisor modules; it has no Guard/EffectService/ExecutionHost implementation. Generic `RpcRequestV1` types exist, but `kernel/src/bin/session_supervisor.rs` accepts only Session Subscribe/Unsubscribe controls. `packages/core/src/session/supervisor.ts` owns a per-Session/active-turn observer child. | Observer currently has read-only authority and no effect RPC. Keep that boundary until the canonical Rust Guard/EffectService/ExecutionHost is implemented within the single execution owner. Contract schemas under `arch_V1/contracts-v2/` are design inputs, not runtime proof. |

The first production integration should use the mounted Core V2 ToolBatch path and a bounded existing builtin (start with `files.write`), preserving OpenCode Session/provider ownership and validating the entire local batch before any mutation. Unsupported effectful siblings must deny the whole batch until routed. Keep the per-Session observer read-only; implement one Rust execution owner rather than another independent process manager. Unmediated hosted effects remain unavailable.

At inventory time: the only current-tree worktree was the primary tree; existing user changes remain untouched. The already-running `scripts/build_full_catalog.py --only-source feed:skills-sh` process (PID 9427) was observed and left running. No task-created worktrees, builds or temporary resources were created.

## P1.3 first guarded Core V2 effect — implementation status (2026-10-11)

- `SessionRunnerLLM` collects and validates the full local provider-tool batch before settlement. Its turn digest binds the fixed `SessionRunnerLLM` identity, Session, agent, provider/model/variant, configured agent permissions, a content-addressed `PermissionV2.policySnapshotDigest`, and materialized tool definitions. `PermissionV2.policySnapshotDigest` hashes versioned JSON containing configured agent rules and canonically sorted saved project grants; saved row IDs are excluded. The snapshot is captured once per provider turn; effect-time `PermissionV2.assert` remains authoritative, including after an explicit `always` approval. This Core path has no selectable harness.
- Core and Rust negotiate `effects.v2`. Rust `EffectHost` currently accepts only one `files.write` per batch, persists the turn-context digest with its challenge, and revalidates the Guard intent at approval, execution, and PREPARED recovery. Existing schema migration adds the digest column; legacy contextless PREPARED rows fail closed as UNKNOWN. Unsupported effects remain denied. A live integration test now sends the actual `SessionRunnerLLM`-generated digest through the Rust process supervisor and verifies a permitted file write, replay denial, and absence of the secret write payload from `effects.sqlite`.
- This is not P1.3 acceptance. Legacy OpenCode tools/routes, MCP, plugins/hooks, LSP installs, auth/settings/network, and hosted/provider-side effects remain outside Rust Guard. Do not enable those paths based on this slice.
- Verification: previous Core targeted Bun suite — 102 passed / 385 assertions; Core typecheck passed; `cargo test --manifest-path kernel/Cargo.toml --locked --offline` — 158 passed; `cargo test --manifest-path kernel/Cargo.toml --locked --offline --test session_supervisor_process` — 16 passed. Current `bun run typecheck` passed; `bun test test/permission.test.ts test/session-runner.test.ts` — 104 passed / 345 assertions (including stable/change-sensitive PermissionV2 digest and same-session Guard-context binding); isolated `bun test test/session-runner-recorded.test.ts` — 1 passed / 24 assertions; `bun test test/kernel-projection-live.test.ts -t "SessionRunner binds its generated context digest through Rust effects.v2"` — 1 passed / 9 assertions (real Core runner, built-in write, Rust supervisor, replay denial and no raw payload in `effects.sqlite`). A combined run initially timed out in that recorded observer test at its 30s outer bound while running concurrently with typecheck; its outer bound is now 60s (internal wait bounds total up to 50s), and the isolated rerun passed. Full Core suite — 1,137 passed, 6 skipped, 7 failed (3 `util.flock` timeouts, 2 Amazon Bedrock provider timeouts, 2 Google provider timeouts). Isolated `test/util/flock.test.ts` passed all 10 tests; isolated Amazon provider file failed during import with `Cannot access 'AmazonBedrockPlugin' before initialization`; Google isolation was not run. These are the exact observed suite results, not a green full-suite claim.
- Latest disk check: 841 GiB free; shared `kernel/target` is 716 MiB and retained. No task-created worktrees or builds; subagents were read-only.
- The existing source allowlist now exposes only `PermissionV2` and the Core test files touched by its required service-method migration; the rest of the local OpenCode base remains ignored.
- Verification update: the extended command `cd packages/core && bun test test/kernel-projection-live.test.ts -t "SessionRunner binds its generated digest through Rust effects.v2 and denies multi-write batches"` passed — 1 test / 15 assertions. `cd packages/core && bun run typecheck` passed after the test edit. The live flow verifies the actual Runner-generated digest, a permitted single write, Rust denial of a two-write batch, no partial file writes, replay denial, and absence of raw request content in `effects.sqlite`.
- Additional Core regression: `cd packages/core && bun test test/session-runner.test.ts -t "denies the complete batch when Rust effect preparation is unavailable"` passed — 1 test / 5 assertions. The test proves a supervisor/Rust preparation error denies both a local effectful write and its read-only sibling before settlement; Core typecheck passed after the test change.
- The legacy files `packages/opencode/src/session/{llm.ts,tools.ts,processor.ts}` are currently ignored by `.gitignore:3` and absent from the tracked source allowlist. Any shippable legacy batch-dispatch implementation needs exact, narrow allowlist exceptions rather than invisible ignored-file edits.
Next exact step: add narrow `.gitignore` exceptions for the legacy session dispatch files, then implement the complete-batch handoff under the current Gate 2 contract. Collect/validate the whole local tool batch before any callback can mutate, then route it through the Rust-supervised execution owner. Keep unsupported origins denied; do not wrap individual callbacks as single-operation batches.
Pinned SDK finding: `opencode/package.json` and `opencode/bun.lock` pin `ai` 6.0.168. Its `run-tools-transformation.ts` parses each provider `tool-call` chunk and invokes the corresponding `tool.execute` immediately; the stream-level `onLanguageModelCallEnd` hook found in current docs is absent from this pinned version. `session/tools.ts` currently supplies those callbacks, while `session/llm.ts` uses SDK `streamText` and `processor.ts` consumes normalized events. Therefore legacy migration needs an explicit batch-dispatch seam, not a callback wrapper. No production path was enabled by this finding.

## OMP upstream research — reference only

- The extension control center was source-checked at OMP commit `03929eb809b93997bb5ccb0ac042f5162a7ee2b6`. `/extensions` is a fullscreen TUI/native picker with provider tabs, extension inventory, filtering, per-kind inspector, provider and user-source switches, per-item disable, and MCP persistence plus live runtime reconciliation. It is a control surface, not the installer; marketplace install/remove/upgrade and plugin enablement live in separate `/marketplace`, `/plugins`, and Settings→Plugins flows.
- Relevant sources: [`extension-dashboard.ts`](https://github.com/can1357/oh-my-pi/blob/03929eb809b93997bb5ccb0ac042f5162a7ee2b6/packages/tui/src/overlays/extensions/extension-dashboard.ts), [`dashboard-runtime.ts`](https://github.com/can1357/oh-my-pi/blob/03929eb809b93997bb5ccb0ac042f5162a7ee2b6/packages/coding-agent/src/modes/components/extensions/dashboard-runtime.ts), and [`plugin-manager-installer-plumbing.md`](https://github.com/can1357/oh-my-pi/blob/03929eb809b93997bb5ccb0ac042f5162a7ee2b6/docs/plugin-manager-installer-plumbing.md).
- Security boundary: OMP documents plugin code as unsandboxed and imported in-process. Reuse the inventory/enablement UX pattern only; HorizonCode's Rust Guard/ExecutionHost remains mandatory for mutating plugin/MCP capabilities.
- Catalog research: OMP `packages/catalog/src/model-manager.ts` already resolves bundled → cache → Models.dev fallback → provider discovery; it has a two-hour default cache TTL and additive-only Models.dev fallback support. `packages/catalog/src/provider-models/openai-compat.ts` owns the descriptor/mapping pipeline. Extend this existing OMP catalog path if integrating it; avoid a competing HorizonCode Models.dev polling/catalog pipeline. OMP `pi-ai`/`pi-catalog` behavior still requires local dependency/runtime and integration verification before adoption.
- OpenCode free-model source verdict: the native client has a deliberate no-API-key selection path, but actual free-model eligibility is conditional on the selected model's server-side anonymous-access policy. No live inference call was made; source evidence follows.

## OpenCode free-model access without a provider API key — source verdict

- OpenCode `dev` client code sets provider `apiKey: "public"` when `OPENCODE_API_KEY`, a Console connection, and configured provider key are all absent. It disables models with any nonzero input cost. This confirms a deliberate no-key client path for zero-input-cost models.
- Deterministic source tests at `opencode/packages/core/test/plugin/provider-opencode.test.ts:260-338` assert the `"public"` no-key client selection and paid-model filtering. The focused command `cd opencode/packages/core && bun test test/plugin/provider-opencode.test.ts -t "without credentials"` could not start: the extracted source tree has no resolvable `effect` package. No dependency installation or network call was attempted; this test evidence is not live gateway eligibility evidence.
- The Zen gateway only routes a keyless generation when the selected deployed model entry has `allowAnonymous === true`; otherwise a missing key or `"public"` returns HTTP 401 `AuthError`. `allowAnonymous` is optional model metadata, and the catalog is loaded from deployment `Resource.ZEN_MODELS1..30` secrets, not source-controlled model entries. Thus no-key access is supported by the client but not guaranteed for every model or current service policy.
- The official Zen docs describe signing in and obtaining an API key for ordinary Zen use. Runtime acceptance must use the actual OpenCode provider/model list with no key, then test a harmless prompt only against a currently discovered no-cost model after user authorization. No remote inference or credential use was attempted in this task.
- Native adapter rule: use the official OpenCode runtime and its own provider list. Do not reproduce the `"public"` sentinel in HorizonCode, copy credentials, spoof client identity, promise anonymous availability, or silently fall back to a paid model. Surface 401/403 as restricted/ineligible.
- Sources: [OpenCode native provider plugin](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/plugin/provider/opencode.ts), [Zen route gate](https://github.com/anomalyco/opencode/blob/dev/packages/console/app/src/routes/zen/util/handler.ts), [Zen model schema/catalog](https://github.com/anomalyco/opencode/blob/dev/packages/console/core/src/model.ts), [Zen docs](https://opencode.ai/docs/zen), and [Server API](https://opencode.ai/docs/server/).
