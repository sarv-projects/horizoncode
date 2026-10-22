# HorizonCode — current implementation checklist (2026-10-11)

## 2026-10-22 — direct CodeMode recovery update

P1 has added source for direct-root CodeMode terminal receipt recovery in
EffectHost. It validates trusted authority, exact committed wave frame/digest,
direct scope and ordered calls against durable `session_batch` rows, and
projects immutable per-call receipt refs/kinds/digests. P1 also added the
DB-derived wave-pin resolver; P2 can recover committed authority and pins
without request-supplied values. This supersedes the earlier “direct query
missing” checkpoint. It remains source-only: P2 must wire the authenticated
HostKernel start/resume/cancel/inspect lifecycle and typed Core Supervisor
projection; P7 must consume it through ordinary ToolBatch. P1's ExternalEditor
binding now carries a typed cgroup identity, which P2 must pass through and
reconcile only after verified quiescence. No tests/builds/typechecks ran; V1 is
PARTIAL / NOT VERIFIED / NOT RELEASED.

CodeMode authority contract: §37.24 start has no Core-supplied lease field.
HostKernel resolves the authenticated current Session/Attempt and Location,
checks enablement, and prepares the outer `codemode.execute` effect/lease
itself. Core passes only trusted lane binding, request ID, enablement ref and
bounded frame. Missing Session→Location authority remains fail-closed.
P7 resolves call correlation through the ordinary `codemode.execute` Tool.Def
trusted Tool.Context `{sessionID,callID,lane,abort}`; callID is private typed
Supervisor context only. HostKernel matches the active Guarded call, derives
the challenge/lease and binds a fresh host requestID before spawn. No new
public RPC fields or caller lease.

P1 has added persisted terminal cgroup binding and startup UNKNOWN/quiescence
reconciliation APIs for interactive `terminal.run`/`terminal.start`; P2 has
source-wired HostKernel with exact Guard lease, principal, Attempt/profile/
owner-epoch pins and kill-and-empty proof before settlement. The route stays
gated by `GUARDED_PTY_RUNTIME_READY=false` pending acceptance. P1 also added
strict CodeMode execution inspect, but P2 still owes authenticated
start/resume/wave/cancel and typed Core lifecycle. P1 removed the stale
anonymous Tavily route; four fixed keyless routes remain with BYO Tavily
separately enabled. Source only; no validation.
P1's effect-origin source audit closes current plugin/MCP/hook/legacy process
bypasses: only pinned HostKernel/session-supervisor processes can launch;
plugin hooks are inert; MCP is unavailable; project tools are not imported.
P2/P4 typed routes and integrated acceptance remain required.

P7 source audit: ActivityStream projection, source-generation/sequence fencing,
resnapshot, ContextLedger display and usage/cost analytics exist in source but
are not verified. P1 provides
`list_direct_attempt_terminal_artifact_receipts`; P2 has source-wired direct
artifact list plus authenticated Core inspect/range and EffectHost /
ArtifactStore receipt checks. P7 integrated this for direct child Attempts
through authenticated `SessionTools` scope, artifact search and opaque shell
ref hints for non-sensitive FULL/SAMPLE captures. Root sessions lack
DirectAttempt scope, so root search remains unavailable. Source only.

Artifact lookup decision: P2 uses P1's terminal-receipt enumerator and reuses
ArtifactStore's deterministic
`terminal_<blake3(effectID)>` key only after deriving effectID from the
authenticated current direct Session → committed ToolBatch → settled receipt
chain and validating stored owner refs, workspace revision, DirectAttempt/effect
IDs and terminal receipt digest. No duplicate database/index or caller-supplied
artifact ID/path.

P7 now includes the canonical Core `providerRequestID` in
`SessionEvent.Step.Ended.usageProvenance.requestID`, aligning session analytics,
ContextSelection and the future P6 journal. P6 still owns non-wire propagation
through RequestExecutor; provider dispatch remains closed.

P7 now includes exact byte counts for Session-message/profile ContextLedger
sources where encoding is known. The aggregate provider input leaves bytes
unknown because `ledger.requestBytes` already reports the total; token counts
remain unknown without tokenizer-based estimates. Core currently exposes only
direct CodeMode wave receipt lookup;
P2 still owes the typed start/resume/prepare-wave/settle lifecycle needed by
P7's ToolBatch consumer.

P7 fixed the ContextLedger source race by pinning it to the `sourceRevision`
captured when Core freezes the request context. Later Session events cannot be
included; cursor lookup failure only suppresses the UI ledger.
The TUI summary labels exact request payload bytes separately from unknown
token counts and includes refs/protection/cache classes.
P7 source review fixed a ContextLedger unbound `sourceRevision` identifier;
typecheck remains deferred.

## 2026-10-22 — cross-phase integration checkpoint

P1/P2/P7 remain active whole-phase owners. P2 has the authenticated managed
effect-wave receipt projection over P1's durable EffectHost rows; exact
`challengeID` is the known terminal `receiptRef`, while pending fails and
UNKNOWN carries no public receipt fields. Direct-root CodeMode still needs the
equivalent P1 DirectSession query and P2 HostKernel caller, bound to Session,
owner epoch, policy/workspace and exact ToolBatch. P7 owns the shared Core
ToolBatch consumer. Both CodeMode lanes stay unavailable until the proof path
is integrated.

P7 now mints a single stable direct provider request ID on canonical
`LLMRequest.id` at request construction for both ContextLedger and the durable
provider journal. P6 must carry that same ID as non-wire RequestExecutor
metadata. `HttpTransport` presently drops `LLMRequest.id`
when invoking the executor, so carry it as non-wire executor metadata rather
than a provider header. Provider sending remains closed until exact route,
profile/context/scope pins and atomic assistant/usage/journal settlement are
connected. Implementation-first hold remains active; no tests or builds yet.

## 2026-10-22 — current continuation checkpoint

Latest P7 source adds a typed Core `Tool.Context.dispatchPreparedToolBatch`
callback in the active direct `SessionRunner`. It validates complete bounded
waves, admits effect-only waves through ordinary `prepareToolBatch`, validates
one-use leases and settles through the frozen Core materialization. The callback
does not recurse or fabricate §37.24 receipt refs/digests. P5 Core CodeMode
registration and P1/P2 authenticated nested-wave receipt projection remain
required; CodeMode stays disabled. No tests/builds/typechecks/audits/provider
calls ran.

Live source owners: P1 Guard/ExecutionHost, P2 managed lifecycle/HostKernel,
P7 streaming/context/artifacts/automation/rewind. P4 handed off PARTIAL with the
Explorer callback now carrying exact `contentDigest`; P6/P8/P9 remain queued
because the child-thread limit is full. Workspace editor launches remain closed
until P1 binds original path/revision/digest to private scratch and P2 exposes
authenticated lifecycle; successful workspace results require a separate Guarded
`files.patch`. P7 is wiring the direct Core SessionRunner caller; P6 must supply
the selected-route Core RequestExecutor adapter. P7 has wired the best-effort
direct ContextSelection/ContextLedger projection, but not the provider journal
or dispatch. P1's durable editor binding remains in progress; its Attempt-scoped
process/effect receipt-recovery query is source-present with exact per-effect
pins. P7 owns the Core nested-wave callback; P5 must add the
Core CodeMode registry adapter. No tests/builds/typechecks until implementation
closes. V1 PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-22 — direct-provider caller correction

Direct-provider source wiring targets the canonical Core `SessionRunner` → `LLMClient.stream` path. The OpenCode-derived `session/llm.ts` branch is not the normal direct caller. P7 owns Core caller/LLMClient integration over SessionStore's existing direct request journal; P2 supplies trusted profile/context/route pins and P6 supplies selected-route transport. Keep dispatch gated until exact frozen pins and atomic settlement are consumed.

## 2026-10-22 — active whole-phase owner checkpoint

P2 managed lifecycle/HostKernel, P4 LSP/DAP/REPL/external editor, and P7 streaming/context/artifacts/analytics/automation/rewind are active. P1 returned PARTIAL after its unblocked source pass and remains responsible for integration/acceptance. P3 and P5 handed off their unblocked Explorer and search/CodeMode source; search and CodeMode stay gated pending P1/P2/P7. P6, P8, P9 and final V1 acceptance remain open. No tests/builds/typechecks/audits/provider probes before implementation closes, per user direction. Mixed Git state preserved. V1 PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-22 — current live roster correction

Active whole-phase owners: P1 Guard/ExecutionHost, P2 managed lifecycle/HostKernel, and P4 LSP/DAP/REPL/external editor. P3 handed off unblocked authenticated Explorer/discovery and exact-revision preview source. P5 handed off unblocked search cascade receipt/retry and authorized CodeMode catalog/strict adapter source; both remain unavailable pending P1/P2/P7. P7 is next to resume when a slot opens. P6/P8/P9 closure and final V1 acceptance remain outstanding. The user requested source implementation before tests; no checks/provider probes are running. Mixed unstaged/untracked work is preserved. V1 PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-22 — current active implementation owners

P1 Guard/ExecutionHost has resumed source implementation. P4 owns the configurable command-only editor, external-editor profile settings/launch adapter, and supervised LSP/DAP/REPL source. P5 owns the approved built-in search cascade and CodeMode source. P3 handed off currently unblocked authenticated Explorer/discovery and exact-revision preview source. P2 and P7 remain the next whole-phase owners when slots open; P6/P8/P9 source closure and final acceptance are still outstanding. The user requested implementation before tests, so no tests, builds, typechecks, audits, provider calls, benchmarks or release gates are being run yet. Git remains mixed and unstaged; preserve unrelated work. V1 PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-22 — live source-only owner correction

Active whole-phase owners: P3 RepoIntel/Explorer, P4 LSP/DAP/REPL/external editor, P5 web search/CodeMode. P3 has implemented authenticated bounded HostKernel discovery/read routes, SDK projections and revision-bound `/editor` previews; exact ignore exceptions expose new files to Git. P4 removed ambient LSP filesystem marker probing and added strict editor-profile schema/config; profile CAS/settings and the gated launch adapter are underway. P5 fixed explicit-null zero-send receipt parsing and added authorized CodeMode catalog projection; nested dispatch remains unavailable pending P1/P2/P7. Further P1/P2/P7 owners could not start because the platform reports its thread limit reached; their source is partial and unaccepted. Verification remains deferred until implementation closes by user instruction. Preserve mixed Git state. V1 PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-22 — current source owner update

P1/P2/P7 agent processes terminated at the platform usage limit; preserve their partial source and resume those whole phases when execution capacity returns. Current owners are P3 RepoIntel/Explorer, P4 LSP/DAP/REPL/editor, and P5 web search/CodeMode. Parent added an optional EventV2 commit callback to OpenCode-derived `Session.updateMessage`; it runs after registered projectors inside the same durable event transaction and provides the seam for atomic provider request settlement. P2 partially added global primary AgentProfileV2 selection but has not propagated complete authenticated root-session profile/scope/policy/harness/route pins. Direct provider dispatch stays gated. P1's exact HTTP/Git-read output persistence/replay APIs still need P2 production wiring. P5 fixed the explicit-null `NOT_DISPATCHED` route-receipt parser. User implementation-first hold remains: no tests/builds/typechecks/audits/providers/benchmarks/release checks until source closure. Preserve mixed unstaged/untracked Git state. V1 PARTIAL / NOT VERIFIED / NOT RELEASED.

## Live continuation status — 2026-10-22

Implementation remains source-only at the user's direction; do not begin tests, builds, typechecks, audits, provider probes, benchmarks or release gates until requested V1 implementation closes. Active whole-phase owners are P1 Guard/ExecutionHost, P2 managed lifecycle/HostKernel, and P7 streams/context/artifacts/analytics/automation/rewind. P6 handed off PARTIAL after completing currently unblocked source work; refill other whole phases as actual slots open. Parent's bounded P9 CodeMode packaging seam consists of a stdio-only helper entrypoint plus Linux GNU bundle and SHA-256 manifest; it is not production exposure. Trusted HostKernel/Core resolution, Guarded nested ToolBatch receipts and cancellation remain required. P1 owns the Session-scope managed-verifier binding and Guarded Git-read EffectHost receipt/replay; P2 owns HostKernel constructors, authenticated Git-read RPC/caller and managed lifecycle. P7 owns the frozen provider payload/ContextSelection and reusable CodeMode nested ToolBatch callsite. See the latest `HANDOFF.md` and `CURRENT_RUN.md` for exact source checkpoints and preserved Git state.

**Parent integration decision — bounded project Git read:** implement the read path under the existing workspace `files.read` grant policy. A valid preauthorized workspace grant avoids per-read prompts; if Guard returns ASK, use the normal authenticated UserAction approval challenge. P1 owns EffectHost Guard binding, durable bounded output/result receipt and exact-binding replay; P2 owns the authenticated HostKernel RPC/Core caller. Possible-send ambiguity stays UNKNOWN and cannot be relaunched. Keep readiness closed until the integrated route has later passed acceptance.

## 2026-10-22 — implementation owner/source refresh

Active whole-phase owners: P1 Guard/ExecutionHost; P2 managed lifecycle, HostKernel and bounded DAG; P5 built-in web search/CodeMode. P3 and P7 have completed their currently unblocked source passes and remain open for integrated dependency work. P1's managed verifier launch binding, trusted HTTP proof, whole-MCP-handshake executor and no-response aggregate settlement are source-present; terminal CANCELLED/FAILED/EXHAUSTED validates exact ordered history and does not fabricate response fields. P2 added nullable `notDispatchedFailure` to normal and restart receipt projections and still owns production HostKernel dispatch/recovery integration. P5 source validates retry reason plus durable receipt and empty response metadata, permitting one same-route retry only for `timed_out`/`transport_failure`; it handles aggregate `CANCELLED` and keeps top-level `NOT_DISPATCHED` for pre-plan rejection. Parent/P2 ruling: aggregate `FAILED` represents a known terminal 4xx outside {401,403,407,408,425,429} with plan digest and exact settled history; `EXHAUSTED` means all approved routes/retries consumed; `CANCELLED` applies after plan admission. P5 removed arbitrary CodeMode callback construction; CodeMode stays unavailable until a private ordinary ToolBatch binding is connected to authenticated Rust/P2 settlement. P2 owns profile/lane propagation through managed prompt and recovery paths; P7's current managed ContextSelection builder now supplies `lane: managed`. P3's history range path size-checks serialized rows before JSON extraction and checks identity/size again for the bounded projection. P7's independent source work includes bounded/redacted streams, replay/resnapshot fencing, artifact truth/analytics, and ephemeral ContextLedger event/TUI projection. P2's UI review found Goal proposal/review/start and Run controls wired, with source-only fixture correction/addition; external-editor draft handoff still depends on P4/P1. No verification commands have run by user direction. Preserve Git state; overall V1 PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-22 — live roster/source alignment

Active whole-phase owners: P1 Guard/ExecutionHost, P3 RepoIntel, P7 streaming/context/artifacts. P5 returned PARTIAL after unblocked work; remaining search receipt transport, direct-root BYO scope and CodeMode helper/HostKernel bridge need P1/P2/P6/P7. P2 is next critical-path refill. P3 aligned ContextLedger TypeScript/JSON Schema/§30.2 and added ContextSelection.lane; P2 must update managed prompt and recovery constructors. Parent added the ephemeral session.context_ledger event contract and CTX-001..005; P7 owns event bridge and TUI rendering. P1 confirmed zero-tool pure-compute start is already accepted in Rust. No tests/builds/typechecks/providers/release checks ran.

## 2026-10-22 — active whole-phase continuation

Current whole-phase owners are P1 Guard/ExecutionHost, P3 RepoIntel and P7 streaming/context/artifacts. P5 returned PARTIAL after its unblocked source work; retry settlement/transport, direct-root BYO profile scope, and CodeMode HostKernel/helper integration remain dependent on P1/P2/P6/P7. P2 is next critical-path refill when a child slot opens; P4/P6/P8/P9 remain required. P3 owns ContextLedger service/schema and bounded history source; P7 owns capture/integration of the exact frozen provider payload. Direct-root anonymous search already exists; direct-root BYO search lacks trusted profile-scope source. The user selected one same-route retry only for proven zero bytes sent; ambiguous transport remains UNKNOWN. No tests/builds/typechecks/providers/release checks have run. Continue whole-phase source implementation before verification. Mixed Git state is preserved; V1 PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-22 08:18 UTC — source integration checkpoint

P1 added the read-only EffectHost direct-session protocol grant candidate lookup; P2 added strict HostKernel preflight and `grantPreflightDigest` handling on `resolve_approval`. Parent P4 integrated the validated singleton digest into Core's auto-resolution and restores ordinary approval on typed `effect_conflict`, retrying without the marker. P2 must confirm its typed conflict and persisted challenge behavior support this fallback. No tests/builds/typechecks/audits were run; this is not acceptance evidence. Active whole-phase owners remain P1, P2 and P5; all other V1 phase work remains open/queued. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-22 08:13 UTC — source implementation status

The active child owners are P1 Guard/ExecutionHost, P2 managed lifecycle/HostKernel and P5 search/CodeMode; this is the actual three-slot capacity. P1 reports root DirectSession read-only LSP/DAP grant-helper and durable search `EMPTY` source; P2 reports HostKernel `EMPTY` plus empty-domain `NOT_DISPATCHED`; P5 gates CodeMode before catalog/interpreter access. Parent P4 source adapters now represent root Sessions without synthetic Attempts and check the live HostKernel epoch, but the production prompt path remains child/managed-only because root workspace revision and grant candidate projection are not yet exposed by a trusted HostKernel call. P1/P2 continue that dependency; P4 launch/protocol, search and CodeMode remain unavailable. No checks/builds/typechecks/provider calls ran by user instruction. Mixed Git tree and repo disk state preserved. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-22 07:44 UTC — architecture freeze / whole-phase source ownership

Line-by-line audit is complete for every `arch_V1/*.md`, with current changed sections reread. Final contract corrections include: explicit direct-session challenge choices and fail-closed unsupported profile semantics; Linux/WSL evidence scoped to the Linux backend; one SourceArtifact lowercase wire enum with UI labels; direct Session artifact retrieval with no direct-to-managed promotion; SSE envelope cursor distinct from replay/source-generation cursors; CodeMode direct-vs-managed enablement and ordered receipt/result bounds. External primary-source research is recorded in §42.15. No validation or test execution occurred, per the user's implementation-first instruction.

Active whole-phase owners: P1 Guard/ExecutionHost, P2 managed vertical + bounded managed DAG, P3 coding path/RepoIntel. P4 LSP/DAP/REPL, P5 web search + CodeMode, P6 providers/settings/Doctor/S1, P7 streaming/artifacts/automation/rewind, P8 resources/evaluation, and P9 distribution/release remain required and will be dispatched as capacity frees. Each owner must implement their whole phase; effectful paths remain disabled until actual prerequisites are accepted. No tests/build/typechecks until all source implementation closes. Preserve mixed Git state and all unrelated user changes.

## 2026-10-22 post-compaction implementation continuation

Current whole-phase owners: P1 Guard/ExecutionHost and grant Core caller, P2 managed lifecycle/V1 DAG and HostKernel, P7 streaming/rendering/artifacts/analytics/automation/rewind. P6's unblocked source pass has returned complete; P1/P2 integration and final acceptance remain. P5's bounded TS CodeMode protocol mirror is present, but its whole phase is partial and needs a slot refill. The persisted grant schema excludes generic child-process scope; build/test authority binds immutable user-owned command profiles. Core's pre-prompt HostKernel grant check is now specified in §§3.23/12.21/37.25 and `direct-session-grant-preflight-v1.schema.json`: P1 computes/compares the ordered-ID correlation digest; P2 implements the read-only HostKernel lookup, while atomic Guard approval revalidates before lease. P7 source review found the ContextSelection compiler omits required requestID/provider-input and wrong message source field; P7 owns the isolated compiler, P2 owns `session.ts` caller. P2 must bind generic `terminal.run` to exact immutable command profiles before build/test grants can quiet prompts. CodeMode, raw ripgrep, managed provider sends, and search remain gated until prerequisites integrate. User deferred all tests/builds/typechecks until source implementation closes; none have run. Refill phase slots immediately and continue the full V1 plan.

## 2026-10-22 06:42 UTC — architecture reconciliation and implementation wave

Full line-by-line `arch_V1` source review completed before implementation. Architecture decisions now define direct routine grants through the sole durable Guard authority, with immutable Core-Config `WorkspaceCommandProfileV1` refs for quiet build/test; CodeMode reuses the existing interpreter and only orchestrates currently authorized Core tools through Rust-Guarded waves; bounded managed Task DAGs are V1 after the single-Task vertical acceptance; the one-Task gate is a prerequisite, not a scope reduction. Updated schemas, flow/event/security/runtime/UX/service/capability/test/provenance/atlas owners. Three whole-phase owners dispatched: P1 Guard/ExecutionHost, P2 managed vertical + DAG, P5 web search + CodeMode. Dependencies: P1 Guard/process/helper precedes P2/P5 effectful exposure; P1/P5 CodeMode Core/Rust bridge; P2's single vertical precedes DAG dispatch; P6 SecretBroker/selected provider prerequisites remain for credentialed routes. Source audit also confirms ripgrep remains false-gated before process construction until HostKernel Guarded read integration. User instructed no tests until source implementation closes; none run. Git is heavily mixed and preserved; no Git mutation. Overall V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-21 16:05 UTC — proof replay contract integrated; P7 owner started

P1 source response, §37 contract, and P2 decoder now agree: unbound reservation carries stable Stage-A `proofDigest` plus current `leaseProofDigest`; bound reservation carries those plus stable Stage-B `receiptDigest`; Stage-A replay returns the persisted binding. P2's bind validation retains the original Stage-A identity, admission uses only Stage-B receipt identity, and prepared context replay carries the exact ContextSelection `sourceRevision`. P8 staged lease source is present; remaining HUP/RC0/resource work is dependency-blocked and unavailable. P1 resumed source work in `effect_host.rs`/`http_execution.rs` with no HostKernel overlap; P2 owns HostKernel managed inbox/wake plus Core managed files. P7 is active on streaming/render/artifact/analytics/automation/rewind and the frozen transformed-payload seam. Source only: no tests/builds/typechecks/audits/provider/benchmark/release checks or Git publication. V1 PARTIAL / NOT VERIFIED / NOT RELEASED.

P7 has frozen the provider-transformed managed message payload before authorization, binds that exact payload in ContextSelection, dispatches the same clone and skips a second transform. P2's complete phase review found managed `agents.message` Rust inbox/wake authority missing; P2 now owns the free managed HostKernel source files and is implementing the §29.5/37/45 delivery contract. Source only; no acceptance run.

## 2026-10-21 15:59 UTC — staged admission source integration checkpoint

Active whole-phase owners: P1 Guard/ExecutionHost, P2 managed/direct child lifecycle, P8 workers/resources/recovery; all three child slots are occupied. HostKernel Stage-A reserve source, P8 staged pins plus `PreAdmissionContextBound`, and P2's no-dispatch Core preflight/coordinator are source-present and being integrated. P2 retains the exact prepared request through bind/admit/dispatch; no provider call occurs during preflight. P1 now resolves persisted Stage-A pins before deriving expiry/worktree, preserving the original reservation. Remaining contract seam: distinguish the immutable Stage-B context-bind receipt digest used for idempotent retry from the fresh cursor/pool-bound lease proof used for current admission, since Attempt attachment advances the OwnerLog cursor; Stage-A replay must also expose whether the context was already bound. P1/P8/P2 are coordinating; P7 is queued for the next slot. No checks or provider/benchmark/release operations have run. Preserve the mixed repository state and repository-only boundary. V1 PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-21 15:53 UTC — Pi/Codex contract mapping and managed pre-admission correction

The repo-local Pi/Codex comparison and supplied Pi Durable RFC mapping are recorded in
`docs/research/2026-10-21-pi-codex-harness-decisions.md`; no fresh upstream fetch was done. A
contract contradiction was resolved: P8's full reservation pins cannot require ContextSelection
before Core can compile on the reserved child worktree. P1/P8 are implementing staged
`managed.pre_admission_target.reserve` → Core no-dispatch compile →
`managed.pre_admission_target.bind_context` (`PreAdmissionContextBound` OwnerLog event) → Attempt
admission consuming the same reservation. P1 owns HostKernel; P8 owns durable staged lease/recovery;
P2/P7 must preserve the identical compiled request. No effect, claim or provider send is authorized
by either pre-admission operation.

P6 added the no-dispatch `Provider.managedRouteProjection` from the existing active Provider and
Auth SecretBroker owners. It returns only exact selected provider/model/harness, fixed-route and
endpoint revision identities, opaque stable SecretRef or exact anonymous-free `null`, and trusted
consent/Guard refs. Rust must independently resolve those facts and derive/consume one-use SecretBroker
use authority; null is not sufficient proof of anonymous routing. P1 provider prepare/begin remain
no-mutation `UNAVAILABLE` with `sendAuthorization: null` until Guarded ExecutionHost transport and
route resolution are wired. P6's whole-phase source pass now reports no additional unblocked P6 source gap; offline Doctor,
provider/settings/model projection and S1 source are present, with P1-dependent transport/credential
work and later acceptance still open. P6 source owner has returned. The newly available child slot
is assigned to whole-phase P2 managed/direct child lifecycle integration. Active owners: P1/P2/P8;
P7 remains next on slot release. Source-first hold remains: no tests/builds/typechecks/provider
calls/release checks. V1 is PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-21 12:56 UTC — P1 source checkpoint and P3 owner

P1 found no remaining unblocked Guard/ExecutionHost source gap in cgroup-v2, ToolBatch, origin gates or verifier settlement integration. Two runner fixture setups now exercise the intended Rust-boundary failures, but remain unrun; P1 still requires integrated acceptance/adversarial and cgroup restart proof. Its source slot is assigned to whole-phase P3 RepoIntel/Discovery. Active owners: P2/P3/P7. P2 completes managed/direct lifecycle and Goal review UI; P3 closes discovery/indexing/parser/overlay/cache source; P7 closes stream/render/artifact/automation/rewind. No checks yet. P5/P6/P8 unblocked source complete, acceptance still open. V1 PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-21 12:54 UTC — phase slot refill

P6 unblocked source review is complete; offline Doctor, anonymous free OpenCode eligibility, settings/provider projections and owner-scoped legacy+V2 question flows are source-present. Protected credential writes, credentialed transport and live Doctor wait on P1 Guarded secret/network grants; FEAT-001..014 and S1 acceptance remain. Active owners are P1/P2/P7. P7 now owns the whole source phase including canonical SSE replay or contract-consistent resnapshot-only behavior, sequence/generation fencing, TUI stream/redaction, artifact truth, analytics, automation and rewind. No verification commands yet; all runtime gates remain fail-closed. V1 is PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-21 12:51 UTC — verifier settlement source integration

P1 now mints the private HostKernel verifier-pin token only for the exact persisted Verified ChallengeSet/evidence, passes it to P8, rejects caller pins on FAILED/CANCELLED, and compares the echoed three verifier identities during receipt replay. P8's worker proof and OwnerLog v4 receipt persist the pins on Verified settlement only. P2 is aligning its strict Core response/request unions to the §33 canonical `builtin.verifier` capability/action and separate no-pin QUARANTINED response. This is source integration, not verification. Active owners are P1/P2/P6; P8 source is complete for currently unblocked work, P5 source is complete but gated, and P7 replay remains open. No test/build/typecheck/audit/provider/release/Git commands. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-21 12:49 UTC — P8 settlement source checkpoint

P8's unblocked worker settlement code now requires P1's opaque verifier-pin token for Verified settlement and persists the three verifier identities in OwnerLog v4 and the durable receipt digest. P1 must mint/validate the token and compare receipt replay; P2 strict Core consumption remains in progress. P8 still lacks trusted hysteresis inputs, safe cache retirement, OS hard quotas, RC0 P1/P2 attestation, and live HUP proof, so dependent effects remain unavailable. Active owners: P1, P2, P6. P6 owns provider/auth/settings/Doctor/S1 source; P5 source projection is complete but runtime gated pending P1/P6. P7 SSE replay/schema gap remains open for the next phase slot. No verification commands have run; source implementation continues. Status PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-21 12:38 UTC — current implementation ownership

Active whole-phase owners: P1 Guard/ExecutionHost; P2 managed/direct child lifecycle; P8 resources/workers/evaluation. User approved optional Linux cgroup-v2 as P1's restart-containment design; existing backend source must be reviewed for lifecycle proof and UNKNOWN recovery, not duplicated. P1 owns full trusted verifier ChallengeSet pins/recovery and settlement receipt echo/validation of `verificationRunID`, `setIdentityDigest`, `challengeSetDigest`; P2 strictly decodes and propagates these pins. P5's unblocked schema/runtime provenance source is complete; runtime remains disabled pending P1 Guard/receipt and P6 SecretBroker acceptance. P8 owns worker/evidence alignment to exact settlement pins. P7 source audit found the SSE route lacks durable Last-Event-ID replay and source sequence/generation fields; next P7 owner must wire canonical replay or consistently narrow V1 to resnapshot-only. P3/P4/P6/P7/P9 remain PARTIAL and open; dispatch whole-phase owners as slots free. No verification commands until source implementation is complete. Preserve mixed Git state and repository-only boundary. Status: PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-21 11:02 UTC — full-scope owner restart








## 2026-10-21 11:15 UTC — P1 contract bounds; P2 checkpoint; P7 started

P1 added strict ToolBatch schema count/identifier bounds (32 calls/effectRefs, 256-byte protocol IDs) and HostProcessRef identifier parity. Its source audit found production effect origins either Guarded or denied before dispatch; no missing first-party production process origin was identified in packages/core/opencode source. It did not add a crash janitor: existing bwrap PID namespace/PDEATHSIG lacks durable exact containment identity, so PID/starttime/boot ID alone cannot safely authorize tree kill or prove quiescence; UNKNOWN remains. P1 is continuing the whole phase source audit and contract work. P2's direct follow-up runner source is in place, with its gate still false; P2 returned partial/unverified. Reassigned its freed slot to P7 streaming/rendering/artifacts/analytics/automation/rewind source implementation; P6 continues. P3/P4/P8/P9 remain partial source checkpoints; P5 remains dependency-gated. No tests/builds/typechecks/audits/benchmarks/provider/release/Git operations ran. No files were staged. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-21 11:13 UTC — P2/P6 direct-source updates; release decisions pending

P2's server-callable serialized follow_up runner and authenticated HTTP delivery path are now source-present. It uses exact request/profile/live Attempt/completed-turn pins, prepare/commit receipts, HostKernel fresh-turn proof, exact message claim, persisted completion and idempotent consume ACK; ambiguity remains UNKNOWN and no duplicate prompt is injected. Runtime remains false-gated pending integrated P1/P8 acceptance. P6 source now narrows anonymous OpenCode eligibility to exact active, zero-priced, supported model refs shared by backend/default/picker; custom model loaders stay unavailable. TUI hydration and lane-specific reply/reject now cover both authenticated legacy and QuestionV2 streams. P6 is doing final source-only boundary review and local upstream comparison. No checks ran.

P9 release implementation remains partial. Two user decisions were requested asynchronously: distribution grant/notice review status, and whether V1 keeps remote install/update disabled until signing policy exists. Continue source work that does not depend on those answers. Active implementation owners remain P1/P2/P6; P1's restart containment source blocker remains unresolved. P5/P7 wait for agent capacity. No tests/builds/typechecks/audits/benchmarks/provider/release/Git operations ran. V1 is PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-21 11:13 UTC — P2 direct follow-up runner source added

P2 added the public follow_up HTTP delivery path using a live child Attempt/profile/completed-turn pin, bounded durable inbox reservation, HostKernel fresh-turn authorization, Guard prepare/commit, and a serialized internal SessionPrompt runner. It claims only the committed message, persists turn/completion receipts, and ACKs consumption; ambiguous delivering/UNKNOWN rows remain inspection-only and exact ACK replay is idempotent. `DIRECT_CHILD_TURN_RPC_ENABLED` remains false pending P1/P8 acceptance. No checks ran; P2 remains active for whole-phase managed lifecycle and integration. P1 resumed source implementation on the restart janitor and remaining protocol/origin closure; P6 continues providers/settings/Doctor/S1 and local-source comparison. No tests/builds/typechecks/audits/provider/release/Git operations ran.

## 2026-10-21 11:11 UTC — HostKernel restart boundary and child wake implementation

P1 source review found that unfinished stdio attempts recover to UNKNOWN, while live supervisor handles are process-local and cannot prove tree quiescence after HostKernel restart. Sandbox paths currently use bwrap PID namespaces, `--die-with-parent`, and PDEATHSIG; P1 is evaluating durable containment identity and restart reconciliation. Parent required identity-safe signaling and proof of the actual whole process tree; PID/starttime alone is insufficient, and any unclosed crash window stays UNKNOWN. No validation ran. P2 confirmed Goal proposal→accepted SpecVersion→review→`goal.start`, distinct HostKernel-assigned reviewer, final live workspace revision, and TUI decisions are source-wired; its remaining direct child `follow_up` HTTP edge lacks a reusable server-callable Core runner. P2 is implementing the runner and keeping the gate false. P6 confirmed distinct legacy and Core Question owners; QA-006 requires both event lanes to project only to their authenticated owner. P6 is handling the narrow source projection while provider/settings work continues. Active owners: P1/P2/P6. P3/P4/P8/P9 returned partial; P5/P7 await a free agent slot. No tests/builds/typechecks/audits/benchmarks/provider/release/Git operations ran. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-21 11:09 UTC — P9 source checkpoint; P1/P2/P6 active

P9 returned PARTIAL after source-only release changes: clean-install scenarios now verify candidate/previous executable digests around each run and after the matrix; installer activation keeps recovery copies for both command names; release evidence fingerprints include `prepare_build.py`. Only installer/release-owned files changed. No release or validation commands ran. P9 is still blocked on distribution grant/notices, signing/update and rollback policy, final candidate and Linux/WSL acceptance. P1 has resumed full Guard/ExecutionHost source work; P2 continues managed/direct child and follow_up runner; P6 continues provider/settings/Doctor/S1. P3/P4 source checkpoints returned PARTIAL, P8 source checkpoint returned PARTIAL. P5/P7 remain queued, P0 integration parent-owned. No tests/builds/typechecks/audits/benchmarks/provider/release/Git operations ran. Mixed unstaged/untracked Git state is preserved. Overall V1 PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-21 11:08 UTC — P3/P4 source handoffs; P6/P9 owners refilled

P3 returned PARTIAL after source-only fixes for bounded directory enumeration, combined RepoIntel selector-count parity (100), profile provenance and fail-closed discovery adapters; parser provenance, trusted buffer snapshots, HostKernel read/cache contracts and P4 readiness remain dependencies. P4 returned PARTIAL after REPL's constant-false authorization gate, LSP/DAP cleanup/quarantine and authenticated P3 document reader wiring; production ingress, P1 Guard/confinement, DAP policy, OS-enforced REPL limits and real-project acceptance remain blocked. Both ran no checks. Reassigned the newly freed slots to whole-phase P6 Providers/Settings/Doctor/S1 and P9 Linux/WSL release source work; P2 remains active, P1/P8 returned source-only partial, P0 integration parent-owned. No tests/builds/typechecks/audits/benchmarks/provider/release/Git operations ran. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-21 11:05 UTC — phase-owner refill and implementation-only checkpoint

P1 returned source-only/partial: HostKernel direct-turn completion and fresh authorization now call the full live Attempt-scope validator against the current revision. P1 acceptance remains open for durable process-tree quiescence, Guard/receipt recovery, origin closure, protocol integration, and adversarial recovery. P8 returned source-only/partial: fixed the evaluation artifact journal digest defect and added descriptor pinning, nonblocking exclusive lock, path/inode checks, and pre-dispatch size/identity fences; RC0/fan-out remain gated on P1/P2 and trusted OS resource limits. Neither phase ran checks.

P2 remains active and found/fixed same-Attempt/same-epoch inbox recovery: an idle child Session's persisted `delivering` row is now UNKNOWN, never reinjected; pending direct-turn completion replay is keyed by exact cycle/result digest and persists only the HostKernel receipt. P3 RepoIntel and P4 LSP/DAP/REPL whole-phase owners have now been dispatched in the newly available slots; P5/P6/P7/P9 remain queued for slots. P0 cross-phase integration remains parent-owned. All agents have the repo-only boundary and implementation-first hold; no tests/builds/typechecks/audits/benchmarks/provider/release/Git operations ran. Git remains mixed and unstaged; preserve all changes. V1 is PARTIAL / NOT VERIFIED / NOT RELEASED.

The parent re-read current instructions/trackers/architecture authority and the authorized attachment. The attachment reiterates the whole V1 target, source-first OpenCode/Codex comparison, complete agent lifecycle review, architecture/flow/event re-audit, no testing until implementation closes, and immediate listed escalation for unresolved product decisions. No new architecture decision was found. Current active whole-phase owners are P1 Guard/ExecutionHost, P2 managed/direct child lifecycle, and P8 resources/workers/worktrees/RC0/evaluation; P3/P4/P5/P6/P7/P9 are queued for prompt refill, and parent owns cross-phase integration/tracker updates. P2's direct-turn Rust interface is source-present but unverified. No tests/builds/typechecks/audits/benchmarks/provider/release/Git operations ran. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-21 06:30 UTC — P2/P8/P9 continuation

P2/P8/P9 are active. P1 returned PARTIAL: executable identity hardening and unrun fixture source are present; §37.9 specifies HostKernel-owned turn begin/complete, DirectTurnScope and one-use fresh-turn authorization, but Rust journal/issuer/effect integration and exact machine schemas remain absent. P2 is implementing the Core caller against P1-owned types and retains fail-closed behavior. P4/P6/P7 returned PARTIAL. P8 is adapting the local Oh My Pi MetaHarness experiment/run/task/trace and resume patterns (§42.14) to an offline fake-provider HUP runner. P9 owns safe Linux/WSL release source. SA-021 covers multi-owner dependency visibility and interrupted-owner recovery. HUP/CM tests are specifications until source is complete; no checks/provider/release operations ran. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-21 06:29 UTC — P1 contract gap and active owner wave

Active owners are P2/P8/P9. P1 returned PARTIAL with executable identity source hardened; §37.9 now defines the HostKernel turn-cycle/FreshTurnAuthorization contract, while the Rust journal/issuer, DirectTurnScope integration and strict wire schemas remain unimplemented. P2 is implementing the Core side only after matching P1-owned types and keeps follow_up unavailable. P8 owns offline HUP runner source; P9 owns safe Linux/WSL release source. P4/P6/P7 returned PARTIAL. SA-021 added parent dependency/ownership and interruption-recovery acceptance. No tests, builds, typechecks, audits, benchmarks, provider or release operations ran. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-21 06:27 UTC — current phase owners and evaluation continuation

P1/P4/P8 are the active whole-phase owners. P1's executable identity closure is source-present with unrun fixtures; its HostKernel fresh-turn issuer is in progress and Core must prove the exact minted runner-cycle boundary, not merely report an arbitrary completed sequence. P2 returned PARTIAL, keeps follow_up unavailable, and has unrun usage-before-effect and pending-message projection source. P6 added the UsageProvenance SDK projection and strict fixtures, then returned PARTIAL; P7 returned PARTIAL with no further safe change. Added SA-021 for coordinator dependency/ownership visibility and interrupted-phase recovery. HUP-001..008 and CM-001..009 are acceptance contracts only; no HorizonCode runner, benchmark result, or uplift evidence exists. No checks/provider/release operations ran. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-21 06:14 UTC — source continuation and evaluation contract refresh

Active owners are P1/P2/P6. P1 must close trusted executable identity (basename-only allowlisting is insufficient) and durable janitor proof. P2 continues usage ordering and the safe-boundary follow_up contract. P6 resumes to expose canonical UsageProvenance through the SDK. P7 returned PARTIAL after fixing stream-consumer exception recovery by resnapshot and adding bounded read-only usage analytics; automation lacks the approved timezone scheduler, while restore/artifact settlement remain gated and terminal graphics stay text-only. P5 is source-complete for unblocked work, dispatch gated on P1/P6; P8 added RC0 duplicate/overlap identity rejection. P3/P4/P9 remain PARTIAL or queued. No checks or external operations ran.

The HUP catalog now includes evidence-based failure-stage attribution and an optional OpenCode/Codex scaffold arm gated on parity of model revision, tasks, tools, permissions and budgets. CM-008/009 require explicit finite CodeMode timeout/call/output limits and make clear there is no hard interpreter memory limit. CodeMode remains hidden until Guard mediation; JCode's QuickJS sandbox informs bounded-runtime/cancellation tests, not a second runtime. Implementation-first hold continues. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.

## Owner refresh — 2026-10-21 06:08 UTC

P4 returned PARTIAL with the DAP false gate and DAP/REPL bypass fixtures authored but unrun. The active whole-phase owners are P1 Guard/ExecutionHost, P2 managed vertical, and P8 resources/workers/worktrees/RC0. P8 owns the next available unblocked source wave in its existing resource, durable worker, worktree and RC0 modules; it must preserve unavailable CPU/memory/FD/process hard-quota truth and keep fan-out/eviction closed until P1/P2/P8 evidence passes. P3 and P4 remain PARTIAL; P5/P6/P7/P9 are queued or dependency-limited. No test/build/typecheck/audit/benchmark/provider/release command has run. All work remains within the repository and Git remains mixed/unstaged.

Status: operative coding plan. Architecture authority is arch_V1/README.md + arch_V1/17-GOVERNANCE-DECISIONS.md. Current observed status is HANDOFF.md.

## Current source-execution note — 2026-10-21 06:03 UTC

Whole-phase owners currently occupying the three available child slots are P1 Guard/ExecutionHost, P2 managed vertical, and P4 LSP/DAP/REPL. P1 now delays Linux terminal exit receipts until a bounded complete `/proc` sweep proves process-tree quiescence; fresh-HostKernel durable sweep proof remains open. P1 also owns direct Core process/PTY origin closure in `core/src/process.ts`, `core/src/pty/*`, and process/PTY portions of `core/src/session/supervisor.ts`; preserve P3's exact-text RepoIntel digest changes in that shared file. P2 is closing the managed budget race where provider-step usage can be charged after local effects become eligible; it owns HorizonCode's processor/LLM/ToolBatch middleware path, not the separate Core SessionRunner. P3 returned PARTIAL after source changes for a separate 4 MiB selector scan bound, exact-text HostKernel document digest verification, and unrun paging/forgery/work-limit fixtures. Parser provenance, trusted overlay, guarded query/cursor acceptance and P1/P8 cache lifecycle remain. P5/P6/P7/P8/P9 are PARTIAL or queued and should be assigned whole-phase owners as slots free. Keep managed verifier/finalization/fan-out, editor protocols, web search, automation/rewind and cache eviction unavailable until their named P1/P2/P3/P6/P8 prerequisites pass. User's implementation-first hold still prohibits execution checks and provider activity. The latest AGENTS.md confines all access/artifacts/services to this repository; no external attachment, host path or Git remote is accessed. The shared Git tree remains mixed and unstaged. No phase is verified and V1 is not released.

## Current source-execution note — 2026-10-20 09:03 UTC

The active whole-phase owners are P1 Guard/ExecutionHost, P6 providers/settings/Doctor/S1, and P7 stream/artifacts/automation/rewind; P3/P4/P8 have returned source-only partials and P5 remains parent-owned. P5 source implements auth-4xx per-route recording and fallthrough only to another explicitly enabled route, bounded retry/429 handling, provenance, and metadata-only UNKNOWN recovery, but remains disabled pending integrated P1 Guarded transport. P2 remains partial on P1 verifier/quiescence and integrated settlement acceptance. P6's Auth-owned fixed SecretBroker sender now composes with HostKernel's durable per-route PREPARED/DISPATCHING/SETTLED/UNKNOWN transitions and P5's exact bounded aggregate resume; search remains disabled until P1's aggregate path is accepted. Implementation is still source-only: no tests/builds/typechecks/audits/provider probes until requested source work is complete. The repo-only boundary prohibits all work outside `agentx`; mixed Git state is preserved without publication or cleanup.

P3/P8 cache ownership is frozen: P1/HostKernel is the only owner of actual retained RepoIntel generations, authenticated query pins, and safe retirement; P8 remains metadata/planning only. P3 may add a typed observation adapter behind a disabled sink. P8 eviction candidates require exact HostKernel revalidation and drained query pins before retirement, then a fresh observation; unknown allocation/reclaimed bytes must remain unknown.

P3 source now includes a pure Core observation projection from trusted ServerAuth and strict HostKernel generation pins. It has no production sink, does not modify the shared supervisor, omits registry identity without a trusted build version, and reports unknown physical allocation/reclamation. This is source progress, not an active P1/P8 cache integration.

Do not use archived architecture or compatibility stubs as implementation instructions.

## Gate 0 — preserve and inspect

- [ ] Read AGENTS.md, HANDOFF.md, arch_V1/README.md, §17 and §10.
- [ ] Inspect git status/head and active processes; preserve user-owned dirty state.
- [ ] Inspect exact source/callers/tests for the first unfinished gate.
- [ ] If external code is needed, use §42 exact immutable source pin and complete license/dependency review.
- [ ] Run targeted baseline tests without interrupting unrelated active builds.

Exit: exact local implementation state known and no competing authority/runtime introduced.

## Gate 1 — P1.2-B Session observer production lifecycle

Owners/source to inspect first:

- packages/core/src/session/supervisor.ts and SessionV2/public Session flow;
- packages/server composition;
- kernel session projection/subscription/handshake/supervisor/startup code;
- existing Bun/Rust cross-runtime tests.

- [x] Automatic owner/lifecycle for relevant Session observer.
- [x] Stable SessionLink source ID/store/cursor/epoch/digest/redaction.
- [x] Authenticated/versioned private startup and READY gating.
- [x] Bounded pages, exact completed-page ACK, hasMore.
- [x] Retention gap -> resnapshot.
- [x] Restart from last completed cursor.
- [x] Active provider-turn crash/recovery test.
- [x] Cancellation/unsubscribe/host shutdown cleanup.
- [x] Rust cannot write canonical conversational content.
- [x] Platform support and unsupported reason are truthful.

Exit: read-only Session observation is production-shaped and restartable.

Verified implementation mapping (2026-10-11): OpenCode Session ID is the source owner ID; the injected `Database.Service.path` selects the exact EventV2 store; the durable per-Session cursor stores sequence plus event digest; the sidecar lease and authenticated handshake bind supervisor epoch and process incarnation; the Rust projection exposes only event/message/call IDs under its fixed redaction policy. On a retention gap, the host safely removes only owner-private derived projection/checkpoint files, then rebuilds from the unchanged OpenCode source. No separate transcript or Session message store is created.

## Gate 2 — P1.3 universal ToolBatch Guard/ExecutionHost

Inventory every effect entrypoint before coding:

- files/edit/shell/process/Git/build/test;
- legacy OpenCode routes;
- plugin/skill/hook/MCP;
- LSP mutation and DAP;
- browser/desktop;
- persistent REPL callbacks;
- settings/auth/network;
- hosted/provider-executed tools;
- external agents/automations.

- [ ] Pin turn provider/model/harness/tool registry/policy generation.
- [ ] Collect complete provider local-tool batch before any effect.
- [ ] Validate every call; malformed sibling denies whole effectful batch.
- [ ] Preserve the distinction between pre-dispatch all-or-none validation and execution: partial effects may occur after dispatch; record per-effect receipts/UNKNOWN, cancellation and rollback limits, and reconcile before dependent retry.
- [ ] Resolve canonical IDs/aliases and effect classes.
- [ ] Rust Guard admits/denies/needs approval for full batch.
- [ ] PREPARE durable EffectIntent and one-use leases before mutation.
- [ ] Execute effect only through authorized ExecutionHost/worker.
- [ ] Record receipt or UNKNOWN and reconcile target.
- [ ] Non-idempotent UNKNOWN is never blindly retried.
- [ ] Disable hosted effects that cannot be pre-authorized.
- [ ] Negative bypass tests for every included origin.
- [ ] Direct Session works without Goal.

Exit: no tested mutation path bypasses the canonical effect boundary.

Implementation increment (2026-10-11; Gate 2 remains open): the Core V2 SessionRunner admits a bounded single-call `files.write` through `effects.v2` and Rust Guard/EffectHost. Its turn digest binds `SessionRunnerLLM`, Session/agent/provider/model/variant, configured agent permissions, a stable `PermissionV2.policySnapshotDigest` (configured agent rules plus saved project grants), and pinned tool definitions. Effect-time PermissionV2 checks remain authoritative after explicit approvals. Core typecheck, 104 targeted Permission/runner tests, the recorded observer integration test, and the current live Runner→Rust integration test pass; the latter covers allowed single write and Rust denial of a two-write batch (1 test / 15 assertions), with replay denial and payload privacy checks. Other inventoried origins are not migrated; see `HANDOFF.md` for exact results. Do not mark Gate 2 complete.
Additional Core regression: supervisor/Rust effect-preparation failure denies the complete local batch before either an effectful write or read-only sibling settles (1 focused test / 5 assertions; Core typecheck passed).

- Additional Core V2 increment (2026-10-11): `ToolRegistry.materialize` in `packages/core/src/tool/registry.ts` omits registrations whose capability `effectClass` is unknown from both model definitions and the settlement snapshot. The regression checks missing and explicit unknown classifications are absent and return `Unknown tool` at validation/settlement without invoking them. Verification: `cd packages/core && bun test test/session-runner-tool-registry.test.ts` — 19 passed / 41 assertions; `bun test test/session-runner.test.ts` — 93 passed / 308 assertions; `bun run typecheck` passed. No live provider/platform was exercised; legacy/HorizonCode CLI-host package and other external effect origins remain unmediated.
- Additional Core supervisor ownership guard (2026-10-11): `SessionSupervisor.watchSession` reserves a Session ID for one observer within its service instance, returns a typed ownership failure through the readiness Deferred on duplicates, and releases the reservation at scope exit. `SessionExecutionLocal` propagates the failure before `SessionRunner.run`; the live test verifies duplicate rejection and later sequential watcher recovery. Verification: `cd packages/core && bun test test/kernel-projection-live.test.ts -t "SessionRunner binds its generated digest through Rust effects.v2 and denies multi-write batches"` — 1 passed / 18 assertions using the local Rust sidecar; `bun test test/session-runner-recorded.test.ts` — 1 passed / 24 assertions; `bun run typecheck` passed. Observer duplication remains scoped to one Supervisor instance; Gate 2 remains open.
- Additional same-process V1/V2 ownership and preflight (2026-10-12; Gate 2 remains open): the module-level Session lease is keyed by Session ID and backend class (`core-v2` / `opencode-v1`), permits nested same-class scopes by refcount, and rejects cross-class overlap. Core V2 acquires before observer startup; V1 loop/shell, prompt/command, and summarize acquire before provider execution or their persistence/interpolation/compaction prework. The init handler preserves the typed busy failure; prompt_async preflights synchronously before forking, and the child repeats its lease. Public HTTP 409 is declared for init, prompt, prompt_async, command, and summarize. Verification: owner nesting 1 test / 3 assertions; V1 preflight 1 / 11; prompt conflict-before-persistence 1 / 3; command conflict-before-shell-interpolation 1 / 3; cassette provider + Linux Rust observer cross-flow 1 / 28; OpenAPI 409 1 / 9; HTTP mapper 1 / 2; summarize HTTP 409/prework 1 / 3; init + async prompt HTTP 409/prework 1 / 5. Those historical bounded typecheck attempts timed out without diagnostics; current follow-up package typechecks for Core and packages/opencode now pass independently. No live provider inference.
- Current V1 increment (2026-10-12; Gate 2 remains open): `Tool.Def` now carries canonical capability metadata through `ToolRegistry.tools`; `SessionTools.resolve` only exposes classified read-only builtins, the supported `files.write`, and internal control tools. The pinned `ai@6.0.168` V3 `wrapStream` gate buffers tool calls to terminal `tool-calls`, validates the complete batch, and asks the session-owned Rust supervisor to prepare non-read-only batches before callbacks. Missing/unknown/malformed/duplicate/mixed/unowned/cancelled/incomplete batches fail closed. A single admitted `files.write` passes its challenge into the existing PermissionV1 edit approval, then Rust `approveEffect`/`executeWrite`; local direct write was removed. Verification: tool batch 8 passed / 28 assertions; prompt capability + Rust-owner-unavailable integration 2 passed / 4 assertions; missing-challenge write regression 1 passed / 3 assertions. The denial path uses fake/unavailable-supervisor coverage, and the positive V1 write now also passes through the actual local Rust supervisor with approval/execution/receipt assertions. Both modified TypeScript packages pass independently. Other direct shell/subtask/command/plugin/MCP/LSP/HTTP origins remain outside this slice; provider-executed tools are only rejected on returned chunks and cannot be reversed after remote execution. Do not report P1.3/Gate 2 complete. Next: migrate or disable every remaining inventoried effect origin with negative/recovery coverage.
- Additional V2 `files.patch` / session-revert increment (2026-10-13; Gate 2 remains open): Rust EffectHost admits bounded ordered patch batches through Guard with exact operation matching, file preimage/postimage validation, receipts and restart reconciliation. Core V2 `SessionRevert.stage/clear` uses a restore plan and `SessionSupervisor.runPatch`; its HTTP route test passed 1 / 5 through the local Linux supervisor. WebView and TUI callers use the existing V1 `/session/:id/revert` and `/unrevert` routes. Fixed legacy/Core persistence by validating legacy absolute revert paths, storing relative `restoreFiles`, and mapping them back to V1 absolute paths on read. Manual Linux UI evidence, projection regression and current typechecks are recorded in the 2026-10-13 checkpoint below. No Windows or full-workspace acceptance.
- Additional VCS and Workspace guarded patch increment (2026-10-13; Gate 2 remains open): `Vcs.apply` parses bounded unified diffs and routes them through `SessionSupervisor.runPatch`; local `Workspace.copyChanges` builds bounded operations and uses the same Rust Guard/ExecutionHost path. Remote/mixed workspace copy remains fail-closed. The TUI workspace dialog now allows copy only after explicit `yes`; its rendered dialog and Enter-key path pass a component test. Verification against the actual local Linux supervisor: VCS 13 tests / 24 assertions; Workspace 37 / 127; TUI confirmation 1 / 1; HorizonCode CLI-host package and TUI typechecks pass. The VCS/Workspace tests require a file-backed EventV2 DB because Rust cannot observe in-memory DBs; the VCS fixture also needs a projected Session and Project row. Root overlay audit passes: 6,627 compared, 127 changed, no missing/hidden/stale entries. No Windows or manual WebView revert acceptance.

P1.3 terminal slice — acceptance gates are specified in §32.23 (TM-001 100 MB
bounded search and TM-002 stale generation; reuse these, do not duplicate) plus
PTY-001–PTY-006: model `bash`/TUI `!` Guard approval and denial; V1/V2 create and
unchanged `Pty.Info` compatibility; tickets, credentials and exact origins; legacy
and binary framing, replay, sequence gaps and backpressure; restart/fencing and
`UNKNOWN`; native Windows ConPTY/pipe authentication/Job Object cleanup. Contract
details are in §§14.2–14.3, 30.17, 33.7/33.23 and 37.13; `terminal.resize` is
`guarded_effect`, with the registry/runtime mapping specified in §33.7. These are
required acceptance gates, not evidence of implementation or test completion.


## Gate 3 — P2 managed control

Read §11/§12/§15 and existing kernel OwnerLog code.

- [ ] Goal + immutable accepted SpecVersion.
- [ ] Run/Task/Attempt state with versioning/idempotency.
- [ ] SessionLink correlation only; no Rust transcript.
- [ ] pause/resume/cancel fences.
- [ ] workspace/resource leases.
- [ ] evidence/verification bound to final integrated revision.
- [ ] restart/replay.
- [ ] retry exhaustion/NeedsYou.
- [ ] direct Session unaffected.

Exit: durable managed work is additive to OpenCode conversation ownership.

Managed context dispatch also requires two source contracts before request 1 and later
requests can run: (a) P8's authenticated read-only RESERVED worktree target projection from the
exact opaque reservation proof (currently omitted by READY_TASK although reservation and
internal target resolution exist), and (b) P1's Rust OwnerLog-backed `managed_context.advance`
endpoint for exact-next provider request sequences after seq1. P2/P7 keep dispatch fail-closed
until both contracts and the immutable compiled-request handoff are wired.

## Gate 4 — P3 coding path and RepoIntel

- [ ] canonical files/search/Git/terminal/build/test wrappers;
- [ ] stale-safe files.patch, optionally Hashline strategy internally;
- [ ] RepoIntel symbol/definition/reference path before broad reads;
- [ ] persistent index invalidation/overlay tests;
- [ ] requested/effective Lightweight/Adaptive/Full profile over one index; exact base-generation and owner-bound overlay provenance; build coalescing, corruption rebuild and typed quality/fallback reporting;
- [ ] existing resource/cache owner throttles optional indexing/embeddings under pressure; stale query-to-files.patch fences reject changed source;
- [ ] bounded log/artifact search;
- [ ] context/tool discovery for small models;
- [ ] benchmark any native OMP-inspired walker/AST optimization before adoption.
- [ ] route LSP document synchronization through authenticated `repo-intel.v1/read_document`; no Core/app-process filesystem fallback, and stale/denied/oversized/symlink/non-UTF8 reads must stay unavailable.

Exit: common coding change is fast, source-grounded and Guarded.

## Gate 5 — P4 LSP, DAP and persistent REPL

Use §30, §37 and §33.

- [ ] reuse healthy editor LSP where possible;
- [ ] supervised LSP lifecycle/query pins, owner-safe idle eviction, resource-admitted startup and typed fallback/stale-result behavior;
- [ ] OS-enforced helper filesystem/process/network confinement; unavailable when the platform cannot enforce the declared profile;
- [ ] code actions/rename through canonical file effect;
- [ ] debug.\* adapter lifecycle, breakpoints/step/variables;
- [ ] guarded debug.evaluate with disable policy;
- [ ] passive DAP inspection remains distinct from getters/expressions that execute target code;
- [ ] repl.\* bounded Python/JavaScript lifecycle;
- [ ] state persists only inside a REPL generation;
- [ ] authenticated owner/workspace/sandbox-generation/capability-ceiling binding and OS-enforced REPL isolation;
- [ ] tool callback re-enters ActionDescriptor/Guard;
- [ ] crash/reset/idle-expiry invalidates refs.
- [ ] project immutable Core Config `ExecutionLaunchProfileV1` to HostKernel; resolve executable, derive cwd from registered Location, pass literal profile argv only, sanitized environment, no interpolation or P4-supplied process fields; bind HostProcessRef generation/epoch and receipts.
- [ ] use the existing `execution.v1`/single ExecutionHost prepare-launch-IO-cancel-status boundary; deny before spawn on stale profile, missing Guard lease, unsupported confinement or unresolved process state. DAP debuggee launch/attach is separately Guarded; REPL stays unavailable until required OS resource limits are enforced.
- [ ] make the private profile IPC match `ExecutionLaunchProfileDefinitionV1.executableSelector`; HostKernel resolves that trusted selector and never accepts a caller-supplied executable path. Include strict `HostProcessRefV1` schema/parity for each actually supported process kind, with profile/executable pins and no PID/path authority.

Exit: no language/debug/REPL route has ambient host authority.

## Gate 6 — P5 browser/desktop (post-V1) and built-in web search (V1 since 2026-10-18)

**Browser/desktop:** not a V1 release gate under A-V2-31. Keep every browser/desktop route unavailable; do not spend V1 implementation time there. Preserve those checkboxes as future acceptance if the scope is separately promoted.

**Web search (V1):** promoted into V1 by the 2026-10-18 user scope decision (`DEC-V1-26`). No box below is complete without exact tests:

- [ ] web.search direct vs grounded provider routes;
- [ ] built-in default route resolves without user configuration, or reports an honest unavailable reason;
- [ ] BYO-key providers (Brave, Exa, …) enable/credential/order in Settings (§16.7);
- [ ] enabled routes cascade in settings order; route failure falls through; exhausted chain → one bounded retry + per-route reasons;
- [ ] no route used unless enabled/configured (enable = consent); no hidden paid fallback;
- [ ] provider/auth/cost/freshness provenance on every result; `web.search.inspect_provider` honest status;
- [ ] timeout/rate-limit/offline stable errors; untrusted-content/injection handling;
- [ ] cancellation, bounds and artifactization for large fetched content.

**Browser/desktop checkboxes (post-V1 only):**
- [ ] browser managed vs attached context ownership;
- [ ] generation-bound DOM/ARIA/screenshot refs;
- [ ] guarded navigation/click/type/upload/download;
- [ ] desktop displays/windows/AX/screenshot capability matrix;
- [ ] guarded focus/input/clipboard, DPI/geometry correctness;
- [ ] worker/back-end crash and stale-ref tests;
- [ ] real supported-OS/provider journeys.

Exit: privileged interaction is mediated and support status truthful.

## Gate 7 — P6 agents/extensions/provider/model/settings UX (V1 CLI/TUI)

Use §16, §29, §33.

- [ ] AgentProfile/Harness registry and bounded specialists.
- [ ] Complete the direct-session child lifecycle using the existing Core Session/TaskTool owner: durable parent-child lineage; queue-only `agents.message` versus explicit follow-up turn; bounded list/inspect/capabilities/graph/result projections; wait/activity semantics where timeout does not cancel; cancel fencing and observed cancelled/still-running/UNKNOWN outcomes; bounded per-parent active/total/depth/message limits; safe-boundary delivery and TUI activity/result projection. Reuse OpenCode/Codex lifecycle patterns from pinned source, but preserve Horizon profile pins, Guard/effect reconciliation and one Core Session writer. Keep `agents.spawn` unavailable until Guard, capacity reservation and durable launch/recovery boundaries are wired.
- [ ] Skill/Hook/MCP/plugin sealed IDs and trust/capability boundaries.
- [ ] one ActionDescriptor for slash/menu/key/API/model.
- [ ] agent/harness picker constrains model picker correctly.
- [ ] provider/model/role hub with cost/auth/status provenance.
- [ ] Adapt compatible non-OpenCode provider/auth/model integrations primarily from pinned OMP under Horizon's existing provider, auth, catalog and direct-Session owners; no account rotation or hidden fallback.
- [ ] For an explicitly selected native OpenCode backend, pin one official SDK/API generation and prove the actual provider/model list, streaming and account entitlements; SDK presence is not universal model access.
- [ ] schema-driven settings requested/effective/source/locked/apply boundary.
- [ ] Goal draft/review/accept UI before managed effects.
- [ ] V1 CLI/TUI underlying action/state parity; web/desktop parity is post-V1.
- [ ] credentials never leak.

## Gate 8 — P7 streaming/artifacts/analytics/automation (V1 CLI/TUI)

Use §31/§37.

- [ ] bounded UiEventMux and stable streaming prefix/tail;
- [ ] transcript virtualization/focus/scroll stability;
- [ ] isolated safe SVG;
- [ ] closed-fence Mermaid;
- [ ] deterministic complete-table chart;
- [ ] terminal graphics negotiation/budget/fallback;
- [ ] SourceArtifact FULL/SAMPLE/FAILED truth;
- [ ] analytics measured/estimated/unknown provenance;
- [ ] automation durable overlap/missed/retry policy and Guarded invocation.

## Gate 9 — P8 resource efficiency, long-horizon/recovery/evaluation (V1)

- [ ] bounded worktree/resource pool;
- [ ] reproducible RC0 process-tree baseline at 1/5/10/20 sessions and measured optimization with identical task success; local-model memory accounted separately;
- [ ] bounded worker/subagent pool and typed DAG only after the P2 single managed Attempt and independent verifier pass;
- [ ] deterministic recovery across host/kernel/worker/provider failure;
- [ ] stop criteria avoid quota waste;
- [ ] §32 real-work suites across model classes;
- [ ] security bypass suite;
- [ ] performance budgets;
- [ ] final integrated revision verification.

## Gate 10 — P9 Linux/WSL CLI/TUI packaging/release

- [ ] license/notices closure;
- [ ] native platform support matrix;
- [ ] explicitly mark native Windows unavailable until native tests pass; WSL is not Windows evidence;
- [ ] signing/update/rollback if enabled;
- [ ] config/data migration;
- [ ] clean-install/upgrade;
- [ ] release UX/security/performance gates.

## Deferred post-V1 technical-debt gate — HorizonCode-only naming and fast TypeScript builds

**Schedule after V1 completion only; not part of the current P1.3 implementation and not a reason to delay delivery.** The normative owner is `arch_V1/10-DELIVERY.md §10.12`.

- [ ] Benchmark the existing TypeScript/Bun/Turbo build/typecheck/test graph; refactor package boundaries, project references, generated typings, caching, dependency invalidation and CI gates for efficient targeted iteration without weakening the full release gate.
- [ ] Complete the staged first-party migration to `horizoncode` naming throughout package metadata/scopes, CLI executable(s), binaries, generated clients, internal first-party imports, UI, docs, settings and distribution artifacts; `horizoncode` is the canonical user-facing executable name and `hzcode` is its shipped short command (both start the same CLI entrypoint; amended 2026-10-18).
- [ ] Preserve pinned upstream compatibility and required OpenCode dependency identities, copyright and notices until an explicitly tested replacement is safe. Product identity and legal source attribution are different things.
- [ ] Validate a clean clone/install, Linux and Windows builds, typecheck/test matrices, real Guard flows, published-tarball dry run, update/back-compat and rollback; remove temporary aliases only with proof.
- [ ] Record measured build time, cache hit rate, disk usage and failure diagnostics before and after the refactor. Prevent multiple equivalent expensive builds.

Gate status: **DEFERRED / NOT STARTED** until V1's integrated verification and release baseline exist. Do not bulk-rename source or loosen checks now.

## Implementation evidence rule

A checkbox is not complete because docs/schema/unit mocks exist.

For every completed slice record:

- exact modified source/functions;
- owner/capability IDs;
- tests and outputs;
- negative/recovery case;
- platform/provider/backend actually exercised;
- performance/resource evidence when relevant;
- unsupported paths;
- resulting HANDOFF status.

No commit/push/destructive cleanup without explicit authorization.

## Current evidence checkpoint — 2026-10-13

- P1.2-B is complete for the currently claimed local lifecycle scope; P1.3 remains the active implementation gate.
- `bun run typecheck` passes in `packages/core`, `packages/opencode`, and `packages/tui`; `packages/app` typecheck passed on unchanged caller source. Full 36-package Turbo typecheck passed on 2026-10-12 but was not rerun after the current P1.3 changes.
- Historical actual V1 `files.write` passes Rust admission -> approval -> execution -> receipt; denial, missing-challenge and complete-batch tests pass.
- Rust `files.patch` now supports bounded ordered batches with Guard binding, preimage/postimage validation, receipts and restart reconciliation. The full kernel suite previously passed 160 tests / 15 suites.
- V2 revert stage/clear HTTP integration passed 1 test / 5 assertions through the real local Linux Rust supervisor. WebView and TUI callers use V1 `/session/:id/revert` and `/unrevert`, with manual interaction evidence below.
- Focused tests: Core snapshot 4 / 19 and V1 projection 10 / 23; OpenCode `apply_patch` 9 / 30, snapshot 53 / 630, prompt/tools/write 49 passed / 1 skipped / 178; V2 revert HTTP 1 / 5; VCS 13 / 24; Workspace 37 / 127; TUI workspace confirmation 1 / 1; prompt retry/promotion 1 / 10; full `httpapi-session.test.ts` 27 / 148. The prior prompt-wake failure was fixed by forwarding `createRoutes` Layer replacements into `buildLocationServiceMap`.
- Overlay audit: 6,627 pinned files compared; 127 changed, 0 missing, 0 symlink deltas, 0 hidden changed/new source files and 0 stale unignore rules. Fresh-clone hydration, architecture convergence and provenance checks passed at prior checkpoints.
- Full 36-package Turbo typecheck passed on 2026-10-12, but was not rerun after this P1.3 increment. Full integrated release/CI validation remains open.
- Local Linux WebView Vite UI used the live local API: `Revert message` and `Restore message` invoked V1 revert/unrevert requests (both HTTP 200) and toggled the Guarded file `after` -> `before` -> `after`. TUI write/undo/redo and the outside-worktree Guard denial were also exercised. Windows acceptance remains absent; frontend typechecks and Linux UI/backend evidence do not establish Windows acceptance.
- OMP transport/catalog migration, native OpenCode adapter, visual edit and deployment flows are DESIGNED, not production-wired.
- P1.3 terminal slice (2026-10-13): the guarded-PTY contract is accepted/review READY in `.slim/deepwork/horizon-guarded-pty.md` `#4232`; §§14/30/32/33/37 and `10-DELIVERY.md` were updated. Partial, unverified source now includes Rust terminal validation/replay primitives, a claimed Linux PTY/Windows ConPTY process backend, `ownerEpoch` HelloResult and a projection-only `session_supervisor`. There is still no proven `hz-kernel` host singleton/lease/multiplexed RPC/Guard dispatch/terminal event-artifact-recovery service, nor complete Core/root WebView/TUI `!` integration; old V1/V2 PTY runtime still reaches Bun process effects. No terminal-slice tests/builds/formatters ran. `kernel/src/terminal.rs`, `kernel/src/terminal_process.rs`, and `packages/core/src/trusted-principal.ts` are ignored by `.gitignore:6 (*)`; restore Git visibility only after reviewing the user's dirty ignore rules. Windows named-pipe DACL/owner proof, live Guard flows and native Windows acceptance remain absent.
- Question/clarification status: built-in `question`/`question.ask` is CODE_PRESENT, WIRED and TESTED through service/component/mock coverage for multi-question, single/multiple choice, custom text, answer and dismiss; it is **not** specified in canonical catalog `33`, domain schema `12`, acceptance catalog `32`, or the operative P1.3 plan, and has no live-runtime verification. The new TUI mixes V2 list with V1 reply/reject. Guard permission `ASK` is a different feature. The user marked ask/MCQ support important; track architecture, route-parity and live acceptance before claiming V1 completion.
- Exact current commands/results live in `HANDOFF.md`; historical implementation increments above remain provenance, not the current status authority.

## Final adoption and execution reconciliation — 2026-10-14

**Status: approved implementation guidance, NOT implemented functionality.** Retain the complete V1 capability roadmap above and the canonical owners in §17/§20. Do not build another direct Session, agent loop, independent Rust tool authority, extension registry, native shell, leader daemon, or Rust TUI. The existing OpenCode-derived direct Session is canonical; Rust owns managed work, Guard, leases and effect evidence. This section chooses *order and implementation technique*, not a new architecture authority.

### Source-grounded adoption decisions

| Candidate | Decision | Proof before enabling |
|---|---|---|
| Grok early connection/prewarm, deferred auth/MCP discovery | Prototype behind existing selected provider/session transport; never make background paid calls | Cold/warm time to usable composer, first useful output, auth and MCP phase p50/p95 |
| Grok leader/follower IPC | Reuse current Horizon supervisor/session lifecycle; no new resident daemon by default | Owner exclusivity, reconnect, actual latency improvement |
| Grok CoW/Btrfs worktrees and gix status | Optional backends in existing leased workspace/search interfaces | Git/index correctness, dirty user-file preservation, disk pressure, cross-OS fallback, end-to-end time |
| Grok adversarial goal verifier | Optional independent read-only reviewer for complex managed tasks; deterministic evidence first | Criteria/revision-bound verdict; finite review/retry budget; no invented new requirements |
| OMP Hashline | Model-compatible edit dialect **inside existing files.patch**, not a security mechanism | Full source revision/digest/fence stale check; atomic failure; first-attempt success, tokens and retries |
| OMP artifact references and Agent Hub | Reuse existing artifact, Session and managed Task/Attempt identities for derived inspection, steering and bounded result refs | No second transcript or effect authority; permission and resume tests |
| Codex sandbox/checkpoint patterns | Implement accepted per-OS confinement and producer/route-compatible compaction metadata | Negative sandbox cases; newest invalid checkpoint must not silently fall back to older authority |
| OpenCode compaction, TUI, skills, hooks, ACP/MCP | Reuse pinned inherited implementation where tests prove support | V1/V2 parity, versioned toolset, no privilege bypass or redundant runtime |
| Snapcompact (transient imaging and persistent archive are distinct) | DEFERRED/UNAVAILABLE in V1; no runtime code, toggle or capability; reconsider only after P1.3 and context baselines | Same-model fidelity, capability and image-token/count/byte limits; privacy, cost/cache, recovery/rollback; exact source license/dependency review |

### Security-critical native read/grep/gix acceptance

Do **not** paste the proposed `canonicalize() -> search_path()` Rust implementation into production. Validation followed by a path-based open is subject to symlink/TOCTOU races. A native backend must use a pinned root and audited handle-relative open-time confinement (for example Linux `openat2` where supported), consistent permission/redaction checks for every descendant and symlink, and the incumbent isolated backend or typed UNAVAILABLE when equivalent protection cannot be enforced. Read-only still can exfiltrate secrets to model/provider/logs. Bound bytes scanned/output, files/matches/line lengths, time, memory and workers. Propagate partial search/Git errors and filtered untracked status rather than falsely returning complete/clean. Blocking tasks retain cancellation ownership and semaphore limits until actually ended. Test hostile Git config, symlink swapping, protected files, cancellation and per-OS isolation.

Short Hashline display anchors (including 2-byte line hashes) never authorize edits. A source revision/full digest plus current Guard/lease is the authoritative precondition. Prepare and validate before atomic mutation and reject stale inputs; do not universally require read-before-write in the current context, which would unnecessarily block legitimate new-file creation.

### Real implementation dependency order

- [ ] **P1.3:** Inventory all V1/V2/legacy shell, command, plugin, hook, MCP, child, hosted, network and other mutation origins. Either mediate before dispatch through one Guard/ExecutionHost or disable, including provider-side tools without enforceable pre-execution authorization.
- [ ] **P1.3:** Enforce bounded ToolBatch count/argument size/stream time/memory; deny malformed/unknown/stale/cancelled effectful batches atomically; one-use lease, durable receipt, UNKNOWN reconciliation, true cancellation state and bypass tests.
- [ ] **Direct coding:** Execute an actual read/search/edit/test/diff/retry task without managed Goal overhead, with real evidence of the requested outcome and baseline latency/cost.
- [ ] **P2 managed vertical slice:** Accepted immutable SpecVersion -> Task/Attempt -> supervised bounded action -> effect receipt -> independently verified final integrated revision; crash/restart and human-edit conflict test before multiple workers.
- [ ] **Context/edit:** Preserve original direct history; rebuild compact control footer from canonical Rust task/effect state; pin checkpoint producer/model/harness/source cursor; reject malformed newest checkpoint rather than trusting older grant. Benchmark trim/compact retention, re-fetch, latency and outcome.
- [ ] **Speed:** Benchmark existing ripgrep/Git/index and patch paths first. Enable guarded native search/gix, Hashline, connection warming or CoW only behind rollback flags once both correctness/security and net benefit are proven.
- [ ] **V1 remaining capability gates:** Continue LSP, DAP, persistent REPL, built-in web search (promoted 2026-10-18, `DEC-V1-26`), skills/hooks/plugin and guarded local MCP integration, providers, CLI/TUI settings, artifacts/rendering/analytics, local agents/workers and Rust-owned automation within their approved owners, independently tested and accurately labeled. Browser, desktop, web/desktop/mobile SDK clients and outbound ACP/VIS/DEP remain post-V1 under A-V2-31.

#### Selected next four major slices (2026-10-15)

1. **P1.3 host-kernel runtime and package closure.** Follow the normative host-scoped `hz-kernel` contract in §§14/37; implement the Rust host process and inject its target manifest/asset through `packages/opencode/script/build.ts`, then wire Core's existing authenticated client. Acceptance: real host handshake/READY and durable owner epoch; actual effects RPC; Guard denial before mutation; explicit approval, one-use lease, receipt/UNKNOWN recovery; the per-Session projection worker remains separate. Verify the built artifact through Core↔Rust IPC. Linux/WSL evidence does not qualify native Windows.
2. **P1.3 first direct shell/process origin.** Close the actual `packages/opencode/src/session/prompt.ts` `shellImpl -> spawner.spawn` route before touching broader origin classes. Require complete bounded ToolBatch admission before spawn; malformed/mixed/ASK/DENY/timeout cases launch zero processes; an allowed call consumes one lease and records outcome; cancellation, restart and UNKNOWN are reconciled. Use the existing PTY-001–006 contract and preserve the selected provider/model/harness.
3. **RC0 resource sampler and reproducible baseline (parallel).** Add OS-owned process-tree sampling and attribution to the existing resource owner, not a dashboard. Record Linux PSS/RSS/CPU and native Windows private bytes separately; reproduce 1/5/10/20-session workloads with hardware, cache, task, provider/model/harness and local-inference conditions bound to raw artifacts. Never kill unrelated processes or claim WSL as Windows evidence.
4. **P2 single managed vertical.** Only after P1.3 admission is proven: accepted SpecVersion → one Task/Attempt → one bounded action through the same Guard → durable receipt/evidence → independent verification of the final integrated revision. Prove pause/cancel/restart/UNKNOWN and human-edit conflict before worker fan-out.

Snapcompact is not one of these slices. Its future experiment remains blocked on the existing context/accuracy/cost/privacy gates; no new session owner or shortcut is introduced.

**Implementation checkpoint (2026-10-15):** Core `MessageChannel` now fences outbound application frames with the authenticated `ownerEpoch`/`processIncarnation`, rejects missing or mismatched inbound fencing, and uses the declared `msgpackr` codec; regression tests cover all ten Rust application-frame kinds and malformed fence values at the Rust 256-byte UTF-8 boundary. Core frame tests: 7 pass / 35 assertions; Rust `frame_fence_rejects_foreign_epoch_or_incarnation`: 1 pass. `packages/opencode/script/build.ts` now has native Linux GNU host-artifact/manifest logic but emits `unavailable` while `kernel/Cargo.toml` has no `hz-kernel` binary; Windows host packaging and Core named-pipe/runtime support remain unavailable. A direct `terminal.run` deny-before-dispatch smoke could not load the hydrated ignored `packages/core/src/pty.ts`: module evaluation throws `ReferenceError: input is not defined` at line 995; that overlay also has 40 typecheck diagnostics and was left untouched. This closes only wire-fence interop and a fail-closed packaging path. No effects/terminal end-to-end path has been established; do not mark slice 1 complete. Core typecheck remains non-green at 92 diagnostics across 23 files; none were reported in the new frame-fence helpers or their regression test.

### Six benchmark lanes, not another dashboard

Store small versioned JSON/CI artifacts bound to commit, OS, CPU/RAM, fixture, provider/model/harness, permission mode and cache state. Measure (1) cold/warm composer-ready, TTFT and first useful output with stage breakdown; (2) first *correct* repository search hit, incremental edit/rename/branch-switch update and stale window; (3) context/tool bytes, tokens, protected-fact retention, compaction latency and subsequent re-fetch; (4) first-edit success, stale conflict, retry count, final regressions and token cost by dialect; (5) 1/2/4/8 worker final verified success, wall time, conflicts, coordination, disk and cost; (6) TUI input/frame p95, scroll/focus, recomposition/CPU/memory at 100/1K/10K transcript blocks and parallel streams. Distinguish harness time, provider inference and **total verified task time**. Tool-ready ≠ feature WIRED; passing mocks ≠ end-to-end VERIFIED; existing GitHub workflow YAML ≠ green CI run.

### Evidence and source-truth rules

The remote source reviewed was `dead4339cae87f9e48c25e4e9586096d600bb164`; it has `kernel/`, `packages/core/`, `packages/opencode/` and `indexd/`, **not** the independent `horizoncode-runner`, `horizoncode-orchestrator`, `horizoncode-tools` or `horizoncode-tui` crates imagined in other reports. The key-shaped string in `opencode/packages/http-recorder/test/record-replay.test.ts` is inside a secret-detection fixture, not proof of a live credential. Do not rewrite Git history without actual alert and provenance confirmation. At the initial remote review checkpoint, GitHub Actions had zero runs; PR #1 subsequently ran full validation. For current commit-bound hosted results consult `HANDOFF.md` and the Actions checks, never assume this historical snapshot remains current. No benchmark or Experimental Settings runtime integration was verified by this documentation-only change. Use immutable source pins in §42 before translating rival code. The current implementation gate remains P1.3.

## Optional-feature Settings and Experimental class — A-V2-29

Integrate with the existing §16 Settings/config owner and §33 canonical capability/action registry; do not create a separate feature registry, feature daemon or TUI-only flags. `FeatureExposureV1` is a derived projection schema in `contracts-v2/feature-exposure-v1.schema.json`. The official maturity/release tag is `experimental` (then `beta`, `stable`), distinct from DESIGNED/CODE_PRESENT/WIRED/TESTED/VERIFIED/RELEASED and runtime unavailable/disabled reasons.

- [ ] At every optional feature introduction, register one searchable owning setting with stable key, default/scope, requested/effective/source/locked/apply-boundary and availability; display in Settings → Features, plus Settings → Experimental if classed experimental.
- [ ] Experimental default OFF; user explicitly opts in on eligible developer/early-access build. A DESIGNED/unsupported feature is disabled/unavailable, **never fake-enabled**. A developer-only feature is invisible as an actionable control in ordinary public builds.
- [ ] V1 TUI command palette, help, tool/agent picker, running status and CLI/SDK surfaces render `[Experimental]` or equivalent from the **same descriptor**, and show effective status/reason. Future desktop/web consumers must reuse that projection; no TUI-only independent source of flags.
- [ ] Enabling a setting cannot override Guard/policy, change selected model/harness, launch paid inference, or perform an unauthorized effect. Apply boundary and next-turn/next-session/restart state are explicit.
- [ ] Run FEAT-001..010 in §32 with schema/registry validation before declaring a feature TESTED or VERIFIED; preserve safe disable/migration when class changes.

The 2026-10-15 source review in §§16.15.2/30.4/42 SRC-024 finds future ContextService projection architecturally plausible but not integration-ready: Core V2 lacks the owner, exact-model image metadata, image-aware budget and local renderer. Snapcompact is outside the next four V1 slices; no executable setting or runtime claim is appropriate.

### Feature-source audit and smallest implementation route (2026-10-14)

**Historical source snapshot (2026-10-14; superseded by the 2026-10-15 live-overlay correction and A-V2-31):** Core V2 and legacy V1 experimental/config/migration, OpenCode instance config/runtime flags and config API, GUI-local `settings.v3`, GUI Settings tabs, TUI config/app/command/status, schema and architecture validator were inspected. At that snapshot these paths did not implement the later shared projection/UI. Current first-party CODE_PRESENT/PARTIAL status and V1 CLI/TUI scope are recorded in `HANDOFF.md`, §20.10.1 and `implementationtov1release.md`; app GUI is not a V1 acceptance surface. Exact runtime acceptance remains §32 FEAT-001..014.

- [ ] Inventory user-selectable optional controls and legacy experimental environment variables. Deliberately classify `OPENCODE_EXPERIMENTAL` inheritance so broad flags cannot silently enable newly governed experiments.
- [ ] Implement one derived `FeatureExposureV1` read/effective-state projection from existing backend config, source precedence, platform/build/eligibility and Guard constraints; don't make GUI-local `settings.v3` the execution authority.
- [ ] Implement narrow source-version-safe opt-in persistence using current config update owner. Concurrency, denied policy, pending turn/session/restart, rollback and opt-out must work.
- [ ] Add keyboard-accessible V1 TUI Settings → Features/Experimental and command/status `[Experimental]` labels. GUI/web settings entries are post-V1; future consumers must project the same effective runtime state and unavailable reason.
- [ ] Run schema/contract validator, V1/V2 binding tests and FEAT-001..014 actual integration. A passing generic typecheck or designed schema is not completion.

This work is part of P6 Settings/UX but must be integrated before *new optional effectful features* are presented as executable. It does not replace P1.3 Guard completion.


## P1 and P2 completion ledger — implementation gate, October 14 2026

STATUS: This maps existing source to remaining work, not a new subsystem or claim of release readiness. Completion source is HANDOFF.md and exact passing CI/OS evidence; Gate 2 and Gate 3 remain OPEN.

### P1: origins and required exact negative proof

| Priority | Existing owner/origin | What must be proved |
|---|---|---|
| 1 | packages/opencode/src/session/prompt.ts: shellImpl -> spawner.spawn | All shell/process/Git/build/test effects require kernel PREPARE and one-use ExecutionHost lease before spawn. Validate cwd/argv/env, sandbox profile, output bounds, process tree, cancellation and UNKNOWN. Do not break direct UX without providing a guarded replacement. |
| 2 | Same file: commandWork -> ConfigMarkdown.shell -> Process.text | No shell interpolation before Guard; denied, malformed or mixed substitutions spawn zero processes. |
| 3 | Same file: handleSubtask -> TaskTool.execute | Parent permission, workspace fence, budget, model/harness and child scope intersect; no Task spawn or child mutation without Guard. |
| 4 | packages/opencode/src/tool/registry.ts and hydrated plugin/hooks/MCP/code-mode implementations | Executable callbacks and network calls require pre-dispatch authority, not metadata classification or post-execution permission UI. Explicitly disable unmediated extensions. |
| 5 | packages/opencode/src/session/llm.ts and provider adapters | Opaque GitLab hosted workflow blocked in PR #4; audit and preempt remaining hosted execution, remote MCP and native tool paths. |
| 6 | packages/core/src/session, V1 legacy HTTP routes, maintenance jobs | All externally callable effectful operations cross the same kernel authority, including settings/auth/network and background jobs. |
| 7 | LSP/DAP/REPL/browser/desktop/automation/external agents | Every enabled action has canonical scope, authenticated origin, pre-launch Guard, resource generation and OS-specific confinement tests; otherwise UNAVAILABLE. |
| 8 | kernel/src/guard.rs and effect_host.rs | Generalize single files.write-only capability to complete atomic batches, durable PREPARED intents, exact one-use lease, receipts, UNKNOWN target reconciliation and no unsafe retry. |
| 9 | packages/opencode/src/session/tool-batch.ts | Preserve PR #3 partial-frame lifecycle tests, PR #4 abort propagation and hard bounded provider-stream deadline, 32-call and 256/512 KiB byte ceilings. |

P1 adversarial matrix: forged callback, stale call ID/capability, invalid streamed siblings, simultaneous conflicting effects, plugin/MCP alias bypass, symlink and path-swap attacks, environment/credential exposure, denied child shell, process escape, network/OS guarantee mismatch, explicit cancellation before and after PREPARE, lost target receipt and non-idempotent UNKNOWN. Unsupported host/platform capability must decline rather than claim best effort as enforced. Green typechecks are insufficient.

### P2: execution sequence and production acceptance

1. Authenticated Goal + immutable accepted FULL SpecVersion: objective, scope, constraints, criterion descriptions, budgets, project/workspace and source digests. A model or plugin cannot approve its own spec.
2. Existing Rust durable owner gets real Run/Task/Attempt event control and SessionLink correlation without a second canonical transcript. Tasks depend on independently verified PASS; Attempts carry actor/agent/provider, policy/owner epoch, workspace and retry budget.
3. Add bounded supervised scheduler, worker/worktree/resource leases, conflict graph, heartbeat, cancellation fences, explicit provider choice and guarded EffectHost dispatch. Worker completion alone is never Task PASS.
4. Reconcile effects/leases after process crash. Unsettled active Attempts enter RECONCILING; never automatically retry non-idempotent UNKNOWN, erase dirty state or leak child processes.
5. Trusted final verifier associates all accepted criteria with artifacts, test identities and current final integrated revision plus workspace overlay. Detect human edits/stale proof before SUCCEEDED; otherwise FAILED/NEEDS_YOU.
6. Wire authenticated API/TUI, user steering, pause/resume/stop, restart/reconnect. Test fan-in dependencies, arbitrary crash at each effect stage, stale owner fences, duplicate delivery, budget exhaustion, manual approval, success/failure/NEEDS_YOU and native Windows capability truth.

Current PR #4 implements only an INTERNAL OwnerLogV2 backed control projection and guarded stream hardening. It now has internal Task verification and criterion/final-revision state transitions, but NO independently authenticated verifier adapter, managed RPC/API, worker scheduler, effect target reconciliation, lease engine, or native Windows qualification. Keep P1 and P2 open until all above tests prove real end-to-end execution.

Do not create new agent loops, tool authorities, separate Rust conversation stores or competing feature registries. Use source paths above, existing Owners in 17, execution contract 14, lifecycle 11, schemas 12 and task fixtures 32.

## Resource-efficiency and JCode adoption implementation gates — 2026-10-15 (A-V2-30)

**Baseline:** Horizon `main@4e2086633d006f7d8b7709cb0df622f77a9b8d54`, JCode `1jehuang/jcode@1f612a7`. This section records **newly accepted work, not completed work**. The normative owners are §17.10, §18.17, §20.11, §21.10, §29.17, §30.20, §31.16, §32.32, §33.29 and §37.16; this plan is the sole task-order tracker. Never interpret a checked research item as working runtime.

### RC0 — baseline and resource instrumentation (independent of mutation enablement)
- [x] Pin external JCode source and distinguish implemented vs Proposed/Design/Draft/Being implemented in §42.9.
- [x] Record current per-Session `SessionSupervisor.open` / `session_supervisor.rs` process topology and Rust managed admission truth.
- [ ] Add first-party `scripts/perf/` harness with Linux process-tree PSS/RSS/FD/CPU/threads, macOS footprint/native Windows private bytes. Tests for missing/permission-denied metrics and PID reuse; no fabricated zero.
- [ ] Add redacted, bounded process-tree ResourceSampler with host/kernel/Session/Run/Attempt/child/cache/local-model attribution and compatible sampling period.
- [ ] Record reproducible current Horizon/JCode controlled 1/5/10/20-session baseline and real task outcomes in `docs/performance/evidence/`, with exact commits, machine, build, warm/cold, embeddings, model selection and method.
- [ ] Decide per-platform release budgets/regression ratchets from evidence, then add CI test. **Do not claim JCode's PSS values for Horizon.**

### RC1 — mandatory P1 security and current supervisor
- [ ] Complete enabled tool-origin interception (direct shell/process, Task/subagent, hooks/MCP/plugins, provider-hosted, LSP/DAP/REPL, browser/desktop/network/automation) with pre-dispatch Guard/lease/receipt/UNKNOWN and no-bypass tests. Unsupported origins remain unavailable, not implicitly trusted.
- [ ] Measure baseline per-Session supervisor process count, per-SQLite observer cost, startup, watchdog/cursor and isolated effect write.
- [ ] Prototype **read-only** shared Rust SessionLink multiplexing behind `SessionSupervisor.Service` with peer-auth binding, per-Session queue/cursor/epoch/cancellation, bounded ACK and cross-session negative tests.
- [ ] Fault-inject one client abuse, one worker crash, kernel crash, malformed packet, conflicting owner and stale epoch; prove no cross-session read or mutation authority and no lost receipt.
- [ ] Only then consider shared effect-host cutover with full §14 P1 tests; preserve existing interface and rollback. Run JC-RES-001/002/008/009/010.

### RC2 — P2 useful managed execution and headless workers
- [ ] Wire reviewed full SpecVersion acceptance, authenticated kernel RPC and Rust Task DAG scheduling over existing managed state (no second Task database or transcript).
- [ ] Add resource-aware WorkerExecution/Attempt pool: lightweight read-only headless attachment, strict isolated process for untrusted effects; leases, cancel/kill tree/UNKNOWN settlement and idle reuse keyed by trust/config/workspace.
- [ ] Typed DAG edges carry artifact ref/source revision/criteria; cycle/depth/member caps, independent coverage review and final integrated-revision verification. Complete concurrent task/edit and crash recovery tests.
- [ ] Add source-generation-safe file-touch **advisory** index plus authoritative digest/lease precondition and collision UI. Run JC-RES-007/011/012/018.

### RC3 — P3/P6 practical daily coding and compatibility
- [ ] Provider Doctor offline/catalog/full under existing transport, model catalog and secret ownership; explicit spend confirmation, bounded requests and typed stream/tool-call diagnostics. JC-RES-013/014/015.
- [ ] Add transparent provider prewarm **only** for consented no-spend pools; distinguish selected local model warm/load from API warmup and record actual cache hits or unknown.
- [ ] Add one-owner external Session import preview/commit/resume with original provenance, no token/credential copy, no dual live transcript owner; test supported backend formats. JC-RES-019.
- [ ] Cap/attribute context, index, Markdown/Mermaid/image, provider projection and tool-tail bytes; opt-in scope-bound local recall, no mandatory embedding/remote account. JC-RES-003/005/020.

### RC4 — P7/P8 UX, operations and release acceptance
- [ ] Adaptive idle/deep-idle redraw with full-frame reason tracing and bounded in-place tool-tail; stable focus/scroll on 10k messages, 1000 streaming deltas and reconnect. JC-RES-006/016/017.
- [ ] Expose measured/estimated/unknown resource graph, per-Session/Attempt worker/process costs, provider diagnostics and conflict warnings in TUI/CLI and derived GUI/API (feature exposure truthful; experimental opt-in when necessary).
- [ ] 10/20 Session real-work task success + crash/unknown effect/pressure/lease and cross-OS qualification; CI perf ratchet and installer/licensing; preserve no automatic paid fallback. JC-RES-001..020 plus existing §32 security/recovery cases.
- [ ] Record exact binaries/build flags, benchmark raw evidence, negative/positive tests, platform matrix and user-approval gates in HANDOFF; append actual work diary to CURRENT_RUN.

### Engineering rule

Work on RC0 **without** claiming P1/P2 completion; proceed with required real Guard and managed execution in the existing Gate 2 → Gate 3 order. RC3/RC4 adapters may be designed/tested in isolation but must not expose effectful bypasses. `README.md` is a product page and must not become a RAM benchmark claim. Automatic hot-swap/self-dev remains developer-option work with independent rollback/security gates, not a reason to defer the fundamental engine.

### RC5 — remaining JCode adoption parity (not omitted)

The original 24-candidate audit includes supporting features beyond core RAM. Track all of them explicitly; implementation can overlap where different code owners/tests permit.

- [ ] **Active user steering and terminal input compatibility:** confirm existing durable steer/queue behaviour under concurrent streams; render queued/accepted/next-turn state; verify UI-016/017 ordering and restart acceptance plus Shift+Enter/tmux/SSH; never corrupt the selected provider request/cache prefix.
- [ ] **V1 CLI/TUI SDK/protocol:** thin documented, authenticated CLI/TUI SDK over one Core Session and Rust managed owner; API version negotiation, reconnect/replay and simultaneous local client activity, without new conversation authority. Remote/mobile/web/desktop SDK clients and hosting remain post-V1.
- [ ] **Rich provider auth/catalog/compatibility:** evaluate JCode provider-source breadth alongside existing OpenCode/OMP candidates, reuse current transport/model picker and secret ownership, verify explicit user selection, RC-011 failure/retry behavior, and cache/cost provenance with Doctor fixtures.
- [ ] **Tool intent and large-output opt-in:** add concise user-visible intent/purpose only behind canonical ActionDescriptor/ToolBatch schema; bounded output remains an artifact/stream, not an escape from limits.
- [ ] **Compile-time rebuild and release-resource hygiene:** profile Rust crate/Bun TypeScript invalidation, no duplicated heavyweight build trees, benchmark incremental compile and install size; only split modules after measured hot-path impact.
- [ ] **Multi-session activity map:** derived UI over the same Session/Run state, focus/scroll isolation, pausing/resuming and clean external terminal/tmux integrations; JCode multisurface is Proposed, not shipping proof.
- [ ] **Human-quality performance/demo trial:** repeat real user workflows and record authentic TUI video, input/stream p95, verification success, understandable errors and accessibility; never represent mock/demo placeholders as completed product.
- [ ] **Post-V1 separately gated:** developer-only signed/reversible self-development/hot-swap canary and secure remote/mobile SDK surface with fencing, rollback and no separate Task/Session engine. These are not V1 release gates; preserve A-V2-29 and human authorization if later promoted.

Source-to-feature coverage crosswalk: §42.10. These are accepted product capabilities with individually honest availability/evidence, **not an instruction to discard them on scope grounds**.

## Implementation-ready RC0–RC5 function/test ledger — 2026-10-15

**Authoritative design is in the topic owners; this ledger only orders code work.** All entries below are **NOT IMPLEMENTED by the documentation PR** unless separately identified in HANDOFF with source and real test evidence. Do not create a second Session, Task, tool registry, authorization engine or runtime in the name of JCode parity. The precise HLD is §01.13, API/IPC §13.12, state/durability §11.20, schema work §12.16, LLD §15.20/§18.18–19/§21.11/§29.18/§30.21/§31.17/§37.17–19 and tests §32.33–34.

| Deliverable | Concrete code boundary | Core functions / adapters to implement | Test gate |
|---|---|---|---|
| RC0.1 process-tree measurement | host supervisor + Rust/OS ResourceSampler, script harness under `scripts/perf/` | `resolveOwner, walkOwnedProcesses, readCounters, deduplicateTree, attributeByLease, sampleWithBudget` | JC-RES-001/002/003/004 |
| RC0.2 process/budget truth | Rust WorkerExecution/resource lease owner; §11.20 sole reservation/pressure state enum, §18.18 accounting | `reserveCapacity, chargeActiveUsage, evaluatePressure, releaseIfSettled, reconcileOrphan`; prevent `ACTIVE`/`UNKNOWN` shadow states, double debit and expiry-after-launch free | JC-RES-006/012.C–J |
| RC0.3 cache/renderer | existing context/index/TUI owners | `cache.lookup, insertIfCurrent, pin/unpin, evictToBudget` | JC-RES-005/006/020 |
| RC1.1 Guard closure | existing provider/callback/host paths + Rust `guard.rs/effect_host.rs` | complete atomic batch, classify origins, authorize, durable PREPARE, one-use lease, launch, receipt/UNKNOWN, cancel | existing P1 denial matrix + JC-RES-009 |
| RC1.2 shared read-only observer | `SessionSupervisor.Service` and Rust supervised IPC | `attach, subscribe_page, ack_page, detach, cancel_scope, read source cursor` with peer/epoch/queue quotas | JC-RES-008/009/010 |
| RC1.3 eventual shared effects | same Rust Guard and EffectService, feature-negotiated | migrate one effect class behind selected kernel owner, durable reconcile then release old supervisor | full §14 bypass/regression & benchmark |
| RC2.1 managed scheduler | Rust `managed_control.rs`/OwnerLog, authenticated API | `acceptFullSpec, graphValidate, readyTasks, admitAttempt, reserveResourceLease, settleDelivery` | JC-RES-007/018 + P2 |
| RC2.2 worker execution | Rust WorkerExecution + §14 ExecutionHost; authenticated ingress/Task/Attempt/owner epoch on every request | `enqueue, reserve, attachExistingCoreClient, startIsolatedWorker, settleWorker, revokeLease`; untrusted ticket/lease alone cannot launch | JC-RES-007/009/012.H–K |
| RC2.3 reviewer | existing Rust Evidence/Verification owner with independently authenticated adapter | `verifyCriterion, bindRevision, finalizeRun`; no child self-approval | JC-RES-018 |
| RC2.4 file-conflict safety | file watchers/handler + Rust guard revision preconditions | authenticated `recordObservedTouch, listForPath, invalidateGeneration`; internal-only `evictExpired`; bind Session/owner epoch/source generation; hard write lease/hash validation separate | JC-RES-011/012.K |
| RC3.1 Provider Doctor | existing selected provider/auth/catalog source; §37.18 | `inspectOffline, probeCatalog, probeFull` with authenticated grant ownership/epoch, consent and actual token/billing evidence | JC-RES-013/014/015/012.L |
| RC3.2 context+recall | ContextLedger/indexd and selected model provider | `compileContext, recallScoped, getTokenBudget, invalidateSourceEpoch` | JC-RES-003/005/020 |
| RC3.3 session import | canonical host Session and explicit native backend adapter | `detectSources, previewImport, commitImport, detachExternalSession` | JC-RES-019 |
| RC4 TUI | hydrated existing renderer + UiEventMux | `normalizePaintEvent, stablePrefixDiff, coalesceReplaceableDelta, chooseFrameDeadline, paintChangedCells` | JC-RES-016/017 |
| RC4 surfaces | existing Settings FeatureExposure and API/TUI/app | `resolveEffectiveFeature, renderResourcePanel, renderProviderDoctor, showFileConflict` | FEAT-001..014 + resource suites |
| RC5 clients | existing public Session/API and authenticated backend adapters | `attachClient, subscribe/ack/replay, sendUserInput, steer, cancel` | replay/auth/single-owner/turn-epoch tests |
| RC5 dev canary/packaging | supervised build/test worker, release owner | `prepareCandidate, testAndAttest, requestUserApproval, activateCanary, rollback` | isolation/signature/rollback and disk/build cases |

**Definition of executable specification before marking a checkbox:** every selected function above has an existing/new concrete file path *in a hydrated checkout*, typed parameters/return/limits, ownership of durable vs derived data, error-code mapping, explicit concurrent/cancel/crash behaviour and a complete test with fixture bytes and method. §37 pseudotypes are not compiled/generated contracts: RC0–5 may be marked CODE_PRESENT only after actual modules/schema appear, WIRED only after real ingress/egress, VERIFIED only after security/OS/performance tests. Benchmarks from JCode or README screenshots are not runtime proofs.

**First coding sequence:** P1.3 requires the host-scoped `hz-kernel` prerequisite in §§14/37; then close the first shell/process origin with complete-batch Guard admission and a real guarded replacement. RC0's read-only ResourceSampler may proceed in parallel only for stable Rust-owned process/lease identities. “Do not build the shared effect daemon first” means do not prebuild the proposed multi-Session observer/virtual-session broker; it does not defer or replace the normative host-scoped effects owner, and it does not permit routing effects through `session_supervisor`. Keep native Windows unsupported paths unavailable until native Windows source/OS tests pass. Follow `AGENTS.md` worktree/cleanup discipline.

## Missing accepted journey implementation ledger — ACP / visual / deployment (2026-10-15)

These flows were already accepted in §§3.16–3.18; prior implementation-specific resource hardening did not fully cover their host interfaces. They are **unchecked** until actual source/contract/system proof exists.

- [ ] **ACP outbound adapter (P6):** hydrate upstream OpenCode ACP server for source reuse, then add distinct Horizon client adapter through existing AgentProfile/DelegationMailbox and Rust worker/Guard. Implement version/auth/capabilities/session link, tool mediation, typed result, cancel/reconnect and UNKNOWN with tests ACP-001..008. Native OpenCode mode remains a separately owned backend, not a second direct Horizon Session writer. *(Superseded for V1 by the 2026-10-16 scope decision and `DEC-V1-24`: external ACP client integration is post-V1; retain this design and ACP-001..008 as the promotion plan.)*
- [ ] **Visual source selection (P5/P7):** browser/preview observation + build/source-map generation → bounded source candidates/ambiguity → approved guarded `files.patch` → re-observe/verification. Real VIS-001..004; do not turn a pixel or untrusted DOM into write authority.
- [ ] **Deployment (P5/P9):** provider/environment/account discovery and deterministic artifact manifest; explicit spend/secret/effect consent; Guard PREPARED/lease; target-side idempotency+receipts; real URL/revision health and critical workflow check; bounded rollback/reconciliation. Real DEP-001..008; no speculative production deployment or success from an upload alone.
- [ ] Add versioned generated machine contracts + canonical §33.30 candidate registrations and actual entry points before marking any new tool WIRED, and update HANDOFF with CI/OS/provenance. Source seam §20.13, safety §14.18, interfaces §§37.20–21, tests §32.35. The existing P1 universal Guard is a prerequisite for effectful routes; do not invent a second execution engine.

## 2026-10-16 — user-directed next-agent execution wave

This records the requested delegation method; it does not change P0–P9 dependencies, mark a gate complete, or authorize effectful work ahead of P1.3.

- Main agent owns architecture/source research and integration. Read the active owner docs and inspect the local pinned OpenCode tree plus the exact OMP/OpenCode revisions in §42 before coding. Prefer compatible source reuse or bounded algorithm adaptation over a fresh parallel implementation; inspect callees, tests, per-file licenses, exceptions and dependency closure, then record any port in §42.
- Use separate bounded agents for P0, P1.2, P3, P4 and P5; one agent owns P1.3 followed by P2, sequentially. P2 starts only after the P1.2/P1.3 entry gates pass. Keep writable file sets non-overlapping and preserve all pre-existing dirty/untracked files.
- P3/P4/P5 may research or implement compatible non-effectful paths in parallel, but every effectful origin remains unavailable until the canonical Guard/ExecutionHost boundary and its negative/recovery tests pass.
- The user explicitly authorized native Windows testing under `/mnt/c/users/sonali/desktop/` in a newly created temporary directory with a child `hzcode` folder. PowerShell 5.1.26100.9711 is available and the Desktop path exists. No such test directory was created in this continuation; keep Windows results separate from WSL/Linux evidence.
- Current implementation status and exact verification remain in `HANDOFF.md`; chronological changes and next steps remain in root `CURRENT_RUN.md`.

## 2026-10-16 — V1 scope decision (revised by user) — Linux-first CLI/TUI with source-adapted capabilities

**Scope boundary only: no gate is marked complete and the fail-closed rule stands.** The detailed V1 goal/status/source map is `implementationtov1release.md`; architecture authority remains the exact topic owners in `arch_V1/README.md`.

**Platform and surface:** V1 targets Linux/WSL-first **CLI/TUI**. Native Windows stays truthfully **UNAVAILABLE** until native acceptance. Web app, desktop app, browser automation/attached-browser and desktop/computer control are post-V1; built-in web search is V1 per the 2026-10-18 promotion (`DEC-V1-26`). Browser-based visual editing, deployment journeys and external ACP client integration remain post-V1; local Rust-owned subagents/workers remain V1.

**V1 finish list (must complete):**
- **A1–A4** — pass the product-level `bun run horizoncode:typecheck` (covering the CLI host, TUI, and Core) → rerun `scripts/architecture/run_push_gate.sh` → push `main` after exact-scope verification → restore Git visibility of hidden first-party files. `packages/opencode` remains an internal source path during the staged naming migration. Nothing ships while the gate is red or commits are unpublished.
- **C13, C14, C15** — guarded shell/process origin, command interpolation, Task/subagent origin. The coding-agent mutations; without them "safe coding agent" is false.
- **C16–C18, C10** — close remaining effect origins (plugins/MCP/hooks, hosted tools, legacy routes) by **mediate-or-disable** with zero-spawn negative tests proving no bypass; full mediation only if capacity allows.
- **C20, C21** — Guard generalization (complete batch/lease/receipt/UNKNOWN settlement) + ToolBatch bounds. Makes the Guard story uniform.
- **C25 (trimmed)** — adversarial matrix limited to origins that are actually enabled. The security claim's evidence.
- **D1, D2, D4–D8, D11 (+ D9-minimal, H7)** — P2 first proves the single managed vertical: SpecVersion → one Task/Attempt → one guarded action → receipt → independent verifier; pause/cancel/restart/UNKNOWN and fault tests; API/TUI entry point + Goal review/accept. This is the prerequisite, not the complete managed V1 scope. Under DEC-V1-31, bounded multi-Task DAG execution, independent per-Task verification, conflict-safe leases and aggregate Run settlement are also required for V1 after the vertical passes. Until that later acceptance, multi-Task dispatch stays unavailable.
- **K1, K2-honest, K5, K6** — license/notices, declared platform matrix (Linux/WSL supported; Windows truthfully unavailable), clean install, release gates. Legal + installability are irreducible.
- **S1** — question/`question.ask` catalog + schema + live acceptance (user-flagged).
- **S3** — final-head CI, full gate, DOC guards. The release evidence itself.
- **Expanded V1 capabilities:** LSP, DAP, bounded REPL, OMP-preferred provider/settings/TUI UX, broad tested providers, streaming/rendering, artifacts/analytics/Rust-owned automations, bounded worktree/resource pools, quotas, cross-model suites, worker/subagent DAG, file conflicts, Provider Doctor, session import, bounded caches/local memory, TUI performance and measured JCode-informed RAM/resource optimization. Full goal/status/source mapping and evidence criteria are in `implementationtov1release.md`.
- **RC0 measurement is required V1 work:** capture reproducible 1/5/10/20-session resource baselines and verify measured optimization without correctness/security regressions. **Optional:** RC0.3 cache/renderer baseline capture (bounded cache behavior itself remains a V1 goal) and C22 Linux PTY process-tree cleanup guarantee.

**Post-V1 deferral (keep unavailable, never fake-enable):** web/desktop application surfaces; browser automation/attached-browser and desktop/computer control; external ACP client, visual source-edit and deployment journeys; native Windows acceptance; remote/cloud continuation; shared live collaboration; autonomous self-improvement; broad voice/media and hosted image generation; full product/package/build naming migration; updater and other explicitly deferred platform features. (Built-in web search was removed from this list on 2026-10-18 — it is V1 per `DEC-V1-26`.)

**V1 source-intake method (user directive 2026-10-16):** do **not** rebuild compatible capabilities from scratch without first checking the pinned references. Source clones and exact pins are recorded in `repo_take/NOTES.md` and §42. Use OMP first for compatible provider implementations and CLI/TUI settings/visual patterns; inspect both pinned OpenCode and OMP for LSP/DAP/REPL; use the documented, version-appropriate official OpenCode API/SDK only for explicitly selected OpenCode-owned sessions. Claude Code is behavior reference only; no source reuse. Every port still requires exact file/callee/test, license/dependency, and `REUSE EXISTING / ADAPT ALGORITHM / ADAPTER / REJECT` review; preserve Horizon owner/Guard and test locally. New adapted first-party modules use HorizonCode naming while preserving notices and genuine dependency IDs. Never replace the tracked `opencode/` snapshot with a clean upstream checkout.

**Dependency order and evidence:** P1.3 Guard precedes effectful feature exposure. Then prove one managed Attempt and an independent final-revision verifier before expanding worker/DAG fan-out. RC0 measurement can proceed independently on stable owner identities. The main agent owns integration and status changes; keep at most one heavyweight Rust build active. Scope does not promote implementation status.

## Design-hole closure assignments — 2026-10-18 (user-directed)

Recorded from the design-level audit (`CURRENT_RUN.md` §8; gates in `arch_V1/17-GOVERNANCE-DECISIONS.md` §17.4). No gate below is claimed complete.

- **OS-confinement backend (`horizoncode-sandbox`) — P1.** The backend is present and source-wired through HostKernel terminal/stdio confined preflight and dispatch (`terminal_process.rs`, `host_kernel.rs`; source review 2026-10-19). This does not yet establish the final product containment matrix or no-bypass/denial acceptance. Linux target: bubblewrap namespaces + Landlock/seccomp-class restrictions + scoped roots (pinned `repos/codex` research: `codex-rs/linux-sandbox` bwrap+landlock, `codex-rs/network-proxy`; §42 provenance/license review). Required evidence remains per-kernel containment plus LS-009 / DAP-002 / REPL-001 / PS-003 denial tests. Keep any unproven origin unavailable until its actual dispatched process is shown confined.
- **Checkpoint/rewind — LLD closed 2026-10-18 (§14.19, §16.18, §31.18); wiring P7 (session/artifact surface) with P8 recovery acceptance.** V1 reliability criterion §32.24; tests CP-001/CP-002; core seam `packages/opencode/src/session/revert.ts`; gate `DEC-V1-25`.
- **HorizonCode-as-MCP-server exposure — post-V1 (`DEC-V1-23`).** Verified 2026-10-18: the pinned Codex source is MCP-client only (spawned MCP server processes are sandboxed) and the current Claude Code CLI reference has no `mcp serve`; both ship structured headless surfaces instead (Codex `app-server`/`exec-server`; Horizon `run`/`serve`/future SDK). Real parity item: spawned stdio MCP server processes must run through P1.3 Guard/ExecutionHost confinement (§14.6).
- **Editor/IDE integration breadth — post-V1 (`DEC-V1-24`).** V1 is CLI/TUI only; external ACP client stays post-V1 (design §37.20 retained; tests ACP-001..008); VS Code/JetBrains-class extensions are undesigned and unclaimed.
- **Built-in web search — promoted into V1 (user directive 2026-10-18, `DEC-V1-26`).** Design: §33.9 `web.search.*`; §37.5 WebSearchBrokerV1; §16.7/§16.15 settings; `DEC-V1-20` cost/auth/reliability matrix; acceptance in §32 and Gate 6. Model: built-in default route + optional BYO-key providers (Brave, Exa, …); enabled routes form one ordered cascade with fail-through; exhausted chain → one bounded normal retry + per-route reasons; no route used unless enabled; no hidden paid fallback. Research packet (competitor behavior + provider matrix) in flight; implementation follows design sign-off.

## Web-search V1 promotion — 2026-10-18 (user-directed)

Built-in web search was promoted from post-V1 into V1 by direct user instruction (`DEC-V1-26`). No gate is claimed complete.

- **Design owners updated in the same pass:** `arch_V1/33` §33.9 (V1 label + cascade contract), `arch_V1/37` §37.5 (route configuration/cascade/settings/provenance contract), `arch_V1/16` §16.7 (web search connections in Settings), `arch_V1/14` §14.16 + `arch_V1/15` §15.12 (effect classification + fallback semantics), `arch_V1/17` §17.4 (`DEC-V1-26` added; `DEC-V1-20` amended) + §17.11 amendment, `arch_V1/32` acceptance bullets, `arch_V1/10` §10.7, `arch_V1/01` scope note.
- **Research (competitor/provider packet completed 2026-10-18; tool-suite study still running):** competitor behavior (Cline, Codex, OpenCode, Claude Code, others) + provider landscape — recommended built-in keyless chain Exa → You.com → Tavily → Firecrawl → Parallel → TinyFish; BYO-key set Exa/Tavily/Brave/Parallel/You.com/Firecrawl (+ tier 2 Kagi/Jina/Linkup/Serper); Google CSE/Bing/DuckDuckGo excluded; SearXNG deferred post-V1; 429-only failover with Retry-After cooldown; no auto keyless→paid upgrade. Matrix seed recorded in §37.5. Tool-suite upgrade study (Desktop Commander, Playwright MCP, Context7, DeepWiki) mapped to §33 IDs still running.
- **Implementation workstream (P5-WS, queued):** source-adapt the typed provider routing from the pinned OMP reference (§42 SRC-007; `repo_take/oh-my-pi/packages/coding-agent/src/web/search/`) under the §37.5 contract, after P1-ORIG frees `packages/opencode/src/tool/websearch.ts`; Settings wiring, cascade tests and acceptance evidence follow.

## VEO-inspired roadmap review — 2026-10-19 (design proposal only)

The user supplied `C:\Users\Sonali\Downloads\extra_some_Stuff.md` for critical review. The full 1,851-line note was compared with the pinned product source, current competitor documentation and the active architecture owners. The selected mechanisms are now refinements to the existing required V1 phases under A-V2-33; system HLD, owner-level flows, event projections, schemas/LLD and tests are recorded in `arch_V1/01`, `/03`, `/04`, `/12`, `/29`, `/30`, `/31`, `/32` and `/37`. The initial decision analysis is in `docs/superpowers/specs/2026-10-19-veo-inspired-capability-roadmap.md`.

Required V1 allocation: P1 owns authenticated Guarded delegation/effect scope; P2 owns the one accepted-SpecVersion/Task/Attempt vertical, typed evidence and independent final-revision verification; P3 owns bounded generation-bound RepoIntel navigation and stale-write rejection; P6 owns provider/cache/cost truth and reviewed skill trust; P7 owns evidence artifacts and replay-safe UI/analytics projections; P8 owns attributed reservations and recovery. P4, P5 and P9 retain their existing scope. The dependency edges remain P1 → P2 effect dispatch, P7 ArtifactStore → P2 verifier evidence, P2 → P8 fan-out; P3/P6/P7 independent preparation continues in parallel. Effectful dependent paths stay unavailable until the corresponding upstream acceptance passes.

VEO-F1..F8 remain optional post-V1 extensions (including broader mutation campaigns, visual verification and staging/production integrations), not extra release phases or V1 blockers. P2 now owns the canonical private IPC `delegation-binding-v1` schema and golden fixture under `arch_V1/contracts-v2/`; managed admission denies before preparation when accepted trusted binding fields or live leases are unavailable. P7 lifecycle labels are projections over existing owner streams/cursors, not new OwnerLog kinds or an event bus. The remaining RepoIntel, evidence and event wire shapes must be reconciled with their owning schemas, generated bindings and fixtures before cross-process wiring. The review does not authorize another runtime, event bus, index, effect authority, hidden provider fallback or autonomous production changes. The full phase-to-owner/evidence matrix is maintained in `implementationtov1release.md`.


## 2026-10-19 15:52 UTC — live execution checkpoint and implementation-first hold

This checkpoint reconciles the operative phase queue with the current whole-phase roster. The user explicitly directed implementation before tests/builds; historical test reports remain preliminary and do not authorize a verification wave until source implementation for the requested V1 scope closes. Do not enable a dependent effect because its source or interface exists.

| Phase | Live owner/state | Remaining implementation before verification |
|---|---|---|
| P1 Guard/ExecutionHost | Active whole-phase owner | Finish universal pre-dispatch Guard and OS confinement, shell/process/interpolation and authenticated child effects, enabled-origin mediate-or-disable closure, atomic bounded ToolBatch leases/receipts/UNKNOWN/cancel/restart. Keep unsupported origins disabled. |
| P2 managed vertical | PHASE_PARTIAL (Core/Rust source paths present; awaiting P1 verifier and integrated acceptance) | Source paths exist for distinct authenticated review, accepted plan-to-Task/Attempt, pinned profile/worktree, usage accounting, child quiescence, typed verifier evidence/artifacts and Core-to-TUI delivery. Current source fixes split direct SHA-256 from managed BLAKE3 output pins and accept bounded HostKernel UNKNOWN reasons while enforcing exact sourceRevision for every verifier outcome. The Core flow calls authenticated `finalize_run` after verified Attempt settlement and before P8 release; restart recovery accepts only a terminal verified/quiesced/all-settled snapshot, replays finalization only when the Run is still VERIFYING, then asks P8 to settle the exact Attempt. HostKernel/P8 source resolves the deterministic final-Inspect receipt against the current terminal snapshot/root/claim, and same-owner-epoch pending disposition is replayed; changed-epoch or uncertain settlement remains quarantined and requires the separate reconciliation contract. Authenticated cancel interrupts only the exact active child Session returned by Rust recovery and retains CANCELLING through receipt reconciliation. Regression source exists; no checks were run. Remaining: P1 guarded verifier dispatch, durable output/quiescence and fresh-process UNKNOWN reconciliation; acceptance of P8 final-Inspect/restart settlement and integrated P2 recovery/conflict behavior. Finalization and dispatch remain effectfully unavailable while the P1 verifier adapter is disabled. |
| P4 LSP/DAP/REPL | Active whole-phase owner | Finish supervised lifecycles, production editor ingress, mediated LSP edits/rename, DAP attach/evaluate, REPL callbacks/recovery and Linux real-project journeys. All effectful dispatch waits on P1 Guard/confinement. |
| P8 resources/workers/RC0 | Active whole-phase owner | P8 now persists/replays the typed HostKernel child worktree projection in `worker_delegation_bound`, maintaining parent-root revision separately for P8 registration validation and child measured revision for Attempt/lease/terminal checks. Remaining implementation: finish final-Inspect settlement/recovery integration with P1/P2, resource/RC0 evidence composition, and any remaining durable recovery/worktree paths. Keep fan-out disabled until P1/P2 acceptance; required 1/5/10/20 baselines remain for verification. RC0 stays `NOT_ATTESTED`. |
| P7 streaming/artifacts/analytics/automation/rewind | Partial, queued | Complete cursor/emitter/SDK parity, redaction/render interactions, truthful artifact fidelity, P8-backed automation/checkpoint/rewind and replay/resnapshot journeys. |
| P3 RepoIntel | Partial, queued | Complete a real authenticated source/parser producer, bounded structural results/pages, stale-write rejection and recovery; preserve honest unavailable results where unsupported. |
| P5 built-in web search | Partial, queued | Complete built-in default plus user-enabled ordered cascade, route auth/cost/status provenance, bounded retry/cooldown/failure reporting, Settings consent and Guarded transport. Never silently upgrade to paid routes. |
| P6 providers/settings/Doctor/S1 | Active whole-phase owner; source partial | Source paths cover provider/model capability and cost provenance, explicit-zero-price anonymous OpenCode selection/default, Config-owned requested/effective/source/locked/pending settings, offline Doctor API/TUI, S1 owner-chain list/reply/reject and mixed-effect denial, and the Auth-owned fixed SecretBroker sender. P6 also supplies `Provider.managedRouteProjection` for managed LLM route pins: exact active provider/model/profile harness, bundled first-party adapter, HTTPS or loopback endpoint, opaque route/endpoint revision, unique SecretRef (or null only on exact anonymous-free proof), and internal consent/Guard refs. It returns no URL/secret bytes and does not dispatch; HostKernel still independently returns no-mutation UNAVAILABLE for both anonymous and credentialed managed sends until route/consent/Guard validation and guarded ExecutionHost transport exist. The search sender validates P1's exact one-use DISPATCHING permit, sends one fixed route through existing SecretBroker/transport, settles or marks UNKNOWN, and P5 resumes the Rust-owned cascade only with the bounded response and exact durable receipt. Search and live Doctor remain disabled pending P1 Guarded aggregate/probe acceptance; protected credential mutation remains unavailable without native protected input and Guard write authority. Remaining: source-close any newly exposed integration mismatch, then final-revision FEAT-001..014, S1, provider/model switch and explicitly authorized free-model acceptance. No verification has run. |
| P9 and integrated release | Partial, queued | Finish Linux CLI/TUI packaging/install/license and Git visibility work; after implementation closes run final-revision typecheck, tests, security/platform/release gates and exact-scope publication. |

P1/P2's current private interface is `ManagedAttemptScopeV1` with Goal/Run/Task/Attempt IDs, canonical-decimal owner epoch/revision, authenticated Location/Session, workspace revision digest and Rust-owned delegation-binding digest. Each effect remains separately bound to its exact effect ID, OwnerLog revision, capability and one-use lease digest. P1/P2 agree verifier observations must bind the same live Attempt plus exact criterion effect IDs and the HostKernel's freshly observed workspace revision. P4's Location/workspace pins are distinct from process generation, owner epoch and REPL source generation. The verifier remains disabled until its actual guarded dispatch and durable receipt path exists. Corresponding normative flow/schema/runtime contracts are in arch_V1 §§3.22, 12.19 and 37.22; observed phase state is in `implementationtov1release.md` and `HANDOFF.md`.

At this checkpoint P1/P2/P4 occupy all three available child slots; P8 is next on slot release. C: `/mnt/c` had 20 GB free (96% used), `kernel/target` 2.7 GB and `indexd/target` 292 MB; only the main worktree is present. The shared tree is mixed staged/unstaged/untracked and `main` is 12 commits ahead. Preserve all existing ownership; no stage/commit/push/cleanup/prune. Overall V1 remains PARTIAL / NOT RELEASED.


### 2026-10-19 15:53 UTC — P1/P2 source delta (not acceptance)

P1 source-wired exact managed terminal-effect receipt recording from HostKernel, with durable Attempt/principal/epoch/Location/Session/effect/revision/lease/target-receipt/workspace-revision bindings; unresolved outcomes remain UNKNOWN and no-relaunch. P1 added host-derived Attempt and per-criterion effect IDs to verifier journal/observation records. P2 tightened coding/verifier principal matching and requires every coding receipt to succeed at the pinned source revision before verifier intent; the verifier must preserve that revision. The legacy HostKernel verifier call sequence remains incompatible, so verifier dispatch and finalization remain disabled. No build/test evidence exists for this delta. Keep the remaining phase implementation queue in the 15:52 checkpoint above and the main status matrix in `implementationtov1release.md`; release remains PARTIAL / NOT RELEASED.

### 2026-10-19 15:56 UTC — managed revision-chain integration checkpoint

The HostKernel source derives a live managed Attempt workspace head from immutable Attempt admission provenance and the ordered predecessor-linked SUCCEEDED receipt chain, then checks the registered workspace root. The aggregate OwnerLog revision is distinct from each effect edge's bound revision. Source review found `ManagedControl::RecordAttemptEffectReceipt` still compared each coding receipt to the original Attempt base; P2 acknowledged the gap and is implementing the reducer's independent ordered-chain validation with P1. This is an integration blocker: verifier dispatch/finalization remain disabled until HostKernel and reducer enforce the same chain, including read-only verifier before=after=head and no caller-supplied rebase. Normative detail is now in arch_V1 §§3.22, 12.19, 14.3 and 37.22. P1/P2/P4 are still active phase owners; no tests/builds/typechecks are allowed yet under the implementation-first instruction. V1 remains PARTIAL / NOT RELEASED; remaining phase work and final verification/release gates remain as listed in the 15:52 matrix above.

### 2026-10-19 15:57 UTC — Guard lease/managed intent revision cycle resolved

Persist the Attempt edge and immutable verifier intent (trusted profile/executable, criterion, arguments and current workspace head) before Guard lease issuance; the durable intent does not contain the one-use lease digest. Refresh ManagedAttemptScope to the post-intent OwnerLog revision, then Guard/approval binds a one-use lease to the exact edge, immutable intent digest and live revision/workspace fence. EffectHost owns durable one-use consumption; the HostKernel-authenticated settled receipt records the exact lease digest. Authenticated distinct reviewer approves; trusted verifier profile principal owns the supervised child and receipt. An OwnerLog/workspace change while approval is pending invalidates authorization. This resolves the discovered revision cycle under §14.3 and is recorded in §§3.22/12.19/14.3/37.22. P1/P2 remain responsible for wiring and managed reducer chain validation; P4 keeps DAP unavailable until a correctly typed supervised process ref exists. No tests/builds/typechecks; V1 remains PARTIAL / NOT RELEASED.

### 2026-10-19 18:01 UTC — source audit and owner stop reconciliation

The user stopped all subagents; the live roster is empty and this supersedes prior active-owner checkpoint rows. The user-directed implementation-first hold remains: do not run tests/builds/typechecks/audits/provider probes until implementation scope closes. Local HorizonCode CLI-host package and Codex tree inventories and phase-level source decisions are recorded in `arch_V1/42-EXTERNAL-SOURCE-PROVENANCE-REGISTER.md` §42.12. No upstream source was copied. The working tree remains mixed staged/unstaged/untracked on `main` 12 ahead; C: has 60 GB free. V1 remains PARTIAL / NOT RELEASED. Resume from actual source and the complete V1 phase matrix, not the historical owner roster; preserve all existing changes and do not stage/commit/push/clean/prune while exact ownership is ambiguous.
## 2026-10-19 18:26 UTC — source-led architecture re-audit checkpoint

This is a progress checkpoint inside the full V1 target, not a phase completion. The user
directed that all subagents stop, so no implementation owner is active; do not restart agents
under that instruction. Keep the implementation-first hold: no tests/builds/typechecks/audits
or provider probes until implementation closes.

Source inspection compared OpenCode's direct Task/child Session behavior with Codex's
root-owned agent-tree lifecycle (spawn reservation, parent-policy config snapshot, lineage,
safe-boundary mailbox, send/follow-up distinction, wait, interrupt/cancel, terminal result,
resume ownership and residency). A mismatch was found between §03.5's managed-only wording
and the no-Goal direct-session delegation allowed elsewhere. §§03.5, 29.5, 37.9 and derived
§45.8 now describe separate direct Core Session and managed Rust Task/Attempt lanes; §42.12
records exact source findings and adaptation boundaries.

Open contract choice: `SubagentDeliveryV1` currently lacks a direct/managed lane discriminator
and leaves `authorityDigest` undefined. User was asked to select a single lane-tagged envelope
or separate schemas. Do not change that contract until the answer arrives. The remaining
architecture/source audit still spans the V1 modules and all active `arch_V1` topic owners;
implementation and release requirements remain those in this plan and the latest HANDOFF.
### 2026-10-19 18:28 UTC — sandbox resource-limit source gap

The Linux `horizoncode-sandbox` source reports OS `ResourceLimits` unsupported; current
terminal/non-PTY launch paths require filesystem, network-denial and process-tree guarantees
but not CPU/memory/process-count quotas. Admission, sampling, deadlines and output caps do
not prove OS enforcement. §14.5 records the finding.

### 2026-10-19 — resolved delivery, resource and search-failover decisions

- `SubagentDeliveryV1` is one lane-tagged envelope: direct Core delivery binds parent/child
  Session plus trusted profile revision and effective permission-scope digest; managed
  delivery binds the exact Rust `DelegationBindingV1` digest and Goal/Run/Task/Attempt IDs.
  `authorityDigest` is domain-separated BLAKE3 over canonical MessagePack including the
  domain tag, lane, parent/child execution IDs, owner epoch and validated authority claims; it is
  recomputed by the trusted owner; it never grants authority. A browser-safe TypeScript
  decoder is source-present at `packages/schema/src/subagent-delivery-v1.ts` but is not yet
  typechecked or wired into Rust/Core dispatch; Rust parity and a shared golden fixture remain.
- OS CPU/memory/process-count/FD guarantees stay unavailable until the selected backend
  enforces them. Profiles requiring them fail before launch. Admission/monitoring is allowed
  only for actual bounded/observed dimensions and cannot be advertised as hard OS quotas.
- Built-in web search records auth 401/403/407 per-route failures and continues only through
  explicitly enabled/configured routes. Other non-rate-limit 4xx stop and surface. The
  production Guard gate remains closed until P1's dispatch/security prerequisites pass.
- The user-directed implementation-first hold remains active: do not run tests/builds/
  typechecks/audits/provider probes until all requested implementation work closes. The user
  stopped subagents; do not restart them. §04 additionally records lane-bound child progress
  and redacted search-route attempt projections, with replay/resnapshot forbidden from
  reissuing a request. Trackers remain PARTIAL / NOT RELEASED.

### 2026-10-19 — SubagentDeliveryV1 decoder source delta

Rust strict MessagePack decoding and authority-digest recomputation are now source-present in
`kernel/src/subagent_delivery.rs`, alongside the browser-safe TypeScript decoder. The Rust
module is not wired to a delivery RPC or direct/managed Task lifecycle. Cross-language golden
fixtures, tests, runtime integration, current-revision verification and all V1 phase gates
remain open. No test/build/typecheck/audit was run under the user's implementation-first hold.

### 2026-10-19 — P2 reviewer-path source reconciliation

Current source includes middleware-derived `ServerAuth` transport through the authenticated
Core→HostKernel private request and durable distinct SpecVersion reviewer assignment/decision
checks. This corrects the earlier checkpoint that treated the production reviewer channel as
absent. The real-socket positive path and forged-identity negatives remain unverified; P2's
reviewer requirement is CODE_PRESENT/WIRED at source level, not TESTED/VERIFIED.

### 2026-10-19 — direct Task profile authority resolution

Core Config's immutable `AgentProfileV2` revision is authoritative for both direct-session and
managed child profiles. Core Config owns an explicit `agent_profile_selectors` mapping
`{selector, profileId, revision}`; TaskTool resolves only that exact immutable target. Profile
display names and legacy `Agent` names are not implicit aliases; duplicates, stale mappings,
wrong-owner profiles and missing revisions fail closed. A profile update never silently moves
an existing selector. A child resumes only its Session-pinned revision. Legacy `Agent` config
is migration input and cannot issue child authority. The resolved V2 profile must drive the
actual child model, harness, instructions, tool exposure and effective
parent-intersected permission scope before its revision/digests are pinned to the child Session
and Direct Attempt. Resume must recover that exact revision or fail closed. No decorative V2
digest over legacy runtime values, unpinned parent-model inheritance or silent latest-profile
substitution. P1/P2 own the direct integration boundary; implement source-only until the user's
implementation-first hold is lifted. `VEO-017` is the required stale/mismatch/recovery test.

Product-wide TypeScript status is always referred to as HorizonCode `bun run
horizoncode:typecheck`. A package-scoped result is a HorizonCode TypeScript package check with
its package path (for example, `packages/opencode`); it is not labeled an OpenCode product
typecheck.

### 2026-10-19 19:18 UTC — P3/P4 authenticated read and process profile contract

P1 source now includes the additive bounded `repo-intel.v1/read_document` operation; P4
LSP reads only through the injected HostKernel adapter. The existing RepoIntel service,
RepoRead context, registered Location binding and Guard `files.read` remain authoritative.
Contract/schema and RD-017/LS-011 acceptance are updated in §§12.18/17/30/32/37. P1 is
adding source coverage; no tests were run.

The user-approved Core Config→HostKernel launch profile is fully specified at §12.20 and
`contracts-v2/execution-launch-profile-v1.schema.json`. It carries immutable ID/revision,
kind, configured executable selector, literal argv, fixed Location-root cwd and sanitized
environment policy. No interpolation or caller-supplied process fields are accepted. P1
owns typed `execution.v1` prepare/launch/read/write/cancel/status and HostProcessRef/receipt
integration; P2 owns managed intent/reducer and Core/TUI contracts; P4 owns client lifecycle.
Managed verifier, P4 process launch, DAP debuggee effects and REPL remain unavailable until
their respective P1 Guard/confinement/resource prerequisites pass. Whole-phase owners P1,
P2 and P4 are active; P3/P5/P6/P7/P8/P9 await available slots. The implementation-first
hold remains in force; V1 is PARTIAL / NOT RELEASED.

### 2026-10-19 19:38 UTC — active source continuation

The user confirmed the existing trusted Core Config as the immutable LSP/DAP launch-profile
source projected into HostKernel and run through the existing single ExecutionHost supervisor.
P1/P2/P4 are the three active whole-phase owners; P7 is next on actual slot release. P2 now
resolves explicit Core Config selectors to AgentProfileV2 for direct Task child admission and
is extending the same live coding Attempt through verifier effect receipts, typed evidence
and settlement. P2's latest source preserves/resumes only the same active Attempt for a
durable VERIFYING Run when exact verifier, receipt-chain/current-head and no-prior-verifier-
intent/evidence conditions hold; it does not renew the Attempt epoch. P1 must still revalidate
the live lease and recover the exact challenge journal before verifier dispatch.

P1 source reconciles durable direct-profile capacity at HostKernel startup: only a provably
pre-admission missing/empty owner record is abandoned; persisted reservation authority fields
must match the direct Attempt record; mismatch fails startup closed; terminal release is
replayed, while EXECUTING/UNKNOWN stay reserved. The strict execution protocol page decoder
rejects sequence gaps. HostKernel now has typed `protocol_op`, `protocol_read`, and
`protocol_reply` routes that validate process and Attempt scope, workspace revision, and Guard
challenge/lease; each intentionally returns `capability_unavailable` before IO because the
durable operation receipt journal and replay event buffer are not yet implemented, so leases
are not consumed. P4 is aligning its typed client to contiguous replay and fail-closed
quarantine semantics. P1 has now closed the code-mode MCP bypass in source: nested `callTool`
dispatch is removed/denied, the `execute` tool is not registered even when the experimental
flag is enabled, and a fake-client zero-dispatch regression is added but unrun. No
tests/builds/typechecks/audits/probes/performance runs are to start before V1 implementation
source closes. All phases and final release remain PARTIAL / NOT RELEASED. Git ownership
remains mixed; one worktree; C: `/mnt/c` has 60 GB free.

### 2026-10-19 19:43 UTC — process receipt and verifier restart integration

The user's launch profile source is trusted existing Core Config projected into HostKernel and
run only by the existing ExecutionHost supervisor. §37.6 now defines the typed
`protocol_op`/`protocol_reply` receipt ACK: exact process ref, canonical request sequence,
separate IO sequence, operation and receipt digests, durable intent before lease/write, and
durable terminal receipt before acknowledgment. Ambiguous/partial dispatch is UNKNOWN with no
replay. Inbound event sequencing is separate and contiguous. P1/P4 keep these routes unavailable
until the journal and event replay implementation land.

P2 narrowed same-Attempt VERIFYING restart after P1 showed that the current execution receipt
does not retain output bytes or ArtifactRefs: safe preservation is limited to pre-verifier
dispatch at the exact frozen revision, or settlement from already durable typed evidence and
matching artifact/receipt pins. A possible-dispatch crash before evidence stays UNKNOWN with no
redispatch. VEO-018/§37.22 record the artifact durability requirement. No validation runs before
all V1 source implementation closes.

P1 source review additionally found the current HostKernel managed verifier begin/execute
handlers are not wired to P2's Attempt-bound effect/intent/receipt reducer APIs; the broker
authorization has an empty Session and no Attempt scope. P1 owns HostKernel integration and P2
owns the reducer/API. Keep verifier execution unavailable until authenticated Session/Location,
exact Attempt/effect, owner-epoch, current-workspace, reviewer, Guard lease and durable receipt /
evidence bindings cross this boundary.

Parent added the exact receipt machine schema under
`arch_V1/contracts-v2/execution-protocol-receipt-v1.schema.json` and defined canonical
MessagePack digest preimages in §37.6. DAP `threads` uses the existing scoped read-only
`debug.stack` capability; `variables` stays unavailable without adapter-specific passive-read
proof. HostKernel must reject stale persisted Attempt owner epochs before resume and preserve
CANCELLING. P4 replaces the stale raw-child LSP test and adds typed DAP fixtures as source only;
the implementation-first hold still forbids running them.

### 2026-10-19 19:51 UTC — current source continuation

The user confirmed the trusted Core Config→HostKernel LSP/DAP launch-profile projection
through the existing single ExecutionHost supervisor. P1/P2/P4 remain the active whole-phase
owners; P7 is next only when a child slot opens. P1 source now connects HostKernel verifier
operations to P2's Attempt-scoped intent/receipt/evidence reducer calls and stale-epoch
rejection, but `TRUSTED_VERIFIER_ADAPTER_AVAILABLE` remains false. Terminal verifier
output/ArtifactRef reconstruction after possible dispatch is missing and must remain UNKNOWN
without replay. Protocol IO still returns unavailable before write/read until its durable
dispatch journal and event replay buffer are complete.

P1 added canonical protocol operation/dispatch-receipt digest helpers and strict ACK parsing,
but durable journaling, supervisor IO, receipt-before-ACK and replay remain unimplemented.
P4 added typed no-effect LSP/DAP fixtures and Core-side journals for outbound sequence,
receipt/process-IO comparison, response correlation, replay suppression and conflict
quarantine; HostKernel protocol IO and process effects remain unavailable. P2 added a
revision-fenced Goal Run control route, SDK operation and TUI `goal.control` confirmation
path that returns the displayed Goal revision and rejects stale views before CAS. No
test/build/typecheck/audit or provider/performance command may run before all V1 source
implementation is complete. Git ownership remains mixed; keep it unchanged. V1 and every
phase remain PARTIAL / NOT RELEASED.

### 2026-10-19 19:53 UTC — source-only settlement/control update

P1 now source-wires managed verifier evidence followed by exact live-Attempt settlement from
the OwnerLog receipt digest. Workspace drift persists terminal receipts before setting
UNKNOWN. The verifier kill switch remains false. Recovery must reconcile a crash after OwnerLog
settlement but before verifier-journal SETTLED from durable OwnerLog only; a pre-evidence or
pre-artifact crash remains UNKNOWN/no redispatch.

P2's `goal.control` TUI flow now loads the authenticated snapshot and current Run, displays the
Goal revision, sends `expectedRevision`, and consumes a bounded Run status projection. The
server rejects stale view revisions before OwnerLog CAS. Source-only regressions were added,
not run. Implementation-first hold remains; all phases and release remain PARTIAL / NOT
RELEASED.

Parent source review found `managed_execute_verification` returns `VERIFIED` unconditionally,
although the reducer sets RunPhase::Failed when any criterion verdict is FAIL. P1 owns deriving
the response from the durable Run state and adding a source regression. This is an open source
finding; the verifier adapter is disabled and no validation ran.

P4 source additionally validates DAP event-page Attempt/process/workspace scope and event/byte
bounds, advances the process IO pin, rejects skipped cursors, and retains REPL direct Attempt
scope. DAP fixtures are source-only. HostKernel protocol methods remain fail-closed before IO
while P1's durable journal/replay is missing.

Open recovery finding: HostKernel evidence-only recovery omits RunPhase::Cancelling, although
the reducer preserves cancellation during Attempt settlement. P1 owns no-dispatch settlement
reconciliation that preserves CANCELLING; P2 owns truthful response/schema/TUI status. A crash
in this state must not strand durable evidence or trigger redispatch. Source fix pending.

Superseding source update: P1 now reconciles evidence-backed CANCELLING/CANCELLED states,
validates the exact settled receipt digest and maps truthful verifier statuses. A prior epoch is
accepted only for evidence-backed settlement reconciliation; stale unresolved Attempts become
UNKNOWN. P2 still needs TypeScript schema/SDK/TUI cancellation status parity. P1 also applies
JavaScript safe-integer bounds to DAP request IDs. P4 added duplicate-ACK receipt idempotency,
conflict quarantine, bounded receipt history, inbound cursor fencing and event/byte bounds.
HostKernel dispatcher/replay IO remains absent; source-only and unverified.

P2 has aligned the GoalVerification response schema, SDK types and TUI status messages for
CANCELLING/CANCELLED/FAILED with P1's HostKernel status mapping. Source-only, unverified.

### 2026-10-19 20:01 UTC — managed prompt scope and phase ownership

P2 source inspection found no production ManagedAttemptScope entry into Core prompt/ToolBatch:
managed control can plan/admit, but prompt execution accepts only direct Attempt authority. P2
owns the typed scope path in `session/prompt.ts`, `session/managed-control.ts`, and its route/UI
caller. P1 retains exclusive ownership of `session/tool-batch.ts`, Guard client and HostKernel
ingress and will integrate the scope there. The agreed envelope binds Goal/Run/Task/Attempt,
owner epoch, expected managed revision, Location/Session, workspace revision and delegation
binding digest. All caller-provided pins must be checked against authenticated durable state;
the envelope does not confer authority. No effects are enabled by P2 caller plumbing alone.

P1/P2/P4 remain active whole-phase owners in all three available child slots; P7 is next on an
actual slot release, followed by the remaining queued phase owners according to dependencies.
The implementation-first hold remains active. No verification command ran. Git remains mixed on
`main`, 12 ahead, and C: via `/mnt/c` has 60 GB free. V1 remains PARTIAL / NOT RELEASED.

### 2026-10-19 20:03 UTC — Attempt-bound lease revision cycle closed by contract

P1/P2 found that direct and managed Attempt scope digests include the current aggregate owner
revision, which advances when ToolBatch effect edges are bound. To preserve the exact lease
fence, the normative order is now Guard evaluation and explicit approval → atomic binding of
the complete exact Attempt effect set → HostKernel refreshed-scope/current-state validation →
one-use lease issue bound to refreshed scope plus exact edge/intent. A pre-bind challenge is
provenance only and may transition exactly once before a lease exists; even ALLOW defers lease
issue. No issued lease is mutable and no caller rebase is accepted. VEO-019 covers stale/raced
revision, duplicate bind, cancellation/restart and lost refreshed-scope outcomes. This applies
to direct and managed Attempt effects. Parent recorded the contract in §§14.3, 17.15, 32.38 and
37.22.

P2 reports CODE_PRESENT source for typed ManagedAttemptScope propagation through managed-control,
prompt and LLM, plus bounded atomic `BindAttemptEffects` reducer support. P1 retains exclusive
ToolBatch/`tools.ts` and HostKernel lease integration. No checks ran. Implementation-first hold
and PARTIAL / NOT RELEASED remain.

### 2026-10-19 20:05 UTC — managed admission ownership

P2's source review confirms production HostKernel `managed_admit` still returns
`capability_unavailable`: complete authenticated DelegationBinding/owner proofs are missing.
P1 accepted this HostKernel implementation (including exact Task profile pin and host-issued
managed scope); P2 owns Core/TUI caller and strict projection. Scope propagation through
managed-control/prompt/LLM and the atomic bounded reducer command are CODE_PRESENT, not an
end-to-end path. P1 owns ToolBatch/EffectHost sequencing and the post-bind lease boundary. P2
must obtain a fresh host-issued scope after each OwnerLog mutation. Managed effects remain
disabled; no tests/builds/typechecks have run.

### 2026-10-19 20:07 UTC — P8 prerequisite and P4 adapter source delta

P1 identified that `ManagedDelegationAdmissionFactsV1::from_owner_proofs` requires authenticated
Attempt/profile/context proofs, active parent WorkerExecution lineage, a durable P8 worker
lease and a Guard effective-capability ceiling. The current HostKernel has no producer for the
worker lineage/lease facts, and `open_worker_owner` keeps fan-out closed; P1 will not invent
proof from caller input. P8 is now a direct prerequisite for P1 managed admission/P2's vertical;
P7 artifact APIs remain needed for independent verification. P1 continues its independent
Guard work and will define the host interface needed from the next whole-phase P8 owner.

P4 added method-bounded DAP adapter source and hardened LSP transport sequencing, retained
Attempt scope, response-listener ordering and fail-closed request behavior. Process launch and
REPL effects remain unavailable pending P1 protocol/supervisor/confinement; OS quotas remain a
REPL prerequisite. No validation ran. P1/P2/P4 remain active; P8 and P7 are prioritized for
actual slot releases according to these blockers. V1 remains PARTIAL / NOT RELEASED.

### 2026-10-19 20:10 UTC — P8 active and managed root-execution contract resolved

The whole-phase P8 worker/resource/worktree owner `p8_worker_resources_full_1019` is active in
one of the three actual child slots alongside P1 (`p1_guard_full_resume`) and P2
(`p2_managed_wave2_1019`). P4 has returned its source-only adapter package and is PARTIAL pending
P1's Guarded supervised process/IO/replay/confinement path and unsupported OS quota boundaries.
P7 is queued for the next real slot because P2's independent verifier requires immutable
ArtifactStore output/evidence APIs.

Parent resolved the missing parent of the first managed Task: `DelegationBindingV1.parentExecutionID`
uses a durable Rust logical root-coordinator `WorkerExecutionId` bound to the authenticated
existing Core Session/Run, OwnerLog and fenced Core transport/process incarnation. It is lineage
for the existing Core coordinator, not a second runtime, transcript or spawned process. The
current Attempt owns its own P8 RESERVED lease; shared Core process measurements are counted
once and no separate root-worker quota is claimed. Nested children continue to require an active
claimed parent WorkerExecution. P8 pins pre-admission Attempt/profile/context/Spec/workspace facts
in the RESERVED lease; P1 atomically persists the binding and lease refs, then P8 attaches the
exact binding digest before claim/dispatch. If identity/incarnation is unavailable, admission
fails closed. This ruling is recorded in arch_V1 §§12.18, 17.16, 29.5, 37.22 and VEO-021.

P2 confirmed its `ManagedAttemptAuthority` helper had no production caller and no actual
prompt/LLM scope propagation. It is now adding the missing generated SDK operation for the
existing `goal.plan` TUI caller and a trusted `promptManaged(input, authority)` entry; it reports
P1 has supplied typed profile/context admission fields and owner-derived scope. This path is
still being wired, not acceptance evidence. P1 and P8 have the root proof/lease sequence and
exclusive file boundary. No tests/builds/typechecks/audits/provider probes/benchmarks ran.
Git remains mixed and untouched; C: via `/mnt/c` last showed 60 GB free. No cleanup/prune.
V1 remains PARTIAL / NOT RELEASED.


### 2026-10-19 20:13 UTC — launch-profile decision and direct receipt dependency

The user confirmed the V1 LSP/DAP launch-profile source: project the existing trusted Core
configuration into HostKernel, resolve the immutable profile there, and execute only through
the existing ExecutionHost supervisor. Do not accept caller-selected executable/argv/process
fields or introduce a second supervisor. P1 owns the authenticated projection and Guarded
launch path; P4's LSP/DAP adapters remain unavailable until the supervisor, confinement and
protocol receipt/replay prerequisites are implemented.

P1's active source review found that Rust `DirectAttemptControl` currently persists admission,
exact effect-intent binding and terminal status, but lacks durable per-effect receipts and
per-receipt workspace-head revisions. This prevents safe direct-child multi-effect dispatch
and scope refresh after workspace mutation. P2 now owns adding the direct Attempt receipt/head
owner-log command with exact effect/intent linkage, replay/conflict handling and UNKNOWN
recovery; P1 owns HostKernel/EffectHost integration, receipt validation, lease sequencing and
fail-closed dispatch. This boundary is source work only; no tests/builds/typechecks/audits ran.

P1, P2 and P8 remain the three active whole-phase owners. P7 is next after an actual slot
release; P3/P5/P6/P9 remain queued. The implementation-first hold remains active. Git state is
mixed and preserved; no stage/commit/push/cleanup was performed. C: via `/mnt/c` has 60 GB free.
V1 remains PARTIAL / NOT RELEASED.


### 2026-10-19 20:13 UTC — pre-approval bind ordering gap

P1 source review found ToolBatch PREPARE currently binds Attempt effect edges before the Core
approval decision, violating the approved lease order. P1 is moving the atomic bind to the
post-approval resolution path (or immediately after an unchallenged Guard ALLOW), retaining the
pre-bind scope only as challenge provenance. The HostKernel must then return the refreshed scope,
revalidate the exact effect set/current workspace and issue a lease against that refreshed scope.
No Attempt mutation occurs before a required approval; retries remain idempotent and stale/cancelled
requests fail closed. Source fix is in progress; no tests or checks have run.


### 2026-10-19 20:14 UTC — approval ordering also covers managed effects

Parent source review found `managed_bind_attempt_effect` accepts `awaiting_approval` and writes
`BindAttemptEffect`, so the same PREPARE-before-approval mutation may exist on the managed
per-effect path. P1 is tracing and correcting both direct batch and managed per-effect callers
under the common §14.3/VEO-019 order: challenge/provenance first, approval if required, complete
exact binding, refreshed scope/revalidation, then one-use lease. Verifier immutable intent
handling must follow its specific contract without mutating the Attempt before approval. This
is an open source finding assigned to P1; no checks ran.


### 2026-10-19 20:40 UTC — user decision and implementation roster

The user chose a distinct authenticated goal.start after accepted SpecVersion. The normative Goal path now keeps goal.plan effect-free, persisting a non-dispatchable PLANNED Run with pinned Tasks; goal.start makes an atomic, revision-fenced, idempotent PLANNED→RUNNING transition and readies dependency roots for the exact accepted SpecVersion/Goal revision. Start alone creates no Attempt/effect authority. P2 owns full Rust/Core/API/SDK/TUI implementation. VEO-023 covers stale/unauthorized/spec-swap/replay/idempotency and no-dispatch cases. Architecture references: §§3.4, 17.18, 32.38, 37.22.

Active whole-phase children: P1 p1_guard_v1_resume_1020; P2 p2_managed_v1_resume_1020; P7 p7_stream_artifacts_v1_1020. P1/P2 have an agreed exclusive boundary for managed reducer versus HostKernel and are coordinating P2's observation_digest receipt schema. P2's durable recovery UNKNOWN fix is source-only. P7's targeted per-path checkpoint recovery preview is source-only; reset refusal and effectful restore remain disabled. P8 is queued after prior agent exit; P3/P4/P5/P6/P9 remain queued or partial.

Implementation-first hold remains; no validation commands. Git state remains mixed, one worktree, and preserved. C: via /mnt/c has 60 GB free. V1 is PARTIAL / NOT RELEASED; implementation, then final-revision verification/acceptance/release remain.



P1 and P7 aligned on checkpoint filesystem facts: P1 owns a typed descriptor-relative no-follow HostKernel per-path observation (path, kind, link count, digest, size, executable) with race checks; P7 consumes it through the existing workspace boundary, never a parallel reader. Restore remains unavailable until the host facts and Guarded dispatch exist. Selected-path recovery accepts only conflict-free captured regular files with one link; full reset after later commits stays refused. Normative preview contract and CP-001/CP-002 were updated in §§14.19, 16.18 and 32.


### 2026-10-19 20:44 UTC — source-only managed and checkpoint deltas

20:44 UTC source delta: P2 has added reducer source for atomic PlanRun, new RunPhase::Planned, and StartPlannedRun (RUNNING plus dependency roots READY); its Core plan path and authenticated HTTP goalRunStart handler are being wired. P1 owns the HostKernel plan_run/start_planned_run routes and must reject Planned from all dispatch/admission/control paths. P2 also changed direct receipt persistence to use observation_digest and persist recovery UNKNOWN. P1's typed descriptor-relative no-follow HostKernel workspace observation now carries path, kind, link count, digest, size and executable, with single-link rejection and race checks. P7's checkpoint manifest/preview now requires those trusted file facts; selected-path preview remains blocked until authenticated dirty/untracked status is complete and restore stays disabled.


Checkpoint preview provenance correction: the current trusted source compares workspace revision digests, not Git commit ancestry. The preview field is therefore workspaceRevisionChanged, not laterCommit. Full restore is refused on any revision change; no Git commit provenance is claimed. P7 renamed the source field and uses the same name in the projection. P1 received the private no-follow preview/recompute route contract from P7; VCS dirty/untracked status remains required before selected-path preview can expose actions.


### 2026-10-19 20:45 UTC — planned-run authority pins

P2 confirmed the planned-run reducer recomputes the canonical Task-set digest at goal.start and persists it in the start event; the operation body has no task/profile input. PLANNED rejects scheduler/admission/pause/resume and can be safely cancelled without creating effects. The user-facing API/TUI/SDK journey remains in progress; P1 owns HostKernel routing.


Additional P7 capture gap: current capture_guarded can accept snapshot bytes unrelated to the observed file manifest. P1 now owns a bounded opaque snapshot bundle minted by the same descriptor-relative no-follow traversal/race check, binding exact file bytes and manifest to the observed revision. P7 may persist only that bundle; capture/preview/apply remain unavailable until it exists. This is now normative in §14.19.


Cross-phase parent review found legacy HostKernel managed start_run/add_task ingress remains beside the new planned-run path. P1/P2 are coordinating fail-closed disablement/replay-only compatibility so no legacy call can create a dispatchable Run outside exact PLANNED + authenticated goal.start. VEO-023 now covers both ingress paths.


Attempt-bound ToolBatch design is now explicit in §14.3: approve and bind the full exact set before first dispatch, then issue/consume one lease at a time. A successful settled receipt and correlated refreshed scope are required before leasing the next member; failure/UNKNOWN/missing/mismatch fences the remainder. P1 is implementing the HostKernel/Core API expansion under the already authorized P1 scope; VEO-019 now covers this sequence.


### 2026-10-19 20:52 UTC — trusted checkpoint capture bundle consumed

P1 has added the bounded `TrustedWorkspaceSnapshotBundleV1`, minted from the same descriptor-relative no-follow traversal that derives the workspace revision and file manifest. P7 now makes checkpoint capture consume only that opaque bundle, derives file records and manifest digest from it, and persists its serialized bytes instead of request-supplied bytes. `CHECKPOINT_CAPTURE_ENABLED` remains false until P1 completes and the parent reviews authenticated Guarded HostKernel wiring; preview actions still require authenticated VCS dirty/untracked facts, and restore apply remains unavailable. This is source progress, not acceptance evidence. No tests/builds/typechecks/audits/probes/benchmarks ran. P1, P2 and P7 remain active whole-phase owners; V1 remains PARTIAL / NOT RELEASED.


### 2026-10-19 20:53 UTC — runtime route gaps and serial lease implementation

P7's source review found the remaining runtime boundaries explicitly: HostKernel still lacks AutomationServiceV2 and checkpoint snapshot-preview routes; Core/TUI lacks automation list/edit/history; guarded checkpoint restore and artifact eviction adapters plus receipt recovery are absent. P1 now owns the HostKernel/Guard routes and is implementing `effects.v2/lease_next_batch_effect`: HostKernel chooses the next exact Attempt-bound intent from durable ordered state, requiring a successful prior receipt and current observed workspace head before issuing one lease. Approval binds the full set before the first dispatch; Core must execute sequentially and request each later lease only after the prior receipt settles. P2 owns canonical managed Core/API/TUI control; P7 continues replay/render/artifact source work. These dependent effects remain unavailable until their authority, receipts and recovery are wired. No checks have run.


### 2026-10-19 20:56 UTC — explicit managed start reaches the TUI

P2 reports the TUI now obtains a trusted Goal snapshot, derives current Goal revision and accepted SpecVersion ID/digest, requires a `PLAN_ONLY` Run, then calls `goalRunStart` with only Goal/Run/idempotency and surfaces returned phase/revision or conflict. Core's legacy `startRun`, `addTask` and `markTaskReady` exports/service methods have been removed. SDK snapshot fields and fixtures remain in progress. No checks have run; this is source status only.


### 2026-10-19 20:57 UTC — Goal snapshot pins and automation control source

P2 has added accepted SpecVersion and per-Run `specID` fields to the Goal review snapshot projection and updated generated SDK response shapes, completing the source data needed by `goal.start`. A TUI regression fixture now covers deriving the accepted SpecVersion/revision from the trusted snapshot and sending the start request; it has not been run. P2 is moving to Core/API/TUI automation list/edit/history while P1 defines the HostKernel route and response bounds. C: last checked at 59 GB free (88%); Git remains mixed (150 staged, 235 unstaged, 173 untracked; no conflicts) and untouched.


### 2026-10-19 20:58 UTC — incomplete direct receipt cancellation fence

P2's source audit found direct `Cancel` can currently mark an Attempt CANCELLED while bound effects have no terminal receipts, and P1's HostKernel path can release its terminal slot. A batch cancelled after a successful prefix also needs a typed durable proof that all remaining intents were unleased/revoked. Cancellation without that proof must become UNKNOWN and retain/fence the slot until reconciliation; cancellation proven before dispatch can be terminal. P2 is tightening reducer receipt-chain semantics and P1 owns HostKernel cancellation/slot handling. This is source-only; no tests or validation run.


### 2026-10-19 21:00 UTC — renderer bounds and lease replay gap

P7 has source changes to clip raw renderer input before sanitization, cap aggregate rendered output with inert-source fallback and truthful FAILED fidelity, validate stream envelope seed advances correctly, and bound artifact-reference metadata before text encoding. No tests/builds/typechecks ran. Parent source review of P1's new `lease_next_batch_effect` found a lost response could strand an issued next lease because retry rejects an existing lease digest; P1 has been asked to return the same authority safely or reconcile an unconsumed lease after restart, and to define exhaustion behavior. P7 confirms checkpoint preview/VCS facts, guarded restore/eviction and HostKernel automation routes remain open source work. C: last checked at 59 GB free.


### 2026-10-19 21:02 UTC — parser and replay bounds tightened

P7 now caps completed artifact source at 16,384 lines before split/parser allocation and returns inert source with FAILED fidelity above 512 KiB rendered output. Oversized replay deltas request a canonical resnapshot rather than direct delivery; invalid cursors are not forwarded as trusted resnapshot IDs. ArtifactRef metadata is checked against a 4 KiB limit before trimming/allocation. All are source edits only; no tests/builds/typechecks ran. P1 still owns authenticated checkpoint preview/capture, same-boundary VCS status, Guarded restore/receipt reconciliation and AutomationServiceV2; P2 owns automation control API/TUI. P7 keeps these effect paths closed pending those contracts.


### 2026-10-19 21:04 UTC — P8 resumes as whole-phase owner

P7 returned PARTIAL after completing its independent renderer/replay source work; its remaining runtime routes and evidence are blocked on P1/P2. The freed child slot is now assigned to `p8_resources_workers_full_resume_1019` for the entire P8 resources/workers/worktree/RC0 phase. P8 owns its durable worker, worktree, resource and RC0 modules; P1 owns HostKernel/Guard integration and P2 owns managed-control/Core integration. P8 must continue independent work, coordinate exact proof/lease boundaries, and keep fan-out unavailable pending verified P1/P2 prerequisites. Active child roster: P1, P2, P8. No validation commands have run.


### 2026-10-19 21:08 UTC — managed TaskTool caller dependency

P2 source review found no production caller for managed Task execution: `TaskTool` admits only DirectAttempt and calls `ops.prompt` with direct authority; `promptManaged`/`ManagedAttemptAuthority` are not yet wired. P2 cannot safely add the managed dispatch adapter until P8 supplies the authenticated scheduler-to-Core proof/handoff and P1 provides the HostKernel admission/Guard boundary. P8 has been asked for the exact proof, reservation, delegation binding, digest attachment, dispatch, cancellation and recovery sequence; P2 continues independent automation/reviewer/verifier/UI work. Managed effectful execution and worker fan-out remain disabled.


### 2026-10-19 21:12 UTC — managed admission ordering settled

The §12.18/§37.22 ordering is now explicit in §37.22 and §17.18: HostKernel mints opaque `TrustedPreAdmissionPinsV1` from authenticated current Ready Task/Spec/profile/context/Guard/workspace/budget/parent facts; P8 durably reserves and returns `ReservedWorkerLeaseProofV1`; P1 atomically appends Attempt + DelegationBinding + exact refs; P8 attaches the binding digest; then authenticated one-use `managed.claim_dispatch` returns `ManagedDispatchHandoffV1` to Core TaskTool. Crash/lost response remains RESERVED/UNKNOWN until OwnerLog reconciliation; no timeout release or automatic relaunch. P1/P8 are implementing this boundary; P2 consumes the opaque handoff when available and continues independent P2 source work. Managed dispatch stays unavailable until the full chain is present.


### 2026-10-19 21:15 UTC — automation owner and storage boundary

P1 has supplied the strict `automation.v1` operation set and P2 has added the Core RPC adapter plus typed HTTP handler using trusted principal and registered Location. Parent settled the HostKernel owner boundary in §37.10: Rust persists only under private `state_dir/automations/`, scoped by authenticated owner binding plus registered Location/workspace; no request path or Session-only persistence. List/create/update CAS require a bounded Rust-owned registry in addition to per-definition occurrence journals. `run_now` stays unavailable until Guarded invocation and receipt recovery exist. P1 owns the HostKernel route; P7 owns the Rust registry/journal; P2 owns the SDK/TUI path. No checks have run.


### Active source checkpoint — Goal start and automation

User-selected managed-start contract: accepted SpecVersion → persisted complete PLANNED Run →
explicit authenticated `goal.start`; start is idempotent/revision-fenced and grants no Attempt or
effect authority. P2 has source for the Core/API/SDK/TUI path; final Rust routing and acceptance
remain open. Parent source review found P2 automation response mismatches, which it corrected;
Core `runNow` now refuses locally with CAPABILITY_UNAVAILABLE before issuing an RPC. P1 must
keep Rust `run_now` unavailable before scheduling or Guard. The Rust bounded registry/index is P7
owned, while P1 progresses remaining P1 work and coordinates the typed interface. P1, P2 and P8
are active. Implementation-first hold remains: no verification commands have run.


### Active source checkpoint — managed dispatch fence and DAG planning

P8's source now exposes the durable `ClaimedWorkerDispatchProofV1` facts (Attempt/worker IDs,
binding and pins digests, OwnerLog ID/sequence/event digest, pool revision and stable claim
nonce); P8 confirms this is a separate log from managed control. Parent arbitration therefore
assigns the no-replay `ConsumeManagedDispatch` marker to the canonical managed-control OwnerLog:
P1 authenticates and invokes it, P2 owns the reducer event, and P8 owns the durable one-use claim
proof. No cross-log atomicity is assumed. Core persists the exact consume receipt and pending
prompt state before provider dispatch; ambiguous restart is UNKNOWN/no automatic retry. §§17.18
and 37.22 now record this contract.

P2 also removed the single-Task/one-criterion plan ceiling and now builds bounded 1–64 Task DAGs,
validates exact criterion coverage, dependency membership/cycles, and pins each AgentProfile
revision. This is source-only. P1/P2/P8 remain active; no tests/builds/typechecks/audits/probes/
benchmarks have run. V1 remains PARTIAL / NOT RELEASED.


### Active source checkpoint — durable handoff/restart work

P1 has changed post-dispatch missing or malformed write/patch response and receipt handling to
best-effort persist UNKNOWN and return uncertainty, rather than surfacing a validation error that
could invite retry. P1 is reviewing cancellation/reconciliation branches and wiring the managed
consume route. P2 owns the typed `ConsumeManagedDispatch` reducer event in ManagedControl; P1
validates the live P8 claim and calls it. P8 now records exact pre-admission RESERVED worker IDs
in restart/owner-epoch recovery events so they do not timeout-expire across the P1 admission
window; CLAIMED/RELEASE_PENDING remains quarantined. These are source changes only. P2's bounded
1–64 Task DAG plan source is present and profile-pinned. P1/P2/P8 remain active, with all
validation still deferred.


### Active source checkpoint — authenticated Core peer identity

P1 source review found HostKernel request context currently retains owner epoch and negotiated
process-incarnation string but not the OS-authenticated Core PID/start identity. `unix_peer.rs`
validates SO_PEERCRED and executable identity, but the identity is dropped before request
routing. Parent assigned P1 to propagate a private typed listener-to-HostKernel context carrying
PID/UID/GID, executable identity and process-start identity, bound to the negotiated incarnation;
these facts must never come from RPC bodies. Missing identity keeps managed root admission
unavailable. §§17.18/37.22 now record the rule. This is source work only; no tests/builds/
typechecks/audits/probes/benchmarks have run.


### Active source checkpoint — durable candidate renewal (2026-10-19)

P8 is adding an opaque `PreAdmissionReconciliationReceiptV1` reconstructed from its exact
durable EXPIRED tombstone event. It binds NotAdmittedNoDispatch, exact candidate worker/ticket/
Attempt and pins, P8 OwnerLog cursor, pool revision, and reconciliation/receipt digests. P2 owns
the private idempotent `AbandonPreAdmissionCandidate` reducer transition and persisted Task
generation; P1 validates P8's opaque receipt and derives a fresh deterministic candidate from
Task ID + persisted generation. P8 enforces candidate Attempt uniqueness; tombstoned IDs cannot
be reused and generation advance grants no dispatch authority. P1 reports private listener-only
Unix peer identity fields plus live PID/start/executable validation; its hello/fence relation
still needs an explicit source comment. P1 source-repaired the partial-prefix cancellation
predicate, with phase completion ongoing. No validation commands have run.
Candidate identity binds Task ID plus durable `attempt_count` and `candidate_generation`:
admission increments the first counter, while only a verified pre-admission tombstone increments
the second. P2 CASes both in the abandonment proof/event/receipt; P1 includes both in immutable
reservation pins and derives the candidate from this tuple, preventing collisions after admitted
retries.
Candidate tombstone proof and receipt use typed P8 disposition/reservation enums with strict
persisted-event decoding. P8 removed an invalid comparison of worktree base-revision locator to
measured workspace content revision; both remain distinct immutable pin values (§§21.11/37.22).
No validation ran.
Candidate identity was refined to include both `Task.attempt_count` and
`Task.candidate_generation`: successful admission advances attempt count; only a verified
pre-admission tombstone advances candidate generation. P2 CASes both in the abandonment
proof/event/receipt, and P1 pins both before deriving IDs. This makes admitted retries unique.


### 2026-10-19 — candidate renewal integration checkpoint (source only)

P8 now exposes durable reconciliation-receipt lookup by candidate Attempt ID for exact `NotAdmittedNoDispatch` + `EXPIRED` tombstones. P1's authenticated `managed.reconcile_pre_admission_candidate` accepts only Goal/Run/Task selectors, derives identity from persisted Task `attempt_count` and `candidate_generation`, validates current accepted SpecVersion/profile/SessionLink/Location/workspace plus authenticated Core peer and ServerAuth/no-process state, and supplies P2 the opaque P8 receipt. P2 recomputes the candidate and CASes both counters on the exact READY Task under managed revision and delivery idempotency. P8 validates uniqueness and distinct workspace-content/worktree-base revision pins. This source path creates no Attempt or dispatch authority.

Implementation remains in progress for whole phases P1/P2/P8; P1 managed admission/claim/consume and P2 production managed TaskTool dispatch still depend on P8 durable proofs and canonical P2 consume integration. P3/P4/P5/P6/P7/P9, final integration and release remain open. No tests/builds/typechecks/audits/probes/benchmarks were run.


### Active source delta — candidate replay and dispatch fence

P1 now consults P2's exact `candidate_abandonment_receipt(delivery_id)` before deriving the current candidate generation. Replay still revalidates authenticated ServerAuth, Goal/registered Location/workspace, then matches P8's opaque `NotAdmittedNoDispatch` + `EXPIRED` receipt and the exact Task counters, pins, worker/ticket, and receipt digest before returning the durable result. P2 also added an exact `managed_dispatch_consumed_receipt(attempt_id, delivery_id)` lookup; P1 has been asked to use it before any P8 lookup or candidate dispatch proof reconstruction. Source only; no tests/builds/typechecks/audits have run.

P2 confirms `TaskTool` remains fail-closed for managed attempts because HostKernel `managed.claim_dispatch` / `managed.consume_dispatch` are not yet wired. `goal.start` is mounted through the goal-review handler; SDK/TUI source includes automation controls, while `run_now` remains unavailable. P1/P2/P8 continue as whole-phase owners; the managed child dispatch dependency remains open.


### Source decision — managed lease inputs (2026-10-19)

Resolved P1's request for implicit admission defaults from the existing owners: trusted inputs come from the authenticated accepted SpecVersion, the Task-pinned AgentProfileV2, and P8's durable pools. Each Attempt reserves one `ActiveWorkers` unit bounded by both WorkerPool `max_live_workers` and Spec `max_workers`; this is admission accounting, not an OS quota. CPU/memory/disk/FD are measurement/backpressure only unless OS enforcement is proven; unsupported explicit memory/disk guarantees remain unavailable, and no synthetic quotas are created. P2 must persist trusted `goal.start` time so Attempt expiry can use remaining Spec `max_run_duration_ms`; profile `limits.wallTimeMs` further bounds it when present; the existing 24-hour lease ceiling applies, and expiry never releases a lease. P8 supplies worktree ID/base locator only from eligible clean durable registrations; HostKernel's content digest stays a separate pin. Missing eligible worktree or unknown required capacity keeps admission unavailable. Architecture decision recorded in §17.19 and implementation contracts in §§21.11 and 37.22. Source-only; no validation run.


### Source delta — persisted start time and lease resolver (2026-10-19)

P2 now derives `Run.started_at_ms` from the canonical OwnerLog envelope `time_ms` for `planned_run_started`; replay reconstructs the same value. HostKernel's `goal.start` response projects that trusted time, and the managed owner exposes remaining accepted Spec duration; this timestamp is not request supplied. P1 corrected its caller to keep `start_planned_run` timestamp-free and will require a positive trusted remaining duration when deriving child lease expiry. P8 is implementing `resolve_managed_worktree` from its durable registration owner and correcting the distinct Task revision / workspace content digest / worktree base-locator pins. P8 must also project trusted ActiveWorkers capacity from pool limits; CPU/memory/disk/FD stay monitoring unless OS enforced. Source only, no checks run. Managed admission/claim/consume remains absent; TaskTool stays fail-closed.


Architecture synchronization: §03.4 now describes lease limits and worktree source; §04.2/4.3 bind Run duration to the durable OwnerLog envelope timestamp; §12.1 exposes Run.startedAtMs as a derived projection. These reflect the current P2 source direction and settled §17.19 policy; still unverified.


### Managed child runtime boundary decision (2026-10-19)

Resolved P1's question from §17.18/§37.22 and the existing Core TaskTool seam: managed children run as logical Core Session/Task/Attempt inside the existing Core process; V1 does not launch a second model-host executable. The immutable Core Config AgentProfileV2 selects model/harness and child policy. P8 WorkerExecution is lineage + resource/worktree lease identity, not spawn authority. Shell/process effects still pass through the single P1 Guard/ExecutionHost. LSP/DAP executable-profile projection is a separate P4 contract. This is recorded in §17.20, §03.4/§03.5 and §37.22. No checks run.


### Active managed-admission source delta (2026-10-19)

P8 now exposes an admission-only `DurableManagedLeaseProofV1` purpose tagged `PreAdmissionReserved`, built from exact immutable pins and current RESERVED OwnerLog proof with no attached binding/process authority. The separate post-append resolver requires purpose `AttachedAttempt`. P8 also added the durable registered-clean-worktree resolver and one-ActiveWorkers capacity projection bounded by pool `max_live_workers` and Spec `max_workers`; base locator remains distinct from measured workspace digest.

P1's HostKernel `managed_admit` source now follows authenticated profile/context/current Task checks → root peer proof → P8 worktree/reserve → P2 atomic Attempt+DelegationBinding → P8 binding attachment → post-append attached proof. This is CODE_PRESENT only. Parent identified a required exact admission-response replay before P1's current revision/READY checks; P2 is adding a delivery-keyed receipt lookup and P1 must revalidate current auth/workspace/P8 attachment before returning it. Managed `claim_dispatch` / `consume_dispatch` and Core TaskTool handoff remain open. No tests/builds/typechecks/audits/provider probes have run.


### 2026-10-19 — managed claim profile digest boundary (source only)

Core resolves the Task-pinned AgentProfileV2 definition from trusted Config and sends that exact
content with authenticated managed claim and consume requests. HostKernel recomputes the canonical
Rust definition and permission-ceiling BLAKE3 digests and compares them to the durable Task,
DelegationBinding and P8 pins before prompt dispatch; Core does not duplicate Rust's MessagePack
digest implementation. The contract is recorded in arch_V1 §§17.21 and 37.22. P1 owns HostKernel
validation and sampling route; P2 owns Core request parsing/calls and the reachable TaskTool prompt
path; P8 owns durable resource/worktree/worker state and authenticated Core resource measurement.
P1 has source for admission-receipt replay before stale revision checks and revalidates current
root/process/workspace/P8 attachment. Parent review asked P1 to compare permission-ceiling digest
to the durable P8 pin and remove a duplicate workspace-binding predicate. P1/P2/P8 remain active;
P3/P4/P5/P6/P7/P9 plus integrated acceptance/release remain open. No tests/builds/typechecks/
audits/probes/benchmarks have run by user direction. Preserve mixed Git state; no stage/commit/push.
C: last checked using /mnt/c has 59 GB free. V1 remains PARTIAL / NOT RELEASED.


### 2026-10-19 — managed dispatch adapter and recovery boundary (source only)

P1 now has HostKernel source for authenticated `managed.claim_dispatch` / `managed.consume_dispatch`, exact
admission-receipt replay before stale revision checks, profile definition/permission digest
revalidation against durable Task/DelegationBinding/P8 pins, and consume-receipt replay that
revalidates current authenticated owner, root/process identity, workspace and P8 binding. Handoff
numeric fields use canonical decimal strings across Core IPC. Parent review confirms admission
replay checks exact profile permission-scope digest and a single workspace-binding predicate.
P8 added authenticated Core-process sampling separately from worker-tree measurements and is
implementing an exact replay resolver for a claimed P8 lease after a lost claim response; claimed
work remains fenced if proof/process/cancellation/epoch facts are ambiguous. P1 owns the HostKernel
sampling route only where an existing architecture owner supports it; no new public endpoint is
assumed.

P2 added typed Core claim/consume adapters that resolve the exact trusted AgentProfileV2 and send
its definition for Rust digest validation. P2 has resumed whole-phase work: the production
scheduler-to-TaskTool caller and durable prompt-pending/restart state remain absent. Rust
ManagedControl/OwnerLog remains the canonical scheduler; Core may only execute Rust-selected
bounded ready Tasks inside the existing root Session/TaskTool path. Task selectors cannot come
from model/tool arguments. Exact consume must be persisted before provider dispatch; crash after
possible provider invocation becomes UNKNOWN with no automatic repeat. P2 continues the complete
reviewer, effect intent, live workspace revision, verifier evidence and Goal/TUI/recovery work.

P1/P2/P8 are active whole-phase owners. P3/P4/P5/P6/P7/P9, cross-phase acceptance and release
remain open. The implementation-before-validation hold continues: no tests, builds, typechecks,
audits, provider probes or benchmarks have run. Git remains mixed and untouched; no stage/commit/
push. C: last checked through /mnt/c has 59 GB free. V1 remains PARTIAL / NOT RELEASED.



### 2026-10-19 — Rust-selected managed Task and child Session boundary (source only)

P1 added a bounded authenticated `managed.next_schedulable_task` projection using canonical Rust
ManagedControl selection. It returns the exact candidate Attempt counters/profile pin and bounded Goal/
Spec/criterion context; Core does not select Task authority. P1 is separating `parentSessionID`
(Run SessionLink/root coordinator) from `sessionID` (durable Task child Session) through admission,
P8 pins and handoff. P2 has typed claim/consume Core adapters and resumed whole-phase work to
connect the Rust-selected candidate to existing TaskTool/promptManaged with a durable child Session
and prompt-pending record. Each Task gets a distinct child Session parented to the Run root; model
or tool arguments cannot choose Task/Attempt/session IDs. P8 is adding an exact durable WorkerClaim
receipt/resolver for lost claim responses; no process dispatch follows merely from replaying it.
These decisions are recorded in arch_V1 §§17.20–17.21 and 37.22. P1/P2/P8 remain active; P3/P4/P5/
P6/P7/P9, cross-phase acceptance and release remain open. User-directed implementation-only hold
continues: no tests/builds/typechecks/audits/provider probes/benchmarks. Git mixed and untouched; no
stage/commit/push. C: last checked via /mnt/c has 59 GB free. V1 remains PARTIAL / NOT RELEASED.


### Active dependency decision — Run root Session binding

`goal.start` now has an approved interface extension: it carries the active top-level Core Session
ID. Core verifies the persisted Session's authenticated principal, project, workspace and Goal
relationship before forwarding. Rust pins that SessionLink in the same explicit start transition
and includes it in exact retry fencing. HostKernel performs authenticated P8 root-coordinator
registration before any scheduler/admission can proceed; failure leaves execution unavailable.
The start transition still grants no Attempt or effect lease. P1 owns ingress/HostKernel, P2 owns
reducer/API/Core/TUI, and P8 owns root registration/recovery. Source integration remains active.
Implementation-only hold remains; V1 is PARTIAL / NOT RELEASED.

Resource-sampling boundary (corrected): P8's sampler is Attempt-scoped telemetry/backpressure,
not admission authority. ActiveWorkers capacity is durably accounted in Rust against pool/Spec
limits. Do not sample before admission or turn unknown optional telemetry into denial. No public
resource wire operation before §12.16 ResourceSnapshot schema; diagnostics remains unavailable.

P8 source checkpoint: worktree journal recovery now permits an intent-only operation to resume,
but a durable `worktree_dispatch_started` marker recovers as UNKNOWN and cannot redispatch. Safe
release requires same-root clean pre-delete evidence, post-delete MISSING, and no dirty or
user-owned changes; legacy receipts without pre-release evidence are history only. P8 remains
active for whole-phase work; no checks run.

P8 found raw public WorktreeRegistration facts could feed admission without guarded creation
provenance. P8 is replacing them with an opaque durable registration from the exact settled
Guarded Create intent/receipt and HostKernel-resolved canonical path/base locator; P1 wires the
Guarded route. Fresh no-follow clean/owned/current evidence is mandatory for new admission;
legacy registrations remain historical only. Source work continues without validation.

P8 implemented `VerifiedWorktreeRegistrationV1`: exact durable completed Create + fresh Inspect
receipts are rebound to the owner, root generation, worktree ID, base-revision locator, measured
workspace revision and canonical path. P8 rechecks the receipts and requires owned no-follow
CLEAN state with zero dirty entries and no user changes. Legacy registration events cannot
qualify. P1 must wire the HostKernel worktree lifecycle route. Source only; no checks.

P1 confirmed the sampler cannot see sibling Run workers before an Attempt exists. Metrics remain
monitoring/backpressure only; unsupported required OS-enforced profile limits stay unavailable.

P1 source review confirmed no HostKernel Guarded worktree Create/Inspect/Release route, journal
or driver exists yet. Core direct create/remove stays disabled. P1 owns the guarded no-follow
operation/receipt path; P8 owns durable registration provenance and tombstones. Managed
worktree admission remains unavailable until both are wired.

P2 now persists protected authenticated ServerAuth ownership metadata on Session creation, rejects
goal.start for a Session owned by another principal, prevents HTTP mutation of owner/root markers,
and adds `sessionID` to the start response/SDK. Provisional Core store/instance/epoch guesses are
not SessionLink authority; the exact Rust SessionSupervisor BLAKE3 cursor/source projection
remains a blocker. Source only; no checks.

P8 found that a safely deleted worktree could remain marked Free and be selected again. It is
adding a durable registration tombstone gated by clean pre-delete and MISSING post-delete proof;
the ID remains historical/non-reusable. P1 admission must resolve only verified live
registrations and fail closed on ambiguous removal/replay.

Start SessionLink dependency: HostKernel has no Core SessionStore/projector and cannot derive
durable cursor/source metadata from `sessionID`. P2 supplies a private projection from trusted
Core Session owner state including authenticated principal and Goal/project/workspace binding;
HostKernel stamps its live owner epoch. Start remains unavailable until that exact projection is
wired; post-start SessionLink attachment cannot substitute.

Cursor digest constraint: Core `EventV2.latestCursor` returns SHA-256 over canonical JSON;
Rust SessionLink requires the actual BLAKE3 cursor from `hc_session_receipts`. P2 must use the
existing Rust SessionSupervisor projection. No digest rehash/wrapping is valid; unresolved cursor
keeps explicit start unavailable.


### Source correction — SessionLink and managed start (2026-10-19)

`SessionSupervisor.sessionProjectionCursor(sessionID)` returns the durable Rust projection ACK
checkpoint and exact BLAKE3 cursor; cursor acquisition is implemented. Remaining identity fields
are resolved from durable Core owners: immutable database sourceStoreID, immutable
project-directory sourceInstanceID, and per-Session sourceEpoch initialized to 1 and incremented
only for explicit source-lineage reset/replacement. Never synthesize from path/time/process epoch.
User confirmed explicit authenticated `goal.start` after accepted SpecVersion; it atomically pins
SessionLink and grants no Attempt/effect authority. P2 owns Core identity persistence/projection;
P1 validates and pins. Managed worktree operations use a private authenticated control request
routed through Guard/EffectIntent/lease/receipt/ExecutionHost, with selectors from trusted P8 state,
not model ToolBatch or caller paths/argv. Source only; no checks run.

P8/P1 worktree boundary detail: P8 issues opaque `WorktreeLifecycleOperationPinV1` with stable
idempotent operation identity, root owner/ref, fixed selected worktree identity/path, current
revision and durable intent cursor/epoch. The pin has no execution authority. P1 validates root
proof and routes through Guard + EffectIntent/one-use lease/receipt + confined ExecutionHost; P8
persists the possible-dispatch marker before invocation. Release needs clean pre-delete, MISSING
post-delete and no active lease, followed by permanent tombstone. After dispatch-start, restart is
UNKNOWN and cannot redispatch. No validation run.

Core SessionLink sourceDigest uses SHA-256 domain `horizoncode.session-link.source.v1\0` over the
exact ordered bounded projection fields in §12.3, with u64 big-endian UTF-8 byte-length prefixes;
null latest message/part refs encode empty, and transcript content is excluded. No checks run.

### 2026-10-19 22:06 UTC — user decision and live owner checkpoint

The user confirmed explicit authenticated `goal.start` after accepted SpecVersion and a complete persisted PLANNED Run. It atomically pins the authenticated root SessionLink, readies only dependency roots, and grants no Attempt/effect authority. P1 has source for typed HostKernel SessionLink decode, fixed-order SHA-256 validation, authenticated Core-peer checks, epoch stamping and atomic start. P2 is adding authenticated P8 root registration after that transition; no admission or scheduling may proceed until registration succeeds.

Actual active whole-phase owners are P1 Guard/ExecutionHost, P2 managed vertical and P8 resources/workers/worktrees/RC0. P1 is implementing one global user-owned Core Config `git_executable` absolute path and private authenticated Core→HostKernel projection. HostKernel canonicalizes/hashes it, pins profile revision/digest, and rechecks before launch in the existing supervisor. Project/plugin config, ambient PATH and request-supplied executable/argv/path are forbidden. P8 has source for read-only pending intent, post-Guard/approval/lease possible-dispatch fencing, and removal receipt reconstruction/replay; focused regression source is present but unrun. P2's production Rust-selected scheduler→TaskTool managed prompt path remains absent.

P3/P4/P5/P6/P7/P9 plus cross-phase acceptance/release remain open. No validation commands were run; user-directed implementation-first hold remains active. Git is mixed and untouched; one primary worktree; C: has 59 GB via `/mnt/c`. V1 remains PARTIAL / NOT RELEASED.

### 2026-10-19 22:09 UTC — start/profile ordering and worktree sandbox boundary

Parent source review corrected the ordering: explicit authenticated `goal.start` and P8 root-coordinator registration do not depend on optional Git configuration. P2 moves trusted Git-profile registration to the worktree acquire path before any Git dispatch. Missing profile denies worktree-backed admission while leaving the effect-free Run start valid.

P1 must keep all of `.git` protected and add only a typed broker-operation `.git/worktrees` write exception if the selected OS backend enforces it with no-follow/canonical roots. Git argv stays fixed and uses `--no-checkout`; if the backend cannot prove nested write isolation, lifecycle effects remain unavailable. P8 is adding a current-root/epoch-bound Inspect target derived only from the exact settled Create intent/receipt to complete first-use Create→Inspect→Register. Source only; no checks run.

### 2026-10-19 22:10 UTC — root registration and first-use worktree source updates

P2 moved trusted Git profile registration out of `goal.start`: start now remains SessionLink-pinned and registers the P8 root coordinator; the Git profile is registered through a separate adapter only before worktree acquire. P8 added an Inspect target resolver derived from the exact completed Create pin and settled receipt, with same current root/epoch, clean/owned/no-follow and no-prior-registration requirements. Release selection still requires a verified live registration. P1 must resolve `.git` gitfile common directories only through trusted no-follow HostKernel inspection and confine that separate metadata root; otherwise keep managed worktree actions unavailable for that Location. Source only; no validation.

### 2026-10-19 22:12 UTC — intent-only worktree restart recovery

P8 must not leave an intent-only Pending operation indefinitely ambiguous after the root epoch changes. Because P1 persists the dispatch-start marker before exposing a request to the supervisor, a Pending journal record with no marker/receipt proves NotAdmittedNoDispatch. P8 will append a durable retirement/tombstone receipt for the exact operation/key only with fresh authenticated proof of the same Goal/Run/root Session/Location/workspace lineage. The tombstone cannot change the tree or authorize dispatch; exact retry returns EXPIRED, and a new operation needs a new key plus fresh Guard/approval. Different lineage or ambiguous state stays denied. P8 owns the durable contract; P1 owns the pre-dispatch marker boundary.

P2 source update: root registration now validates the root execution ID, OwnerLog ID/sequence/event digest and WorkerPool revision as well as Goal/Run/Session/Location. Protected Core root binding pins schema version, accepted Spec ID/digest and SessionLink source digest; exact retries verify the same binding. No tests run.

P2 source review finding: Core's current `goal.start` handler recomputes SessionLink on retry, although Rust pins the initial value. The Rust Goal snapshot already contains `Run.sessionLink`, but the Core typed decoder omits it. P2 must carry the exact pinned link through the projection and use it for RUNNING/recovery; only a PLANNED Run may derive a fresh projection. Validate all owner/Goal/Spec/Session bindings before replaying root registration. This covers Rust-commit/Core-metadata crash recovery and moving-cursor idempotency.

P1's proposed first-create path is accepted conditionally: persist the exact P8 possible-dispatch marker after Guard/approval/one-use lease, then create only absent fixed metadata/destination directories by descriptor-relative no-follow operations beneath trusted canonical roots. Prepare confinement and launch fixed Git argv through the existing supervisor. No overwrite of existing/user-owned paths. A definite no-spawn result needs supervisor proof; any ambiguity is UNKNOWN/no retry. If OS backend cannot enforce the exact nested write roots, remain unavailable.

P8 source now appends `WorktreeOperationRetiredNoDispatch` for exact intent-only Pending operations only, under fresh same Goal/Run/principal/root-Session/Location/workspace/Spec proof. It yields a typed EXPIRED no-dispatch receipt, no worktree mutation or authority, supports exact same-key replay, forbids revival, and reconstructs the receipt on replay. An unrun source fixture and P8-owned §21.12 update are present. P8 continues remaining phase source review.

### 2026-10-19 22:15 UTC — current implementation-only checkpoint

P2 source now strictly decodes `Run.sessionLink` from Rust's Goal snapshot and reuses that immutable link for RUNNING `goal.start` replay; a fresh Core projection is computed only for PLANNED start. A parent source review caught and P2 corrected a snapshot-before-declaration dereference. P1 preserves the original owner epoch on exact HostKernel start replay; scheduling still requires fresh authenticated P8 root-coordinator registration.

P8 added a replay fence requiring the retired-no-dispatch event's current owner epoch to equal the replayed WorkerPool epoch. P8 source review still finds no production HostKernel guarded worktree route/sampling caller. P1 remains responsible for the authenticated worktree lifecycle route through Guard, approval, one-use lease, durable possible-dispatch marker, confined supervisor and receipt, with P8 owning durable registration/tombstone proofs. P2's scheduler-to-TaskTool child-session prompt path and full managed review/verifier/recovery remain open.

Implementation-first hold: no tests, builds, typechecks, audits, provider probes or benchmarks. Active whole-phase owners: P1/P2/P8; remaining P3/P4/P5/P6/P7/P9 await available slots (P4 has partial source only). V1 remains PARTIAL / NOT RELEASED. Git state remains mixed and untouched.

P8 source follow-up: resource samplers now derive Core PID/start/incarnation from fresh authenticated peer facts supplied at sampling time, closing stale same-epoch token reuse. The sample remains observational; no pre-admission dependency or unsupported OS quota claim is introduced. Production sample route remains unwired and requires P1's authenticated peer proof if needed.

### 2026-10-19 22:19 UTC — P8 durable settlement producer ruling

**Ruling:** `WorkerPoolControl` must not durably append SettleWorker/ReconcileRelease from caller-built `WorkerSettlement` / `ReconciliationProof` booleans. Use opaque crate-private P1 HostKernel-minted settlement/reconciliation proof values, bound to exact P8 cursor/revision/state, managed Attempt + DelegationBinding, claim nonce, P1 process generation/owner epoch and exact P2 terminal/effect evidence. P8 rechecks its own state and derives internal transition flags before append; exact receipt replay is stable, while stale or ambiguous evidence remains quarantined. No new public RPC. This is recorded normatively in arch_V1 §17.24. **Cost if wrong:** extra proof plumbing and implementation time; if instead loose booleans were accepted, caller assertions could release worker capacity without proving process exit and effect settlement.

### 2026-10-19 22:19 UTC — V1 logical-worker settlement clarification

**Ruling (supersedes the process-exit part of the 22:19 ruling):** §17.20 defines managed WorkerExecution as a logical child Core Session/Attempt in the shared Core process. V1 settlement must not assert or wait for a worker-specific PID exit, because no such child process is launched. Keep the opaque P1/P8 proof boundary, bind authenticated root/Core peer identity, exact P8 cursor/revision/claim/Attempt/DelegationBinding, P2 terminal Attempt and complete effect receipts, and P1 proof that the child prompt/callback scope, Attempt leases and owned command processes are quiescent. Guarded workspace facts determine worktree reuse; uncertain evidence retains/quarantines capacity. A future process-backed worker mode must prove its exact supervised process exit separately. **Cost if wrong:** requiring a nonexistent PID makes V1 settlement impossible; allowing logical completion without the durable effect/quiescence chain could release active capacity while effects remain in flight.

P1 source delta (22:19 UTC): exact SessionLink start replay preserves pinned owner epoch; admission deadlines use the minimum trusted profile/accepted Spec/persisted remaining Run/24-hour values; Git profile registration requires ServerAuth plus current authenticated Core peer; the trusted executable is re-canonicalized and rehashed immediately before spawn; EffectHost permits only exact Git worktree IDs for UserAction. No P1 lifecycle route/driver exists yet. P2 is producing a crate-private Rust terminal Attempt/effect-chain projection for P1 to combine with prompt/callback quiescence and current peer/process/workspace facts; P8 WorkerExecution is logical Core child with no child PID. Production P2 TaskTool caller and P1/P8 settlement route remain source gaps. No checks run.

2026-10-19 22:20 UTC — Cross-phase quiescence ruling: §17.24 adds `managed_dispatch_quiesced`, a one-use ManagedControl OwnerLog event appended from P1's opaque proof after Core's exact managed `promptManaged` call returns and outcome is durably recorded. HostKernel checks current Core peer, consumed handoff/child Session/Attempt and no Attempt callbacks/Guard leases/owned commands. Exact retry returns the marker without re-prompt; missing marker after possible dispatch means UNKNOWN and retains P8 capacity. P1 owns HostKernel proof validation; P2 owns Core caller and ManagedControl event/snapshot projection. No validation.

### 2026-10-19 22:24 UTC — implementation checkpoint

P1/P2/P8 continue whole-phase implementation. P2's canonical terminal snapshot now includes a durable quiescence marker cursor and separates workspace revision domains; P1's HostKernel quiescence digest consumes that typed snapshot and exact child effect IDs, current authenticated peer observations, and exited process receipts. P8's logical-child settlement consumer and replay receipt remain unfinished; the boolean/process-exit producer is being replaced. Parent review flagged the invalid Task revision/workspace digest comparison for repair.

P5 source correction: the ordered cascade now retries explicit transient 408/425 once after the first pass. Authentication 401/403/407 fall through only to other enabled/configured routes; 429 records cooldown and falls through without retry; other 4xx stop. Production route dispatch remains unavailable until P1 Guarded transport and P6 SecretBroker integration are complete. No tests/builds/typechecks/audits/probes ran. V1 remains PARTIAL / NOT RELEASED.


### 2026-10-19 22:30 UTC — P5 no-key provider chain expansion and source correction

Parent continued independent P5 work while whole-phase P1/P2/P8 owners remain active. Research against current provider primary pages found anonymous/no-key search support for Exa MCP, You.com `profile=free` (100 queries/day), Tavily MCP's explicit keyless search mode, Firecrawl Keyless (per-IP daily cap), and Parallel Search MCP (anonymous lower-rate mode). TinyFish Search is free but its documented API path requires account/API-key or OAuth, so it is not classified as part of the anonymous no-key default. Updated §37.5 and §16.7 accordingly and added source links/recheck caveat to §42.

Source-only P5 changes: Core config now recognizes `tavily_keyless` and `parallel_keyless`; the cascade's enabled default/order and route cap now include the five anonymous no-key routes; adapters expose those fixed endpoints/tools (including Tavily's fixed keyless headers); the TUI settings list represents both routes and keeps network dispatch unavailable pending Guard. The route parser now accepts common provider snippet fields, and tool-display labels cover both additions. Parent also fixed transient 408/425 classification earlier. P5 remains partial: no production Guarded transport/SecretBroker composition, native grounded-model route, broader BYO adapters/credential controls, route-event/provenance integration, or acceptance evidence is complete. Search remains fail-closed. No tests/builds/typechecks/audits/provider probes/performance runs were executed; Crawl4AI's browser binary was unavailable and Context7 quota was exhausted, so official primary-page web search/open was used as a fallback.


### 2026-10-20 05:16 UTC — P8 source continuation

P8 aligned the worker-pool module contract with §17.20: V1 managed WorkerExecution is a logical Core child Session/Attempt and cannot launch or claim a worker-specific PID. `WorkerPoolControl::dispatch_bound_managed_worker` now fails closed; generic process-backed pool primitives remain isolated as future-mode code. RC0's private P8 envelope now retains per-worker metric aggregates with the exact process-generation list. Its Python ingestion accepts Rust's bounded `{quality: UNKNOWN, reason}` metric representation and rejects unknown reasons or numeric substitutions. §37.22 records this private ingestion boundary and its non-attestation/OS-enforcement limits. Source fixtures were added or updated; no tests/builds/typechecks/audits/probes were run. P8 still depends on P1 authenticated HostKernel proof/guard routes and P2 terminal verifier evidence; P2 fan-out and RC0 release baselines remain unavailable until those integrations and later verification pass.

### 2026-10-20 05:24 UTC — P8 settlement/source continuation

P8 now defines the final managed-child Inspect pin from the exact claimed worker, durable admission/worktree pins and verified Create registration; its revision comes only from the Rust terminal snapshot. Settlement OwnerLog/receipt state carries the Guarded Inspect operation/Host receipt refs, final workspace revision, bounded P2 evidence digest/artifact refs, and a typed `HostRunReceiptRefV1` derived only after committed settlement. Reconciliation revalidates the exact persisted Inspect operation/receipt against durable worktree registration lineage while allowing a newer authenticated owner epoch. P1 owns authenticated HostKernel call sites and independently sources verifier identity/run from its verification journal. Successful verified settlement requires final Inspect and evidence refs; ambiguity retains/quarantines. Replay accepts legacy six-field events and expanded typed events. P2/provider owns token and monetary-cost accounting; the required durable stop-before-next-dispatch proof and terminal accounting cursor/provenance are recorded in §37.22. No tests/builds/typechecks/audits/probes were run. RC0 remains `NOT_ATTESTED`; full P8 source and P1/P2 integration remain in progress.

RC0 attribution is explicitly process-backed only: V1 logical child Sessions share the authenticated Core PID, so they must not receive fabricated per-worker process metrics. The sampler's Core-owner source label now states this limitation; only separately durable process-backed lease trees can appear under worker metrics. P1's HostKernel-owned helper/process inventory remains required for broader Attempt-level resource attribution.

### 2026-10-20 05:44 UTC — P5 parent fallback source update
P5 owner dispatch was rejected by the collaboration service's agent thread limit. Parent owns only P5 TypeScript/runtime and documentation while P1 keeps exclusive HostKernel/EffectHost/Guard ownership and P6 keeps Auth/SecretBroker/provider settings/question ownership. The single HostKernel call is `execution.execute_search_cascade` over the exact ToolBatch-approved `{query,limit,routes,credentialRefsByRoute}` plus authenticated Session/message/call/Location/Attempt/challenge/lease pins; reply carries bounded per-route attempt receipts, and UNKNOWN halts. P5 runtime now preserves UNKNOWN as a distinct attempt status, records route cost/auth provenance from fixed route IDs, and writes attempts in order. No checks run; production remains gated until P1 durable aggregate receipts/recovery and P6 reference composition land.

### 2026-10-20 05:54 UTC — final Inspect approval boundary
The P1/P2/P8 source interface is now explicit: verifier evidence is committed while the coding Attempt remains live; after typed evidence/Task Verified/Attempt SETTLING, P1/P8 perform the final guarded Inspect at that exact evidence revision and settle only with both terminal P2 snapshot and final Inspect receipt. Since Guard approval is interactive, Inspect is two private operations: prepare exact P8 pin + Guard challenge; explicit Core/TUI approval; execute with one-use lease + durable possible-dispatch fence + supervised fixed Git Inspect + durable receipt; then settle. Every P8 intent append invalidates prior root proof and requires fresh derivation from durable state. P1/P2 are implementing the boundary; no checks run.
Implementation integration ruling: managed settlement uses a distinct verified SETTLING candidate projection to pin the final Guarded Inspect. Once its exact receipt is durable, P2 settles the Attempt and publishes a terminal snapshot; P8 releases the worker only from that snapshot plus the Inspect receipt. This avoids requiring the terminal Attempt state before the Inspect needed for settlement. P8's durable completed-Inspect receipt accessor is still required for restart recovery. P1/P2 own source integration; no verification has run under the implementation-first hold.

### 2026-10-20 06:03 UTC — P4 launch-profile adapter source

P4 added a strict TypeScript decoder and private HostKernel resolver adapter for the §12.20 `ExecutionLaunchProfileDefinitionV1` contract. It enforces exact fields, canonical positive-u64 revisions, bounded literal argv, fixed cwd/environment policies, and one managed/direct Attempt lane. It validates the HostKernel response and returns only the matching immutable `profileRef` plus canonical Guard approval pins; it has no process API and does not bypass approval. REPL remains denied by HostKernel until OS CPU/memory/FD limits exist. Production composition remains blocked: legacy `ConfigLSPV1` has no immutable profile revision and the trusted Config runtime has no DAP profile projection. P1 protocol dispatch/replay and confinement acceptance also remain outstanding. No checks were run.

2026-10-20 06:02 UTC implementation status: the P2 `ManagedAttemptSettlementCandidateV1` and P8 candidate-based final-Inspect pin plus exact durable receipt recovery are now present in source. P1 still must expose authenticated HostKernel preparation/execution and recovery; P2 still must wire verifier/Inspect approval orchestration, terminal snapshot settlement, SubagentDeliveryV1 into TaskTool, and durable budget charging. P1/P2/P6 agents exited on usage limits; P4/P7/P8 are the actual active whole-phase owners. User requires implementation before any tests/builds/typechecks/audits/probes. V1 remains PARTIAL / NOT RELEASED.

### 2026-10-20 — P6 offline Provider Doctor config integration
Added a cache-only, secret-free Config projection for Provider Doctor and passed it through the offline/catalog/full handler path when present. It uses `InstanceState.has` and never loads configuration; this avoids the remote well-known-config fetch possible during ordinary Config initialization. Only provider/model IDs and allow/deny lists cross the projection. If no local config is cached, the Doctor preserves UNKNOWN. This is unverified source progress; no tests/builds/typechecks were run under the implementation-first instruction.

### 2026-10-20 — P1/P2/P8 source integration assignments
P1 will implement the existing §37.22 `managed.execute_final_inspect` contract using P8's durable dispatch-start, guarded-receipt persistence, and exact candidate/terminal recovery APIs; no new wire contract is authorized. P8 resumed for whole-phase child-workspace revision persistence and replay, consuming P1's typed admission projection. P2 received exclusive ownership of the session step-finish reducer and usage projection to persist deduplicated provider-reported token/cost usage before the next provider dispatch. Root source revision, child measured workspace revision, and worktree base revision are separate authority facts. Implementation-only; final checks remain deferred.

### 2026-10-20 — managed settlement and usage implementation checkpoint
P1 added the HostKernel `managed.execute_final_inspect` path; source review found that it still needs exact child-worktree read-only confinement, receipt resolver error discrimination, and revision re-observation before recording clean P8 evidence. P8 added durable child-workspace projection persistence/replay. P2 wired usage accounting at `step-finish`; Rust derives cumulative totals and ceilings (effective tokens are min of Spec and pinned profile token budgets; cost ceiling remains Spec-only), and Core stops before the next provider step on STOPPED. No tests/builds/typechecks were run; this checkpoint is source-only and not acceptance evidence.

P2 source checkpoint 2026-10-20: `DelegationBindingV1` pins providerID/modelID and optional AgentProfileV2 tokenBudget. Usage is appended durably per actual LLM `step-finish` before next provider dispatch, with source identity assistant message ID + finish index, Rust-derived BLAKE3 operation/digest, per-field provenance, cumulative token/cost totals, and an idempotent receipt. Effective token ceiling uses existing fields only: min(SpecVersion.maxTokens, profile.limits.tokenBudget) when present; monetary ceiling is SpecVersion.maxCostMicros. Core halts the current managed stream on Rust STOPPED. Token totals count provider input and output once; reasoning/cache values remain provenance submetrics. No validation ran under the implementation-first hold. Remaining P2 acceptance is full authenticated review, live Attempt/current-workspace binding, independent verifier/artifact/test evidence, Core→TUI proposal/review, pause/cancel/restart/UNKNOWN/stale-review/conflict recovery and exact final-revision Inspect/settlement journey. Managed effect fan-out stays disabled until P1/P2/P7/P8 acceptance.

### Decision update — managed budget authority (2026-10-20)
Use the existing schema: enforce tokens against the minimum of SpecVersion `maxTokens` and pinned AgentProfileV2 `limits.tokenBudget`; enforce cost against SpecVersion `maxCostMicros` alone. Do not extend AgentProfileV2. P2 must carry this through durable accounting, restart/replay, pre-next-dispatch stopping, and final acceptance.
P2 delivery update 2026-10-20: both direct Core children and managed Rust Attempts now have lane-tagged delivery construction at runtime. Direct TaskTool persists the envelope before prompt dispatch and advances from a strict validated prior child envelope; managed Task delivery derives from pinned HostKernel handoff/consume receipts. Both retain exact profile/permission or DelegationBinding authority and lineage. Unverified; direct child delivery and managed end-to-end recovery selectors remain required before P2 acceptance.

### 2026-10-20 — phase-owner reallocation
P8's current independent source pass returned PARTIAL. Source now separates and replays parent-root, admitted child-workspace, and worktree-base revisions; supplies typed pre-admission/post-attach target projections; recovers exact candidate/terminal final-Inspect receipts; and counts authenticated Core process sampling in bounded aggregate telemetry. RC0 remains NOT_ATTESTED; managed P1/P2 integration and real-work/platform evidence remain. Freed phase-owner slot is assigned to whole-phase P7 implementation (`p7_stream_artifact_automation_full`). Active phase owners: P1, P2, P7. P3/P4/P5/P6/P8 integration/P9 and cross-phase release gates remain open. No tests/builds/typechecks/audits/provider probes until source implementation closes, per user direction. Git remains mixed and unstaged; C: 46 GB free via `/mnt/c`, kernel/target 520 MB.

### 2026-10-20 — P7 HostKernel integration gap
P7's current source audit confirms TUI cursor reconnect/replay, bounded artifact FULL/SAMPLE/FAILED storage/rendering, Rust automation OwnerLog registry/journal, and checkpoint preview/receipt structures. P7 continues its independent phase work. HostKernel lacks production automation registry dispatch routes and guarded checkpoint capture/preview/restore routes; trusted same-boundary dirty/untracked VCS facts remain absent, so restore preview stays blocked and Core SessionRevert unavailable. P1 owns `host_kernel.rs` and has been assigned these adapters under the existing §37/§14.19 contracts. Keep `run_now` and restore fail-closed until Guard, exact workspace facts, durable receipt and restart recovery invariants exist. No tests/builds/typechecks/audits run.

### 2026-10-20 — verifier Location and aggregate search source handoff
P1 is implementing `execution.execute_search_cascade` as one aggregate durable HTTP operation consuming one Guard lease, retaining bounded ordered route receipts and resolving restart/lost-response state as UNKNOWN without replaying bodies. Keyless fixed routes are being wired first; BYO remains unavailable until trusted Rust SecretBroker lease use exists. P7's existing `AutomationRegistryV1` and `CheckpointJournalV1` APIs were provided for P1 HostKernel route integration; invocation/restore remain disabled pending Guard, durable receipt recovery and same-boundary VCS facts. P2 found verifier approval currently uses the root `InstanceState.directory` Location while the managed Attempt uses P8's child worktree; P1 must project the exact authenticated child LocationRef or prove request LocationRef is ignored. P2 keeps verifier dispatch fail-closed pending that resolution. No tests/builds/typechecks/audits run.

### 2026-10-20 — P7 source continuation
P7 now resets ended-stream sealing on a source-generation replacement and requires a fresh opaque HostKernel observation to settle checkpoint restore as Succeeded; every planned path must match the captured digest, length and executable mode as a regular single-link file, with exact Applied receipts. `record_restore_receipts` no longer accepts a caller boolean. P1 integration must supply the post-dispatch observation; invalid/missing proof stays UNKNOWN. These are source changes only; tests/builds/typechecks/audits remain deferred until implementation closes. P7 remains PARTIAL pending HostKernel automation/checkpoint/Guard routes, VCS status in trusted preview facts, and Core/TUI recovery integration.

### 2026-10-20 06:34 UTC — implementation-first owner refresh

Active whole-phase owners: P1 Guard/ExecutionHost/HostKernel, P2 managed vertical, P3 RepoIntel. P7 returned PARTIAL after source-generation replay and checkpoint final-observation changes. The integrated source remains unverified because implementation must finish before tests/builds/typechecks/audits/provider probes. P4/P5/P6/P7 integration/P8 integrated acceptance/P9 and final cross-phase/release work remain open.

Source review confirms P1's aggregate search retry/fallback policy and authenticated managed verifier child-Location projection are present, with P2 consuming the latter. HostKernel automation registry routes and checkpoint routes remain absent; P1 owns them. Keep invocation/restore unavailable until Guard, trusted workspace/VCS observation, durable receipt/recovery and effect dispatch are complete. Preserve the mixed Git tree; C: 46 GB free via `/mnt/c`; V1 PARTIAL / NOT RELEASED.

2026-10-20 06:35 UTC — Existing managed revision contract clarification applied: immutable worktree target admission revision remains pinned, while the Attempt scope's live child revision advances only through validated HostKernel receipts. P2's Core decoder now retains full target identity across refresh; P1 owns trusted live-head projection/enforcement. No checks run.

2026-10-20 06:36 UTC — P2 is fixing a managed-verifier UI deadlock by stacking the scoped Host Guard approval dialog above the live verifier dialog and popping only the approval layer. P3 added bounded `repo_detect`, authenticated reference/definition query wiring with truthful parser UNAVAILABLE, and explicit generation/workspace/node/file/parser provenance. P3 carries requested/effective RepoIntel profile plus typed restriction reason; P6 owns trusted config resolution and P8 owns bounded pressure facts. Implementation only; tests remain deferred until source work closes.

## 2026-10-20 06:44 UTC — implementation ledger refresh (source only)

Full V1 remains the delivery target. Active phase owners are P1 Guard/ExecutionHost/HostKernel, P2 managed vertical, and P4 LSP/DAP/REPL; P3 RepoIntel returned PARTIAL. P5 agent launch was refused by the actual child-thread limit, so the parent owns its independent TypeScript bridge while P1 owns the Rust HostKernel route. P6, P7, P8 integrated acceptance, P9, A1–A4 and final release proof remain queued/open. No phase is verified or released.

Source deltas: HostKernel automation read operations and checkpoint list/preview have been added; mutation routes that lacked Guard/lease/receipt were changed to fail closed. Invocation, capture and restore remain unavailable, and preview remains blocked without trusted VCS facts. HostKernel web-search cascade now accepts ordinary no-Goal/no-Attempt direct sessions, while direct Task Attempt stays unavailable without a same-head external-effect receipt. Parent removed the incorrect Core Attempt-required check; search transport remains gated off pending its Core adapter and crash-recovery authority pins. P3's RepoIntel tool/provenance additions remain typed unavailable where parser/buffer/freshness dependencies are absent. P2 is connecting the existing final-Inspect contract through TUI managed-root approval, execution, receipt recovery and settlement. P4 is adding trusted global DAP profile projection; P1 owns its bounded durable protocol journal/event buffer.

Implementation-first hold: do not run tests/builds/typechecks/audits/provider probes until source implementation closes. Preserve all existing staged/unstaged/untracked work. Last resource snapshot: C: 46 GB free via `/mnt/c`, `kernel/target` 520 MB, no HorizonCode build/test process; unrelated LiteCowork builds remain untouched. Final verification and exact-scope publication remain pending.

### 2026-10-20 06:51 UTC — managed recovery contract integration
P1 source now returns the exact existing SETTLING candidate with durable evidence/artifacts, or RESUME_EXECUTION for the same approved-but-undispatched verification set only when reviewer/owner/spec/final-revision/profile pins match; it never creates a replacement challenge or reissues a consumed one-use lease. P2 is integrating those strict responses. User-selected budget authority is existing-schema only: `min(SpecVersion.maxTokens, AgentProfileV2.limits.tokenBudget)` for tokens and `SpecVersion.maxCostMicros` for cost. P2 owns adding cancellation support for P5's `execution.v1/execute_search_cascade` call. P4 continues independent typed/config work with effectful paths gated. No verification run; V1 remains PARTIAL / NOT RELEASED.

2026-10-20 06:52 UTC follow-up: P1 verifier recovery now projects the exact registered child-worktree `approvalLocation` at frozen finalRevision for NEEDS_APPROVAL, RESUME_EXECUTION and SETTLING. Existing approved verification resumes only with original pins and saved lease digests; no challenge/lease is reissued. P2 consumes this DTO; P1 updates §37. Source only, no verification.

2026-10-20 06:53 UTC: P1 documented managed verifier restart recovery in arch_V1 domain §12.19 and runtime §37, covering exact child approval Location, strict pin matching, no stale lease/challenge replay, and SETTLING candidate versus terminal SUCCEEDED. This reconciles design docs with source; P2 integration and verification remain pending.

2026-10-20 06:54 UTC resource check: C: has 45 GB free via `/mnt/c`; kernel/target is 520 MB; no extra worktrees. Active Cargo jobs belong to LiteCowork and remain untouched. No HorizonCode validation has run.

### 2026-10-20 06:55 UTC — P5 response fencing and P2 settlement
P5 Core now validates HostKernel route receipts against the exact approved route order, allowing a same-route second attempt only after RETRYABLE_FAILURE and requiring selectedProvider to have an approved SUCCEEDED receipt. Added acceptance cases are intentionally unrun. P2 source wires managed final Inspect, CLEAN receipt, authenticated settlement and P8 release using the child approvalLocation. P1 still owns receipt-first recovery after consumed Inspect challenge and idempotent terminal settlement recovery after SUCCEEDED; P2 keeps these crash windows fail-closed.

2026-10-20 06:55 UTC P4 source continuation: LSP codeAction/rename proposals are bounded, DAP commands map to canonical Guard actions, and REPL callbacks track generation, duplicate, in-flight and UNKNOWN outcomes. Because the existing Rust boundary has no REPL RPC and required OS resource limits remain unsupported, interpreter execution stays unavailable; no parallel Core authority was added. Tests remain unrun.

### 2026-10-20 07:00 UTC — managed verifier retry semantics clarified
A full Core retry may reuse P8's deterministic final-Inspect pin, obtain a fresh Guard challenge and explicit approval, and then resolve the exact completed durable receipt without redispatch. The unresolved replay case is transport retry of the same execute request after its challenge was consumed: HostKernel must resolve the matching completed receipt before stale-challenge rejection. Separately, P8 `settle_dispatch` must recover idempotently if canonical Attempt SUCCEEDED was durable before a crash or lost response. P1 owns Rust source and exact typed recovery; P2 consumes it. This does not authorize effect replay, new evidence, or release without reconciliation. No tests/builds/typechecks run.

### 2026-10-20 07:01 UTC — P4 source handoff; P8 reactivated
P4's independent implementation is PHASE_PARTIAL: bounded immutable LSP/DAP protocol DTOs; codeAction/rename WorkspaceEdit proposals; DAP capability and per-command argument validation; bounded generation-scoped REPL callback/replay/UNKNOWN state. It added focused test source but did not run tests/builds/typechecks under the implementation-first hold. P4's remaining runtime work depends on P1 HostKernel journal/reply/Guard/confinement and codeAction/rename capability mapping, P3 authenticated RepoIntel `read_document`, and P8/OS resource enforcement plus a canonical REPL boundary. The freed child slot is assigned to whole-phase P8 durable worker/worktree/resource integration and RC0–RC5 P8 scope. Active phase owners: P1, P2, P8. V1 remains PARTIAL / NOT RELEASED.

### 2026-10-20 07:03 UTC — recovery integration and direct message contract
P8 now distinguishes genuine absent pending worktree intent from stale/UNKNOWN/quarantined/completed resolver errors. P1 uses this typed result before resolving a completed final-Inspect receipt, so only explicit absence follows the first-dispatch path. Same-epoch execute retries can return the exact cached receipt only; full HostKernel restart uses fresh Guard approval for the same deterministic P8 operation and exact durable receipt resolution before any redispatch. P1's read-only `managed.settlement_recovery` identifies one exact terminal Attempt; P2 strictly decodes the terminal snapshot and exact durable verificationRunID/challengeSetDigest/finalRevision/evidence refs, then calls only existing `settle_dispatch`. Ambiguous/multiple recovery remains uncertain. No tests/builds/typechecks run.

The user resolved direct-session messaging: use existing `agents.message` with `deliveryMode: "queued" | "follow_up"`; add no separate `agents.followup` capability. Normative §29/§37 and this Gate 7 now record that shape. P6 owns strict machine schema, bounded Core queue/safe-boundary child turn control and TUI projection. Active phase owners P1/P2/P8; P6 is queued until the next actual slot. This source-only update does not enable child spawn before P1 Guard/recovery gates.

### 2026-10-20 07:08 UTC — active phase assignment and release ledger

Active whole-phase child owners: **P4**, **P6**, **P8** (three-child platform cap). **P1** is next queued continuation; **P3/P7** are queued behind critical P1 protocol/HostKernel seams. **P2** has source-side managed terminal settlement recovery integrated; acceptance remains deferred by the implementation-first instruction. **P5** remains parent-owned for Core transport and SecretBroker route composition. **P9/A1–A4** and final release gate remain open.

P1 latest code supplies `managed.settlement_recovery`, exact final-Inspect retry recovery through P8's typed resolver, bounded same-HostKernel-epoch exact-response caching, and LSP codeAction/rename capability mappings. P1 phase is not complete: bounded protocol operation/reply journal and event buffer, full execution-origin Guard matrix, atomic ToolBatch/recovery, and guarded automation/checkpoint routes remain. P2 decoder requires exact verifier IDs/digest, final workspace revision, and evidence refs and only accepts success after P8 reports RELEASED. P4/P6/P7 dependent effectful paths remain unavailable until Guard, durable lifecycle, confinement and resource prerequisites are proved. No tests/builds/typechecks/audits/provider probes run until source implementation is complete. C: 45 GB free via `/mnt/c`; `kernel/target` 520 MB; one primary worktree; preserve the mixed unstaged Git tree.

### 2026-10-20 07:10 UTC — P4/P6/P8 source integration

P4 now exposes bounded LSP codeAction/rename proposals through injected authenticated document-read capability and source freshness checks; P3/P1 still own the real HostKernel document ingress and effect boundary. P8 fixed RC0 aggregation to sum worker rows and add each authenticated shared Core identity once, retain the latest sample sequence and mark conflicting equal-sequence samples UNKNOWN; regression source is present, unrun. P6 reuses Core's existing durable SessionInput inbox/safe-boundary promotion. Parent's accepted direct-message contract is now normative in §29/§37: public `agents.message` only; private Guard prepare/commit/inspect bound to exact parent/child/profile/permission/epoch/message/payload/mailbox/capacity facts; one-use authorization and durable receipt/UNKNOWN recovery; distinct fresh-turn proof for `follow_up`; queued never starts a turn. P6 owns schema/Core/TUI implementation, P1 owns Rust, and dispatch remains unavailable until both sides and prerequisites are wired.

### 2026-10-20 07:12 UTC — P8 handoff and P1 resumption

P8 returned PHASE_PARTIAL: typed pending Inspect resolution and corrected RC0 worker/Core aggregation are source-present; OS-enforced resource quotas, trusted independent attestation and integrated recovery evidence remain. P1 resumed into the available child slot; active whole-phase owners are P1/P4/P6. P8 is queued for acceptance/integration after P1/P2. No validation runs under the implementation-first hold.

### 2026-10-20 07:13 UTC — P5 source status correction and P4 protocol boundary

P5's production ToolRegistry composes `WebSearchRuntime.node`, which sends the admitted aggregate request to HostKernel; fixed keyless dispatcher, durable aggregate receipt and UNKNOWN recovery are source-present. The false-by-default runtime readiness gate remains, so no network route is enabled/verified; BYO awaits P6 SecretBroker refs and P1 one-use consumption. §37.2 has been corrected. P4 found a mismatch between the existing reply DTO's separate Guard lease envelope and P1's latest note requiring a buffered `eventSequence`/originating callback lease. Parent is reconciling it with P1; P4 holds only reply-wire changes and continues independent work. No tests/builds/typechecks run.

2026-10-20 07:14 UTC correction: P1 clarified that §37.6/Rust DTO is normative. Every buffered server callback gets a separate fresh Guard challenge/one-use lease after read; the reply carries its own Guard envelope and new outbound requestSequence, correlating by retained serverRequestID+method. `eventSequence` remains HostKernel-internal. Exact retry returns the same receipt; uncertainty fences UNKNOWN. No reply DTO change; P4 continues, still unavailable pending P1 dispatcher evidence.


2026-10-20 07:15 UTC — P6 direct-message API decision and runtime blocker: user selected public `agents.message` `deliveryMode: "queued" | "follow_up"`. Core may translate public `queued` to private HostKernel `queue`; queued only persists, while follow_up requests one serialized fresh child turn at a safe boundary and cannot alter an active request/token stream. P6 confirmed TaskTool's direct child still uses the V1 SessionPrompt transcript while Core's durable SessionInput inbox belongs to the V2 runner; writing to SessionInput directly would split history. P6 will continue independent whole-phase work; message dispatch remains unavailable until the correct durable inbox-to-child-runtime adapter and P1 Guard prepare/commit/inspect boundary are wired. Active child owners remain P1/P4/P6. No tests/builds/typechecks/audits/provider probes run under the implementation-first hold. Preserve the mixed unstaged tree; C: has 45 GB free via `/mnt/c`; one primary worktree; no cleanup/pruning.


2026-10-20 07:17 UTC — owner handoff correction: P4 returned PHASE_PARTIAL after independent source work (LSP exact Guard method mapping and bounded callback validation, DAP unsupported-command denial, source-only regression coverage, §37.6 status); runtime acceptance still depends on P1 process/protocol/confinement, P3 authenticated document ingress, and P8 enforced REPL quotas. P4 is queued for resumption after those dependencies. The freed platform slot is assigned to whole-phase P3 RepoIntel; active owners are P1/P3/P6. P1's direct-message private DTO now fixes service `direct.message.v1`, prepare/commit/inspect, private `queue|follow_up`, nested authority pins, payload 1–16 KiB, capacity 1–32, and SHA-256 payload digest; P6 is aligning its adapter while preserving public `queued|follow_up`. No tests/builds/typechecks/audits/provider probes run under the implementation-first hold. Overall V1 remains PARTIAL / NOT RELEASED.


2026-10-20 07:18 UTC — P3 bridge ownership: P3 resumed as whole-phase owner and may add only the authenticated `repo-intel.v1/read_document` service/adapter seam in `packages/core/src/session/supervisor.ts` plus new P3 bridge modules. Existing managed-control P2/parent edits in the shared supervisor file are protected; P1 has been asked to avoid that Core file during this lease and retains HostKernel/Rust ownership. P4 LSP files remain P4-owned; P3 must expose an adapter module or coordinate before touching them. No validation run.


2026-10-20 07:19 UTC — P5 Core credential-reference composition: parent wired `Auth.Service.searchCredentialRefs()` into the production `WebSearchRuntime.node` and exposed only the fixed BYO route IDs in its trusted supported-route projection. The existing Auth method returns only a unique AVAILABLE opaque SecretRef per fixed provider ID; broker errors/ambiguity omit routes, and no key bytes enter Core. `WEB_SEARCH_RUNTIME_READY` remains false; HostKernel presently admits keyless routes only, and P1's fixed BYO transport/one-use consumption plus integrated acceptance are still required. §37.2 updated. Source-only; no tests/builds/typechecks/audits/provider calls. Active phase owners P1/P3/P6; P4 PARTIAL/queued; V1 PARTIAL / NOT RELEASED.


2026-10-20 07:20 UTC — P1 security seam continuation: P1 added strict private `direct.message.v1` prepare/commit/inspect DTOs and the canonical `agents.message` Guard policy, but RPC routing/OwnerLog durability remain fail-closed. Automation dispatch was tightened so only list/inspect/history reach `automation_rpc`; create/update/enable/disable and run_now remain unavailable before effects without Guard/receipt paths. LSP protocol dispatcher/reply and direct message operations remain unavailable pending HostKernel journaling/recovery. Source only; no checks run.


2026-10-20 07:21 UTC — P3/P6 integration: P6 is adding the trusted Config repo-intelligence requested/effective profile projection as a P6-owned seam; P3 will consume it without editing Config ownership. P3 requested HostKernel stale RepoIntel node proof validation before `files.patch`; P1 asked for exact schema-derived ref/digest fields before changing the shared HostKernel DTO. P1 also found the search cascade recorded 429 `Retry-After` but advanced immediately despite §37.5 requiring bounded cancellation-aware cooldown; P1 is correcting the Rust route behavior. All remain source-only and fail-closed.


2026-10-20 07:22 UTC — RepoIntel stale-write evidence shape: P3 requested a stale node proof before `files.patch`. The canonical `RepoNodeRefV1` contains workspaceBinding, sourceGeneration, sourceRevision, optional overlayDigest, pathRef, fileDigest, nodeId/nodeKind/symbol, byteRange, and parserId/parserVersion; there is no separate opaque node digest. P1 will keep HostKernel DTO work owner-scoped and derive any binding digest from the fully validated schema plus authenticated live generation/revision. No patch request field can authorize a stale write.


2026-10-20 07:23 UTC — P6 RepoIntel settings seam: `FeatureExposure` is a boolean compaction toggle and cannot represent RepoIntel's requested/effective `lightweight|adaptive|full` modes. P6 is adding a dedicated Config/API setting with optimistic concurrency and a typed requested/effective/source/locked/unavailable projection for P3; changing the setting alone must not launch work or network activity. P6 owns §16; P3 consumes the projection and P8 supplies pressure narrowing. Source only; no validation.


2026-10-20 07:25 UTC — P1/P3/P6 source integration advances: P1 added `prepare_tool_batch.repoIntelFence` validation over query ID, generation/revision/workspace binding and exact path/file-digest refs, including authenticated live scope, bounded resnapshot and unique target matching; only root selector `.` is supported pending safe path rebasing. P3 added the authenticated Core `readRepoDocument` bridge and an LSP callback bridge for P4, and consumes P6's new Config profile projection. P6 source now has the Config-owned optimistic-concurrency three-mode setting, TUI selector and question owner-chain workspace ancestry denial. P1 also changed web-search 429 handling to cancellation-aware bounded cooldown and records effective retryAfter; cancellation during cooldown leaves aggregate UNKNOWN. Source-only, no tests run. Identified a transport-bound issue: document read max was set to 6 MiB, equal to RPC frame maximum; JSON string escaping/envelope could overflow, so P1/P3 are coordinating a smaller shared bound.


2026-10-20 07:27 UTC — parent integration rulings and source checkpoint (implementation only)

- **P6 `agents.message` ruling:** the user reconfirmed public `deliveryMode: queued | follow_up`; Core maps `queued` to private HostKernel `queue`. Parent source review requires private `directAttemptID` in authority pins for both modes because HostKernel has no child→Attempt index. HostKernel must re-resolve the exact durable admitted DirectAttempt and match parent/child/profile/effective scope/epoch/workspace. `queued` has no fresh-turn proof; `follow_up` additionally requires a fresh-turn DirectAttempt proof. P6 owns schema/Core/TUI and P1 owns the private DTO/HostKernel side. Both modes stay unavailable until the V1 child transcript has a durable safe-boundary append/ack API and the Guard journal/lease/receipt/UNKNOWN path is wired.
- **P3/P1 patch-fence integration:** P3 found that existing `apply_patch` prepares absolute operation paths, while P1's `repoIntelFence` compares normalized RepoIntel-relative paths. P1 is changing only the fence comparison to derive a canonical path relative to the authenticated registered root, rejecting escapes and ambiguity while preserving Guard operation paths.
- **RepoDocumentRead bound:** P3 schema/Core and P1 HostKernel now agree on a 1,000,000-byte body cap, leaving RPC frame headroom.
- **Active whole-phase owners:** P1 Guard/ExecutionHost/HostKernel, P3 RepoIntel and P6 settings/providers/Doctor/S1/direct child lifecycle. P4 remains PARTIAL and queued; P2/P5/P7/P8/P9 and final integrated release gates remain open. The three actual child slots are occupied; no extra concurrency is claimed.
- **Implementation-first hold:** no tests, builds, typechecks, audits, provider calls or probes were run. These source changes have not been accepted or verified. Git remains mixed and unstaged; C: has 45 GB free via `/mnt/c`, `kernel/target` is 520 MB, and only the primary worktree exists. V1 remains PARTIAL / NOT RELEASED.


2026-10-20 07:29 UTC — P1/P3 patch-fence interface resolved in source: HostKernel now derives a normalized RepoIntel-relative comparison path from each existing absolute `files.patch` operation under the authenticated canonical registered root. The Guard operation path remains unchanged; root escapes, non-normal components and ambiguous targets are rejected before admission. This closes the source-level adapter mismatch, not acceptance evidence. P1 confirmed it will add P6's required exact `directAttemptID` pin and durable owner re-resolution. No tests/builds/typechecks/audits run.


2026-10-20 07:32 UTC — P3/P1/P6 interface updates (source only): RepoDocumentRead is now capped at **131,072 bytes** in the P3 schema/Core; P1 is aligning HostKernel. Worst-case JSON escaping is about 786 KiB, leaving frame headroom under the 1 MiB LSP bound. The P3 LSP document-reader adapter was hidden by the root `*` overlay rule; parent added its exact `.gitignore` exception, and Git now reports the source as untracked/visible (not staged). P1 now requires and resolves exact `directAttemptID` for both message modes, includes it in authority digest, validates the persisted OwnerLog's principal/session/epoch/profile/scope/workspace/head, and denies non-EXECUTING child Attempts. Message RPCs still return unavailable until Guarded mailbox durability, Core V1 transcript append/ack, and follow_up safe-idle proof are implemented. No tests/builds/typechecks/audits run.


2026-10-20 07:35 UTC — follow-up integration requirements: the P3 schema now models RepoIntel patch targets as exactly one existing-file digest or `expectedAbsent: true` destination proof. P1 must accept only those strict shapes and revalidate absent destinations under authenticated root/revision (the current HostKernel parser still requires `{pathRef,fileDigest}`). Parent approved this source contract for adds/moves. The P4 LSP client currently requests 6 MiB while RepoDocumentRead allows 131,072 bytes; P3 is clamping within its new Core→LSP bridge so the authenticated request remains within the shared cap. `apply_patch` UI/schema description must name both forms. No tests/builds/typechecks run.


2026-10-20 07:37 UTC — P1/P3 RepoIntel fence now agrees on source: HostKernel accepts only the strict XOR source-ref forms `{pathRef,fileDigest}` or `{pathRef,expectedAbsent:true}`. It validates existing digests against the authenticated live generation; expected-absent targets are checked under the registered root with component-wise no-symlink/real-directory validation and a final workspace-revision recheck. Absolute Guard patch paths are retained and only mapped for RepoIntel comparison. P3 updated schema/UI description and clamps LSP document reads to 131,072 bytes. No validation run.


2026-10-20 07:39 UTC — source checkpoint and phase-slot update: P1 has now set HostKernel RepoDocumentRead to 131,072 bytes, matching P3 schema/Core. P1 also added operation coherence: expected-absent refs must match `write` operations with null expected-before; digest refs must match writes/deletes with a prior digest. This supersedes the 07:35 note that Rust still required only file digests. P3 returned **PHASE_PARTIAL** after exhausting independent source work; remaining P3 dependencies are P4 LSP composition, P8 resource-pressure narrowing, a trusted unsaved-buffer producer and approved structural parser/index. One child slot opened and is assigned to the whole P8 phase; active owners are P1/P6/P8. P6 found a missing Config-owned RepoIntel profile compare/write implementation used by its own routes/UI and is restoring it before resuming child status projection. No tests/builds/typechecks/audits run; C: remains 45 GB free via `/mnt/c`, kernel/target 520 MB.

Implementation checkpoint (2026-10-20): P5 Core now checks negotiated HostKernel `execution.v1.web-search-cascade` and `effects.v2` before dispatch; P1 offers the cascade feature only with Guard readiness. The global search readiness switch remains false until integrated acceptance, and BYO routes remain blocked. Managed budget source follows the settled authority rule: token ceiling is `min(SpecVersion.maxTokens, pinned AgentProfileV2.limits.tokenBudget)` over present values, and maxCostMicros comes from SpecVersion alone. This is source implementation only; verification remains deferred by user instruction.

Implementation follow-through (2026-10-20): P5 preserves ToolBatch-pinned opaque credential refs end-to-end through the aggregate HostKernel request and fails closed unless the cascade and effects features were negotiated. P8's typed RepoIntel pressure projection is source-present; trusted pressure ingress/recovery and P3 consumption remain. P2 is active in the freed child slot. No validation has been run.

Phase allocation update (2026-10-20): active child owners P2/P6/P8; P1 PHASE_PARTIAL queued to resume; P3/P4/P7/P9 queued or partial; P5 parent-owned. Continue whole V1 source implementation before the deferred integrated verification/test/release wave. Preserve mixed unstaged Git state and foreign processes; latest disk check: C: 45 GB free through `/mnt/c`, kernel/target 520 MB, one primary worktree.

Reference-source follow-up (2026-10-20): current local OpenCode TaskTool and Codex agent-control source were inspected directly. The source reuse decision remains in §42.12; it now records the precise queue/trigger, parent notification, wait, interrupt and pre-input spawn rollback behavior and the boundary that Codex's process-local mailbox is not durable Horizon authority. P6 owns direct lifecycle adaptation; no tests/builds were run.

Source audit update (2026-10-20): P2 corrected the plan-only response and remains partial at P1/P8 integration. P8's managed worker settlement now allows the capacity-releasing OwnerLog event only for SUCCEEDED+VERIFIED; failure/cancel/unknown states retain capacity for typed reconciliation. P1 resumed, with P1/P6/P8 active. No tests/builds/typechecks have run.

2026-10-20 07:42 UTC — continuation checkpoint: active whole-phase owners are P1 Guard/ExecutionHost, P6 providers/settings/Doctor/S1/direct lifecycle, and P8 resources; all three actual child slots are occupied. P2 remains PHASE_PARTIAL pending P1/P8 integration. P3/P4/P7/P9 and final integrated implementation/release work remain open or queued; P5 is parent-owned and fail-closed. P6 changed direct delivery outcomes to start QUEUED, become EXPIRED only before prompt invocation, and become UNKNOWN after prompt invocation or acknowledgement-persistence ambiguity; child history is retained and no unsafe lineage detach/delete is attempted. P1 hardened terminal.start so post-admission persistence failures are UNKNOWN and never reported as RUNNING. P8 is implementing a bounded pinned-cache eviction planner; success settlement remains SUCCEEDED+VERIFIED-only, while a separate failure release must follow §11.20/§18.18 owned-process termination and settled-effect reconciliation; V1 logical children share Core and cannot claim per-child PID termination. Public child messaging is `agents.message` with `deliveryMode: queued|follow_up`; bounded named-child wait is read-only and timeout never cancels. No tests/builds/typechecks/audits run. Git remains mixed, unstaged and ownership-sensitive; only the primary worktree exists; C: 45 GB free via `/mnt/c`, `kernel/target` 520 MB; the unrelated LiteCowork Cargo test remains untouched. HorizonCode V1 remains PARTIAL / NOT RELEASED.

### 2026-10-20 07:49 UTC — P1/P6 source update and P5 provenance correction
The user confirmed public `agents.message` uses `deliveryMode: queued|follow_up`; P6 owns implementation: queued is durable enqueue-only and follow_up requests one serialized fresh turn at a safe boundary. P6 now reauthorizes parent/workspace ancestry on each named-child wait poll and matches the persisted scope pin against the exact HostKernel DirectAttempt. Delivery is still unavailable pending safe V1 transcript append/ack, P1 Guard journal/lease/receipt recovery, and fresh-turn proof. P1 source denies unsupported capability IDs before preflight, giving plugin/MCP/hook/hosted/legacy IDs zero effect, and prevents failed/cancelled managed Attempts from entering success settlement; P8's explicit quarantine-only reconciliation API is in progress. P5 removed fabricated `latencyMs: 0`; no latency is emitted until measured. Active whole-phase owners P1/P6/P8; P2 remains partial; P3/P4/P7/P9 and final integration/release remain open; P5 parent-owned. No tests, builds, typechecks, audits or probes run. V1 remains PARTIAL / NOT RELEASED.

### 2026-10-20 07:51 UTC — direct-child aggregate admission and managed quarantine source
Cross-review of §29.13, AgentProfileV2 and TaskTool found profile-specific child totals could be bypassed across profiles. The selected fixed V1 aggregate ceiling is 64 direct child Sessions per parent Session; profile-specific `maxTotalChildren` and `maxActiveChildren/maxParallelChildren` remain independently stricter. P1 now enforces the aggregate count across profiles from authenticated `parentSessionID` under the durable admission OwnerLog lock and on replay; terminal children count, exact retries dedupe, and abandoned never-created Attempts do not count. P6 is aligning Core UX and normative §29.13. P1 also integrated P8 `quarantine_managed_worker` for exact FAILED+FAILED and FAILED+CANCELLED terminal snapshots after current binding, consumed-handoff quiescence, settled effects, authenticated peer and workspace checks. Quarantine retains ActiveWorkers/worktree and claims no process-tree exit; P8's separate fresh reconciliation proof must precede any release. P5 corrected stale §16.7/§42 status text to distinguish route adapters from execution readiness and removed fabricated `latencyMs: 0`. All changes remain source-only and unverified; no tests/builds/typechecks/audits run. Active whole-phase owners P1/P6/P8; P2 partial; P3/P4/P7/P9 and final acceptance/release remain open. V1 PARTIAL / NOT RELEASED.

### 2026-10-20 07:53 UTC — P6 partial handoff; P7 whole-phase owner started
P6 returned PHASE_PARTIAL after its source pass: exact-parent-linked direct child status and bounded wait with per-poll owner/workspace reauthorization and HostKernel Attempt pins; 64-child aggregate early count; offline-only Provider Doctor projection; provider capability reporting; RepoIntel settings and S1 owner checks are present. Delivery remains fail-closed pending P1 message journaling/lease and safe-turn proof plus durable V1 transcript append/ack. Live Doctor/BYO and S1 mixed-effect integration need P1/P7; verification is deferred. The P1 durable aggregate count is now by unique `(parentSessionID, childSessionID)` pairs, so resuming the same terminal child does not consume another unit; a second concurrent Attempt or mismatched profile/principal denies. P1's typed failed/cancelled quarantine retains capacity/worktree; P8 owns the distinct fresh release proof. P7 is assigned as the whole-phase owner in the freed slot, alongside P1/P8. No checks run; V1 remains PARTIAL / NOT RELEASED.

### 2026-10-20 07:55 UTC — P8 fresh release proof; P1 resumed; P7 active
P8 added a separate fresh release reconciliation contract requiring the historical terminal settlement proof, exact durable quarantine receipt, current owner/root and terminal snapshot, HostKernel quiescence digest, and a mandatory fresh Guarded Inspect receipt pinned to the active registered worktree/current root. UNKNOWN/MISSING cannot release; a dirty observation may release ActiveWorkers only while the worktree remains quarantined. P1's previous partial handoff predates this API, so P1 resumed as the whole-phase owner to integrate it and continue remaining Guard/HostKernel/direct-message/SecretUseLease/protocol-journal work. P7 is active as the whole-phase owner with exclusive `kernel/src/artifact_store.rs`, `automation.rs`, `checkpoint.rs` plus P7 Core/TUI/schema; P1 retains Guard/HostKernel/effect_host/protocol, and P8 retains worker/resource/worktree accounting. No checks run; all effects remain fail-closed until required acceptance.

### 2026-10-20 07:58 UTC — P5 unknown transport and latency truth
Core now maps any interrupt/transport failure after invoking `execute_search_cascade` to explicit UNKNOWN, stops later serial batch effects and never retries a route; typed HostKernel refusal is unavailable. Successful `latencyMs` is a measured monotonic aggregate Core→HostKernel round trip, not provider-server time. P1 still needs to provide exact durable receipt inspect/replay after a lost RPC reply; therefore the search feature remains unavailable. A §37.5 cache mismatch is awaiting the user's preference: the LLD says per-URL/content-hash caching, while the V1 request/runtime returns search links only and has no page-content fetch or bypass contract. No validation run.


2026-10-20 08:04 UTC — P5 V1 scope ruling and continuation: `web.search`/`WebSearchRequestV1` return bounded links/snippets and define no page fetch or cache-bypass input, so the §37.5 per-URL page-content cache is deferred post-V1; V1 must not fetch/cache content implicitly. The normative text now records that boundary and the explicit contract needed before future page retrieval. P1 is adding a read-only exact-authority `inspect_search_cascade` for lost RPC replies; it may reconcile status/receipts but never re-execute. A settled success with an unrecoverable response body must be surfaced as “completed, results unavailable,” distinct from unsettled UNKNOWN and exhaustion. P7 asked P1 to assess authenticated owner/CAS automation definition CRUD while leaving `runNow` disabled; parent passed the request to P1. P7 source fixes include accurate artifact pending failure and live raster-cache gauge aggregation; effectful artifact/automation/checkpoint paths remain Guard-gated. Active whole-phase owners P1/P7/P8. No tests/builds/typechecks/audits/provider probes run; user deferred them until implementation is finished. Git remains mixed/unstaged (13 commits ahead); C: has 45 GB free via `/mnt/c`, `kernel/target` 520 MB, one primary worktree. Overall HorizonCode V1 remains PARTIAL / NOT RELEASED.
### 2026-10-20 08:16 UTC — repo-only boundary and P5 receipt recovery integration

The user set a hard repo-only boundary; root `AGENTS.md` binds parent and phase owners to repository-contained file access/artifacts and forbids external-service operations, including Git remotes, while active. This supersedes previous `/mnt/c` disk checks. The attachment path is outside the boundary and is not to be reopened. Active whole-phase owners are P1/P7/P8 (all three child slots). P5 Core now validates/carries HostKernel-minted `routePlanDigest` only for `web.search` approval requests and performs read-only `inspect_search_cascade` after an ambiguous transport failure, bound to the original HostKernel challenge, location, one-use lease, approved-argument digest, route-plan digest and optional Attempt pins. It never redispatches. P1's HostKernel operation is still in progress; the production readiness flag stays false. No checks were run. Mixed Git state is preserved and V1 remains PARTIAL / NOT RELEASED.
### 2026-10-20 08:20 UTC — P1/P7/P8 source integration checkpoint

P7 added a read-only checkpoint Core bridge and HTTP list route; parent exposed only the three exact owned paths through `.gitignore`. Preview remains unexposed until it can use trustworthy same-boundary VCS dirty/untracked facts. P8 reports durable root-coordinator reauthorization, fresh Guarded Inspect intent/receipt reconciliation, and truthful unknown-size/overflow cache eviction accounting; P1 is integrating its strict authenticated HostKernel DTOs. P1's no-dispatch `execution.v1/inspect_search_cascade` source matches the P5 Core adapter. P1 previously attempted `cargo check --lib` and reported 139 diagnostics across shared dirty Rust modules; this is not acceptance evidence. In line with the implementation-first instruction, further checks are deferred until implementation is complete. No tests/provider probes/audits run. The repo-only boundary is active; no external path/service access. Active owners P1/P7/P8; V1 remains PARTIAL / NOT RELEASED.
2026-10-20 08:21 UTC — P5 error-state correction: HostKernel `hostCode` alone does not prove that web-search avoided dispatch; `effect_outcome_unknown` and post-dispatch receipt/response failures are typed too. Core now treats only `feature_not_negotiated` as a definitive no-dispatch error. Every other typed failure uses the exact original challenge/lease/digest pins for read-only receipt reconciliation, falling back to UNKNOWN without retry. Source only; validation deferred.

### Continuation checkpoint — 2026-10-20 08:24 UTC

Source integration only: reconciliation now has an explicit parent/child Session identity rule in `arch_V1/17-GOVERNANCE-DECISIONS.md` §17.24, and P1/P8 have been instructed to align their source checks to it. P7's checkpoint-control test is explicitly unignored for Git visibility; P7 removed automation mutation controls that have no guarded HostKernel implementation and retained only supported read-only projections. No verification was run under the user's implementation-first instruction. Active owners remain P1, P7 and P8; all other V1 phases and final integrated acceptance/release checks remain on the ledger as open/partial. Repo-only boundary and mixed unstaged Git state remain in force.

### 2026-10-20 08:24 UTC — owner roster correction

P7 returned PHASE_PARTIAL after completing its independent source work; its remaining gated work is P1 Guard/receipt integration and a trusted atomic VCS/workspace observation for checkpoint preview/recovery. P2 now owns the freed full-phase slot. Actual active owners: P1 Guard/ExecutionHost, P2 managed vertical, P8 resources/worktrees. P3/P4/P6/P7/P9 and P5 parent-owned work remain incomplete; integrated verification and release gates remain deferred until source implementation closes. No tests/builds/typechecks/audits were run.

P5 source cross-check (2026-10-20 08:24 UTC): re-read the pinned local OpenCode `websearch.ts` and `mcp-websearch.ts` implementations. Their selected single Exa/Parallel route and direct Core HTTP authority do not satisfy Horizon's ordered consented cascade. The concrete reusable pattern is fixed MCP request schema, bounded JSON/SSE parsing, and visible provider/cooldown provenance. Updated `arch_V1/42` source provenance to bind this adaptation to the existing Rust Guard/ExecutionHost and SecretBroker. No code was copied from upstream; no checks or probes were run. P5 remains parent-owned and incomplete.

### 2026-10-20 08:26 UTC — P1/P2/P8 integration note

P1 source adds guarded quarantine Inspect prepare/execute, fixed child-root Git inspection, exact P8 receipt replay and revision stability checks. P8 source now distinguishes child Attempt Session pins from root Run SessionLink pins. P1 still must implement a durable fresh-process proof that no callback/owned command remains after restart; uncertain paths remain quarantined. P2 reports principal reviewer, explicit goal.start, pinned worktree/revision, accounting, TUI and verifier/Inspect adapters present and continues the full source-gap audit, including restart/stale review/conflict/artifact paths. These are source statements only; no tests/builds/typechecks/audits run. Active owners remain P1/P2/P8.

### 2026-10-20 08:27 UTC — P2 phase source audit (not acceptance)

P2 reviewed §12.19/§17.24/§37.22/§32.38 against the full current Rust/Core/HTTP/TUI path. Authenticated reviewer assignment and proposer/self-review denial; effect-free `goal.plan` plus exact accepted-plan `goal.start`; AgentProfileV2, Attempt and P8 child-worktree revision binding; per-step usage accounting before another provider request; quiescence separate from verification; strict typed current-revision artifact evidence; and final Inspect→terminal Attempt→P8 settlement projections are source-present. API/TUI already report `PROMPT_UNKNOWN` with replay fenced; §37.22 now specifies this truthful state. Existing source fixtures cover stale/spoofed reviewers, crash/restart UNKNOWN, changed workspace revisions, artifact binding and settlement; they remain unrun on the integrated revision.

P2 has no remaining schema/API mismatch reported by P1 or P8. P1's `TRUSTED_VERIFIER_ADAPTER_AVAILABLE` remains false pending Guard/confinement/restart acceptance, and fresh-process proof of no live callback/owned command is still required. P8's exact settlement consumer matches the P2 candidate→Inspect→terminal sequence and remains dependent on HostKernel proof. P7 retains broader artifact lifecycle ownership. Managed dispatch and verifier enablement remain disabled; V1/P2 are PARTIAL and NOT ACCEPTED. No validation commands were run.


### 2026-10-20 08:31 UTC — source re-audit and phase-slot update

Read the user-requested attachment. It reiterates full V1, local OpenCode/Codex source adaptation, full architecture re-audit and implementation-before-testing. Cross-checked local `opencode/packages/opencode/src/tool/task.ts`, Codex `repos/codex/codex-rs/core/src/codex_delegate.rs`/`thread_manager.rs`, and Horizon §§03.5/29.5/42.12. Codex's reserve-before-spawn, startup cleanup guard, bounded event/op pipes, cancellation propagation and one-shot shutdown are useful lifecycle patterns; P2 reports equivalent Horizon lineage/admission/cleanup/cancel/no-replay source is present. P2 returned PHASE_PARTIAL after fixing the managed BLAKE3 completion digest (direct SHA-256 unchanged) and strict verifier UNKNOWN reason/finalRevision decoding; no P2 source-only task remains until dependencies land. P1 resumed as full phase owner for remaining Guard/ExecutionHost implementation, especially durable fresh-process process/callback liveness proof, universal effect-origin handling, batch/receipt recovery and direct-message journaling. P6 owns whole provider/settings/Doctor/S1 phase; P8 remains active. No validation commands or live provider calls run. Repo-only boundary active; V1 remains PARTIAL / NOT RELEASED.

### 2026-10-20 08:37 UTC — whole-phase queue update

P1 repaired missing durable RUNNING transitions on both Inspect dispatches and reconfirmed the durable 64 distinct child-session cap. Current stdio supervisor cannot prove descendant-tree exit after HostKernel restart; keep UNKNOWN quarantined until authenticated tree-exit receipts are implemented. P8 finished independent source work with bounded reconciliation-root history and soft/hard→RECOVERING hysteresis; dependent pressure/history/cache wiring remains open. P3 RepoIntel and P4 LSP/DAP/REPL now occupy newly freed whole-phase slots alongside P2/P6. P1's remaining universal effect/receipt/message gaps, P7, P9, P2 integration and parent P5 integration remain in scope. No tests/builds/typechecks/audits/probes run; V1 remains PARTIAL / NOT RELEASED.

### 2026-10-20 08:38 UTC — P5 source guard

The parent tightened Core validation so a HostKernel web-search cascade receipt cannot continue after an `UNKNOWN` route attempt; added a focused source regression. No test was run and this does not enable search. P2/P6, P3, and P4 are active whole-phase owners. P1's remaining Guard scope is next in queue, followed by P7/P9 and integration; V1 remains PARTIAL / NOT RELEASED.

2026-10-20 08:39 UTC — P5 now enforces aggregate receipt consistency: UNKNOWN cannot coexist with successful route evidence, and result-unavailable reconciliation requires a final successful route receipt. Focused source regressions remain unexecuted; runtime stays disabled.

2026-10-20 08:40 UTC — P6 aligned the resource API: canonical ResourcePolicyV1 keeps exact §18.18 ResourceLimitV1 limits, while the settings-facing Config result has a distinct ResourcePolicyProjectionV1 name. Effective limits remain absent/UNSUPPORTED without platform facts; no quota defaults are fabricated. P8 was notified.

### 2026-10-20 08:41 UTC — P4/P1 phase update

P4 source-aligned LSP 128 KiB reads and DAP validation with existing Rust limits, plus launch/protocol DTO parity; all effectful lifecycles remain unavailable pending P1 Guard/journal/confinement and P3 reader integration. P4 returned PARTIAL. P1 resumed for the entire remaining Guard/ExecutionHost phase and will tighten Rust RepoIntel patch-fence references to the TS/patch-operation 64-item bound. Active owners P1/P2(P6)/P3. No validation commands run.

2026-10-20 08:42 UTC — P3 cache source now has a bounded idle TTL, pin-deferred release, internal generation eviction, and source-accounting callbacks that do not claim physical bytes reclaimed; P8/P1 HostKernel integration remains required. P6 default OpenCode model selection now requires explicit zero cost for every pricing field and active availability; unknown or paid candidates remain unavailable, with no fallback. Both are source-only and unvalidated.

2026-10-20 08:43 UTC — P1 source checkpoint: UNKNOWN stdio and HTTP executions now retain admission capacity alongside active/prepared work until authenticated reconciliation; HostKernel's RepoIntel patch-fence cap now matches schema and patch operations at 64. No checks run; P1 remains in progress.

2026-10-20 08:44 UTC — P6 returned PHASE_PARTIAL after its source audit. P6-owned projection/auth/provider/settings/Doctor/S1 sources are updated; offline Doctor, explicit zero-cost OpenCode selection and fail-closed credential mutation are source statements only. Its acceptance remains deferred under the implementation-first hold. P8 resumed in the freed slot to integrate the canonical P6 resource policy with P3 cache ownership and complete P8's remaining source gaps. Active owners P1/P3/P8.

## 2026-10-20 08:49 UTC — user review note and implementation continuation

The user authorized one exact read of the supplied attachment; it is complete, and the root operating rule now states that no further outside-repository access is authorized. It reconfirms complete V1 scope, source-backed OpenCode/Codex adaptation, a full architecture/flow/event re-audit, and implementation before testing. No decision ambiguity requiring user input was found. P1/P2/P7 are the active whole-phase owners; P1 now has a source-level HostKernel retained RepoIntel generation map bounded by 64 entries and 64 MiB observed source bytes, with no heap/reclaimed-byte claim. P3 remains queued for P8 authenticated CacheRegistry integration. The parent continues P5 and cross-phase architecture review. Validation remains intentionally deferred until implementation completion; V1 remains PARTIAL / NOT RELEASED.

### 2026-10-20 08:50 UTC — P7 async render generation fence

P7 added a generation fence to the isolated SVG raster cache so late results from superseded
geometry/theme generations are discarded. A reversed-completion regression fixture is present
but unrun. The full P7 source remains in progress: HostKernel owns guarded automation mutation,
invocation and checkpoint effect wiring; same-revision trusted VCS+filesystem observation is
still required before checkpoint preview can expose actions. No tests/builds/typechecks/audits
were run; P7 remains PARTIAL / NOT VERIFIED and all effect paths remain fail-closed.

2026-10-20 08:52 UTC — P7 analytics projection now allowlists metric/source/unit tuples and fails malformed numeric observations to UNKNOWN; source fixtures are unexecuted. Effectful automation/checkpoint and real TUI acceptance remain incomplete pending P1 integration and the later implementation-wide validation phase.

### 2026-10-20 08:53 UTC — actual-source recheck and P7/P1 boundary

Re-read the local OpenCode TaskTool and Codex agent spawn/runtime/mailbox/completion source. The adaptation is limited to reservation, durable lineage, accepted-input ordering, and partial-start cleanup; Codex's in-process mailbox and best-effort completion remain unsuitable as Horizon authority. Exact source notes are in §42.12. P7 resolved automation CRUD from existing normative owners: §33.16 capability IDs, §14.2 Guard approval, and §14.3 `prepare_user_effect`; P1 owns Guard/lease/Rust CAS/receipt, P7 owns Core/TUI orchestration, and P2 retains its managed goal/review/run handlers. No parallel effect authority is introduced. P2 fixed source ordering for exact-child cancel-after-fence and is closing the VERIFYING settlement-recovery gap. No verification commands run; implementation-first hold continues.

### 2026-10-20 08:56 UTC — P2 terminal settlement recovery source delta

P2 source now closes the split terminal transition: after Guarded final Inspect and `settleAttempt` commit typed evidence and a successful Attempt, Core calls authenticated `finalize_run` before P8 settlement. A terminal recovery snapshot whose Run remains VERIFYING now replays only that finalizer, then exact P8 settlement; a snapshot already marked SUCCEEDED skips finalization. Both paths require the same verified Task, succeeded Attempt, quiesced child, all-settled effect chain, exact observed final workspace head and typed artifact/evidence refs. Run cancel now interrupts only the exact Rust-recovered active child Session after durable cancellation fencing and retains CANCELLING until receipt reconciliation. Source regression added; no checks run. P1 verifier dispatch/fresh-process UNKNOWN acceptance and P8 final-Inspect receipt restart acceptance remain blockers; dependent effects remain unavailable.


### 2026-10-20 09:00 UTC — active source integration checkpoint

Repo-only boundary is absolute and supersedes the prior one-time attachment permission. P1/P6/P7 are the active whole-phase owners; P2 is PHASE_PARTIAL and awaits P1/P8 integration; P3/P4/P8/P9 and final gates remain open. P2 source now finalizes a Run only after exact verified Attempt settlement and recovers VERIFYING by replaying only finalization then P8 settlement; cancellation interrupts only the exact recovered child after durable fencing. P7 added read-only checkpoint list exposure through SDK/TUI. Automation definition changes now use canonical prepare_user_effect, Guard approval and one-use leases: Core carries the server-generated action/challenge/lease/input-digest projection, P1 owns HostKernel/CAS/reconciliation, and P7 owns route/UI orchestration. P5 remains disabled while Core's 11 configured route IDs exceed HostKernel's five keyless fixed route policies; P6/P1 are implementing the SecretBroker-backed routes. No tests/builds/typechecks/audits/provider probes were run. All phase acceptance and release status remains PARTIAL / NOT VERIFIED.


### 2026-10-20 09:01 UTC — automation Guard receipt ownership refinement

P1 repaired Guard's supported-action policy for automation definition CRUD and retains the server-generated action identity. Parent's narrow Core supervisor extension returns the generated action identity and capability plus optional Guard challenge/input digest, and rejects automation calls outside ServerAuth/no-Session scope. P7 added Rust AutomationRegistry guarded CAS methods; it computes a post-CAS receipt-core digest excluding proof fields and persists that digest with challenge/EffectIntent/lease digests in one OwnerLog commit. P1 owns HostKernel binding/one-use lease and EffectHost durable PREPARED/SETTLED receipt; P7 owns registry and Core/TUI integration. Use the Guard inputDigest as semantic request digest rather than recomputing Rust MessagePack canonicalization in TypeScript. Add exact idempotency reconciliation as read-only and never replay the mutation. No tests/builds/typechecks run.

### 2026-10-20 09:19 UTC — source continuation; no acceptance promotion

The latest user instruction makes the repository-only boundary absolute, including C: metadata,
external services and remotes. No input outside `agentx` is required. Active whole-phase owners:
P1 Guard/ExecutionHost, P7 streaming/artifacts/automation/rewind, P8 resources/worktrees/RC0.

Parent source work adds the Core adapter for P1's authenticated artifact read contract:
`artifact.read-context-v1`, `artifact.v1/artifacts.inspect`, and bounded `artifacts.read_range`.
Core repeats the exact ArtifactRef in the request body and private authenticated context, requires
ServerAuth and a matching managed Attempt Session/Location, and caps reads at 768 KiB. The
supervisor exposes narrow inspect/range methods for trusted callers. Public routes may not take
Attempt scope from clients; they must resolve it from authenticated managed verification state.
Direct Attempt artifact reads remain unavailable. This is source only and does not satisfy P7
acceptance; no tests/builds/typechecks/audits/providers were run. V1 remains PARTIAL / NOT
RELEASED.

### 2026-10-20 09:11 UTC — repo-only boundary reaffirmed and integration routing

The user's repo-only boundary is absolute and has no exceptions. No external path, `/mnt/c`, home-memory service, external service, or Git remote is required; OpenCode/Codex references are already in-repository. Active whole-phase owners: P1 Guard/ExecutionHost, P7 streaming/artifacts/automation/rewind, and P8 resources/worktrees/RC0. P1 source-integrated guarded automation CRUD/reconcile and matching Summary DTOs; invocation remains disabled. P7's mutation affordances are explicitly unavailable and send no mutation request. P7 found ArtifactStore bounded read-permit APIs but no HostKernel/Core/TUI read path; P1 owns authenticated HostKernel handlers, P7 owns Core/HTTP/SDK/TUI projection. P8 added truthful resource-limit status, RC0 ingestion checks, and an in-memory pressure controller; live/durable ingress remains gated until the existing Config/HostKernel owners provide an authenticated typed policy pin. No tests/builds/typechecks/audits/probes run. Git remains mixed and preserved; `kernel/target` is 627 MB. V1 remains PARTIAL / NOT RELEASED.

### 2026-10-20 09:21 UTC — implementation continuation

P7 returned PHASE_PARTIAL after adding Core managed-artifact decoding and fixing ArtifactStore
independent range reads with repeated authorization/no-follow/digest checks. The first-party
Core module is explicitly Git-visible. Artifact HTTP/SDK/TUI routes remain unavailable until an
authenticated server-side resolver can provide the current managed Attempt scope for the
transcript source ref; no caller-supplied Attempt authority is accepted. The freed phase slot
is assigned to whole-phase P3 RepoIntel/cache; active implementation owners are P1/P3/P8. P8's
cache bridge still requires P1 HostKernel's Arc generation pin-count and exact candidate
revalidation/retirement API. Tests/builds/typechecks/audits remain deferred by the user. V1
remains PARTIAL / NOT RELEASED.

### 2026-10-20 09:23 UTC — source-only owner handoff

P3 remains PARTIAL pending P1's HostKernel-owned RepoIntel generation identity/pin-count and
candidate revalidation/retirement interface; no second cache registry or premature reclaim
callback is authorized. P8's pressure controller entrypoints are crate-private until
authenticated policy ingress is wired. The P3 slot is assigned to whole-phase P2 managed
vertical. Active owners: P1/P2/P8. P7 remains PARTIAL: its artifact read API is source-integrated
but public routes, checkpoint effects and automation invocation retain their current scope,
Guard and evidence prerequisites. No checks were run. V1 is PARTIAL / NOT RELEASED.

P5 correction (09:24 UTC): a settled HostKernel success with an absent or undecodable result
body is now `RESULT_UNAVAILABLE` with its receipt ref, never cascade exhaustion. The serial tool
settles that known terminal result and does not retry. Added an unrun source regression covering
absent, empty and malformed result bodies. Implementation only; validation remains deferred.

### 2026-10-20 09:27 UTC — P2/P8 integration delta

P2 found the managed terminal projection omits existing Attempt usage-ledger totals, cost/token
provenance and UNKNOWN remainder, accounting cursor, and ceiling digest required by §37.22.
P2 owns the `managed_control.rs` projection and TS decoder; P1 will bind the exact summary into
settlement and P8 consumes only that proof. P1 also defined pre-admission authenticated
ResourcePolicy pinning to Rust's deterministic candidate Attempt; P8 receives only the effective
per-Run worker cap, never a Run cap applied globally. These remain source implementation tasks;
feature use stays unavailable pending integrated acceptance. No checks were run.

### 2026-10-20 09:32 UTC — P2 terminal accounting source delta

P2 now derives a typed terminal/candidate usage summary from durable Attempt usage receipts and
includes it in both state digests. It distinguishes known token/cost subtotals from UNKNOWN or
ESTIMATED remainder, records aggregate metric/cost provenance, accounting cursor, ceiling digest,
stop reason, receipt count and the BLAKE3 receipt-chain digest. Missing accounting is not
fabricated as zero; a settlement candidate requires the durable ledger. Core validates and
preserves the strict summary shape for candidate and successful settlement recovery. P1 owns
HostKernel serialization; P8 consumes the exact authenticated terminal proof. Source fixtures
are unrun. P1 verifier/HostKernel integration, P8 receipt/restart acceptance and P2 full-phase
acceptance remain open; no effects enabled.

### Active source continuation — 2026-10-20 09:31 UTC

Whole-phase implementation is active for P1, P2 and P8. P2's durable usage summary and P8's
authenticated pre-admission ResourcePolicy pin/per-Run ActiveWorkers cap are source-present and
await P1 HostKernel integration; P1 is continuing Guard, ExecutionHost, and generation-retire
integration. The direct-child lifecycle adaptation uses the local OpenCode/Codex source patterns
recorded in §42.12 while retaining HorizonCode's Core Session and Rust Attempt authorities.
P5's cascade remains unavailable while the first-party SecretBroker transport authorizer and
Guarded dispatch are incomplete. No tests/builds/typechecks/audits have been run during this
implementation-first wave. These are source checkpoints, not phase acceptance; all V1 release
gates remain open.

### 2026-10-20 09:36 UTC — P2 source audit and user-facing accounting projection

Source audit across authenticated review, explicit `goal.start`, pinned AgentProfileV2, Run
control, Task dispatch, current workspace revision, verifier, final Inspect, and Core→TUI found
the principal flows present. The remaining independently implementable projection gap was that
the GoalVerification HTTP schema and TUI omitted the new Rust-bound terminal usage summary. The
HTTP response now carries the typed summary; the TUI requires it for `SUCCEEDED` and displays
known token/cost subtotals alongside UNKNOWN/ESTIMATED remainder and cost provenance. Candidate
and terminal decoder also enforce nonzero cursor/receipt count, status consistency, and cursor ≤
the exact managed revision. No checks run. Actual verifier dispatch/restart and final-Inspect
receipt recovery remain blocked on P1/P8 evidence, so P2 is still PARTIAL / NOT ACCEPTED and
managed effects remain disabled.

### Live execution ledger — 2026-10-20 15:12 UTC

- **Active whole-phase owners:** P1 Guard/ExecutionHost; P2 managed vertical; P8 resources,
  worker/worktree lifecycle, recovery and RC0. Prior owners terminated due to platform usage
  limit; the new wave has non-overlapping source ownership.
- **Parent-owned:** P5 web-search continuation. MCP response parsing now caps wrapper blocks at
  32 and text wrappers at 128 Ki characters before JSON decoding; Guard/SecretBroker dispatch
  stays disabled.
- **Queued:** P3 RepoIntel/cache, P4 LSP/DAP/REPL, P6 providers/settings/Doctor/S1, P7
  streaming/artifacts/automation/rewind. Assign whole-phase owners as slots free.
- **User boundary:** work only inside `agentx`; no external paths, `/mnt/c`, services, or remote
  Git. Preserve mixed Git state; no stage/commit/push/cleanup.
- **Validation:** user requested implementation first; no tests/builds/typechecks/audits/probes/
  benchmarks run. All phases and integrated release acceptance remain incomplete; V1 is
  PARTIAL / NOT RELEASED.

15:13 UTC P5 update: MCP response decoding bounds content blocks/text size, and HostKernel
`NEEDS_APPROVAL` now remains a typed `NOT_DISPATCHED` outcome. Both are source-only changes;
no checks ran and search remains disabled pending integrated P1/P6 acceptance.

15:14 UTC P2 source update: managed `STOPPED` usage now denies new coding effect intents in
single-effect and atomic batch reducers, and Core stops the stream/prompt loop after recording
the step's usage receipt. Verifier work in VERIFYING is unaffected. This is implementation only;
validation remains deferred.

15:17 UTC phase update: P2 returned PARTIAL after source-only STOPPED usage enforcement; P4 now
owns the full LSP/DAP/REPL client phase. P8's PSS pressure consumer is source-present but advisory
and unavailable without configured hysteresis plus authenticated product ingress. P1 retains
Rust Guard/HostKernel scope and is continuing verifier recovery and metadata-only BYO SecretBroker
authorization; P6 will wire the existing in-process ProviderTransport. No tests ran. All changes
remain inside `agentx` and HorizonCode V1 is PARTIAL / NOT RELEASED.

15:18 UTC DEC-V1-06 binding finalized in `arch_V1/12-DOMAIN-SCHEMAS.md`: requester identity is
an opaque stable digest of authenticated HostKernel principal; managed `runRef` is exact; profile
scope hashes pinned AgentProfileV2 ID/revision/digest. Missing profile pin denies BYO. P1 writes
the metadata authorization projection; P6 reuses the in-process ProviderTransport. No bytes or
SecretBroker leases cross RPC.

15:19 UTC: P8 pressure hysteresis is now bounded per owner and resets after restart, but remains
advisory/unwired and non-durable. P4 has source for trusted launch-profile projection and strict
Attempt envelope validation; it returns approval only, with process effects disabled pending P1
and OS-enforcement evidence.

### Live execution ledger — 2026-10-20 15:22 UTC

- **Active whole-phase owners:** P1 Guard/ExecutionHost; P6 providers/settings/Doctor/S1; P8
  resources/workers/worktrees/recovery/RC0. P4 returned PHASE_PARTIAL after safe source-only
  resolver/protocol hardening. P2 has source-only STOPPED admission enforcement but remains
  PARTIAL pending dependencies and integrated acceptance.
- **Parent-owned:** P5 web-search cascade source; runtime remains disabled pending P1/P6.
- **Queued:** P2 continuation, P3 RepoIntel/cache, P7 stream/artifacts/automation/rewind. Start
  each as a whole-phase owner as slots become available; P1 also owns the shared Rust protocol
  journal/transport required by P4.
- **Boundary:** repository-only; no external paths/services/remotes. Preserve mixed Git state; no
  staging, commit, push, or cleanup.
- **Validation:** implementation-first hold remains active; no tests/builds/typechecks/audits,
  provider calls or benchmarks. V1 remains PARTIAL / NOT RELEASED.

15:25 UTC source progress: P8 added a non-Clone HostKernel-only cache observation receiver
with sequence/epoch/freshness fencing; it remains inert until P1 authenticated ingress and P3's
caller/eviction callback exist. P6 added typed `NoModelsError` if OpenCode or an eligible free
model is missing, then returned PARTIAL. Its SecretBroker search composition awaits P1's confirmed
metadata-only projection. The freed slot is assigned to whole-phase P7 (streaming, renderer safety,
artifacts, analytics, automation and checkpoint/rewind). Active owners: P1/P7/P8. P2/P3/P6
continuation remain queued. No validation ran.

15:28 UTC P8 corrected its RC0 sampler's unsupported-platform label to identify the actual host
system rather than claiming every non-Linux target is Windows. The source regression is unrun.
Cache ingress still requires P1 authenticated mint/transport and P3/Core event plus generation
release integration; P8 continues other source work.

15:30 UTC P8 now requires a bounded nonempty durable `usage_accounting` chain for VERIFIED
worker settlement, validates optional failed/quarantine summaries, and binds all summary fields in
a versioned proof digest. P2 must compose this exact usage contract into managed completion.
Source only; no validation ran.

15:32 UTC P8 returned PARTIAL after closing independent source work. Remaining P8 integration
depends on P1 authenticated cache mint/RPC, P3's Core event and generation-release composition,
P1/P2 verifier/quiescence/final-Inspect recovery, supported OS quotas and RC0 attestation. The
freed child slot is assigned to whole-phase P3 RepoIntel; active owners are P1/P3/P7. P2/P6/P8
follow-ups remain queued. No validation ran.

15:27 UTC P7 source update: the authenticated HorizonCode TUI automation manager now shows request
scope, action version/digest, timezone, overlap/missed-run policy, retry bounds, next/current
occurrence, latest result, and `needs_you` when present. Missing occurrence information is reported
as unreported. Definition mutations and invocation remain unavailable pending integrated P1
Guard/lease/receipt evidence. Checkpoint capture/restore and artifact HTTP/TUI reads still depend on
P1 HostKernel contracts and trusted managed Attempt scope. No tests/builds/typechecks/audits ran;
P7 remains active and V1 remains PARTIAL / NOT RELEASED.

15:39 UTC P2 closed the source projection seam for P8's durable usage summary in managed
completion/candidate/recovery decoders: bounded metrics, nonzero cursor/receipt counts,
receipt_count ≤ cursor ≤ managed revision, and complete lowercase BLAKE3 ceiling/chain digests.
Finalization remains gated on P1 verifier/quiescence and P8 settlement recovery. Active owners
are P1/P2/P3. No validation ran.

15:41 UTC P1 now rejects supplied RepoIntel continuation cursors before Location lookup/source
collection; P3 lexical partial results omit cursors until authenticated cursor leases exist. P1
identified P6's fixed Brave transport profile as GET + `x-subscription-token`; P6 must allow only
that exact tuple. Fresh verifier recovery remains disabled because UNKNOWN journal recovery does
not prove prior-process quiescence. P2 consumes P8's canonical usage proof with the current five
Rust-emitted metric names. No validation ran.

15:36 UTC P7 returned PARTIAL after its independent read-only TUI automation projection. Checkpoint
operations still require P1 trusted workspace/VCS observation and Guarded HostKernel operations;
artifact reads still require P1 authenticated handlers and trusted Attempt resolution. The freed
slot is assigned to resumed whole-phase P2, including composition of P8's durable usage-accounting
proof. Active owners are P1/P2/P3. No validation ran.

15:44 UTC P2/P1 found a cancellation race where provider completion during CANCELLING can lose
the usage receipt because `record_usage` is RUNNING-only. P2 owns the receipt-only reducer update;
P1 owns the narrow HostKernel allowance. Coding-effect admission remains denied during
cancellation. P1 protocol journal, verifier quiescence, durable BYO receipts and cache mint remain
unimplemented/gated. No validation ran.

P3's current source pass adds bounded lexical candidates from immutable HostKernel generations,
exact UTF-8 byte ranges, file digests and deterministic node IDs. Overlay mode and semantic
definitions remain unavailable; Core and HostKernel reject unauthenticated cursors before source
collection. Bounded pagination waits on P1's authenticated cursor lease. No validation ran.

15:47 UTC P1/P2 completed the source seam: CANCELLING usage-only receipt append accepts exactly
one revision increment attributable to RequestCancel; Rust uses its current revision for proof/CAS
and rejects unrelated stale changes. Coding effects stay exact and RUNNING-only. No validation ran.

15:49 UTC P1 tightened revision rules: equality only in RUNNING; CANCELLING usage requires the
captured scope to be exactly one RequestCancel revision behind the HostKernel snapshot. P2 added
a 4,096-entry receipt-chain decoder cap. No validation ran.

15:51 UTC P2/P3/P7 returned PARTIAL after independently runnable source work. Active whole-phase
owners are P1/P6/P8: P1 owns HostKernel protocol journal/verifier/BYO/cache-mint work, P6 owns
metadata-only SecretBroker transport and provider/settings/Doctor/S1 gaps, P8 owns cache and
settlement recovery. P2/P3/P7 resume when their dependencies land. No validation ran.

15:55 UTC P5 now exposes a gated metadata-only HostKernel search-secret authorization seam; no
route dispatch or network call uses it. P6 added a strict in-process SecretBroker/ProviderTransport
adapter with provider-specific profiles, including fixed Brave GET/header. It remains inert pending
P1 durable per-route PREPARED/dispatch/receipt and Guarded send. P8's planner excludes positive
cache pins and preserves UNKNOWN allocation without an authenticated process sample. No validation
ran.

15:58 UTC P6 returned PARTIAL after strict projection decoding and local one-use SecretBroker
consumption source; no network sender or cascade call is wired, pending P1 durable route receipts
and Guarded send. P4 resumed Core LSP/DAP lifecycle implementation against P1's HostKernel
protocol journal. P8 binds worker samples to durable child source revision, excludes positive cache
pins from planning and reports unmeasured physical allocation as UNKNOWN. Active owners P1/P4/P8.
No validation ran.


## 2026-10-20 15:50 UTC — P1–P8 implementation continuation

The user resumed the full P1–P8 source implementation and asked to defer tests/builds/typechecks/audits until implementation is complete. Active whole-phase owners are P1 Guard/ExecutionHost, P6 providers/settings/Doctor/S1, and P7 streaming/artifacts/automation/checkpoint. P1–P8 remain the full requested delivery target. P2 and P4 returned source-only partial; P3 is queued for a slot; P5 remains parent-owned. P8 returned source-only partial after P1/P8 integrated more source seams.

Current source deltas: P1 added a durable typed protocol IO/event journal and typed LSP reply subject/receipt, all still release-gated; BYO search route attempts now persist PREPARED/DISPATCHING/settled or UNKNOWN, with restart recovery, and P1 is defining the resumable Rust-owned aggregate step needed to retain one cascade state machine. P1 also mints authenticated RepoIntel cache observations and exposes exact HostKernel retirement composition. P2 fixed `goal.start` so it captures the intended root Session before confirmation, and source review confirms immutable AgentProfileV2 child pins plus authenticated Goal/review/start/control TUI paths. P4 binds protocol requests to direct/managed Attempt scope and composes the authenticated RepoIntel reader without filesystem fallback; process effects remain disabled. P8 binds the full five-key usage summary into final-Inspect candidate v2, adds exact Pending/Completed Inspect receipt recovery, keeps source bytes separate from physical allocation, and binds worker source revision into RC0 schema v3. P6 is composing its fixed SecretBroker sender with P1's durable per-route transitions; P7 is continuing full source work.

Remaining source/dependency items: P1 Guard/ExecutionHost and Linux confinement integration, managed verifier quiescence, final protocol replay/recovery and aggregate BYO pause/resume; P2/P8 managed Inspect/settlement wiring; P3 authenticated pagination/cursor and cache lifecycle, plus parser-backed semantics; P4 P1 protocol/launch gates and OS-enforced REPL quotas; P5/P6 one Rust-owned search cascade with SecretBroker route callback, provider/settings/Doctor/S1 source completion; P7 guarded automation/checkpoint/artifact operations; P8 trusted cache pressure trigger/consumer, RC0 HostRun and independent attestation. Effectful paths remain unavailable wherever Guard, receipt, or OS enforcement is not yet accepted.

No tests, builds, typechecks, audits, provider calls or benchmarks were run. This is source status only; no phase is VERIFIED or RELEASED. The shared mixed Git state is preserved; no staging, commit, push or cleanup was performed.


## 2026-10-20 16:00 UTC — P5 bounded response projection and P1/P6 search handoff

Parent added a Core-side structural/UTF-8 size bound for HostKernel web-search response bodies before parsing or retaining provider data (20,000 nodes, depth 24, individual strings 2 MiB, aggregate accounted body 4 MiB); malformed cycles, non-finite values and unsupported values are rejected. This is source-only and web search remains gated. P1 is wiring the durable aggregate cursor to BYO attempt authorization/settlement. P6 is composing the fixed SecretBroker sender through HostKernel begin/settle/UNKNOWN transitions, using a strict DISPATCHING permit and a durable SETTLED receipt. P6 confirmed `resultCount:null` is accepted for HTTP success, leaving semantic parsing in Core. P1 has not yet published the aggregate pause/resume DTO. No checks/builds/typechecks/audits/provider probes ran. P1/P6/P7 remain active whole-phase owners; P2/P3/P4/P8 work is queued for available slots. V1 remains PARTIAL / NOT RELEASED; mixed Git state preserved.


## 2026-10-20 16:05 UTC — P6 source handoff; P2 slot refill

P6 returned PARTIAL after its currently independent source work: provider/model availability and truthful free-route selection, requested/effective settings, offline Provider Doctor/API/TUI, S1 owner-chain projection/filter/callback/mixed-effect denial, provider/model switching, and Auth-owned HostKernel begin → fixed SecretBroker request → settle/UNKNOWN with strict permit/receipt matching. It remains integration-blocked on P1's Rust aggregate pause/resume plus parent P5 wiring; network execution stays unavailable. P2 has resumed as whole-phase owner for managed Task/Attempt, authenticated review/verifier, workspace revision, TUI delivery and lifecycle recovery; P1 and P7 continue. P3/P4/P8 remain queued for slots. Parent P5 added bounded HostKernel response projection and awaits P1's exact cascade DTO before Core resume wiring. No verification ran; source only, V1 PARTIAL / NOT RELEASED.


## 2026-10-20 16:10 UTC — P1/P5 cascade continuation boundary; P2 inbox pagination

P1 has now source-wired the initial Rust aggregate pause: after any earlier keyless routes, it durably links the exact one-use BYO authorization attempt to a HostKernel-owned ordered cursor and returns `WAITING_SECRET` with cascadeRef/Digest, route-plan digest/index, next-route authorization, and prior route receipts. P1 is implementing `resume_search_cascade`; Core must validate/forward P6's exact bounded provider response and durable settled receipt, while Rust retains route/retry/fallback authority. Parent P5 now strictly decodes the bounded continuation envelope and rejects orphaned fields, invalid index/digests, terminal prior attempts, and scope transitions; it currently remains gated and does not yet dispatch/resume the secret route. P2 added bounded on-demand Goal-review inbox pagination via the authenticated cursor, keeping each request capped at 64. No checks/builds/typechecks/audits/provider calls ran. P1/P2/P7 active; P6 source handoff partial; P3/P4/P8 queued. V1 remains PARTIAL / NOT RELEASED.


## 2026-10-20 16:15 UTC — P2/P7 partial handoffs; P4 resumed; P3 queued

P2 returned PARTIAL after on-demand authenticated Goal-review pagination and the prior root-Session-capture fix; its remaining acceptance is blocked on P1 verifier/effect receipts and P8 final Inspect/settlement. P7 returned PARTIAL after artifact HTTP/SDK/TUI reads, renderer/transcript redaction and bounds, stream fences, artifact fidelity and analytics provenance; automation invocation and checkpoint mutation remain unavailable pending P1-owned Guarded operations/observation DTOs. The freed slot resumed whole P4 to integrate LSP/DAP/REPL clients against P1's protocol journal and finish all independently executable source; process/evaluate/REPL effects remain gated by P1 and OS proof. P1 is implementing `resume_search_cascade` using the agreed Core binary body + P6 durable receipt; it is resolving honest EffectHost transport provenance for non-socket SecretBroker sends. P8 resumed cache/worker source; P3 remains queued because the agent thread limit prevented starting another owner. P5 Core now sends only validated WAITING_SECRET routes to Auth, then exact receipt/body to Rust resume; final integration depends on P1 handler and transport-provenance representation. No tests/builds/typechecks/audits/provider probes ran. V1 PARTIAL / NOT RELEASED; shared Git state preserved.


## 2026-10-20 16:20 UTC — P8 cache seam handoff; P3 resumed

P8 returned PARTIAL after adding exact final-Inspect/usage binding and RC0 child-revision source; P8 reports its HostKernel-retained generation observation/retirement composer is present but unconnected at four HostKernel generation-removal callsites. It also added P8 registry invalidation, but no trusted pressure-policy ingress exists, so no cache eviction trigger is enabled. RC0 remains NOT_ATTESTED until P1 live-peer/workspace evidence and P2 independent verifier evidence; OS resource quotas and fan-out remain unavailable. P3 is now resumed as whole-phase RepoIntel owner to connect authenticated generation pagination/cursor and the P1/P8 cache sink using exact current signatures. P4 is active against P1's protocol journal; P1 continues Guard/ExecutionHost and BYO aggregate resume. P5 Core handles the strict WAITING_SECRET→Auth fixed send→Rust resume loop; it is fail-closed and not yet verified. P2/P6/P7 remain PARTIAL/queued for slots. No tests/builds/typechecks/audits/probes ran. V1 remains PARTIAL / NOT RELEASED.


## 2026-10-20 16:25 UTC — P5 authenticated BYO continuation wired in Core source

Parent P5 now validates every Rust `WAITING_SECRET` continuation against the exact next approved route before any secret send, calls P6 Auth with the response authorization plus Rust-minted cascadeRef/Digest and authenticated Attempt scope, checks the returned one-use SETTLED receipt against the bounded response, then calls `execution.v1/resume_search_cascade` with the exact receipt metadata and MsgPack binary body. Continuations are bounded by approved route count; Core never retries provider dispatch and reports UNKNOWN when a continuation cannot be reconciled. Strict response parsing rejects malformed/orphaned cursor fields and terminal prior attempts; source regressions were added but not run. P1 has confirmed `secret-broker-fixed-route` is the existing honest EffectHost receipt provenance for this non-socket transport and is implementing the resume RPC plus cancellation support. P3, P4, P1 active; P8 returned PARTIAL; P2/P6/P7 source handoffs remain PARTIAL/queued pending dependencies and slots. No tests/builds/typechecks/audits/probes ran. Search remains gated and V1 PARTIAL / NOT RELEASED.


## 2026-10-20 16:30 UTC — P3 source seam triage; P1 continuation recovery

P3 reports generation pin/query source exists, but Core currently rejects continuation cursors before Location/source read and HostKernel passes no cursor to indexd. No authenticated opaque cursor lease or Core cache notice/retirement RPC projection is published yet; P3 is continuing all independent Core pagination/cancellation/recovery and cache-consumer interface work without inventing production authority, while P1 owns supervisor/HostKernel seams. P1's BYO resume path cannot yet guarantee same-request replay after a lost nonterminal response; parent requested an authenticated read-only continuation resolver that returns the exact next prepared cursor only after a known settled failure, terminal result-unavailable after successful body loss, and UNKNOWN on ambiguity. Secret bodies will not be persisted/replayed. The existing feature remains gated. No checks/builds/typechecks/audits/probes ran.


## 2026-10-20 current owner/dependency checkpoint — source only

Requested scope remains full P1–P8; implementation is not complete. P1 Guard/ExecutionHost, P2 managed vertical and P4 LSP/DAP/REPL are active whole-phase owners; P3 is PHASE_PARTIAL; P5 is parent-owned; P6/P7/P8 are queued for newly available slots. Exact dependency edges: P2 verification/finalization→P1 trusted verifier/quiescence + P8 final Inspect; P3 cursor/cache→P1 authenticated cursor lease + P8 cache invalidation; P4 effectful protocols→P1 Guarded HostKernel journal + OS enforcement; P5/P6 search→P1 durable aggregate and P6 fixed SecretBroker route sender; P7 artifact/checkpoint/automation mutation→P1 authenticated Attempt/workspace/Guard operations; P8 cache retirement→P1 HostKernel retained-generation ownership + P3 lifecycle caller.

Source update: P3 bounded cursor and descriptor-rooted no-follow tree/manifest changes returned partial on its exact upstream dependencies. P1 now exposes gated read-only search continuation recovery; Core P5 invokes it after a lost resume response and never redispatches the provider. P1 still owns route-history append correction and mixed BYO/keyless continuation. No validation/builds/provider calls were run by explicit user direction. All release states remain NOT VERIFIED / NOT RELEASED.


16:35 UTC P5 continuation recovery update: Core now calls `inspect_search_cascade_continuation` after a lost `resume_search_cascade` response, carrying the exact settled receipt and authenticated HostKernel Attempt scope. It accepts only the resolver's Rust-owned next prepared route or receipt-only terminal/UNKNOWN result; it never repeats the provider request. This is source-only and remains behind the release gate. Parent assigned P1 three source-review fixes: append the current settled route (not the first history item), safely handle/reject mixed BYO→keyless order before any post-dispatch uncertainty, and support the documented direct Core Attempt receipt owner.

16:36 UTC P4 reports source for shared execution.v1 LSP/DAP clients with authenticated Attempt pins, bounded replay/correlation, serialized dispatch, Guard lease per outbound operation, quarantine on uncertainty, and strict callback validation. DAP attach/evaluate and all process effects remain unavailable pending Guard/confinement proof; REPL remains unavailable pending P8 OS quotas. P4 continues its whole phase. No checks ran.

### P2 whole-phase source audit — latest continuation

P2 found and closed a plan/verification mismatch: Core and the canonical Rust reducer previously
accepted up to 64 Tasks in a Run, while the current verifier reducer rejects any Run whose Task
set is not exactly one. Core now refuses zero/multi-Task V1 plans; Rust refuses new multi-Task
plans and independently fences their start, scheduler selection, and Attempt admission.
Historical OwnerLog replay remains supported. The one accepted Task must cover all accepted
criteria. Normative §12.19/§17.18 and VEO-025 now record the constraint. No tests, builds,
typechecks, audits or provider calls were run.

The remaining P2 blockers are still P1's guarded verifier dispatch/output receipt, prompt
quiescence and fresh-process UNKNOWN reconciliation, plus P8's exact final-Inspect receipt and
settlement recovery. Integrated pause/cancel/restart/stale-review/workspace-conflict acceptance
remains pending those interfaces and the implementation-wide verification stage. P2 is
PHASE_PARTIAL, not VERIFIED.


## 2026-10-20 — P1/P6/P8 continuation; P7 refill; P5 response-loss correction

The requested P1–P8 implementation remains source-only and incomplete. Active owners are P1 Guard/ExecutionHost, P8 resource/worker/cache, and P7 streaming/artifacts/analytics/automation/checkpoint (the completed P6 source pass released its slot to P7); P5 remains parent-owned. P2/P3/P4 have source-only partials and remain in the refill queue for integration after their prerequisites land.

Parent review found and corrected a P5 initial-response recovery defect in `packages/opencode/src/tool/websearch-runtime.ts`: successful exact-pin `inspect_search_cascade` recovery now feeds the existing continuation loop; failed/missing reconciliation still returns UNKNOWN without redispatch. P8 is implementing an independently durable post-settlement worktree disposition transition; Core/P2 settlement projection remains a follow-up. P6 removed the unsafe byte-to-secure-handle export and documented credential put/revoke/live Doctor as unavailable pending protected native input and a Guarded authenticated write contract.

No tests, builds, typechecks, audits, provider calls, benchmarks, or Git publication ran. Feature gates remain closed where Guard, receipts, independent verification, or OS enforcement are incomplete. The shared Git state remains dirty with no staged changes; only the repository tree was inspected. V1 remains PARTIAL / NOT RELEASED.


## 2026-10-20 — P1 terminal admission correction; P7 resumed

P1 fixed a source-level shell interpolation denial: user-action and ToolBatch consent projection had assessed residual `no_symlink/no_hardlink`, which are outside Guard's broker-process guarantee set. Those checks now use the exact configured executable/profile, bounded argv/environment, workspace-root confinement, sandbox and one-use dispatch preflight before projecting an empty residual. Denied/no-spawn behavior is unchanged; no test was run.

The released P6 slot is active on whole-phase P7. P7 is closing independent Core/TUI source gaps and recording the remaining Guarded automation and checkpoint operations that depend on absent authenticated HostKernel contracts. P1 and P8 continue their entire phase source work. No tests, builds, typechecks, audits, provider calls, benchmarks, staging, commit, or push were performed.


## 2026-10-20 — P7 analytics correction; P2 phase resumed

P7's independent source review found that the SVG raster port emitted `ui.artifact.raster_cache_entries`, but TUI analytics discarded the entry-count gauge while retaining cache bytes. The aggregation now includes per-renderer entry counts with stale-sample rejection and disposal cleanup; the source fixture and §31.17 status were updated. P7 reports stream replay/fencing, bounded redacted rendering, artifact truth/reads, question event filtering, and analytics allowlisting source-present. Automation invocation and checkpoint/rewind mutations remain unavailable pending P1 Guarded effects and trusted same-revision filesystem/VCS observations. No checks ran.

The freed P7 slot is assigned to resumed whole-phase P2 managed lifecycle/verifier integration; it is continuing Core/TUI source work while P1/P8 dependencies land. P1/P8 remain active. P3/P4 are still queued. All phases are source-only; V1 remains PARTIAL / NOT RELEASED.


## 2026-10-20 — P2 exact dirty-revision settlement projection

P2 now accepts verifier-pinned final Inspect at the exact frozen revision when the observed worktree is `CLEAN` or `DIRTY_OWNED`, while still requiring an owned, no-follow snapshot with no user-owned changes. It rejects contradictory dirty-count/status facts. `DIRTY_OWNED` completion requires P8's durable `WORKTREE_QUARANTINED` disposition; Core's normal settlement and terminal recovery projections preserve that disposition for the TUI. P2 updated §37.22. P8 is implementing the Rust durable disposition receipt and transition; P2 remains PARTIAL pending P1 Guarded verifier/recovery and P8 integration. No validation ran.


## 2026-10-20 — P2 managed source integration audit

P2's resumed source audit confirms the current Core/TUI path derives distinct reviewers from ServerAuth, rejects proposer self-review, fences decisions by exact Spec digest/revision, exposes authenticated Goal proposal/review/plan/start/control actions, and binds the root Session to principal/workspace. Managed Task dispatch carries Rust-projected AgentProfileV2 pins and ManagedAttemptScope into ToolBatch; only one direct or managed Attempt authority is accepted per effect, with refresh limited to HostKernel revision transitions. Restart recovery does not retry ambiguously consumed prompts; cancellation persists the Rust fence before interrupting the exact child. P2 added the DIRTY_OWNED exact-revision settlement/quarantine rule to §12.19/JC-RES-021. These are source facts, not acceptance. Remaining P2 source integration depends on P1 Guarded coding/verifier/final Inspect and durable verifier receipts/replay plus P8 Inspect/settlement and terminal recovery. No validation ran.


## 2026-10-20 — P1 generation invalidation; P2 recovery source reconciled

P1 added cache invalidation before known HostKernel RepoIntel lease/generation drops, using the exact retained cache key/parser-set identity; expiration cleanup uses the same helper. A registry pin/invalidation failure now aborts before dropping the generation. Trusted pressure-trigger wiring remains unresolved and stays unavailable unless the P8 consumer can accept an authenticated sample without claiming unsupported OS limits.

P2 found that §37.22 still listed same-challenge replay and terminal settlement projection as gaps although current source has exact `managed_final_inspect_replays`, fresh-challenge/full-Core-restart receipt resolution, and authenticated `managed.settlement_recovery` from terminal OwnerLog. It documented those source paths as present and superseded the stale gap statement. These remain unverified. P2 continues source integration against P1/P8; no validation ran.


## 2026-10-20 — P8 authenticated pressure and settlement contracts

P8 supplied P1 the exact pressure consumer contract: a HostKernel-minted owner-matched `AuthenticatedResourcePolicyPinV1`, a `sample_owned_resources` snapshot bound to authenticated owner/Core identity, sample sequence/time, OwnerLog cursor and WorkerPool revision, and authenticated owner context. Only measured PSS can produce the bounded hysteresis signal. The signal is advisory only; it does not enforce OS limits, authorize eviction, terminate processes, or release leases. P1 is evaluating/wiring this at authenticated ingress. Cache eviction remains disabled until a trusted trigger and generation-safe callback exist.

P8 says its new durable settlement receipt is exposed through Core/P2 with exact Goal/Run/Task/Attempt/worker IDs, disposition, proof digest, OwnerLog ID/sequence/event digest, worker-pool revision and receipt digest; P2's strict decoder binds those fields. Exact DIRTY_OWNED final Inspect requires `WORKTREE_QUARANTINED`; CLEAN reusability follows P8's full predicate. This is source integration only, not tested.


## 2026-10-20 — P2 phase handoff; P3 RepoIntel resumed

P2's independent source pass is exhausted and returned PHASE_PARTIAL. It also changed the TUI to reject Run plans containing anything other than one coding Task before the API call; Rust remains authoritative. P2 source notes now reconcile the exact `DIRTY_OWNED` final-revision evidence/quarantine rule, P8 receipt fields, and existing replay/terminal settlement recovery paths. No checks ran.

The released slot is assigned to whole-phase P3 RepoIntel (Core/indexd/Tool/TUI), to connect authenticated generation pagination and P8 cache lifecycle where exact contracts exist, and finish all independent tree/detect/document-read/fencing work. P1/P8 remain active; no validation or Git publication was performed.


## 2026-10-20 — P1 raw grep/glob process origin fenced

P1 found that `packages/core/src/ripgrep.ts` executed configured `rg` via raw `AppProcess.spawn`; HorizonCode and OpenCode-derived grep/glob tools reached it without HostKernel Guard/ExecutionHost leases. A false-by-default gate now fails before binary resolution/command construction/spawn until a HostKernel-backed read service is wired. This closes the raw process effect path with honest unavailability; P3 can provide a guarded indexed/read implementation later. No tests ran.


## 2026-10-20 — P8 separate disposition durability and truthful metadata

P8 added source for a disposition OwnerLog round-trip/required-epoch regression (not run) and corrected worktree `has_untracked` projection: nonreusable due to dirty tracked or user-owned content no longer implies untracked files. Quarantined disposition now leaves untracked status unknown; only verified clean reuse records `false`. §21.13 documents independently replayable reservation settlement and worktree disposition, with crash-pending lease ownership retained. P1 owns HostKernel settle/recovery call-site wiring; P8 continues the phase. No validation ran.


## 2026-10-20 — P8 source handoff; P4 resumed

P8 returned PHASE_PARTIAL after implementing its separate durable reservation-settlement/worktree-disposition transitions, exact disposition and pending-state projections, crash-pending quarantine/lease retention, dirty-worktree truthfulness, bounded advisory pressure tracking, and an unrun OwnerLog replay regression. OS-enforced worker limits remain unsupported; RC0 remains release-ineligible without trusted attestations. P1 owns the HostKernel settle/recovery projection wiring; changed-epoch recovery needs fresh authenticated root/Inspect plus P2 terminal proof.

The freed slot is assigned to whole-phase P4 LSP/DAP/REPL continuation, finishing independent Core lifecycle/protocol/profile work while P1 Guard and P8 OS enforcement remain prerequisites for effectful paths. Current active whole-phase owners: P1/P3/P4; P2/P6/P7/P8 are partial and will resume when dependencies/slots permit. No tests, builds, typechecks, audits or Git publication ran.


## 2026-10-20 — RepoIntel cursor and deferred disposition recovery boundaries

P3 identified that authenticated continuation cursors still lack a HostKernel lease DTO/service. P3 is implementing Core client/schema plumbing while keeping page continuation fail-closed; it must not infer or accept a model-supplied generation. P1 now owns the HostKernel lease: mint from authenticated first-page scope and bind principal/Session/Location/epoch/workspace root/generation/revision/canonical query digest/expiry/cancellation; resolve and remeasure read policy before continuation source reads.

P8's separate disposition receipt currently lacks an immutable original owner-epoch accessor. P8 is adding that P8-owned pin/API. P1 will attempt same-epoch `settle_dispatch` recovery only from HostKernel's exact pre-admission epoch; after disposition completion it returns the full settlement receipt. Any epoch/proof mismatch stays pending/conflict; Core never supplies epoch authority or treats it as terminal success. Cross-epoch release requires fresh authenticated Inspect and quiescence proofs. No validation ran.


## 2026-10-20 — P1/P3 recovery and cursor integration source seams

P1 wired same-epoch `settle_dispatch` recovery to query P8's pending disposition, compare P8's immutable settlement owner epoch to the current HostKernel FrameFence epoch, complete only the exact pending disposition, require a durable receipt, then pass through the ordinary strict resolver for `SETTLED`. Missing epoch, mismatch, or unresolved receipt remains UNCERTAIN. It depends on P8 landing the `managed_settlement_owner_epoch_for_attempt` wrapper; no cross-epoch recovery is enabled.

P3 added capability-gated Core cursor lease plumbing: strict token bound, first-page generation pin vs continuation token, no `sourceGeneration` on continuation, and authenticated RepoRead plus interrupt cancellation. Runtime remains unavailable until P1 HostKernel mints/resolves the authenticated lease. P3 is checking existing parser/index integrations for remaining semantic source work. No validation ran.


## 2026-10-20 — P8 immutable settlement epoch pin landed

P8 added `managed_settlement_owner_epoch_for_attempt(attempt_id)` derived from immutable `TrustedPreAdmissionPinsV1.owner_epoch()`. The disposition receipt now carries and digest-binds `owner_epoch`; OwnerLog requires a positive value and replay validates it against exact admission pins. Same-epoch completion also checks `self.resumed_epoch == pinned admission epoch` internally. P1's `settle_dispatch` uses this exact getter before it can complete pending disposition and project SETTLED. No validation ran.


## 2026-10-20 — P4 typed read errors; P2 settlement-receipt consumer resumed

P4 fixed LSP document-open/change to preserve typed RepoIntel stale-revision, oversized and out-of-scope errors instead of collapsing them into generic reader failure; no document text is sent after a read failure. LSP/DAP/REPL process and protocol routes remain hard-disabled until P1 Guarded process IO/confinement and OS acceptance; editor ingress and P3 read-document acceptance remain open. P4 returned PHASE_PARTIAL.

P1 approved adding an exact nested P8 `worktreeDisposition` receipt to ordinary `SETTLED`, with immutable owner epoch, final worktree operation/host receipt, observed revision, Inspect receipt, OwnerLog cursor, pool revision, settlement receipt digest and final receipt digest. The P2 whole-phase owner is resumed to update the strict decoder/TUI projection when P1 lands the Rust shape and continue any remaining source integration. P3 is implementing indexd page advancement (`RepoStructurePositionV1` as a non-authority anchor); P1 is reviewing its exact DTO before HostKernel lease integration. No validation ran.


## 2026-10-20 — P1 approved P3 indexd paging anchor

P1 approved P3's internal RepoIntel paging adapter with an exclusive last-emitted position `{path_ref, symbol_index, byte_offset}`, ordered by BTreeMap path and selector order; `byte_offset` is a UTF-8 byte offset. `next_position` exists only while more matches remain and carries no authority token. HostKernel must resolve the opaque cursor before source reads, remeasure workspace and current Guard read grant, and mint the next opaque lease bound to exact generation/revision/query. P3 is implementing the indexd/Core side; P1 owns HostKernel lease wiring. Feature stays unavailable until both are integrated. No validation ran.


## 2026-10-20 — P1 final P8 disposition receipt wire shape landed

P1's Rust source now includes an exact nested `worktreeDisposition` object in the ordinary top-level `status=SETTLED` response. Fields are `ownerEpoch`, `disposition` (`REUSABLE`/`QUARANTINED`), settlement receipt digest, final worktree operation/host receipt, observed revision, Inspect receipt digest, OwnerLog ID/sequence/event digest, worker-pool revision and final receipt digest; all are string projections from the durable P8 receipt. P2's resumed owner is wiring the strict Core decoder/TUI projection. No tests ran.


## 2026-10-20 — P1 authenticated RepoIntel cursor; P2 disposition consumer; P4 resumed (source only)

P1 added a HostKernel-owned opaque `repo_cur_<64hex>` one-use continuation lease. Its stored
pins bind authenticated principal/Session/Location, FrameFence owner epoch, the original
RepoGeneration lease key, workspace root/revision, source generation, canonical selectors and
limits, P3's internal page position, and expiry. HostKernel resolves the lease before obtaining
a Location snapshot, then rechecks current Guard `files.read`, workspace/revision and query
policy. Consume, cancellation, stale policy/revision, generation retirement and process restart
fence the token. The protocol feature remains false and `hz-kernel` does not advertise it; this
is not enabled or verified. P3 owns Core/indexd pagination, P1 owns the Rust lease.

P2 completed its source-only consumer for P8's nested `worktreeDisposition` receipt: strict
Core decoding, control-plane/SDK shape, TUI preservation/display, and recovery fixture now bind
all exact receipt fields and the outer settlement. P2's remaining managed lifecycle depends on
P1's Guarded verifier/output/quiescence and fresh-process UNKNOWN interface; phase acceptance
was not claimed. Its slot is assigned to whole-phase P4 LSP/DAP/REPL source integration.

Current active whole-phase owners: P1 Guard/ExecutionHost, P3 RepoIntel, P4 LSP/DAP/REPL. P5
remains parent-owned; P2/P6/P7/P8 are in the refill queue. Implementation-first hold remains:
no tests, builds, typechecks, audits, live provider calls, or benchmarks ran. Existing mixed Git
state is preserved. HorizonCode V1 remains PARTIAL / NOT RELEASED.


## 2026-10-20 — P2 P8 receipt digest binding corrected; P4 implementation continues

Parent's source-only integration review found that the Core P2 decoder equated the P8
worktree-disposition receipt's own domain-separated `receiptDigest` with the logical settlement's
`settlementReceiptDigest`. Rust intentionally computes these as distinct digests. P2 fixed the
decoder and recovery fixture: both digests retain independent BLAKE3 validation, while only
`worktreeDisposition.settlementReceiptDigest` is bound to the outer logical `receiptDigest`.
This correction and its fixture have not been run. The same owner has shifted to whole-phase P4
source work after finishing independent P2 integration. P1/P3/P4 are active; P2 acceptance
remains gated on P1 Guarded verifier/quiescence and final integration. No validation ran.


## 2026-10-20 — P3 bounded-page progress; P4 dependency queue; P6 resumed

P3 found and corrected a pagination liveness defect within the approved exclusive-last-emitted
position contract. When a file suffix exceeds the remaining page byte budget, indexd now records
partial/truncated coverage and continues to later files instead of stopping the page; it mints
`next_position` only after a real extra matching occurrence proves continuation progress. This can
omit occurrences in an over-budget suffix and therefore remains explicitly PARTIAL; it does not
loop or claim complete coverage. RepoIntel remains feature-disabled pending integration acceptance.

P4 reports its independent source pass exhausted: typed LSP/DAP protocol clients and authenticated
RepoIntel document reads are present, but production process lifecycle lacks the P1 Guarded
ExecutionHost prepare/launch/IO/cancel/status API and Core one-use approval adapter. Process, DAP
attach/evaluate and REPL remain unavailable; REPL also lacks supported OS CPU/memory/process/FD
limits. P4 is queued for immediate resume when P1 lands its interface. The released slot is now
assigned to whole-phase P6 Provider/Settings/Doctor/S1 source implementation.

Active whole-phase owners: P1 Guard/ExecutionHost, P3 RepoIntel, P6 Provider/Settings/Doctor/S1.
P4 is PARTIALLY_BLOCKED on P1; P2 is PARTIALLY_BLOCKED on P1 Guarded verifier/quiescence and
P8 final Inspect/settlement integration; P5 remains parent-owned; P7/P8 await slots/dependencies.
No tests/builds/typechecks/audits/provider calls/benchmarks ran. HorizonCode V1 remains PARTIAL /
NOT RELEASED.



## 2026-10-21 13:24 UTC — PLAN_ONLY authority naming correction

The effective capability-ceiling digest binds an authenticated Attempt ID and owner epoch, so it
must not appear as `permissionScopeDigest` before Attempt admission. P1/P2 instead return Rust-minted
`acceptedScopeDigest` and `profilePermissionCeilingDigest` as plan-time facts, clearly labeled as
planned scope/ceiling. The true effective permission digest is minted after an authenticated Attempt
exists. This supersedes the 13:23 plan checkpoint wording; no client-side digest derivation.


## 2026-10-20 — P3 cursor/tree source wired; semantic/cache gaps retained

P3's source now wires Core cursor schema/call DTO to P1's opaque HostKernel lease, generation
retirement/cancellation removes cursors, and indexd consumes the approved internal position.
The per-page byte-budget overflow path skips over-budget suffixes with truthful partial status
and keeps scanning later files; focused regression source was added but not run. `repo_tree`
has bounded no-follow listing/cancellation and truthful coverage metadata; `repo.detect` and
authenticated `read_document` are source-present. Cursor capability remains disabled pending
acceptance. P3 still lacks parser-backed definition/reference semantics and a trusted immutable
editor-overlay producer; these must remain unavailable unless compatible existing pinned source
and canonical ownership can be established. Cache lifecycle depends on P1/P8 generation hooks.
No checks ran.


## 2026-10-20 — P6 source audit complete; P7 resumed

P6's fresh source audit found no additional safe standalone source change: OpenCode is filtered to
active/free models at default selection, runtime rejects credential-bearing/custom-loader models
before SDK construction, and offline Doctor is authenticated, sanitized and zero-network. P6 remains
PARTIAL / NOT VERIFIED because no acceptance was run; credential put/revoke needs protected native
input plus a Guarded capability, live/full Doctor and catalog action await P1, and search cascade
acceptance depends on P1/P5. No provider calls or validation ran. The freed slot is assigned to
whole-phase P7 streaming/rendering/artifact/analytics/automation/checkpoint source work.


## 2026-10-20 — P1 process lifecycle gate and post-launch cleanup source

P1's source audit confirmed the existing LSP/DAP process path uses HostKernel profile resolution,
Guard challenge/one-use lease, EffectHost durable dispatch/receipt, exact executable/workspace
pins, one StdioExecutionSupervisor, and `horizoncode-sandbox` prepared confinement. P1 added a
false-by-default LSP/DAP lifecycle gate at profile approval, prepare and launch, and attempts
HostProcessRef cancellation if process start succeeds but protocol-journal registration fails.
The Core approval adapter is not yet composed; protocol effect gate remains false and no runtime
acceptance has been run. P4 received the exact launch/protocol DTOs and will resume integration
when its current P7 continuation releases the slot. No checks ran.


## 2026-10-20 — P7 artifact-reference bound; P4 resumed against P1 DTOs

P7 fixed a source-level artifact decoder gap: `ArtifactRef.byteLength` now rejects decimal values
above `u64::MAX`, and §31.18 records the bound. P7 otherwise reports source present for stream
sequence/source-generation fencing, activity route, bounded redacted rendering, analytics,
artifact reads/verified-scope plumbing, Rust automation journal and read-only checkpoint view.
P7 remains PARTIAL because Guarded automation invocation, checkpoint capture/restore and managed
verifier artifact settlement need P1/P2 trusted effects/evidence; integrated UI/reconnect/render/
artifact recovery journeys are deferred to the later verification stage. No checks ran.

P1 has now published the exact HostKernel LSP/DAP launch/protocol DTOs and an off-by-default
editor process lifecycle gate, with post-spawn cancellation on failed journal registration. The
freed P7 slot is assigned to resume P4's Core supervisor/approval adapter and typed lifecycle
integration in P4-owned files. P4's effects remain disabled until acceptance.


## 2026-10-20 — P3 source handoff; P8 resumed on freed slot

P3 returned PARTIAL after source wiring Core/indexd cursor pagination to P1's opaque HostKernel
lease, authenticated tree/detect/document paths, generation invalidation, and partial-over-budget
page progress. Its in-repo pinned-source gap check found no compatible semantic index: OpenCode's
Tree-sitter use is shell parsing/highlighting, and OMP parser dependencies are excluded by §42.11.
Semantic definitions/references and authenticated immutable editor overlays remain unavailable;
cursor feature remains disabled pending acceptance; authenticated pressure-triggered cache
eviction remains unavailable. A focused indexd regression was added but not run.

The released slot is assigned to a fresh whole-phase P8 resource/worker/cache owner to finish the
remaining independent Rust source integration. It must preserve unsupported CPU/memory/process/FD
OS limits as unavailable and keep pressure advisory-only. Active owners: P1, P4 and P8. P6/P7/P3
source passes are PARTIAL; P2/P4/P7 acceptance remains dependent on P1/P8. No checks ran.


## 2026-10-20 — P8 identified shared RepoIntel generation invalidation defect

P8's source review found that P1's HostKernel cache invalidation helper currently retires a
`(principal, workspace, source_generation, build_version)` key on each per-request lease removal,
even when sibling leases still retain that generation. `ensure_repo_generation` can also replace
an identical lease key without explicit old-generation retirement. P1 owns the HostKernel fix: retire
only when the final authenticated lease and Arc owner are gone, and prevent overwrite leaks; P8
provides the retention invariant/API and does not edit P1 files. Cache eviction stays disabled
without trusted pressure policy/callback. This is source review only; no checks ran.


## 2026-10-20 — P1 shared-generation cache retirement race fixed in source

P1 changed HostKernel RepoGeneration lease handling to pin parser-set/build version and file
count; exact-key retry reuses its Arc and refreshes expiry, conflicting replacement fails, and
new leases for the same owner/workspace/source-generation/build-version reuse the shared Arc only
when source revision, Guard policy digest and owner epoch agree. Removing a lease preserves the
shared cache observation while sibling leases exist; final removal requires no active external
Arc owner and successful P8 invalidation, otherwise the lease/Arc remains. Cache observation also
checks current owner epoch and exact parser set. Source-only, not tested.


## 2026-10-20 — P1 extension-origin subworker; P4 lifecycle adapter progress

A bounded P1 subworker is now implementing the plugin/MCP/hook effect-origin closure in its
exclusive Core extension files, while the P1 phase owner remains accountable for Guard and
HostKernel. Existing contracts are used where exact; otherwise effectful dispatch must be gated
false before action. No overlapping Rust/Auth/search/supervisor/TUI edits or validation are allowed.

P4 now exact-decodes Rust launch-profile identity plus consent fields (`inputDigest`, expiry,
targets, normalized targets, policy summary and full approval/residual guarantee assessment),
checks bounded shapes and target equality, and has added a shared-supervisor adapter using the
existing ServerAuth approval Deferred and one-use `resolve_approval` for `language.start` /
`debug.start`. P4 is wiring typed lifecycle RPC calls behind existing false gates. No checks ran.


## 2026-10-20 — Whole-phase source continuation (P1/P2/P4/P7; implementation only)

P1's current source pass confirmed HostKernel terminal/stdio launch is mediated by the retained confined process, Guard one-use lease and durable intent. It is now closing further subprocess origins discovered in Core Git, configured formatters, legacy snapshots, and CLI utility probes; those paths stay unavailable unless exact HostKernel mediation exists. Guarded verifier dispatch remains false because verdict/output recovery is not safely durable after a possible crash.

P2's source pass confirms the authenticated managed review/start, AgentProfileV2-pinned Task scope, per-step usage accounting, cancel fencing, evidence/final Inspect, TUI command mounting and P8 disposition decoder. Its independent source work is exhausted; integrated P2 remains gated on P1 verifier/quiescence/UNKNOWN recovery, P8 final Inspect settlement, and later acceptance. P2 recorded the exact adapted OpenCode/Codex child-lifecycle patterns in the provenance register.

P4 added a Core approval → prepare → launch adapter, typed bounded protocol read/cancel/status decoders, and reconciled the exact P1 consent DTO. It continues with LSP/DAP service installation and policy integration; all effectful process/protocol paths remain disabled pending Guard/confinement and platform proof.

A whole-phase P7 owner is now active on streaming, rendering, artifacts, analytics, automation and checkpoint/rewind source work. Existing P7 effectful automation/checkpoint/artifact settlement paths remain unavailable where authenticated P1/P2 contracts are absent.

P5 source already contains the approved ordered built-in/free and user-enabled route cascade, route controls, auth-failure fallthrough, bounded retry/cooldown provenance, SecretBroker handoff, and HostKernel aggregate/recovery continuation. P5 remains runtime-disabled pending P1/P6 Guarded transport and reconciliation integration. P3/P6/P8 source work is partial; remaining items are the documented semantic-index/editor producer, protected credential workflows/live probes, and trusted pressure/OS enforcement/attestation dependencies.

No tests, builds, typechecks, audits, benchmarks, provider calls, staging, commits, or pushes ran. The implementation-first hold remains. Existing mixed Git state is preserved. HorizonCode V1 P1–P8 remains PARTIAL / NOT VERIFIED / NOT RELEASED. Next: continue P1/P4/P7 source work, refill newly free whole-phase slots for remaining P3/P6/P8 integration, then complete all implementation before the requested verification phase.


## 2026-10-20 — P1 subprocess closure and P4 lost-launch recovery seam

P1's source sweep hard-disabled unmediated Core Git, configured formatter and legacy Snapshot effects; removed pre-kernel spawnSync probes (sysctl, PowerShell, ldd) from the CLI launcher, leaving only the bootstrap process spawn with fixed argv/stdio. No checks ran. Guarded verifier and unsupported process routes remain unavailable.

P4 identified that an accepted editor-process launch whose reply is lost cannot currently recover the HostProcessRef from execution.v1/status; a RUNNING status alone is insufficient to bind protocol IO. P1 owns the Rust status/recovery projection. It must either return the exact original reference with same-epoch and full execution/effect/challenge/location/profile binding, or return typed unavailable and cancel/quarantine. P4 keeps the protocol route disabled and will not fabricate or retry a reference.

P1/P4/P7 are the active whole-phase owners. P2 source pass is PARTIAL and waiting on P1/P8 gates; P3/P6/P8 have source-partial work waiting for phase-owner slots and/or exact dependencies. No tests/builds/typechecks/audits/provider calls/benchmarks/Git publication occurred.


P7 found that HostKernel and authenticated Core HTTP already provide Guarded automation create/update/enable/disable, but the TUI automation manager block still labels those controls unavailable and emits no request. P7 now has exclusive writer ownership of only that `packages/tui/src/app.tsx` block and is wiring CRUD through existing Guard approval. Run invocation remains disabled. Checkpoint preview/capture/restore remain blocked because the exact same-boundary filesystem/VCS observation and Guarded effect contract are absent. Source-only; no tests.


## 2026-10-20 — P1/P4 lost-launch recovery source integrated; P3 resumed

P1 implemented P4's lost-launch-ACK recovery seam in HostKernel. Same-epoch authenticated status now returns only the exact HostProcessRef retained for the running process after matching Attempt scope, principal, frame epoch, Location and effect; it includes pinned profile/executable/generation/kind/epoch and resource guarantees. If protocol/ref recovery fails, HostKernel cancels, marks UNKNOWN, durably quarantines and returns typed recovery-unavailable. Restarted/lost bindings are never reconstructed. Source-only, not tested.

P4's source owner returned PARTIAL after adding approval→prepare→launch, bounded status/read/cancel decoders and protocol binding to existing LSP/DAP clients behind caller Guard authorization. Runtime effects remain disabled pending production installation, P1 Guard/confinement, P3 document-read acceptance, DAP policy and REPL OS limits. P3 is resumed as whole-phase owner for RepoIntel Core/indexd/tool/TUI source integration; semantic parser/editor overlay features remain unavailable absent compatible pinned parser and authenticated immutable producer. Active owners: P1, P3, P7. P2/P4/P6/P8 remain PARTIAL awaiting dependencies and later acceptance. No tests/builds/typechecks/audits/provider calls/benchmarks/Git operations ran.


P1 also removed the unused `CrossSpawnSpawner`/`ChildProcessSpawner` imports and dependency from ToolRegistry after confirming no first-party Core/OpenCode consumer remained. This removes an ambient raw Node child-process implementation from the production tool layer; source-only, not tested.


P1 returned a source-only handoff after HostKernel status recovery, launch-kind alignment, and raw-spawner removal. P1 remains PARTIAL because final integrated source coverage/adversarial acceptance has not run and some effect pathways remain disabled pending acceptance; P1 must be resumed for any new safe source gaps after current phase slots free. Its code is present, not verified. P4 has resumed against the new status DTO; P4 status calls must carry the original direct/managed Attempt scope to recover a retained process reference.


## 2026-10-20 — P3 bounded response fixes; P2 resumed

P3 tightened Core continuation validation: a `nextCursor` is accepted only on a current partial page with exactly the requested maximum count and nonempty nodes, matching Rust's extra-occurrence contract. `repo_tree` now enforces a 32 KiB aggregate UTF-8 output limit while reserving room for truncation/partial notices; source regressions were added but not run. §30 is updated. Semantic definitions/references and editor overlays remain unavailable under §42.11 provenance and missing authenticated buffer producer; cursor runtime remains disabled pending integrated acceptance. P3 returned PARTIAL / NOT VERIFIED.

P2 is resumed as whole-phase owner for managed Goal/SpecVersion/Run/Task/Attempt/review/verifier/TUI lifecycle, using the landed P1 same-epoch process status recovery and exact P8 disposition receipt. It must continue independent source work while Guarded verifier/quiescence and P8 final Inspect recovery remain gated. Active owners: P2/P4/P7; P1 requires source follow-up, and P3/P6/P8 remain partial. No tests/builds/typechecks/audits/provider calls/benchmarks/Git publication ran.


P4 now integrates lost-launch status recovery in Core: after a lost launch reply it requests only exact scoped status and accepts a retained same-epoch HostProcessRef; it never retries spawn. New blocker: per-operation LSP/DAP protocol clients require their own Guard authorize callback, but Core `prepareUserEffect` currently admits terminal capabilities only and Rust rejects editor protocol capabilities. P4 will define the Core-side typed adapter and request the exact capability/lease/receipt contract from P1 while leaving protocol activation disabled. No authorization bypass or invented endpoint is permitted; acceptance must cover approve/deny, stale/replay, cancellation and receipts.


## 2026-10-20 — P7 unblocked source complete; P1 resumed

P7 wired the TUI automation manager to the existing authenticated Guarded create/edit/enable/disable and receipt path, plus a bounded exact-field definition editor. The shared approval dialog now offers `allow_once` for only the exact sessionless ServerAuth workspace-owner lane (`user_action` / `authenticated.user_action`, exact CRUD capability, valid HostKernel Location and full assessed consent); it fabricates no Session/Run identity and preserves all existing binding rules. §37.10/§45.15 and §31.20 status were updated. Invocation remains disabled. P7 also fixed stream seal/cursor eviction and source-generation scope, activity byte accounting, raster-generation fencing/fidelity, and analytics allowlists/live cache gauges; unrun regression fixtures were added. Checkpoint capture/restore and managed artifact settlement remain gated by P1/P2 contracts. P7 returned PARTIAL / NOT VERIFIED; no checks ran.

P1 has resumed on the freed slot for the exact P4 per-operation Guard/lease contract, verifier durable output/quiescence, P8 settlement/Inspect wiring, and remaining effect-origin closure. P2 and P4 continue whole-phase source work. No tests/builds/typechecks/audits/provider calls/benchmarks/staging/commit/push occurred.


P4 supplied the exact per-operation protocol Guard contract to P1: HostProcessRef + Session/Location/workspace revision + exact direct/managed Attempt, protocol sequence/method/payload digest and LSP callback correlation; Guard resolves canonical capabilities and returns a one-use lease, with durable pre-write intent and receipt. Exact replay returns the original receipt without another write; conflicts/stale authority reject; cancellation/crash/receipt loss reconcile to receipt or UNKNOWN/quarantine. DAP attach/evaluate remain denied. P4 owns Core consumers and keeps them false-gated; P1 owns Rust Guard/HostKernel admission. This is the source interface request, not yet implemented or verified.


## 2026-10-20 — P4 operation authorization contract; P8 resumed

P4 added the Core-side `EditorProtocolAuthorizationRequestV1` / lease DTO and ServerAuth-only `authorizeEditorProtocolOperation` adapter. It pins exact HostProcessRef, Session/Location/workspace revision, direct/managed Attempt, protocol sequence, method/command and operation/request digest plus LSP callback correlation; it remains fail-closed until Rust publishes matching per-operation Guard admission and durable receipts. P1 is extending the existing prepare_user_effect/Guard path with canonical method-capability binding, lease consumption and receipt journaling. Production LSP/DAP clients remain uninstalled; no operation is enabled. P4's source owner returned PARTIAL / NOT VERIFIED; further source activation depends on P1/P3/OS gates.

The freed slot is assigned to whole-phase P8 resource/worker/cache source continuation, with exact P1 ownership coordination. P8 may not invent pressure thresholds, enable eviction/fan-out, or claim unsupported OS hard limits. P1/P2/P8 source work continues; P2/P6/P7/P4/P3 remain PARTIAL awaiting dependency and acceptance. No tests/builds/typechecks/audits/provider calls/benchmarks/Git operations ran.


P8 source review found no safe pressure-triggered eviction change: `ResourcePolicyProjection` has no approved lower watermark/calm-window policy, and no authenticated ingress/consumer exists. No values are inferred from soft/hard thresholds. RC0 remains unattested without live P1 HostRun and P2 verifier evidence; OS CPU/memory/process/FD enforcement remains unsupported. P8 hardened its sample timeline so pressure timestamps strictly increase with sequence, added an unrun fixture, and corrected §18.18/cache status. P1 retains exclusive `kernel/src/host_kernel.rs` ownership during its Guard/protocol integration; P8 will not race that shared file. P8 returns PARTIAL pending P1 HostKernel integration, approved pressure policy, OS limits and independent attestation. No checks ran.


## 2026-10-20 — P6 source handoff; active implementation owners P1/P4

P6 returned PARTIAL after confirming current provider/model provenance, free-only model availability, Config controls, offline Provider Doctor, S1 owner-scoped flows and the fixed SecretBroker sender→P1 durable attempt→P5 cascade-resume composition are source-present. No standalone P6 code gap was safe to open without Guard/native consent; live Doctor and credential mutation remain gated, and no checks ran. §16, plan, HANDOFF and CURRENT_RUN are updated.

P8 also returned PARTIAL after strict pressure timestamp ordering; no trusted lower-watermark/calm-window policy exists, so no pressure eviction/fan-out is enabled. P3 and P6 source passes are exhausted. P7 source is complete but awaits P1/P2 gates. P1 is active on protocol-operation Guard/receipts and remaining P1 integration; P4 is active on matching Core lifecycle/protocol consumers; P2 remains queued pending P1 verifier, quiescence and UNKNOWN recovery. P5 remains parent-owned and disabled pending P1/P6 acceptance. No tests/builds/typechecks/audits/provider calls/benchmarks/Git publication ran. Implementable source dependencies remain; HorizonCode V1 P1–P8 is PARTIAL / NOT VERIFIED / NOT RELEASED.


## 2026-10-20 — P1/P2/P4 integration wave active

P1 is implementing the P4 per-operation protocol Guard/lease/durable-receipt path in the existing effects.v2/ExecutionHost boundary, including canonical method→capability checks and same-digest dispatch; no new approval runtime is being introduced. P4 owns the typed Core authorizer/consumer and keeps all protocol routes false-gated. P2 has resumed to consume P1's forthcoming verifier output/quiescence/UNKNOWN DTO and continue managed final-revision verification. Active whole-phase owners: P1/P2/P4. P3/P6/P7/P8 source passes are partial and source-exhausted pending integrated acceptance/dependencies; P5 remains parent-owned and gated. The current runnable dependency chain is P1 Guarded protocol/verifier → P4 LSP/DAP safe wiring and P2 managed verifier; P3 RepoIntel acceptance → P4 document sync; P1/P2 → P7 automation/checkpoint/artifact recovery and P8 RC0. No tests/builds/typechecks/audits/provider probes or Git publication ran.


P1 interface checkpoint (source in progress, 2026-10-20): protocol-operation authorization is being added inside the existing `effects.v2/prepare_user_effect` flow, with strict `ExecutionProtocolAuthorizationV1` arguments, not a new approval endpoint. Guard binds one authenticated direct/managed Attempt, process ref, Session/Location/workspace revision, protocol sequence, typed method/command and operation digest, plus exact retained callback sequence for LSP replies. The ordinary HostKernel challenge → TUI allow/deny → one-use lease is consumed by the existing durable `protocol_op`/`protocol_reply` dispatch journal; replay returns its receipt, ambiguity is UNKNOWN/quarantine. P4 Core is adapting to the proposed DTO. P1 has also begun hardening managed verifier output/evidence recovery; existing managed verifier RPCs remain disabled. These are implementation checkpoints only, not settled wire contracts or acceptance evidence.


Implementation update: P1 will make Rust the sole canonical MessagePack+BLAKE3 producer for `ExecutionProtocolAuthorizationV1.operationDigest`; Core may omit it, and any supplied value must match. HostKernel retains the digest in the Guard challenge and recomputes it at dispatch. P4 is aligning its request/lease DTO and will not hash JSON independently. P2 also added shared strict BLAKE3 validation for managed `challengeSetDigest` across settlement recovery, start/SETTLING, approval resolution and execute result decoding; source-only, not tested.


P1 source clarification: P8's managed final-Inspect path is already present in HostKernel, including exact current revision, candidate-bound approval, guarded git.worktree.list, durable lease/receipt, reconciliation and nested worktree-disposition projection; P2's decoder/settlement consumer is source-present. P2 must not invoke changed-epoch pending-disposition reconciliation as a successful terminal shortcut. Remaining managed verifier gap is process-tree quiescence after abrupt HostKernel death: RunningChild Drop does not kill, stdio handles and process identity are only in memory, so UNKNOWN does not prove descendants are stopped. P1 is investigating the existing sandbox OS process-tree contract; verifier stays disabled unless an OS-owned lifetime/quiescence proof is implemented and later accepted.


## 2026-10-20 — Guarded editor protocol admission source landed

P1 source-landed per-operation LSP/DAP authorization inside existing `effects.v2/prepare_user_effect`. HostKernel strictly decodes `ExecutionProtocolAuthorizationV1`, requires exactly one authenticated direct/managed Attempt, exact same-epoch HostProcessRef/current workspace revision/next journal sequence, derives canonical MessagePack+BLAKE3 operation digest, validates the LSP callback against the exact retained event/request/method, and stores the full canonical DTO in the approved CapabilityBinding. `protocol_op`/`protocol_reply` dispatch now match that retained DTO before durable PREPARED → one-use lease consumption → DISPATCHED receipt; conflicting or stale replay rejects and ambiguous writes fence UNKNOWN. Runtime protocol gate remains false. P4's Core authorizer now sends this exact typed subject and verifies the complete challenge/lease pins before granting the frame lease; P4 is integrating consumers behind false gates. Source-only; no checks ran.

P1's managed verifier remains disabled pending a process-tree quiescence proof and durable typed output/evidence recovery across crash/restart. Plain child kill or UNKNOWN is not sufficient. P1 is evaluating the existing bubblewrap `--die-with-parent` process-tree confinement plus the sandbox guarantee; P2 is preparing the managed verifier consumer against the existing route names while awaiting P1's settled evidence DTO. No tests/builds/typechecks/audits/provider calls/benchmarks/Git publication.


P1 source hardening: `horizoncode-sandbox::PreparedExecution::spawn` now arms Linux direct children with `PR_SET_PDEATHSIG(SIGKILL)` and checks the captured HostKernel parent PID immediately after spawn to close the pre-exec race. The confined stdio path already requires ProcessTree=ENFORCED; only bubblewrap currently satisfies that contract, with `--unshare-all`, `--new-session`, and `--die-with-parent` in a fresh PID namespace. P1 updated the guarantee notes, sandbox README and §42 local-source comparison. This is source, not acceptance: verifier/runtime gates remain false until crash/restart quiescence is proven; durable verifier output/evidence is still not recoverable after restart and must remain honest UNKNOWN.


P2 source update: managed verifier artifact-reference decoding now enforces the existing Rust ArtifactStore bounds (≤64 KiB per ref, ≤4 MiB aggregate manifest refs, ≤32 criteria ×64 refs) and preserves BLAKE3 digest validation. Core route callsites already match `begin_verification` → `resolve_verification_approvals` → `execute_verification`, with terminal `settlement_recovery`; no safe adapter can consume the verifier output until P1's durable typed evidence/quiescence DTO lands. P2 remains PARTIAL and is releasing its implementation slot until that DTO is available. No tests ran.


## 2026-10-20 — Managed verifier durable evidence source confirmed; P2 resumed

P1's current source review confirms the verifier already commits exact typed `ObservedVerifierRunV1` plus bounded ArtifactStore refs to managed OwnerLog before returning `SETTLING`. `settle_durable_verifier_evidence` revalidates evidence, current workspace revision, Attempt/profile and receipts; restart recovers the same SETTLING result and refs without rerunning children. Raw output bytes are not durable; a crash before OwnerLog evidence commit remains UNKNOWN/recovery-required, and orphan artifact manifests do not constitute evidence. Exact response binds Goal/Run/Task/Attempt/verificationRun/challengeSetDigest/final+source revision/settlement candidate/evidence digest/artifact refs. P2 is resumed to wire strict Core/TUI decoding and recovery. Verifier stays disabled pending Linux process-tree acceptance and later integration tests.

This supersedes the earlier tracker note that durable verifier output/evidence references were absent: typed verdict/evidence refs are source-present and restart-recoverable after OwnerLog commit; only pre-commit uncertainty remains UNKNOWN. The outstanding security gap is proven OS process-tree quiescence across abrupt kernel death. No tests/builds/typechecks/audits/provider calls/benchmarks/Git publication ran.


P4 source update: Core's editor-protocol authorization lease now retains the exact direct/managed Attempt projection; the LSP/DAP composition comparator normalizes wire BigInt epoch/revision values to canonical decimal strings before exact comparison. §37.6–37.7 now describe composed `prepare_user_effect` → authenticated approval/one-use lease → typed per-operation dispatch and current false gates. Production paths remain unavailable pending P1 Guard/receipt/OS acceptance, P3 authenticated document-read acceptance and production editor ingress; DAP attach/evaluate/variables and REPL remain gated. No checks ran.

## 2026-10-20 — P2 handoff; P4/P7 active; CodeMode redaction

P2 completed its current managed verifier/recovery Core/TUI source pass PARTIAL / NOT VERIFIED and found no further safe source gap. It strictly decodes HostKernel evidence/UNKNOWN, approved criteria, exact final revision, bounded artifact refs, final Inspect/P8 receipts and canonical HTTP digest/revision fields. Effectful verifier/finalization remain disabled pending P1 process-tree quiescence and integrated lifecycle acceptance. P4 resumed to compose the authenticated P3 document reader into supervised LSP lifecycle against P1's typed Guard boundary. P7 resumed on remaining streaming/rendering/artifact/automation/rewind source. P6's Core safe-boundary consume/ACK source is complete but waits for P1 HostKernel integration. Parent removed raw nested tool arguments from CodeMode metadata and updated expectations; CodeMode remains hidden until Guard mediation. No checks/evaluations/provider calls/Git publication ran.


P2 consumer update: the existing Core managed verifier decoders match P1's durable `SETTLING` response and terminal `settlement_recovery` projection; they bind Goal/Run/Task/Attempt, verification run, challenge set, exact final/source revision, evidence digest, candidate and artifact refs before final Inspect/settlement. Verifier approval now passes both HostKernel-projected canonical root and workspace ID to the existing modal. For a fresh approved challenge set, Core also requires the verifier evidence criterion set to equal the approved criteria. The HTTP schema validates final/source revisions as BLAKE3 and OwnerLog revision as decimal u64; it admits the five bounded HostKernel UNKNOWN reasons, and the TUI carries them into specific reconciliation guidance. No verifier dispatch was enabled. P2 remains PARTIAL pending process-tree quiescence acceptance, integrated pause/cancel/restart/recovery acceptance and the final cross-phase verification wave. No tests/builds/typechecks/audits ran.


## 2026-10-20 — P5 full-source reconciliation (implementation only)

P5 re-read §§16.7/33.4/37.5/42.12 and traced Config, Settings, ToolRegistry/ToolBatch,
Core WebSearchRuntime, P6 Auth ProviderTransport, and P1 HostKernel fixed routes. Source now
contains the approved five-route keyless default order plus six explicitly enabled BYO routes,
auth-4xx fallthrough, bounded retry/cooldown and per-route provenance, one aggregate Guard
effect, fixed Rust transports, one-use SecretBroker attempt receipts, continuation, cancel,
and exact-pin read-only UNKNOWN/result reconciliation. The legacy direct HttpClient search
helper is parser-only. Corrected stale status in §16.7, §37.5 and HANDOFF. No tests, builds,
typechecks, audits, or provider calls were run. This is CODE_PRESENT/WIRED source only; the
false-by-default `WEB_SEARCH_RUNTIME_READY` gate remains until integrated P1/P6 acceptance.
P5 remains PARTIAL / NOT VERIFIED; no independent safe P5 source change remained.

## 2026-10-20 17:55 UTC — phase ledger checkpoint (implementation only)

| Phase | Owner | Source state | Remaining work / dependency | Evidence state |
|---|---|---|---|---|
| P1 Guard / ExecutionHost | `p1_guard_v1` | Direct-message OwnerLog journal and HostKernel prepare/approval/lease/commit/inspect source; new module explicitly Git-visible. | Finish P1 whole-phase origins, verifier quiescence/recovery, direct-message integrated contract and cross-phase acceptance. Keep runtime gates false. | No validation run. |
| P2 managed vertical | queued/partial | Managed Goal/review/start/Task/verifier consumer source is present from prior owner pass. | Resume for P1 process-tree quiescence, final-revision verifier/Inspect settlement and recovery integration; do not enable fan-out. | No validation run. |
| P3 RepoIntel | partial | Bounded RepoIntel/document source exists. | Authenticated lifecycle/cache integration, real query-to-patch flow; semantic parser/editor overlay still lacks approved provenance/trusted producer. | No validation run. |
| P4 LSP/DAP/REPL | `p4_lsp_dap_repl` | Resumed full-phase Core lifecycle/protocol source work against P1 typed Guard contract. | Integrate P1 Guard and P3 document boundary; policy/OS limits; keep unsupported/effectful paths unavailable. | No validation run. |
| P5 web search | parent | Ordered cascade and SecretBroker/HostKernel composition are source-present. | Integrated P1/P6 admission, recovery, consent and route-failure acceptance. | Runtime disabled; no validation run. |
| P6 providers/settings/Doctor/S1 | `p6_agents_provider` | Durable Core inbox and guarded queue-message route/UI are source-present; safe-boundary consumer is in progress. | Finish consumer/recovery, remaining source work; follow-up requires a new trusted Attempt. | No validation run. |
| P7 streaming/artifacts/automation/rewind | partial | Rendering, replay, artifacts and guarded automation CRUD source are present. | P1/P2 artifact and checkpoint receipt/observation dependencies; invocation/restore stays unavailable. | No validation run. |
| P8 resources/workers/RC0 | partial | Bounded resource/recovery source exists. Added §32.40 HUP-001..004 paired uplift and ablation specification. | Trusted pressure policy/ingress, P1/P2 settlement and HostRun attestation, supported OS quotas. | No runtime benchmark/evaluation run. |

Implementation-first hold: no tests, builds, typechecks, audits, benchmarks/evaluations, provider calls, staging, commits or pushes. Latest repo-only resource check: one worktree; `kernel/target` 627 MB; no project build/test process. Git remains mixed/unstaged. HorizonCode V1 P1–P8 remains PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-20 — P1/P2/P6 active source owners; P3 persistent store dependency

Active whole-phase owners: P2 managed vertical, P4 LSP/DAP/REPL and P6 providers/settings/Doctor/S1. P1 completed its current source pass PARTIAL / NOT VERIFIED; effects remain gated, direct-message acceptance remains outstanding, and its Core Git audit confirmed all direct process calls fail closed through AppProcess before spawn. P2 avoids P1 HostKernel and P6 inbox/session file ownership. P3 remains PARTIAL because the bounded `PersistentGenerationStore` has no production caller; authenticated protected-root selection, aggregate cache bounds and reuse/rebuild semantics remain unresolved. P4 now has supervised LSP/DAP compositions but they remain gated pending P1/P3 acceptance; P5 cascade source is present but runtime-disabled; P7 completed unblocked source work PARTIAL with checkpoint restore, automation invocation and terminal graphics unavailable; P8 remains PARTIAL/gated.

P6 implemented durable safe-boundary consumption plus immutable ACK proof/preimage. P1's `direct.message.v1` ACK may accept a fresh authenticated LIVE same-child/profile/permission/owner-epoch/workspace consumer after an uncertain first reply, while retaining exact original Attempt/inbox receipt/prompt/message/payload/ACK pins. Capacity is released only after durable Host ACK receipt persistence. P1 owns HostKernel/§37.9; P6 owns Core/§29.2. No validation, benchmark, provider call or Git publication ran; all runtime/effect gates remain false pending integrated acceptance.

## 2026-10-20 — Evaluation/CodeMode requirements and resource correction

The test catalog now has HUP-005..006 runner self-check and paired-arm parity/contamination acceptance, plus CM-001..007 Guarded CodeMode acceptance. They are specifications only; no evaluation runner or HorizonCode test evidence is claimed. Existing CodeMode remains hidden and effect-denying until Rust Guard/ExecutionHost mediates nested calls; `repo_take/jcode`'s separate QuickJS runtime is not adopted as a second JS engine. Active whole-phase owners are P1, P4 and P7; P2/P3/P5/P6/P8 retain their documented PARTIAL/gated status. No tests/builds/typechecks/audits/benchmarks/provider calls ran. Disk is monitored on C: through `/mnt/c`: 24 GB free of 454 GB (95% used); `kernel/target` 627 MB and one worktree. A test process under `/home/sarvesh/business_Dev/litecowork` is outside agentx and remains untouched. The Git tree remains mixed and unstaged; no publication or cleanup occurred.

## 2026-10-20 — Evaluation/CodeMode requirements and resource correction

The test catalog now has HUP-005..006 runner self-check and paired-arm parity/contamination acceptance, plus CM-001..007 Guarded CodeMode acceptance. They are specifications only; no evaluation runner or HorizonCode test evidence is claimed. Existing CodeMode remains hidden and effect-denying until Rust Guard/ExecutionHost mediates nested calls; `repo_take/jcode`'s separate QuickJS runtime is not adopted as a second JS engine. Active whole-phase owners are P4, P6 and P8. P2 completed a source review PARTIAL; P1 completed a source checkpoint PARTIAL with effects gated and verified all direct Core Git process paths fail closed through AppProcess before spawn. P7 completed unblocked source work PARTIAL; checkpoint restore, automation invocation and terminal graphics remain unavailable. P3/P5 remain PARTIAL or gated. No tests/builds/typechecks/audits/benchmarks/provider calls ran. C: via `/mnt/c` has 24 GB free of 454 GB (95% used); `kernel/target` 627 MB and one worktree. A test process under `/home/sarvesh/business_Dev/litecowork` is outside agentx and remains untouched. The Git tree remains mixed and unstaged; no publication or cleanup occurred.
Added §32.11 LM-018 for the later consented OpenCode free-model smoke after quota reset: exact route verification, one streamed response, one bounded coding task, honest 429/no-fallback handling. This has not been executed.

Latest owner refresh: P3, P6 and P8 are active. P4 completed unblocked source implementation PARTIAL with all effectful lifecycle gates false; P2 completed source review PARTIAL; P1/P7 remain PARTIAL and P5 runtime-disabled. No validation/evaluation/provider activity ran.

## 2026-10-20 18:25 UTC — latest implementation hold checkpoint

Active whole-phase owners are P1 Guard/ExecutionHost, P2 managed vertical, and P3 RepoIntel (three available child slots including parent). P6/P8 returned PARTIAL source handoffs; P4/P5/P7 remain PARTIAL or dependency-gated. P3's current safe source work is strict RepoIntel cross-field/bounds validation. P1 owns Rust authorization; P3 owns Core/indexd ripgrep callers, which are fail-closed before process spawn because no approved generic query route exists. P8 RC0 bounds are source-present with new unrun fixtures; resource policy/fan-out/OS guarantees remain gated. P6 exact same-epoch prepare recovery is source-present; P6 acceptance remains open.

Evaluation boundary: §32.40 HUP-001..006 and §32.41 CM-001..007 specify later acceptance. `scripts/perf/rc0.py` is a resource profiler, not the paired coding benchmark runner. No HorizonCode benchmark harness or uplift evidence is present. CodeMode is an existing restricted interpreter, hidden until nested effects use Rust Guard/ExecutionHost; do not add the separate JCode QuickJS runtime. Implement only source-safe tasks while the user-directed no-testing hold remains active. The current mixed Git state is preserved unstaged, and C: space is checked at `/mnt/c` (24 GB free; `kernel/target` 627 MB). No tests/builds/typechecks/audits/evaluations/provider calls/staging/commit/push/cleanup have run. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-20 18:30 UTC — phase handoff update

P2's latest source audit found no P2-only change; Core managed evidence/UNKNOWN/revision/artifact/settlement decoders match HostKernel projections and its TUI control commands are registered. P2 remains blocked on P1 verifier/process-quiescence recovery and P8 Inspect settlement acceptance. P3 added strict RepoIntel cross-field and response-size validation; ripgrep stays fail-closed before spawn because the canonical generic Guarded query route does not exist. P4 resumed as a whole-phase owner for remaining supervised protocol/consumer source work. Active whole-phase owners: P1/P3/P4. P6/P8 are partial handoffs, P5 is source-present and runtime-disabled, P7 remains dependent. User-directed implementation-first hold remains; no tests/builds/typechecks/audits/benchmarks/provider calls or publication.

## 2026-10-20 18:37 UTC — P4/P7/P9 update

P4 source adapters are present but production editor ingress remains unavailable without trusted Session/Location/Attempt context; keep gates false. P7 is closing a bounded artifact range-consumer gap (offset and cursor-progress validation), with source fixtures not run. P9 is assigned Linux CLI/TUI release-source work only. §32.12 adds SA-018..020 for interrupted child partial writes, child-state recovery after host restart, and explicit-only provider/model switching after 429. Active whole-phase owners: P3/P7/P9. No tests/builds/typechecks/audits/benchmarks/provider calls, package build, staging, commit or push. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-20 — P3/P9 handoff and P1/P7 continuation

P3 source pass returned PARTIAL with bounded RepoIntel response validation and fail-closed ripgrep callers; authenticated P1/P8 read/cache acceptance, parser provenance, unsaved-buffer source, and cursor acceptance remain. P9 source audit confirms both CLI aliases share one launcher; only the installer docs URL changed. Package name/private publication status and root licensing remain unresolved; no manifest/legal decision or package build was made. P1 resumed on authenticated HostKernel integration, P7 on artifact range bounds. No tests/builds/typechecks/audits/benchmarks/provider calls/package commands. Preserve mixed Git state and C: monitoring; V1 is PARTIAL / NOT VERIFIED / NOT RELEASED.

Latest continuation: P1/P6/P7 are active whole-phase owners. P6 is reconciling direct inbox delivery with P1; P7 added source-side artifact range and checkpoint request/response checks with unrun fixtures. P3/P9 returned source-only PARTIAL; P2/P4/P8 remain gated. No tests/builds/typechecks/audits/evaluations/provider calls or release operations.


## 2026-10-20 19:10 UTC — P1/P6/P7/P8 handoffs; P3/P4 resumed (implementation only)

P1 completed its latest source pass PARTIAL. It added a final HostKernel cancellation/deadline fence to RepoIntel responses; guarded document reads, direct-message consume ACK, cache-owner handoff, and pre-spawn ripgrep denial are source-present. A durable OS-level process-tree quiescence proof after abrupt HostKernel death is still missing, so verifier/finalization remain false. P6 reconciled Core inbox prepare/commit/inspect/consume-ACK against the HostKernel pins and found no safe isolated source change; protected credentials/live probes and provider journeys remain gated. P8 found no safe independent source change without trusted pressure-policy ingress, P1 quiescence, supported OS quotas, and HostRun attestation; worker fan-out and cache eviction remain unavailable.

P7 completed its independent source pass PARTIAL: checkpoint action paths now receive strict safe-relative-path, selection, aggregate-byte, regular-file, BLAKE3 and single-link validation in the Core projection, with unrun regression fixtures. Automation invocation and restore remain gated on Guarded dispatch/scheduler and complete same-revision observations. P3 resumed to correct RepoIntel effective-source provenance and inspect remaining safe index/client changes. P4 resumed to resolve safe production LSP/DAP/REPL ingress and lifecycle integration with P1/P3's current contracts.

No tests, builds, typechecks, audits, benchmarks, provider calls, staging, commits, pushes, or cleanup ran. Current active owners: P3 and P4. Git stays mixed/unstaged with one worktree; C: via `/mnt/c` has 23 GB free and `kernel/target` is 627 MB. Work remained inside agentx. V1 is PARTIAL / NOT VERIFIED / NOT RELEASED.


## 2026-10-20 19:22 UTC — P2/P5/P9 active; benchmark provenance corrected

P3 returned PARTIAL after fixing RepoIntel configuration-source attribution and closing unbounded high-fanout directory enumeration; parser provenance, editor overlays, persistent-cache owner/root, cursor acceptance and Guarded ripgrep remain gated. P4 returned PARTIAL after adding a constant-false REPL authorization gate, invalidating output refs/quarantining callbacks on uncertain outcomes, memoized exact-process cancellation for LSP/DAP failures, and LSP setup cleanup. P7 returned PARTIAL after tightening checkpoint preview action paths to Rust's relative-path, selection, aggregate-size, regular-file, digest and link-count constraints. All new/adjusted fixtures remain unrun. Current active owners are P2, P5 and P9; P1/P3/P4/P6/P7/P8 have source-only PARTIAL handoffs.

The benchmark note in §32.40 now distinguishes NVIDIA's Nemotron report values (SWE-bench Verified 70.7% BF16 / 69.5% NVFP4; Terminal-Bench 2.1 56.4 / 53.9) from the user's older estimates; separates Opus 4.5's 80.60% thinking and 80.90% no-thinking configurations; and notes FeatureBench's displayed Lite results are Dataset V1.0 with separate `passed`/`resolved` scores, not comparable directly to Nemotron or a generic 11% claim. HUP-001..006 remain evaluation contracts only; there is no HorizonCode uplift runner or score. CodeMode is intentionally absent from the registry even if experimental flags are set; direct nested MCP dispatch fails before transport. The legacy large CodeMode unit file still contains positive dispatch expectations and must be reconciled before the verification wave.

No tests, builds, typechecks, audits, benchmarks, provider calls, release commands, staging, commits, pushes or cleanup ran. Git remains mixed/unstaged with one worktree. C: via `/mnt/c` has 23 GB free; `kernel/target` is 627 MB. Work stays inside agentx. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.


## 2026-10-20 19:28 UTC — P2 source handoff; P5/P6/P9 active

P2 completed a whole-phase Core/TUI source recheck PARTIAL with no correction: managed verifier SETTLING/UNKNOWN and final-revision decoders match HostKernel; artifact preview resolves exact managed scope through HostKernel; P8 settlement projections match. Managed verifier/finalization/fan-out remain unavailable pending P1 process-tree quiescence and P8 acceptance. P5 found a Settings truth gap: BYO routes are hardcoded as “unconfigured” and UI has no per-route inspect status despite `WebSearchRuntime.inspect` already exposing sanitized local `configured/available/status`; P5 is adding a read-only authenticated settings projection using the existing runtime, without network calls or secret bytes. P6 is active on trusted SecretBroker credential input and remaining provider/Doctor/S1 source work, keeping credential mutation and live probes disabled absent accepted protected input. P9 is adapting release-tool temporary paths to an ignored repo-local artifact subtree and correcting native Windows support claims; no package/legal/signing policy is being invented.

Benchmark evidence in §32.40 now distinguishes the current cited NVIDIA Nemotron and Anthropic Opus configurations, FeatureBench V1.0 leaderboard score fields from V1.1 dataset release, and the 7.7-point Meta-Harness classification result from its TerminalBench-2 coding experiment. Added paired task/repository-group uncertainty guidance and clarified that FeatureBench's CPU gold-patch scoring timing is not HorizonCode inference time. These are reference corrections and acceptance requirements only; no runner or uplift evidence exists.

No tests/builds/typechecks/audits/benchmarks/provider calls/release commands/Git publication/cleanup ran. Active whole-phase owners: P5/P6/P9. Git remains mixed and unstaged with one worktree; C: via `/mnt/c` has 23 GB free and `kernel/target` is 627 MB. Work stays inside agentx. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-20 20:04 UTC — current owner/dependency and source checkpoint

P5 returned PARTIAL with a new authenticated read-only web-search route-status API, schema/SDK/TUI Settings projection; no provider traffic occurs and dispatch gates remain false. P6 returned PARTIAL with authenticated owner-scoped QuestionV2 list/reply/reject handlers, SSE filters for both `question.asked/replied/rejected` and `question.v2.*`, and QA-006/007. Protected credential input/live Doctor stay unavailable. P1 Guard/ExecutionHost and P7 streaming/artifacts/automation/rewind resumed as whole-phase owners; P9 continues Linux/WSL release source work. P2/P3/P4/P8 are PARTIAL/dependency-limited. New `.gitignore` exceptions are exact to the P5 API/schema files and P9 release guide. User-directed implementation-first hold remains: no tests, builds, typechecks, audits, benchmarks, provider calls, release commands or Git publication. Mixed tree, one worktree, C: `/mnt/c` 23 GB free, `kernel/target` 627 MB; V1 PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-20 20:08 UTC — P9 source handoff; P4 resumed

P9 returned PARTIAL after local-candidate Linux/WSL installer, truthful native-Windows/remote-install/upgrade unavailability, and moving release temporary/build artifacts into ignored repo-local `kernel/target/horizoncode-release`. Distribution licensing/notices, package identity, signing/update/rollback policy and exact-candidate acceptance remain. P4 resumed as a whole-phase Core LSP/DAP/REPL owner alongside P1 Guard and P7 streaming/artifacts/automation/rewind; all dependent effects remain false-gated pending prerequisites. P5/P6 have PARTIAL source handoffs; P2/P3/P8 remain PARTIAL/dependency-limited. User hold continues: no tests/builds/typechecks/audits/benchmarks/provider calls/release commands. Mixed tree, one worktree, C: `/mnt/c` 23 GB free, `kernel/target` 627 MB.


## 2026-10-21 06:33 UTC — evaluation and phase-owner checkpoint

The fake-only HUP-005 runner source exists under `scripts/eval/`; it cannot count as real-provider or benchmark evidence. P8 owns the unrun fixture correction (`summarize_pairs(records, manifest)`), capability-row journal recovery, and no-follow/pinned artifact append/read. P9 owns remaining release report/marker/manifest exclusive-write races. P2 remains PARTIAL and fail-closed on P1's missing typed HostKernel follow-up-turn authority. Whole-phase P1/P8/P9 owners are active. User's implementation-first hold remains; no verification commands ran. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.


## 2026-10-21 06:38 UTC — owner refresh after reference audit

Read the user-authorized single attachment `pasted-text-1.txt`; it reiterates whole-V1 delivery, source-first OpenCode/Codex comparison, future-design explanation, complete architecture/flow/event audit, documentation updates, implementation before tests, and an explicit ask to raise any unresolved design decisions promptly. No additional external path/service/remote access occurred. Actual in-repo Codex handlers confirm distinct spawn, queue-only send, trigger-turn follow-up, list, bounded wait, interrupt, parent/root-turn correlation and activity projection; OpenCode TaskTool confirms role resolution, depth bounds, parent-intersected permissions, child Session creation, and explicit background completion injection. HorizonCode adapts these under §29/§37 profile pins, Rust Guard/HostKernel and durable delivery; it does not inherit their ambient authority.

P1/P2/P9 are active whole-phase owners; P8 returned PARTIAL after source-only fake HUP-005 runner work. P1 confirmed §37.9's exact `direct-turn-v1` schema/Rust DTOs exist and is implementing the HostKernel dispatcher/journal; P2 resumed for Core/TUI integration against that exact contract. P8 evaluation artifacts are append-only/fsynced JSONL with no-follow descriptor traversal and paired uncertainty summary; fixtures remain unrun, and worker/resource/RC0 work remains blocked on P1/P2 contracts and an approved pressure policy. P9 added exclusive no-follow artifact writing; remaining P9 decisions/gates are still open. No tests/builds/typechecks/audits/benchmarks/provider calls/release commands ran. Git remains mixed/unstaged; no publication or cleanup. V1 PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-21 — P9 Linux/WSL release source continuation

P9 kept whole-phase ownership and hardened artifact root creation, state-root creation, and report/marker/manifest writes with Linux no-follow directory descriptors and exclusive creation. Candidate build markers now bind the exact root, source revision and source digest; the build script patch is read and replaced through a pinned no-follow parent, and candidate hashing rejects symlinks/non-regular files. Added source fixtures are unrun. Release identity/license/signing decisions remain open; see `scripts/release/README.md` for the decision/evidence table and affected surfaces. Native Windows remains unavailable; no Linux/WSL acceptance, checks, builds, or release commands ran. P9 is PARTIAL; V1 is PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-21 06:41 UTC — implementation continuation and owner ledger

Current whole-phase owners: P1 Guard/ExecutionHost, P2 managed/direct child lifecycle, P5 built-in V1 web search. P9 has returned source-PARTIAL; P5 occupies its released slot. P3/P4/P6/P7/P8 remain PARTIAL/dependency-limited and are queued for immediate whole-phase resumption as capacity frees. P1/P2/P5 may author their owned source and tests, but no tests/builds/typechecks/audits/benchmarks/provider calls/release commands/Git operations/cleanup are being run under the user-directed implementation-first hold.

P2 confirmed the direct follow-up blocker: a child Attempt currently settles per prompt, while §37.9 authorization requires the same live EXECUTING Attempt; the Core inbox/prepare path lacks fresh-proof wiring and no existing Core-owned wake/turn trigger is connected. P2 must preserve this as one live child Attempt across turns and keep dispatch gated pending the canonical turn/effect scope. P1 found that hashing a mutable full Attempt snapshot into the cycle digest risks staling turn authority after an effect updates revision/workspace. A user decision is pending between stable cycle identity pins plus current refreshed Attempt on each effect, and refreshing a complete turn scope after every effect. Continue independent work, do not weaken the Guard/Attempt contract, and leave effectful follow-up unavailable until settled and integrated.

P5 owns full V1 web-search cascade completion and its bounded acceptance fixtures, including explicit route consent/order, per-route provenance, auth failure fallthrough, retry/exhaustion, cancellation, and honest inspect/settings state. P9 source hardening is documented, but license/notices, package scope, signing/update decisions, and exact-candidate acceptance remain open in `scripts/release/README.md`. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-21 06:43 UTC — direct-turn source deltas

P1 now persists HostKernel process incarnation in direct turn-cycle and follow-up authorization issue/reserve events. Replay fences active same-epoch cycles and unresolved proofs from a prior process to UNKNOWN, and treats consumed authorization without its exact successor cycle as UNKNOWN. P2 added strict Core RPC adapters for `turn_begin`, `turn_complete` and `issue_fresh_turn_authorization`, including exact reply, sequence and profile/permission/message-pin checks. Neither change is test evidence. P2 still must wire the Core child lifecycle/wake trigger and preserve one live DirectAttempt across turns. Effect scope remains closed pending the user's choice on mutable Attempt revisions inside the turn digest.

## 2026-10-21 06:45 UTC — whole-phase owner refill

Active whole-phase owners are P1 Guard/ExecutionHost, P6 providers/settings/Doctor/S1, and P7 streaming/artifacts/automation/rewind (all available child slots are occupied). P5 returned source-complete/PARTIAL: the ordered default and explicit BYO cascade, settings consent/order, auth-4xx fallthrough, bounded retry/cooldown, cancellation/UNKNOWN, route provenance and offline authenticated status are present; runtime remains false-gated pending P1/P6 acceptance. P2 returned PARTIAL with strict false-gated turn RPC adapters; actual Core runner lifecycle, same-live-Attempt follow-up, wake trigger and Guarded turn-scope binding remain open, alongside P1/P8 managed evidence/recovery. P3/P4/P8 wait for the next slots and dependency boundaries; P9 remains PARTIAL with release policy and candidate acceptance open. No tests/builds/typechecks/audits/benchmarks/provider/release/Git operations ran. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-21 06:47 UTC — evaluation and CodeMode implementation status

Testing asset review confirms `scripts/eval/` is fake-only HUP-005 source, not a real model benchmark adapter. Follow existing §32.40 HUP-001..008 and §32.41 CM-001..009 rather than adding a competing evaluation design. Start actual testing only after the current implementation-first hold: fake-only runner self-check; explicitly chosen OpenCode free-model bounded coding smoke with honest 429/stop; pinned development subsets; then paired holdout and one-factor ablations. Keep model/provider/sampling/task image/oracle/permissions/tools/budgets fixed between arms. Report percentage-point change, paired outcomes and grouped uncertainty, plus cost, time, token, tool, retry, failure-stage, unsupported and infra counts. The submitted cross-benchmark figures are not a shared score target.

CodeMode wrapper source remains hidden and nested MCP dispatch is denied before transport. Wrapper runtime has no explicit finite timeout, call-count or output-size values and no configured hard memory limit; apply CM-008/009 before any enablement. MetaHarness local source is useful for experiment/run/trace/task-arm matrix and resume patterns only; do not import its container/gateway/paid route. Active source owners P1/P6/P7; P6 dispatch truth and P7 stream/artifact/automation/checkpoint source updates are documented in CURRENT_RUN/HANDOFF. Scheduled automation invocation remains unavailable pending schedule/timezone/DST/clock semantics. No validation/evaluation has run.

## 2026-10-21 06:48 UTC — P3/P1 coalescing handoff

P3 found repeated identical in-flight RepoIntel index builds in `HostKernel::ensure_repo_generation`; retained Arc deduplication happens only after each build. P1 accepted the HostKernel-owned coalescing implementation; P3 retains whole-phase ownership of its independent RepoIntel work. P7 is making only exact `.gitignore` path exceptions for its ignored transcript source/test. Neither finding is verified until final integrated acceptance; tests/builds remain deferred.

## 2026-10-21 06:49 UTC — P7/P8 phase slot handoff

P7 source-partial handoff: bounded transcript output/window/truncation and UI-018 fixture source added; exact ignore paths expose those files. Automation's scheduled invocation needs a canonical timezone-aware occurrence policy and Guarded dispatch. Checkpoint capture/restore needs P1 receipt/Guard and complete same-revision VCS facts. Terminal graphics stay unavailable with text fallback. Integrated acceptance remains. P8 is active for its whole resource/worker/RC0/evaluation phase. Current active phase owners are P1/P3/P8; no validation run.

## 2026-10-21 06:50 UTC — RepoIntel and artifact-search integration review

P1 added pre-build reuse of an exact retained RepoIntel Arc. The HostKernel loop is synchronous and serialized, but it currently rescans the source snapshot before the lookup and requires the same Session, so the §30.22 identical base-pin sharing contract remains under review. Do not label it in-flight singleflight or claim source-scan savings. P3 owns a guarded managed artifact-search tool using the existing ArtifactControl scope and HostKernel digest-pinned range read, with no local path fallback. No tests/builds run under the implementation hold.

## 2026-10-21 continuation note — whole-phase source ownership

Implementation remains the entire P1–P9 V1 scope. The direct-turn digest decision is settled: preserve `DirectTurnScopeV1` over the complete current Attempt snapshot. After each settled effect or fully reconciled batch, HostKernel must return a refreshed scope with unchanged cycle ID/sequence and a digest over the live refreshed snapshot; Core persists it before another effect or completion. Lost refresh replies reconcile only the exact receipt; stale scope is rejected; UNKNOWN/unresolved refresh blocks the cycle. P1 owns HostKernel and P2 owns Core lifecycle integration.

Current owners: P1, P3, P8. P2 resumes immediately when a child slot opens. Keep implementation-first hold: no tests/builds/typechecks/audits/benchmarks/provider calls/release or Git publication until implementation is complete. Repository-only boundary remains absolute. V1 is PARTIAL / NOT VERIFIED / NOT RELEASED.

P3 integration boundary: managed artifact search is wired through ArtifactControl and HostKernel digest-pinned range reads. `repo_tree` and `repo_detect` are removed from model-visible exposure while their only reader is app-process `nodeSource`; keep both UNAVAILABLE until P1's bounded authenticated HostKernel discovery/manifest DTO and P3's Core adapter are implemented and accepted. No tests/builds ran.

P3 handoff: authenticated managed artifact/text/terminal range search is source-wired; `repo_tree`/`repo_detect` are disabled in model exposure pending P1 bounded HostKernel discovery/manifest operation. P3 also has cache policy/retirement, parser provenance, unsaved-buffer, supervised LSP and direct-session artifact ownership dependencies. P2 has resumed as a whole-phase owner. Active owners P1/P2/P8. P1's durable turn-batch journal/schema is source-present, while effect admission/lease/receipt and refreshed-scope wiring is still in progress; P2 must consume the exact P1 DTO. RC0 remains NOT_ATTESTED until authenticated P1 process ownership and P2 final verifier evidence are available. No validation wave yet.

P8 interim: paired evaluation summary now counts all invocations/incomplete pairs and truthfully labels fixture-reported costs. Durable worker replay is present; settlement is gated on P1 quiescence/Guard and P2 terminal Attempt/final-revision proofs. RC0 remains NOT_ATTESTED. No evaluation or test run yet.

P8 independent-source handoff: HUP reporting source is tightened; RC0 remains NOT_ATTESTED without P1/P2 trusted evidence; worker settlement is proof-gated; OS quotas and trusted pressure ingress remain unavailable. P7 resumed whole-phase ownership for streaming, artifacts, automation and rewind. Current active owners P1/P2/P7. No tests/builds/evaluation have run.

P2 interim: direct ToolBatch scope validation and persist-before-dispatch are source-present in Core. The supervisor response/receipt bridge, TaskTool/sessionRunner lifecycle and follow-up completion/wake/recovery remain, pending P1's exact final refreshed-scope DTO. No tests run.

P7 interim: authenticated SSE queue bounds and overflow/reconnect behavior are source-present in the existing event route; no tests have run.

P7 handoff: bounded authenticated SSE admission is source-present; non-Session event replay remains unresolved. Checkpoint/rewind effects and automation invocation stay unavailable pending P1 Guard/revision facts and canonical scheduling policy. P4 resumed whole-phase LSP/DAP/REPL source integration. Current owners P1/P2/P4; no validation run.

P2 interim direct-turn Core validators and Prompt→LLM→ToolBatch propagation are being wired; the post-bind scope response is validated. P4 will model an explicit DirectTurnScope lane for normal direct Sessions in addition to managed/child Attempt, but keep it unavailable until P1 HostKernel protocol/Guard support is defined and accepted; Session ID alone is not authority.

P4 authority clarification: `DirectTurnScopeV1` is child DirectAttempt-scoped, not root-session authority. Root-session LSP/DAP remains unavailable until P1 exposes a canonical authenticated root-session process/effect scope. Keep AgentProfile and ExecutionLaunchProfile pins independent.

P1 found existing authenticated bounded HostKernel `query_structure`; P3 should assess the exact existing RepoStructureQuery/Page as a possible Core adapter for tree/detect before proposing another DTO. Routes remain unavailable pending source and acceptance.

P4 interim source correction: AgentProfileV2 and ExecutionLaunchProfile are distinct; validators now check their own pins independently. Root direct-session editor authority is absent, so that lane stays unavailable pending P1's canonical HostKernel scope. P4 continues output receipt fidelity; no checks ran.

P4 handoff PARTIAL: profile authority pins are corrected and editor output receipt validation is tighter. Production ingress and all effectful P4 paths remain gated by P1/P3/OS prerequisites. P6 resumed whole-phase provider/settings/Doctor/S1 source. Active owners P1/P2/P6; no test/provider run.

P2 now carries DirectTurnScope through Core terminal.run and persists refreshed authority after final write/patch/terminal receipts; replay requires exact scope. Managed child lifecycle and follow-up wake remain. P1 HostKernel admission/lease/receipt path is being integrated with multi-batch replay retention. No tests run.

P1/P2 direct-turn source integration now reaches HostKernel ToolBatch admission/bind/final receipt and Core write/patch/terminal callers with durable scope refresh/replay; TaskTool same-live-Attempt follow-up/fresh-proof recovery is still missing, so runtime remains gated. P6 is fail-closing legacy OAuth mutation routes and correcting unknown Doctor freshness. No tests/provider calls.

P2 restart recovery requires P1 to expose an authenticated live DirectAttemptScope/workspace projection; snapshot summaries and Task metadata are not authority. P6 has fail-closed OAuth routes and corrected unknown Doctor freshness. Trusted S1 owner stamping and protected credential/probe grants remain P1/Core prerequisites; no tests or provider calls run.

RepoIntel cache correction: HostKernel reuses matching generations across same-principal Sessions, with per-Session leases, but still recollects the bounded snapshot each request. This skips index rebuild only; do not claim scan savings or full §30.22 acceptance. Correct older same-Session-only notes.

2026-10-21 07:17 UTC continuation: P1/P3 are active whole-phase owners. The former P2 child hit a model-capacity error, so a replacement P2 whole-phase owner is active. P1 reports implementation of authenticated live Attempt scope recovery and trusted server-auth Session principal stamping; P2 coordinates TaskTool child Session authority and resume integration against those exact contracts. P1 is also closing CodeMode finite timeout/call/output configuration without exposing the tool or claiming hard memory enforcement. P3 verified that current query_structure lacks directory enumeration and a typed missing-path outcome; repo_tree/repo_detect remain unavailable without app-process filesystem fallback. No validation/provider/evaluation/release/Git operations ran. External attachment access remains prohibited by the repository-only boundary; local reference repositories are used.

2026-10-21 07:21 UTC: P3 returned PARTIAL with tree/detect unavailable due to insufficient authenticated HostKernel DTO semantics; managed artifact search and cache-source corrections remain source-present. P1/P2/P6 are active full-phase owners. P2 is repairing missing Session route-handler declarations only after exact index/HEAD comparison to preserve current trusted Question/subagent/Guard changes and effect gates. No validation, provider, benchmark, release, or Git publication ran.

P1 source delta (2026-10-21): CodeMode receives explicit trusted 30 s / 64-call / 64 KiB execution bounds with final output cap, while remaining unregistered and without a claimed memory limit. Protected-native credential write and live Doctor/probe effects remain unavailable: there is no authenticated native-input bridge or grant contract. P6 continues independent settings/offline Doctor/S1 implementation. The live direct snapshot returns a full HostKernel-generated scope only for authenticated same-owner EXECUTING Attempts with current epoch and workspace; P2 must consume it fail-closed. No tests ran.

2026-10-21 07:24 UTC owner refill: P1 returned PARTIAL with authenticated direct scope recovery, trusted Session owner stamping, and bounded-but-hidden CodeMode source. P2/P6 remain active; P7 resumed as a whole-phase owner for remaining streaming/rendering/artifact/analytics/automation/rewind source. P3 returned PARTIAL; P4/P5/P8/P9 remain. Security-sensitive paths remain false-gated until P1 evidence exists. No checks/evaluations/provider/release/Git operations ran.

P2 source update: after comparing the missing handler block with repository index, P2 restored the absent raw handler definitions while retaining current Security/Question/subagent logic. It found additional compile/wire issues (revision type, profile/scope decoding, BigInt serialization, Task profile input, duplicate currentChild, undefined parent variant) and is repairing them before lifecycle wiring. No checks run.

P7 interim source audit: activity stream and replay/redaction bounds are present. Checkpoint capture/restore remains dispatcher-disabled; schedule run-now remains unavailable without canonical timezone/DST semantics plus Guarded invocation. P7 continues independent artifacts/analytics/transcript gaps; no tests run.

Latest authorized attachment read (2026-10-21): confirms whole V1, full local OpenCode/Codex source comparison, architecture/HLD/LLD/flow/event re-audit, implementation before testing, current Markdown upkeep, and prompt listed escalation for material uncertainty. No additional phase requirement or design choice was introduced by its text. No testing commands ran.

P6 interim source finding: Settings' FeatureExposure contract is missing owner/runtime prerequisites and supported platform/model/harness metadata required by §16.15; P6 is updating the Core schema/projection and owner section. No provider calls or checks.

P7 source delta: TUI activity labels/text now receive bounded printable/control/bidi filtering, and event-triggered resnapshot recovery is capped and Session-ID validated. Checkpoint capture/restore and automation run-now remain gated by missing exact HostKernel VCS/restore and canonical schedule producer contracts. Fixture source remains unrun; P7 continues independent artifact/analytics work.

P2 continuation: restored missing Session route handlers from repository index, retained current Question/subagent/Guard behavior, and corrected several direct-turn wire/type mismatches. Now implementing same-live-Attempt follow-up with authenticated scope recovery, fresh proof, Guard inbox commit and `turn_begin`; keep gated until integrated acceptance. HTTP wake service and restart replay for pending completion/delivery remain outstanding. No checks run.

Resource check (2026-10-21): C: via `/mnt/c` has 18 GB free; `kernel/target` is 627 MB and only the primary worktree exists. No build/test processes were started.


2026-10-21 source coordination checkpoint (not acceptance): P1 remains the exclusive owner of the shared direct-turn schema/Rust identifier contract and HostKernel artifact/automation/checkpoint authority; P7 owns isolated TUI/render/replay work. P6 continues provider/settings/Doctor/S1. CodeMode is a candidate HUP ablation, not a separate agent runtime: expose it only after nested-call Guard, atomic ToolBatch, leases, receipts, cancellation and UNKNOWN recovery pass. Preserve HUP-001/002 paired fixed-model comparisons, HUP-005 fake-only protocol self-check, HUP-006 parity/contamination, HUP-007 evidence-based failure attribution, and HUP-008 only when OpenCode/Codex controls are exactly matched. No tests or external calls were run; implementation remains in progress.


2026-10-21 continuation: active implementation slots are P2 managed/child lifecycle, P3 RepoIntel (then immediate P1 Guard continuation), and P7 streaming/render/artifact presentation. P6 finished its currently unblocked source pass; protected credential/live Doctor remain gated on P1. P5 source audit confirms cascade/settings fixtures exist but remain unrun and runtime false. P7 is adding the missing checkpoint TUI entry while preserving disabled restore. No tests/builds/typechecks/provider calls/evaluations/release actions. Keep all runtime gates false until cross-phase acceptance.


2026-10-21 implementation progress: P3 added UTF-8/query/path validation and authored unrun schema-rejection fixtures; tree/detect remain unavailable pending the user's decision on a new authenticated bounded HostKernel discovery DTO. Direct artifact ownership also lacks a resolver. P7 added aggregate SSE queue byte limits, a read-only checkpoint list/preview dialog and bounded printable transcript labels; restore remains unavailable. P2 owner is auditing the Core managed/child lifecycle. P1 will resume Guard source review after P3. These are source changes only; no validation or external calls.


P7 follow-up: checkpoint preview now renders IDs, paths, digests and conflict labels through bounded terminal-safe redaction while preserving exact raw IDs for SDK requests. Authored fixture coverage includes bidi/control characters, Bearer redaction, limits and raw-ID preservation. No tests run; restore remains unavailable.


P1 current blocker: no durable boot-scoped containment identity is retained to prove a stdio process tree is quiescent after abrupt HostKernel owner loss. The live-process PTY janitor and bubblewrap `--die-with-parent`/PDEATHSIG do not give a fresh HostKernel restart proof. Keep unresolved effects UNKNOWN and protocol/verifier gates false; do not use PID-only kill. P1 is checking the local Codex/OpenCode supervisor implementations before settling whether an existing safe primitive can be adapted.


Owner handoff update (2026-10-21): P2 source audit found TaskTool, authenticated follow-up runner, committed inbox claim, turn begin/complete, scope refresh and restart fencing present; runtime remains disabled pending P1/P8. Its owner is now on P4 source completion. P7 returned PARTIAL; its slot is on P8 resources/workers/RC0/HUP. P1 remains the critical Guard owner. Correction to the prior P1 note: `repos/codex/codex-rs` exists in this workspace; an earlier claim that it was absent was wrong and is being rechecked against the actual local source. No tests, builds, typechecks, provider calls or benchmarks.


User decision (2026-10-21): add the authenticated bounded HostKernel discovery/manifest DTO for P3; keep `repo_tree`/`repo_detect` gated until integrated acceptance. P1 owns the HostKernel contract/schema and will hand the precise revision to P3. Codex restart review is corrected: local Rust source exists; its process groups/PDEATHSIG, process-local Windows Job handles, and persisted single-daemon identity do not prove descendant quiescence after restart. P4 found production LSP supervised launch is not wired; a narrow `session/prompt.ts` authority-scope seam is now P4-owned, while launch remains gated on P1. No checks executed.


P8 update: resource/worker Rust files remain proof-gated and preserve OS quotas as unsupported, advisory pressure as unwired, worker settlement as proof-gated, and fan-out closed. RC0 test fixtures now use repository-local scratch instead of default OS temp paths; an unrun locality fixture was added. Remaining P8 blockers: P1/P2 owner-backed HostRun and verifier attestation, quiescence/effect/final-revision evidence, trusted resource ingress/retention, and real OS CPU/memory/process/FD limits. HUP live evaluation remains disabled.


Active phase ownership refresh: P1 HostKernel Guard + approved P3 discovery DTO; P4 LSP/DAP/REPL source integration; P9 local release tooling. P8 source pass is partial and its slot moved to P9. P2 source pass is partial, fail-closed pending P1/P8; P3 adapter waits on P1 DTO. P5/P6 source is present for unblocked work; P7 source is partial. No tests/builds/typechecks/provider/benchmark/release commands have run.


Current owner slots: P1 Guard + approved discovery DTO; P4 supervised LSP/DAP/REPL source work; P9 bounded local release audit/tooling. P1 additionally rechecked actual Codex process sources and found no restart-proof descendant quiescence primitive. P8 partial handoff is complete; RC0/worker proofs remain gated. No test/build/typecheck/provider/eval/release command has run.


P1/P3 integration progress: the approved bounded discovery contract now exists in RepoIntel schema, HostKernel and Core SessionSupervisor source. The response binds authenticated principal, Session, Location, owner epoch, workspace binding, source revision, read-policy digest, root, mode, limits and coverage; HostKernel rechecks Guard/read scope and request deadline. P1 is handing the exact DTO to P3 for model-tool adapter wiring; `repo_tree`/`repo_detect` remain hidden pending acceptance. Source only, no validation.
#### 2026-10-21 continuation decision: crash quiescence

The user approved optional Linux cgroup-v2 containment under the existing ExecutionHost. P1 owns the implementation and exact architecture contract. Require a delegated subtree, assign containment before spawn, persist a boot-scoped verified identity with the effect/process record, and reconcile only the exact same cgroup after restart. Settle quiescence only after kill/wait and verified `populated=0`; otherwise retain UNKNOWN and leave effectful routes disabled. This does not establish CPU/memory/FD quotas or authorize PID-only signaling, a parallel supervisor, or unsupported platforms. P3's approved bounded authenticated `repo-intel.v1/discover` tree/manifests DTO is in source and adapter work remains gated until acceptance. No validation is authorized before implementation closes.

#### 2026-10-21 continuation decision: managed token authority

Authenticated Task creation resolves and validates the canonical versioned AgentProfileV2 definition; Rust immutably pins its `limits.tokenBudget` with the exact profile ID/revision/digest. HostKernel computes `effectiveMaxTokens=min(SpecVersion.maxTokens, pinned profile tokenBudget)` and includes durable `remainingTokens` in the managed Attempt scope digest and each usage refresh. Managed provider steps clamp to the current remainder. Zero is accepted only as an authenticated STOPPED usage projection and blocks all further provider/effect admission before Guard preparation or lease dispatch. Direct sessions are unchanged; SpecVersion remains the cost ceiling. No tests/builds run before implementation closes.

P1 source checkpoint: cgroup identity is now carried into the existing EffectHost PREPARED transaction before pre_exec assigns the sandbox child, and exact cgroup emptiness is required for normal/cancel settlement and restart quiescence proof. A proof never resolves the effect result; restart remains UNKNOWN. Cleanup/error-path closure and enabled-origin review are still in progress. P2 added durable STOPPED/zero-budget settlement and restart recovery without replay, and hard-disabled managed dispatch plus verifier/finalization pending acceptance. P4 added exact DAP status/cancel and gated REPL lifecycle source; typed per-call interpreter operations remain in progress. No validation run.

#### 2026-10-21 P2 managed child source continuation

P2 is rechecking the full managed Run and child-delivery path. Core continues to resolve the immutable, versioned `AgentProfileV2` through authenticated Config; managed Task prompts retain a lane-tagged `SubagentDeliveryV1` bound to the exact Goal/Run/Task/Attempt and consumed handoff. The accepted Spec digest is checked against the dispatched handoff before child creation. Core and OpenCode carry Rust-projected effective and remaining token budgets, include them in managed scope identity, and clamp each managed provider step (including the native adapter) to the durable remainder. A zero remainder is decoded only as an authenticated exhausted accounting projection; the LLM stops before another provider step, while Core and OpenCode deny before ToolBatch prepare/Guard/lease. Initial READY_TASK admission requires a positive remainder. A returned child with stopped usage settles FAILED only after its exact durable quiescence receipt; recovery uses that receipt and does not replay the prompt. `managedTaskDispatch` is hard-disabled in RuntimeFlags and the Goal verification endpoint returns unavailable while its source readiness gate is false. P1 owns the HostKernel scheduler/recovery/usage projections; phase acceptance still needs integrated Rust wire and recovery evidence. SpecVersion remains the cost ceiling. The direct child message dialog no longer has a duplicate unreachable follow-up-success branch. Focused fixtures cover per-step clamp/exhaustion, pre-prepare denial, mismatched Task profile budget and stale Spec/profile handoff pins; they have not run. OS CPU/memory/FD limits remain unavailable until enforced. No test/build/typecheck/audit/provider operation ran under the implementation-first hold. Runtime dispatch, fan-out, verifier and finalization remain gated pending accepted P1 Guard/cgroup/quiescence and P8 settlement proof.
## 2026-10-21 implementation checkpoint — source only

P1 has source-wired optional Linux cgroup-v2 containment into the existing non-PTY ExecutionHost PREPARED/dispatch/receipt/restart path. Membership is established before `exec`; settlement requires matching boot/root/inode/process/effect/profile/lease pins and confirmed `populated=0`. Uncertain cases remain UNKNOWN; empty cgroups are retained rather than removed by a raceable name. PTY remains disabled and cgroup containment does not provide CPU/memory/process/FD quotas. Internal typed REPL operation and authenticated next-sequence routes are source-present but gated pending real OS quota and callback/result-receipt acceptance. P4 continues its full LSP/DAP/REPL source phase.

P7 added bounded SSE JSON preflight before serialization (64 KiB, 8,192 nodes, depth 32) and updated its owning §31/§37/§32 contracts, then handed off PARTIAL. Durable transient-event replay, exact same-revision Guarded checkpoint facts, canonical schedule/DST/clock policy plus guarded automation recovery, and renderer/activity/artifact/analytics acceptance remain open. Restore and `run_now` are denied.

P2's whole-phase managed/direct child work has resumed. Current owners are P1, P2 and P4. P3 adapters remain hidden pending acceptance; P5/P6 dispatch and protected-provider paths remain gated; P8 settlement/RC0 requires integrated P1/P2 evidence and actual OS enforcement; P9 release decisions and exact-candidate qualification remain open. No validation has run per the implementation-first instruction. Overall V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.
## 2026-10-21 owner/dependency refresh

P2's currently unblocked Core/TUI source work is PARTIAL and queued, with §29/§37 corrected to show the current managed token and direct follow-up source. Resume P2 when P1 Guarded verifier/effect receipts and cgroup quiescence/fresh-process UNKNOWN recovery, plus P8 final-Inspect/terminal settlement proof, are source-integrated. The new active P8 owner is closing independent durable worker/resource/worktree/RC0/fake-evaluation source gaps. P1 and P4 remain active; P4 has exact REPL sequence conflict handling, DAP target binding, and LSP cache scope pins. Do not open any dependent runtime gate. No tests/builds/typechecks/audits/provider calls/benchmarks/releases have run.
## 2026-10-21 security/source review update

P1's retained-cgroup cap is 256 entries, with bounded scan to the 257th entry, strict child-name/error handling and serialized count+create; unsupported locking fails closed. This remains source-only. P4 now documents DAP attach as unavailable because separate bwrap `--unshare-all` invocations do not share a PID namespace. P8's RC0 input and HUP seed-parity hardening is source-present and unverified.

P7 SSE admission still needs a source repair before its bound is accepted: `Object.keys` creates a potentially large key array before the node cap, and queued mutable event objects are serialized later. Use bounded own-key traversal and queue a synchronous serialized/immutable bounded snapshot. P1/P4/P8 remain active; P2 is queued on P1/P8 proofs. No tests/builds/typechecks/audits/provider or evaluation runs have occurred.
## 2026-10-21 phase slot refresh

P4 handed off PARTIAL: DAP attach remains unavailable without a shared PID namespace/ptrace policy; DAP evaluate lacks trusted profile permission; REPL requires real OS quotas and typed callback/result receipts; authenticated editor ingress and real-project journeys remain. P8 handed off PARTIAL with safer repo-local RC0 inputs and fake-runner seed/resume/cancellation accounting; trusted P1/P2 attestation, OS quotas and pressure ingress remain. Active owners are P1, P6 and resumed P7. P7 is first fixing bounded own-key enumeration and synchronous immutable SSE serialization, then continues whole-phase source work. P6 is continuing provider/settings/Doctor/S1. P2 remains queued on P1/P8 proof; no dependent runtime gate is open. No validation/provider/evaluation/release command ran.

## 2026-10-21 source-only integration checkpoint

Active phase owners are P1, P6 and P7. P1 is closing the origin inventory after source-wiring cgroup-v2 containment into the existing non-PTY ExecutionHost. Parent classified public SDK `createOpencodeServer`/`createOpencodeTui` spawns as first-party process origins and directed P1 to make them unavailable before spawn for V1 unless mediated by HostKernel. P6 source fixes correct missing selected-model Doctor state and untouched-vs-explicit settings lock state; it surfaced a P2-owned title-generation fallback that must use the Session-pinned provider/model unless the user explicitly configured a separate title model. P7 repaired bounded own-key traversal and snapshots/serializes the immutable SSE payload synchronously before queueing; its owning docs now reflect this. These remain unverified source changes. No tests/builds/typechecks/provider calls/evaluation/release/Git publication have run. P2/P4/P8 remain partial or queued on stated P1/P8/OS evidence; P9 release gates remain open. Overall V1: PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-21 implementation owner refill

P1 finished the source-origin audit, including raw TUI editor/clipboard and SDK spawn APIs; plugin/MCP/hosted-tool paths are disabled or gated, shell remains Guard/HostKernel-routed, and LSP/DAP/REPL launch remains gated. Its cgroup/restart and enabled-origin behavior still needs final integrated acceptance. P6 and P7 handed off PARTIAL source packages with their owners' contract/test-catalog notes updated. P6 remains blocked on protected credential/probe grants and Guarded search; P7 capture/restore and `run_now` remain denied pending same-revision HostKernel facts, Guarded receipts, and canonical schedule semantics; transient non-Session event replay has no canonical owner. Active phase owners are P2, P4 and P8. P2 must preserve the Session-pinned model for title generation absent an explicit title model. No validation or provider calls ran; all runtime gates remain false pending evidence. Overall V1 PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-21 critical-path implementation queue

P1/P2/P9 are the active whole-phase owners. P1 resumed for remaining Guard/ExecutionHost source, particularly protected native-input plus authenticated Guarded SecretBroker/probe grants under the existing §12.17/§14.7/§37 contracts, and dispatch/recovery cleanup; any unsupported contract stays unavailable. P2 continues managed/direct child lifecycle and the Session-pinned title model correction. P9 continues bounded local distribution readiness source with no remote access. P4 is PARTIAL and has no safe remaining source without P1/P3/OS evidence; P8 is PARTIAL with no P8-only source gap and actual quotas/trusted ingress absent. P3/P5/P6/P7 remain source-partial or acceptance-gated. No verification or external operation ran; keep effects gated and overall V1 PARTIAL / NOT VERIFIED / NOT RELEASED.

P2 source update: implicit title generation now retains the Session-pinned provider/model, with only an explicit configured title model as override. P9 found non-repository qualification output paths in release workflows and is correcting them in source only. No checks or workflow execution.

P2 handed off PARTIAL after its Session-pinned title-model correction; the managed verifier/evidence vertical is still blocked by P1/P8 proof. P5 has resumed as whole-phase owner for source-level audit/closure of the approved built-in web-search cascade, with no network calls and runtime false until P1/P6 grants. P9 continues repo-local distribution work; P1 continues critical Guard/ExecutionHost. Active owners: P1/P5/P9. No validation or external activity.

P9 follow-up: qualification workflow outputs are now repository-local under `$GITHUB_WORKSPACE/kernel/target/horizoncode-release/ci-<run>-<attempt>/`; source assertions reject `/tmp` and `$RUNNER_TEMP`. README documents manual read-only qualification without sign/publish/upload/update activation. No workflow/release command was executed.

P1 contract finding: existing SecretBroker contracts define one-use opaque secure input and in-process byte confinement, but omit the authenticated write context/Guard grant/receipt and Doctor NetworkReadGrant policy schema needed to safely enable credentials/probes. Put/revoke now fail before mutation and those paths remain unavailable; do not invent missing authority. P1 reports bounded ToolBatch pre-admission/cancel source and cgroup retention capped at 256 with fail-closed behavior. P5's source interfaces match the existing Rust cascade journal; an exported callback executor remains to be removed/disabled. P6 resumed a complete source-to-FEAT/S1/provider audit. P9 source pass is PARTIAL with local-only workflow outputs, bounded license inventory and installer version mismatch rejection. Current owners P1/P5/P6. No validation or external operations.

P6 resumed review corrected `pending_apply` truth: only explicit `unlocked` permits deferred apply, while unknown lock is blocked; fixture/docs are source-only. P1 source handoff confirms missing SecretBroker mutation/protected-input and Provider Doctor grant schemas, leaving those paths closed; bounded ToolBatch/lease source is not acceptance evidence. P3/P5/P6 are active whole-phase owners. No checks or provider calls.

P5 handed off PARTIAL after removing the production callback-based cascade executor; only a test fixture retains the simulator. Ordered explicit-route cascade and auth 401/403/407 fall-through source is present; P1/P6 acceptance remains. P6 handed off PARTIAL with strict unknown-lock handling. P3's full source audit identified response-validation requirements (requested depth, entry depth, stable ordering/uniqueness, mode semantics) in P1-owned Core discovery projection; P1 resumed to implement that seam while P3 continues its own source audit. Active owners P1/P3. No tests or network calls.

P2 handed off PARTIAL after fixing title model pinning and default-denying the Goal verification UI (mounted app does not opt in); verifier launch/recovery and P8 settlement remain. P1 owns the `Verifying` restart case where challenge state is absent. P4 resumed to continue source work against the current P1/P3 protocols. Active owners P1/P3/P4; no validation.

Parent interface decision for §12.19 recovery: P1 will add a HostKernel-owned idempotent verifier-set prepare/read keyed by a digest of the complete authenticated Run/Attempt/owner-epoch/Spec/profile/final-revision/evidence-plan tuple. HostKernel atomically persists the full set before challenge IDs leave the host; exact retry returns the same awaiting set, pin mismatch conflicts, partial/UNKNOWN remains reconciliation-only. P2 resumes from the exact P1 DTO. P1 also owns an optional digest-bound DAP evaluate permission, default-deny; no runtime gate is promoted before acceptance.

P3 handed off PARTIAL after bounded manifest/document enforcement; model tools remain hidden pending acceptance and parser-backed query, overlays and cache retirement remain gated. P2 resumed against the parent-approved P1 verifier-set recovery interface. Active owners P1/P2/P4.

P1 is implementing default-deny, digest-bound DAP `allowEvaluate`, checked before Guard challenge and dispatch and retained for the exact process generation; P4 aligns its request. The §12.19 crash window is addressed through HostKernel-derived verifier-set idempotency over all authenticated Run/Attempt/epoch/Spec/profile/final-revision/evidence-plan pins, persisting before challenge IDs are returned; only exact awaiting sets replay. P2 aligns the Core consumer. No acceptance evidence yet.

P4 source additions: default-deny DAP evaluate permission is projected from immutable Core config and checked before existing per-call Guard; exact-scope LSP status is read-only HostKernel state and never spawns. P1 is updating the Rust/schema enforcement. P4 continues document ingress and typed REPL recovery source; all effects remain gated.

P4 REPL callback events remain unavailable: no HostKernel callback-read/reply receipt DTO exists. P4 added a constant-false ingress/capability projection and an unrun negative fixture; process and operation gates stay closed.

P4 handed off PARTIAL with default-deny DAP evaluation, exact-scope cached-LSP status, and constant-false REPL callback ingestion; unsaved buffers, production ingress, DAP namespace/ptrace, OS quotas and durable REPL callbacks remain. P8 resumed to audit/implement its full worker/final-Inspect/OwnerLog phase against P1/P2 verifier recovery; keep fan-out/cache eviction/RC0 unavailable until proof.

P1's stable verifier-set source is in progress. Parent requires explicit trusted pins in the response (Goal/Run/Task/Attempt, owner epoch, SpecVersion/profile revision+digest, final revision, evidence-plan digest) together with verificationRunID, stable setIdentityDigest and challengeSetDigest. P2 validates against Core state; P8 carries both digests through final Inspect/settlement. Opaque digest-only validation is insufficient. No tests.


## 2026-10-21 12:57 UTC — implementation continuation / owner refresh

User reaffirmed implementation-first and approved optional Linux cgroup-v2 containment for restart proof. Bootstrap was refreshed from root instructions, trackers, V1 architecture/governance and operative plan. Repo-only boundary remains in force: no host paths, external services, Git remotes, checks/builds/typechecks/audits/provider calls/evaluations/releases, or Git staging/publication. Git state remains mixed and unstaged (198 modified paths, 76 untracked at refresh); one repository worktree; repo-local kernel/target is 627 MB and filesystem reports 817 GB free. No cleanup performed.

Active whole-phase owners (3 child slots): P1 Guard/ExecutionHost (agent_lifecycle_opencode_codex), P3 RepoIntel/Discovery (v1_phase_source_inventory), and P7 stream/render/artifacts/analytics/automation/rewind (arch_audit_contract_flows). P2 source handoff is PARTIAL and not accepted; its exact verifier settlement integration still depends on P1/P8 proof. P4/P5/P6/P8/P9 remain PARTIAL, gated, or queued. P1 cgroup-v2 is optional and Linux-only; assignment requires authenticated delegation, identity is persisted before dispatch, restart recovery reconciles only the same verified cgroup, and uncertain/non-empty state remains UNKNOWN/disabled. No quota guarantees or unsupported native Windows acceptance are implied.

Parent approved two bounded cross-owner source tasks: P3 may add the missing discovery request/page union arms to the canonical RepoIntel JSON Schema matching TS/HostKernel DTOs; P7 may repair only refreshSessionMessages reconnect bookkeeping in packages/tui/src/context/data.tsx to preserve/detect live deltas during canonical pagination, leaving P6 question handling untouched. Parent updated arch_V1/37-RUNTIME-SERVICE-LLD.md §37.11 to make V1 SSE explicitly live-only (no SSE id/global Last-Event-ID), specify per-part sequence/sourceGeneration fencing and canonical owner resnapshot, and record the overlapping-fetch race requirement. These are source changes only. No checks have run. HorizonCode V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-21 12:59 UTC — overlay visibility correction

P1 discovered `kernel/src/cgroup_v2.rs` was hidden by the root overlay ignore policy, despite being included by `kernel/src/lib.rs`. Parent added the narrow `!/kernel/src/cgroup_v2.rs` exception in `.gitignore` and informed P1; the source remains unverified, and the full overlay audit is still deferred with the rest of implementation-first checks.

## 2026-10-21 13:00 UTC — P7 reconnect source handoff; P4 slot refill

P7 completed the source repair of the canonical Session refresh race: overlapping message fetches coalesce; live Session deltas advance generation; pagination retries once; a repeatedly moving source preserves the live projection/cursor rather than overwriting newer events. The change is bounded to refresh/reconnect bookkeeping; P6 question handling was not edited. §31/§45 now reflect this. No checks were run; P7 remains PARTIAL pending full TUI/stream/artifact/analytics/recovery acceptance and P1/P2 dependencies for effectful automation/checkpoint paths.

Available slot is assigned to P4 as a whole-phase source owner for supervised LSP/DAP/REPL integration. Current active owners: P1, P3, P4. P1 cgroup module Git visibility is restored by a narrow root ignore exception; P3 is aligning the missing discovery JSON Schema arms. All three phases remain unverified; implementation-first hold continues.

## 2026-10-21 13:02 UTC — P3 source/docs pass complete; P8 slot assignment

P3 completed its unblocked source/docs pass. The RepoDiscovery request/page union arms now mirror the strict TS/HostKernel DTO in the canonical JSON Schema; §30, §32, and §33 no longer claim discovery is absent and now describe the feature as source-present but gated. Remaining P3 blockers are intentionally fail-closed: registry/cursor use await integrated acceptance, parser-backed semantics lack approved provenance, overlays lack trusted immutable editor-buffer ingress, and cache eviction lacks an authenticated pressure trigger. No schema validation or tests were run.

The freed P3 slot is assigned to P8 whole-phase source integration, prioritizing the P1/P2 verifier-set pins through durable worker/final-Inspect/settlement receipts, then remaining unblocked resource/RC0 source. Current active owners: P1, P4, P8. P1/P4/P8 remain source-only; no validation commands have run.

## 2026-10-21 13:04 UTC — P1/P8 final-Inspect verifier-pin integration

P1 source review closed an identity-binding gap: cgroup `process_kind` is now checked against the persisted capability at preflight, terminal settlement, and startup/restart reconciliation using the canonical stdio process-kind mapping. No validation was run.

P8 confirmed worker terminal settlement already persists and replays opaque verifier-set pins with P2/P8 receipt identity checks, and FAILED/CANCELLED quarantine remains pinless. A newly found source gap is that the P8 managed final-Inspect candidate pin/digest does not yet bind `verificationRunID`, `setIdentityDigest`, and `challengeSetDigest`. P8 owns the worker_durable candidate contract; P1 owns HostKernel prepare/execute/recovery resolution and must pass the exact HostKernel-issued settled token. P2 candidate code is not to be edited. This integration is in progress; no tests.

## 2026-10-21 — current continuation checkpoint

Pi/Codex comparative decisions are recorded in `docs/research/2026-10-21-pi-codex-harness-decisions.md`
and mapped into arch_V1 §§29.21/30.24/31.21/42.16/45.26. Preserve one Core Session owner
and one Rust managed owner; do not introduce a parallel Pi Durable runtime or transcript store.
P1/P3 source passes are complete but unverified; P4/P8 remain partial/gated; P6 is the next
whole-phase source assignment. Codex source research is active. Implementation-first hold remains
in effect: no verification commands/provider calls/evaluations/release checks until source work
is complete. Overall V1 PARTIAL / NOT VERIFIED / NOT RELEASED.


## 2026-10-21 — Codex comparison completed; whole-phase source owners refreshed

The deeper local Codex lifecycle/event/UI review is recorded in §42.17 and the comparison note.
Codex's separate operation/activity events, reserve→create→persist-lineage→accept-input order,
separate admission/execution/residency budgets, bounded activity overview, and parallel-work
guidance are useful patterns. Its topology/thread history persists, but mailbox/runtime state and
completion notification are process-local/best-effort; HorizonCode's explicit durable delivery,
named wait, Attempt authority, and receipt reconciliation remain the stronger contract. No new
schema/runtime was justified and no upstream code was copied.

Active whole-phase source owners: P2 delegation (Codex research agent reassigned after completing
research) and P6 providers/settings/Doctor/S1 (source inventory agent reassigned after P8 pass).
P1's current source integration and P3/P4/P8 unblocked source passes are complete for now, but
remain PARTIAL/NOT VERIFIED because acceptance and dependencies are open. P8 verifier pins now
flow through all five HostKernel→worker final-Inspect/replay/recovery paths and bind the verifier
IDs/digests in its candidate/receipt; worker fan-out, cache retirement, hard OS quotas and RC0
remain gated. No tests, builds, typechecks, audits, provider calls, benchmarks, or release checks
were run. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.


## 2026-10-21 13:10 UTC — P6 handoff and P7/P9 slot refill

P6 completed its unblocked source pass: provider/model routing and explicit free-route eligibility,
settings provenance/lock semantics, offline Doctor, and S1 ownership/callback paths are present.
Provider Doctor TUI now renders the server's VALID/INVALID/UNKNOWN configuration status rather
than conflating a probe PASS/FAIL with configuration validity. Credentials and live probes remain
closed pending P1 authorization; real provider journeys and FEAT/QA acceptance are not run.

The available whole-phase slots now belong to P2 delegation, P7 streaming/rendering/artifacts/
analytics/automation/rewind, and P9 packaging/release-readiness source. All three work source-only;
no validation/release commands run during the implementation-first hold. P1/P3/P4/P5/P6/P8 have
no currently assigned source worker and remain partial/unverified or gated as listed in the phase
ledger. Research/docs are in `docs/research/2026-10-21-pi-codex-harness-decisions.md` and §42.
No changes are staged or published; existing mixed Git work is preserved. V1 remains PARTIAL /
NOT VERIFIED / NOT RELEASED.


## 2026-10-21 13:12 UTC — P7 source pass and P1/P2/P9 owner allocation

P7 reviewed all remaining unblocked source and found no safe change beyond the current bounded
stream/redaction, replay fencing/resnapshot, activity, artifact/analytics, automation-management
and checkpoint-preview implementations. Effectful automation remains disabled; checkpoint
capture/restore and transient-event replay remain blocked on HostKernel facts/owners and Guarded
receipts. No tests/builds/audits were run.

Current whole-phase source owners are P1 Guard/ExecutionHost, P2 direct/managed delegation and
Goal review, and P9 local packaging/release-readiness source. The P2 review-inbox component exposed
source issues that its owner is correcting before route integration; the shared session route is
being coordinated to avoid P7/P2 writer overlap. P7/P6 source passes are complete but unverified;
V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED. Mixed Git state remains unstaged and preserved.


## 2026-10-21 13:13 UTC — P1 source pass handoff; P5 slot refill

P1's final source-origin pass found all reachable first-party process origins already rejected
before spawn or fail-closed behind HostKernel readiness. ToolBatch admission, durable receipt and
UNKNOWN reconciliation source are present. No safe P1 source expansion remains. P1 stays
PARTIAL/NOT VERIFIED pending Linux confinement/cgroup restart and crash/cancel/UNKNOWN acceptance;
SecretBroker mutation/live Doctor remain gated on trusted authenticated input/grant contracts.

The freed slot is assigned to whole-phase P5 cascade source closure against approved route order,
explicit opt-in, auth fall-through, provenance/retry/failure bounds, consent, and no paid fallback.
Current owners are P2/P5/P9. No provider calls, tests, builds, typechecks, audits, or release
operations have run. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.


## 2026-10-21 13:15 UTC — P5 source closure; P3 source owner reassignment

P5 compared the ordered cascade against the approved contract and found the source aligned:
explicit enabled-route order, auth 401/403/407 fall-through without retrying that route, stop on
other 4xx, bounded 429 cooldown/retry, ordered per-route provenance, consent and no paid fallback.
The production callback executor is absent and `WEB_SEARCH_RUNTIME_READY` remains false. P5 has no
unblocked source changes; runtime awaits P1/P6 acceptance.

The freed slot is assigned to whole-phase P3 RepoIntel/Discovery source continuation, reviewing
existing local OpenCode/Codex parser/query patterns and implementing only safe source gaps within
HostKernel's single authority. Parser semantics, unsaved overlays and cache eviction remain gated
unless their exact provenance/ingress/pressure authority exists. Current source owners: P2/P3/P9.
No tests/builds/audits/provider calls were run. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.


## 2026-10-21 13:18 UTC — Source implementation continuation

P3's unblocked source gaps are complete: display labels are sanitized while HostKernel paths remain
canonical, and its tree renderer counts the truncation marker inside the 32 KiB output cap. P9's
unblocked release-hardening source is complete: disabled publication workflow overlays, a fail-closed
package publisher, a pre-Docker container push guard, and distribution-audit checks. Both remain
unverified. Current active whole-phase owners are P2, P4 and P6. P2 is completing managed Goal
proposal/review and explicit start; P4 owns supervised language server/debugger/interpreter paths;
P6 owns provider/model/settings/Doctor/S1 journeys. Continue source implementation; do not begin
tests/builds until implementation is complete. No external paths/services/remotes, staging, or
publication. Overall V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.


## 2026-10-21 13:21 UTC — Whole-phase owner refresh

P4's safe DAP/LSP source fixes are complete; DAP attach and REPL remain blocked on OS enforcement,
namespace/ptrace, quotas and receipt recovery. P6/P8 source re-audits found no further safe code,
with acceptance and independent evidence still open. Active owners are P1, P2 and P7. P2 is
completing an authenticated accepted-Spec/profile selection projection before PLAN_ONLY and explicit
`goal.start`; canonical digests remain HostKernel-derived. P7 continues independent streaming,
rendering, artifact, analytics, automation and rewind work. Tests/builds remain deferred until
source implementation is complete. No external paths/services/remotes or Git publication. V1
remains PARTIAL / NOT VERIFIED / NOT RELEASED.


## 2026-10-21 13:22 UTC — P1/P7 handoff; P5 active

P1 found no further safe source change under the approved contracts; remaining Linux containment
and crash/cancel/UNKNOWN proof is verification work. SecretBroker and live Doctor remain unavailable
until their protected-input, Guard-grant and receipt contracts are defined. P7 found no additional
safe source change; automation invocation and checkpoint capture/restore remain gated. Active source
owners are P2 and P5. P5 is tracing the existing Guarded network grant/receipt contract for the
approved cascade; no provider calls or invented authority. Tests/builds remain deferred. V1 remains
PARTIAL / NOT VERIFIED / NOT RELEASED.


## 2026-10-21 13:23 UTC — P5 handoff; P1/P2 interface work

P5 found no further safe source change; its production cascade is Guard/HostKernel mediated but
remains disabled pending integrated P1/P6 acceptance. P2 found that PLAN_ONLY lacks Rust-minted
per-Task profile and effective permission-scope digests needed to present a trustworthy plan. P1
owns the Rust response/schema; P2 owns Core/HTTP/SDK/TUI mapping and the bounded selector. `goal.start`
must remain gated until those exact pins are returned and shown. No TS hashing or caller authority.
Active owners P1/P2. No tests/builds/network/provider calls. V1 remains PARTIAL / NOT VERIFIED /
NOT RELEASED.


## 2026-10-21 13:29 UTC — Current phase execution state

Superseding the stale 13:23 summary: P1 completed Rust-authored PLAN_ONLY `taskPins[]` and the strict schema. The plan response distinguishes `acceptedScopeDigest` and `profilePermissionCeilingDigest` from Attempt-bound effective `permissionScopeDigest`. P2 aligned Core/HTTP/SDK/TUI to those exact pins. No authenticated accepted-only Goal listing exists, so the current bounded Goal-ID input remains and local Session/DB views do not become managed Goal authority. Goal review/start use authenticated principals and server-side workspace/Spec/Rust ownership checks.

Active whole-phase source owners are P2 (managed delegation and Goal flow), P4 (LSP/DAP/REPL), and P8 (worker pool, final Inspect, verifier recovery and resource budgets). P4/P8 continue independent source tasks while honoring shared P1/P2 contracts and keeping unproven effectful paths gated. The implementation-first hold remains: no verification commands until all source work is complete. Research comparisons use checked-in local OpenCode/Codex/Pi snapshots and the Pi/Codex decision note; repo-only restrictions prohibit external URL fetches or remote queries. Git state remains mixed and unstaged; preserve unrelated work. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.


## 2026-10-21 13:31 UTC — Phase-owner refresh

P2 source work is complete for now, including authenticated selection/review, HostKernel Task-pin validation in Core/HTTP/SDK, and the explicit exact-pin PLAN_ONLY → `goal.start` UI. An accepted-only Goal list endpoint does not exist, so Goal-ID entry stays bounded and explicit. P4 and P8 found no safe new source gaps; they keep their gated paths unavailable pending Guard/OS/recovery evidence.

P6, P7, and P9 now own the remaining unblocked phase source tasks. P7 is implementing provenance-aware aggregate token/cost analytics. Three hidden P2 dialogs were made Git-visible via exact ignore exceptions. All work stays inside the repository; local OpenCode/Codex/Pi reference snapshots and the prior Pi/Codex decision note are the research basis. Testing remains deferred until implementation is complete. No remotes, staging, cleanup, tests, builds, provider calls, or release actions. Mixed work preserved; V1 PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-21 13:35 UTC — P6/P7/P9 handoffs; P1/P7 context work

P6 and P9 completed their unblocked source passes, not verification. P6 now projects truthful bundled Models.dev catalog provenance; P9 local container/release source avoids implicit upstream CI image pulls and audits visibility while publication stays disabled. P7 added bounded provenance-aware token/cost analytics; no cross-route cost sum without currency authority.

P7 also found ContextSelectionV1 is only a Session-message reference list today and is not used by the actual prompt compiler. Reopen P1/P7 source integration: P1 owns strict shared schema/Rust decoder/canonical selection digest; P7 owns Core context compilation and binding the admitted Rust pins to managed provider dispatch. HostKernel computes the digest and returns it on admission/replay; Core carries that exact value into provider-request provenance. Do not invent profile authority for legacy direct Sessions; require the exact trusted Task-pinned profile for managed work. Parent fixed P2 capability selection so accepted Spec requirements cannot be silently weakened by profile intersection.

No tests/builds/typechecks/audits/provider calls until source implementation is complete. No external URLs/remotes under repository-only boundary. Mixed Git state preserved. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-21 13:41 UTC — source comparison and request-bound managed context

The checked-in Pi-like source is OMP `repo_take/oh-my-pi` at `a536558` (2026-10-16), not the Earendil Pi repository, and has no `packages/durable`; the supplied Pi Durable text is analyzed as user-provided design. Local Codex `repos/codex` is at `14830654c` (2026-10-20) with 206 tracked modifications; this is not a clean/latest-upstream review. The expanded local findings and adopt/defer decisions are in `docs/research/2026-10-21-pi-codex-harness-decisions.md`. No external access occurred.

P1/P2/P7 now own one cross-phase correction: ContextSelection is per provider request, not one immutable digest for an entire multi-turn Attempt. Bind each exact compiled prompt at a safe request boundary with monotonic request ordering, live Attempt/owner epoch, authentic Task/accepted Spec/profile/tool/context source revisions and digests, and carry the same immutable compiled request to the provider. P1 owns Rust/schema/HostKernel; P2 owns managed transition/control APIs; P7 owns Core prompt compilation/dispatch. Keep managed prompt dispatch false-gated until connected.

P3 unblocked source review is complete. Discovery cannot currently return its safe symlink inventory because the shared workspace revision walker rejects any workspace symlink first. P1 owns a typed no-follow RepoIntel observation/revision seam; do not weaken mutation snapshot safety. Other parser, editor overlay, and cache/pressure paths remain unavailable pending their named owners/evidence. No tests/builds/typechecks/audits/provider calls were run. Active source owners: P1/P2/P7. V1 PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-21 13:44 UTC — managed context transition boundary and evaluation status

P1/P2/P7 agree on per-provider-request managed context binding: seq=1 selection at Attempt admission; each subsequent provider call advances exact sequence 2..1024 through `managed_context.advance`, pinned to request ID/digest and live Attempt/session/profile/owner epoch/current managed revision. Exact replay is idempotent; stale, conflicting, missing, terminal, or skipped sequence denies. P1 owns HostKernel/schema and durable bounded ref-only selection; P2 the Core managed-control API/projection; P7 the actual processor/LLM pre-dispatch compiler seam and immutable request handoff. This is an agreed source contract, not yet CODE_PRESENT/VERIFIED; keep runtime gates closed.

The evaluation runner remains fake-provider-only. It validates manifests/journals/report logic, not HorizonCode execution or benchmark performance. The existing HUP plan corrects stale headline figures, requires paired frozen configurations and uncertainty, and stages future runs from fake self-check through explicit free-route smoke and pinned benchmark subsets to held-out paired runs. No checks or provider/benchmark calls ran.

## 2026-10-21 13:46 UTC — managed child Session identity parity

The TS adapter currently rejects ContextSelection.sessionID equal to input.sessionID; Rust HostKernel requires the selection Session to equal the exact Attempt child Session and be distinct from the separately bound parentSessionID. P2 owns aligning the TS decoder/check and carrying request sequence/ID/context digest through Core and OpenCode managed scope projections. The context digest must describe the Session that actually owns the provider prompt; root Session is parent lineage. P7 owns the processor/LLM call boundary; P1 owns Rust validation and receipts. No tests/checks.

## 2026-10-21 — P8 staged reservation source update

P8 now implements Stage-A candidate/worktree reservation and Stage-B binding of the actual Rust-validated ContextSelection in `kernel/src/worker_durable.rs`. Restart replay resolves the existing candidate by Attempt identity plus stable idempotency key, returning the original persisted expiry and target pins without extending authority. Stage-B exact replay returns the same stable context-bound receipt without appending a duplicate OwnerLog event; a changed digest conflicts. Stable receipt identities are distinct from the current cursor/pool-bound lease proof. P1 owns HostKernel RPC integration; P2/P7 own exact frozen-request sequencing and admission use.

P8's remaining whole-phase paths were audited against §18/§21 and HUP/RC0 acceptance. No further safe P8-only effectful source change was identified: fan-out, settlement and worktree release need P1 process/effect quiescence plus P2 terminal Attempt/final-revision/verifier evidence; pressure needs approved lower-watermark/calm-window policy and authenticated ingress; cache retirement needs authenticated retained-generation callbacks and measured reclaimed bytes; hard OS quotas and RC0 HostRun/verifier attestation are unsupported. These remain unavailable. Source only; no tests/builds/typechecks/audits/provider calls have run. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.
## 2026-10-21 16:13 UTC — V1 continuation checkpoint

The full V1 scope remains active; do not stop at a source slice and do not start tests/builds/typechecks until implementation is complete. Active owners: P1 Guard/ExecutionHost, P2 managed and direct child lifecycle, plus a documentation-only reviewer comparing checked-in Pi-like/Codex source to the authoritative arch_V1 HLD/LLDs/flows/events. P3 RepoIntel's independent source changes are complete for now and remain gated/NOT VERIFIED. Parent is the cross-phase integrator.

Artifact scope was re-audited against §§31.5/31.17/31.19, §37.22–.24 and VEO-012/VEO-018. P1 will persist bounded terminal output immutably in ArtifactStore with exact Attempt/source-revision owner and truthful fidelity; P2 will bind the typed ArtifactRef to the HostKernel terminal receipt. Public Core reads remain unavailable before a succeeded verified managed evidence record links that exact ref. Internal verifier consumption remains HostKernel-authenticated; no public read authority is expanded.

The requested attachment has been read in full. Local references do not provide an exhaustive or latest-upstream review: the Pi-like checkout is OMP without Pi Durable, and local Codex is dirty. That comparison is still underway. Disk: C: 20 GiB free/454 GiB; repository 5.4 GiB; one primary worktree. No tests/builds/typechecks/provider calls/release checks or Git publication/cleanup have run. Preserve mixed Git state. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.
## 2026-10-21 16:16 UTC — P1/P2/P7 implementation continuation

Focused source comparison of checked-in OMP/Codex against Pi Durable input and HorizonCode architecture is recorded in `docs/research/2026-10-21-pi-codex-harness-decisions.md`. The research owner is reassigned to whole-phase P7 source completion. Active owners: P1 Guard/ExecutionHost, P2 managed/direct child lifecycle and terminal HostKernel capture, P7 stream/render/analytics/artifact presentation/automation/checkpoint UI.

P1's EffectHost settlement now binds typed ArtifactRef and capture provenance; raw output is no longer persisted there and synthetic IDs are removed. P2 is replacing HostKernel's terminal Vec with bounded ArtifactCapture, authentic Attempt/workspace/effect owner metadata and typed settlement, preserving FULL/SAMPLE based on capture truth regardless of exit/timed-out/cancelled status. Capture failure after dispatch is UNKNOWN. `pty.ts` already decodes the typed ref/provenance strictly. Keep user-visible artifact reads gated to succeeded verified evidence. No tests/builds/typechecks/provider calls/evaluations/release operations have run. Overall V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.
## 2026-10-21 16:18 UTC — P1/P2/P7 source integration

P2 has wired HostKernel terminal output capture through bounded ArtifactCapture and P1's typed EffectHost API; full observed output is hashed while retained bytes/fidelity are bounded and Attempt/workspace/effect ownership is host-derived. Process status and capture fidelity are independent. Failures after possible dispatch remain UNKNOWN. P1's EffectHost persists no raw output or synthetic artifact IDs. P7 tightened checkpoint target/action validation and corrected the reconnect overlap status; P2 owns a separate bounded `app.tsx` verifier-preview fix if inspection confirms the issue.

Provider boundary from §14.24/§37.22–24: P2 persists managed request lifecycle; P1 validates route/consent/budget and returns one-use Guarded send authorization; P6 sends through existing fixed-route Core/SecretBroker/provider adapter. These remain disabled until connected/accepted. Active source owners P1/P2/P7. No validation or external provider activity has occurred; implementation-first hold remains.
## 2026-10-21 16:19 UTC — P7 handoff and P6 implementation

P7 source pass completed with checkpoint target/action validation, truthful provenance-based token footer, and §31.18/§31.21/§37.11 status reconciliation. P2 hardened the verifier artifact preview callback against malformed refs/ranges and oversized/noncanonical base64 before decoding. Neither phase has run tests/builds.

The freed child slot is now assigned to P6 whole-phase source work. Active owners: P1, P2 and P6. P6 owns Core fixed-route provider/SecretBroker sender and all remaining unblocked settings, offline Doctor and S1 source closure; P1 owns Guarded one-use HostKernel authorization; P2 owns Rust durable managed-provider lifecycle. Provider dispatch remains disabled until integrated acceptance. Keep implementation-first hold and full V1 target.
### 2026-10-21 16:23 UTC — implementation continuation delta

The source comparison note records the local OpenCode/Codex patterns selected for HorizonCode; it does not claim an exhaustive upstream-tree or current-remote review. The attachment was re-read. New source-backed P7 gap: progressive `tools.search` and next-safe-turn toolset generation are normative (§30.18/§33.21; §14.6/§29.8), but current registry has no generation snapshot. P7 owns Core discovery and boundary switching; P2 must persist the exact generation refs/digest in managed ContextSelection. Managed child messaging separately needs an Attempt-bound effective permission-scope digest; P1 owns protocol/schema/helper contract and P2 owns HostKernel mint/persistence/Core projection. Keep both dependent effect paths disabled until integrated. No tests/builds/typechecks run; full V1 implementation remains open.
P2 now validates managed toolset-generation rows in HostKernel: one harness-pinned generation, up to 32 sorted tools, each input schema at most 1 MiB, with shared domain-separated BLAKE3 digests. P7 owns the Core compiler/expansion mirror. This closes the managed-side structural contract only; HarnessProfile projection, direct-session flow, managed persistence/replay, and full integration remain implementation work.
P1 has added the Attempt-bound Rust digest helper for effective managed permissions, binding sorted concrete capabilities and Guard/profile/Attempt provenance under a dedicated domain. P2 is integrating HostKernel minting and durable persistence; the pre-admission profile-ceiling digest remains separate. No verification is claimed.
The managed-provider lane is explicitly split: P1 validates Guard authority, P2 persists one-use request/UNKNOWN lifecycle in HostKernel, and P6 dispatches through the existing Core ProviderTransport under SecretBroker `withUse`. The search HTTP executor is not the model transport. P6 is queued directly after current P7 work because this is on the managed E2E critical path; P4 follows.
P1's DTO/schema handoff does not satisfy P1 acceptance; the phase owner is resumed to finish the remaining Guard/ExecutionHost source. P2 is renaming pre-Attempt ceiling pins consistently and integrating Attempt effective scope. Keep P6 on the critical-path queue for managed provider transport.
P2 now revalidates the Attempt effective-permission digest at managed dispatch while preserving the separate pre-admission profile-ceiling pin. P1 reported one accidental host-wide process listing, stopped immediately, and made no process changes; future process inspection is limited to repository-contained task evidence.
## 2026-10-21 16:32 UTC — local reference review and live owner ledger

The user's Pi Durable description and the local OpenCode/Codex patterns have been compared against active HorizonCode HLD/LLD, schema, event-flow and acceptance owners in `docs/research/2026-10-21-pi-codex-harness-decisions.md`. Source boundary: no Earendil Pi repository is present locally; `repo_take/oh-my-pi` is a fork, and `repos/codex@14830654c` is dirty. This review does not claim exhaustive upstream file coverage or latest remote state.

Active whole-phase owners: P2 managed/direct lifecycle; P6 providers/settings/Doctor/S1 plus P5 SecretBroker-backed transport; P7 stream/render/artifact/analytics/automation/rewind. P1 is PARTIAL and queued. P2's managed message journal currently gates `follow_up` pending an independent managed completed-turn proof; it must not reuse direct turn scope. P7 source adds permission-filtered deferred tool discovery and records selected toolset generation in managed ContextSelection; restart rehydration checks current descriptor schema digests. P6 is implementing the exact selected-route sender, not a new model transport. No checks or provider calls are allowed until source implementation closes per user instruction. No validation/publication occurred; V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.
## 2026-10-21 16:36 UTC — phase slot refill and P7 integration finding

P7 returned its currently unblocked progressive-discovery source pass: bounded permission-filtered registry descriptors, stable built-in HarnessProfile and retained prompt refs, next-request expansion, restart rehydration with current schema matching, and managed ContextSelection toolset refs. `git diff --check` on the edited P7 source was clean; no compilation or tests were run. Parent review found Rust's ContextSelection decoder checks toolset row count/order and digest formats but does not recompute the advertised `horizon.toolset.v1` generation digest. P2 owns the Rust managed integration and is reconciling this mismatch; do not claim the managed generation contract is fully wired until fixed.

Active whole-phase owners: P1 Guard/ExecutionHost on non-overlapping `effect_host.rs`, `http_execution.rs`, `terminal_process.rs`, sandbox and Core process/PTY source; P2 managed/direct lifecycle with exclusive HostKernel and managed Core files; P6 providers/settings/Doctor/S1 plus P5 transport. Managed follow-up remains unavailable pending an independent managed completed-turn/one-use wake proof. Provider transport remains fail-closed pending exact §14.24 route pin + SDK destination validation + internally-derived SecretBroker context. P3/P4/P8/P9 and integration/release remain open in the full V1 scope. No tests/builds/typechecks/audits/provider calls or publication ran.


## 2026-10-21 16:40 UTC — full-scope continuation

P1/P2/P7 are the active whole-phase implementation owners. P1's persisted cgroup identity now includes the exact optional Attempt-scope digest and checks it at pre-dispatch, settlement and restart reconciliation; old records without the pin fail closed. P2's managed ContextSelection toolset manifest now carries `harnessRevision`, and Rust recomputes the BLAKE3 generation from harness identity/revision and sorted capability/schema members; Core and JSON schema agree. P7 is resumed for full stream/artifact/analytics/automation/rewind source completion. P6/P5 is queued; provider route preparation exists but no lease/send occurs pending the dual-digest decision and P2's fresh-begin permit DTO. All remaining V1 phases and final integration/release remain in scope. No tests/builds/typechecks/audits/provider calls/evaluation/release commands ran.


## 2026-10-21 16:41 UTC — managed follow-up proof decision

Resolved the P2 design gap from §29.5: provider request settlement does not prove a complete assistant turn because it may end in a tool call. P2 will add an authenticated Rust `managed_provider.complete_turn` owner-log transition tied to the exact latest settled request/assistant/response/usage pins, live Attempt and epoch, and absence of in-flight provider work or unresolved effects. That durable completion will mint the separate one-use follow-up wake proof; queued messages remain non-waking. P7 owns the Core final-assistant boundary in `session/processor.ts`/`session/llm/request.ts` and is coordinating the callback with P2; P2 owns Rust/managed-control. Active whole-phase owners: P2, P6 (source continuation), P7. P1 returned a source checkpoint PARTIAL and must be resumed for remaining gaps/acceptance; P3/P4/P5/P8/P9 and final integration remain open. No tests/builds/typechecks/audits/provider calls/release operations ran. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.


## 2026-10-21 16:42 UTC — P1/P2/P6/P7 orchestration update

P6/P5 returned SOURCE COMPLETE for currently unblocked code, not verified: catalog/settings/offline Doctor/S1 ownership projections and ordered search auth-failure behavior are present; provider and search dispatch remain false-gated. The managed transport scaffold prepares an exact request and transport digest without lease or send. The user decision on whether HostKernel must bind both normalized input and exact SDK transport digests is still pending; this is a concrete blocker for managed sends, while independent P6 source is closed. P1 has resumed whole-phase source audit. P2 and P7 coordinated a distinct `managed_provider.complete_turn` proof because a settled provider step may be an intermediate tool-call response; P7 will invoke the P2-owned strict HostKernel transition only after `handle.process()` returns at the exact final assistant boundary, not on `finish-step`. Active whole-phase owners: P1, P2, P7. No tests/builds/typechecks/audits/provider calls/benchmark/release operations ran.

## 2026-10-21 16:44 UTC — P7 managed final-turn source integration

P7 wired the completion callback at the actual terminal SessionPrompt loop exit after canonical message reload, matching current-user parent, final assistant finish, and no remaining non-orphan tool work. It calls P2's strict Core operation with the final assistant ID and live managed Attempt authority only; P2 supplies retained exact HostKernel settlement pins and rejects missing/mismatched settlement. This remains unverified and practically gated because P1/P2/P6 managed Guarded dispatch/settlement is not available. Effectful automation and checkpoint restore remain unavailable. No validation ran; overall V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.


## 2026-10-21 16:45 UTC — P1 checkpoint and P2/P3/P7 active

P1 returned source-complete for currently unblocked work, not verified. `EffectHost::begin_execution_dispatch` now returns UNAVAILABLE before validation/persistence on non-Linux, and §14.21 records the platform gate. P1's audit found bounded ToolBatch admission, serial receipt/lease handling, fixed Guard-pinned shell execution, and fail-closed unsupported effect origins; HostKernel/P2 authority integration and later adversarial/OS acceptance remain. The freed slot is assigned to full-phase P3 RepoIntel/Discovery source work. P2 is implementing a durable `managed_provider.complete_turn` proof from the latest exact HostKernel SETTLED request; P7 wired the caller only at the persisted terminal runLoop boundary (final assistant, current user parent, no non-orphan tool work). Parent review identified a required restart path for recovering exact settlement pins after `.settle` before `.complete_turn`; P2 is addressing it, otherwise UNKNOWN/unavailable. P6/P5 source is complete for unblocked work, with provider/search still closed pending the user dual-digest answer and Guard/SecretBroker integration. Active owners: P2, P3, P7. No tests/builds/typechecks/audits/provider/benchmark/release operations ran. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-21 16:51 UTC — implementation-first continuation ledger

**Active full-phase owners:** P1 Guard/ExecutionHost, P2 managed lifecycle, P6 providers/settings/Doctor/S1. P2 exclusively owns HostKernel/managed-control Rust and Core files; P1 owns Guard/EffectHost/sandbox/process/protocol files; P6 owns Provider/SecretBroker transport and current `session/llm.ts` parse repair. Managed provider V1 now has a parent decision (§17.25): bind normalized Horizon input and exact non-secret SDK transport digests to the same one-use permit/settlement, selected route revision, and Attempt/epoch. No send is enabled until P1/P2 permit APIs exist.

The verifier-specific §§12.19/37.22 prevail over stale contradictory notes: the coding Attempt remains live through verification; use `managed_run` origin while binding verifier intent/lease/receipt to that same Attempt, current revision, trusted verifier-profile principal, and distinct authenticated reviewer. Managed follow-up still needs P2's exact durable complete-turn receipt and one-use wake; queue-only messages never wake. P3 is PARTIAL with authenticated lexical discovery present and symlink/P4/parser/overlay/P8 pressure-trigger dependencies open. P7's terminal callback is source-present but depends on P6 settlement/P1-P2 dispatch. P4, P5, P8, P9 and final integration/release remain open.

Comparative-source provenance is corrected in the research note and §42: Codex and OMP are ignored local reference trees, not tracked files; Codex's local snapshot has no Git identity and its upstream pin is unverified; OMP is not official Earendil Pi; Pi Durable description is user-supplied design input. Adopt progressive context, branch/compaction provenance, usage/activity UI, and explicit scoped parallel lifecycle; retain Core/Rust ownership and existing CodeMode; defer automatic cache warming, hosted sharing, extra runtimes/catalogs, implicit virtual routing, and unguarded nested effects.

A focused P1 test selector was mistakenly invoked under the no-tests hold and stopped at a Bun parse error in concurrent `packages/opencode/src/session/llm.ts:1016`, before any test body. It was not retried; P6 owns the repair. No test assertions, build, typecheck, audit, provider request, release, staging, commit or push was otherwise performed. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-21 17:12 UTC — implementation-first phase ledger

| Phase | Owner | Source state and next work | Dependency / evidence state |
|---|---|---|---|
| P1 Guard/ExecutionHost | Active | Separate verifier process principal added through cgroup/broker/dispatch/recovery/receipt; finish remaining Guarded origins, host integration and fail-closed paths | P2 must project trusted verifier profile principal; acceptance intentionally deferred |
| P2 managed lifecycle | Active | Managed inbox persistence/API added; finish prepare/commit/ACK/recovery, managed safe-boundary wake, exact complete-turn/provider recovery, reviewer/verifier/current revision, Core-to-TUI | Depends on P1 Guard/process pins and P6 provider sender; no verification yet |
| P3 RepoIntel | Queued | Finish parser provenance/bridge, immutable overlay producer, pressure/retirement ingress, workspace revision/symlink seam | P1/P4/P8 interfaces; source acceptance open |
| P4 LSP/DAP/REPL | Active | Whole-phase source owner completing supervised lifecycles and guarded mediation | P1/P3/OS acceptance; paths remain unavailable until then |
| P5 Web search | Source present, gated | Approved cascade order/failure provenance source is present; retain disabled until Guard/SecretBroker integration | Acceptance open |
| P6 Providers/settings/Doctor/S1 | Queued for next available slot | Wire Rust/HostKernel triple-digest request authorization and opaque same-process permit into existing Auth/SecretBroker/Provider path; finish remaining Core sender source | Must bind normalized request, exact non-secret SDK request, and SecretBroker operation to same route/Attempt/epoch |
| P7 Streaming/artifacts/analytics/automation/rewind | Partial | Finish remaining source; keep effectful automation/rewind unavailable until P1/P2 prerequisites | Integrated rendered/replay/artifact evidence open |
| P8 Workers/resources/evaluation | Partial/queued | Finish settlement/recovery, authenticated pressure/evaluation and source gates | OS quotas remain unavailable where unsupported; fan-out gated |
| P9 Distribution/release | Partial/queued | Finish package/install/sign/update/rollback source and exact-candidate release gates | Release evidence not started |

No tests, builds, typechecks, audits, benchmarks, provider calls, release actions or Git publication were performed. This ledger records implementation state only; all phases remain unverified and HorizonCode V1 is PARTIAL / NOT RELEASED.

**17:22 UTC source-only delta:** P4 source owner returned after adding typed bounded REPL callback DTOs, aligned Core request/reply wire and a shared canonical MessagePack encoder; parent added one exact `.gitignore` exception so the new helper is Git-visible. LSP/DAP/REPL effect ingress remains gated pending P1 EffectHost/P2 HostKernel integration, P3 reader acceptance, OS proof and real journeys. P7 now owns the next slot and exclusive `session/prompt.ts`/`processor.ts` scope to implement managed follow-up and finish P7; P2 calls this interface but does not edit those files. P6 remains queued for the next slot. No checks run.

**2026-10-21 implementation continuation:** P1's current source pass has returned but is not accepted; unsupported OS paths remain unavailable. P2 added HostKernel validation of an exact one-use wake claim for next-context advance and the typed `TaskPromptOps` bridge. P2 owns that adapter; P7 owns SessionPrompt injection and keeps managed follow-up inert without complete P1/P6 authority. P6 resumed as provider DTO/record/transport owner, while P2 retains HostKernel call-site ownership. Active owners: P2, P6, P7. Remaining P3/P4/P8/P9 whole-phase work must be scheduled as slots open. Verification remains held until implementation freeze; no tests/builds/typechecks/audits/provider calls/release/Git publication ran. HorizonCode V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.

**Continuation delta:** P7 returned source-complete for currently unblocked work, not accepted. Its runner and bounded stream/render/artifact/analytics/checkpoint foundations are present; automation invocation and restore remain gated by scheduler, same-revision observation and Guard contracts. P7 flagged a permission-scope digest mismatch in the P2 wake-claim path; P2 owns reconciliation. The freed slot has been filled by whole-phase P3 RepoIntel/Discovery implementation. Active owners P2/P3/P6; no tests/builds/typechecks/audits/provider/release/Git operations ran.

**P2 contract delta:** Core managed scope/identity now strictly bind required BLAKE3 `permissionScopeDigest` and `workspaceRevision`. The follow-up runner persists its exact wake claim before compiling the claimed request/context and calling HostKernel context advance; P2 is waiting on P6's stable provider DTOs for the remaining HostKernel call sites. No validation ran.

**Writer ownership correction:** P6 provider DTO/OwnerLog edits reached P2-owned managed-control files. A single-writer handoff is in progress: P6 stops those files and gives exact fields/changes to P2; P2 continues only non-overlapping coordinator/HTTP/Task code until handoff. No overlapping HostKernel/provider edits are authorized until the handoff is explicit.

**P3 source delta:** `repo_tree` and `repo_detect` are registered but cannot be exposed unless experiment, authenticated HostKernel read-context feature, and explicit acceptance readiness all pass; readiness stays false. Core's unused local RepoIntel node is removed, retaining HostKernel as the sole production query owner. P3 records the no-follow discovery revision separately from strict mutation revision. Overlay snapshot producer and trusted pressure trigger remain P1/P8 dependencies. No checks run.

**P3 handoff:** PARTIAL/source-only. Registry wiring is complete for unblocked work and remains closed by explicit gates. Remaining dependencies are P4 unsaved-buffer producer/P1 overlay mint, approved parser provenance (current parser dependency prohibited by §42.11), P8 trusted pressure trigger, P1 protected persistent-store root/restart lifecycle, and integrated symlink acceptance. The freed slot is assigned to P4 whole-phase continuation. Active owners P2/P4/P6; no checks ran.

**Managed follow-up compiler unblocker:** P2 cannot build the exact next normalized body in the coordinator because the child Session has real history. A narrow exclusive helper in currently idle P7 `prompt.ts` is assigned to P2 only if it reuses the existing Core runLoop/context compiler and performs no dispatch or transcript mutation. P7 will review on the next slot. No seq-1 body reuse or caller-fabricated provider input; otherwise follow_up remains unavailable.

**P6 source checkpoint:** P6 added strict managed request/dispatch/settlement/UNKNOWN pins and opaque Auth transport matching; provider send remains closed pending P1/P2. Model/settings/Doctor/S1 independent source is present but unverified. P6 remains open for dependency integration. The freed slot is assigned to P8 whole-phase workers/resources/evaluation. Active owners P2/P4/P8; no verification/provider calls.

**Managed follow-up ACK boundary:** P2 may extend the current transferred prompt helper with a typed post-message-commit/pre-dispatch callback. It must consume/ACK the exact inbox row under refreshed scope before the next send; uncertain state blocks dispatch. P7 reconciles the interface on a later slot.

**P8 source delta:** successful worker settlement now admits only CLEAN or Attempt-owned DIRTY_OWNED final Inspect, rejecting unattributed or user-owned changes during proof mint, live transition, terminal resolution and replay. Failure/cancel remains quarantine-only. No checks run.

**P4/P1 delta:** P4 returned PARTIAL after source-level callback wire alignment; callback HostKernel routes, Guard denial receipt authority, authenticated DAP ingress, unsaved-buffer producer/overlay mint and platform acceptance remain. P1 resumed as a whole-phase owner to reconcile EffectHost receipts and the managed provider Guard path; P2 retains HostKernel dispatcher. Active owners P1/P2/P8. No checks ran.

**Provider Guard decision:** the local spec requires a Guarded durable model-send effect (§14.24/§17 A-V2-27) but the canonical registry lacks an inference action. P1 will add internal-only `providers.infer`; neither `web.search` nor generic outbound HTTP is suitable. It binds exact route/model/harness, all request digests, Attempt/epoch, explicit consent/budget and one-use authorization, and is never projected as a model-callable tool. Dispatch remains gated pending P2/P6 and acceptance.

**P2 follow-up source delta:** both managed Task run call sites now inject the typed runner; it compiles exact next context from history, advances with the persisted wake claim, commits the prompt message, then consumes/ACKs before provider send. It binds refreshed scope/request/message/digests. P2 is addressing crash-after-consume replay and provider digest echoes. No verification ran.

**P8 restart-disposition source delta:** success settlement now has a separate current-epoch fresh-Inspect recovery proof/event bound to original P8 settlement pins, current root/owner, P2 terminal/quiescence and Guard receipt. A historical Inspect cannot release the quarantined lease after epoch change. P8 is completing source review for pressure/cache/RC0/verifier integration and will name exact P1/P2 call sites. No checks run.

**P8 handoff:** current-epoch success-disposition recovery proof/event source is complete for unblocked work; P1 HostKernel root/owner/quiescence/fresh Inspect integration and P2 terminal projection remain. Keep lease quarantined until acceptance. Pressure/cache/RC0 and unsupported quotas remain closed. The freed slot is assigned to P9 whole-phase distribution/release implementation. Active owners P1/P2/P9; no checks/release operations.

**P1 provider Guard source delta:** the canonical registry and §§17/33/37 now record sealed internal action `providers.infer`, not a model tool. EffectHost source has prepare binding, Guard challenge/lease authorization, one-use consume and UNKNOWN restart handling. P2 removes projected challenge/lease authority from the HostKernel route. P1 also added durable REPL page reading from live supervisor/journal facts. No checks ran.

**P2 follow-up recovery delta:** the pre-provider boundary now verifies exact current scope/prompt/inbox, consumes only matching committed delivery, and persists HostKernel ACK before model dispatch; restart/UNKNOWN cannot redeliver. REPL callback route remains unavailable without sourced frame-codec and IO-sequence semantics.

**P9 source delta:** source audit found candidate preparer mutation after digest, preventing reproducible clean candidate proof. P9 is relocating the guard to the first-party build script and making preparation read-only. No builds/releases run.


## 2026-10-21 18:03 UTC — V1 source implementation continuation

Parent re-read the required bootstrap in order. Repository-only boundary remains absolute; mixed unstaged Git state is preserved. Source-first hold remains: no tests, builds, typechecks, audits, provider calls, release operations, remotes, staging, commits, cleanup, or external paths. Repo-local free space remains ample from the last repository-contained inspection (814 GB available; `kernel/target` 627 MB); no build has run since.

Current whole-phase owners (actual live slots): P1 Guard/ExecutionHost, P2 managed lifecycle, P9 distribution/install readiness. P1 reports the sealed internal `providers.infer` EffectHost prepare/approve/consume/settle/UNKNOWN/recovery source with exact request/route/SecretBroker/Attempt bindings; remaining end-to-end HostKernel/Provider/SecretBroker wiring is P2/P6-owned and gated. P2 owns the HostKernel + `session/managed-control.ts` API/response contract; the next P6 owner must own `session/llm.ts`, ProviderTransport, and provider/SecretBroker send callbacks to avoid shared-file races. P2 continues follow-up, reviewer/verifier/current-revision, P8 settlement integration and REPL fail-closed review. P9 is closing unblocked local source; no candidate build or release action.

Queued whole-phase owners for newly freed slots: P6 first (managed provider sender and remaining provider/settings/Doctor/S1 integration), then P3/P4/P5/P7/P8 as their dependencies and owner slots permit. All phase source remains unverified; V1 is PARTIAL / NOT VERIFIED / NOT RELEASED.


## 2026-10-21 18:06 UTC — active owner correction and P6/P7 dispatch

P1's unblocked source phase has now returned source-complete (not accepted). P1 reports Guard checks canonical capability membership through P2's `canonical_capability_id_is_registered`; P2 confirmed the implementation helper is `managed_control::canonical_capability_id_is_registered(&str) -> bool`. P1's provider Guard/EffectHost contract is ready for P2/P6 integration; REPL remains unavailable without the authenticated HostKernel route and sourced interpreter frame codec. P9 returned source-complete for unblocked local packaging/audit source, not release accepted.

Freed phase slots were immediately assigned to P6 (existing Provider/SecretBroker sender plus settings/Doctor/S1) and P7 (stream/render/artifact/analytics/automation/rewind). Actual live owners: P2, P6, P7; P2 exclusively owns HostKernel + managed-control files and is correcting stale §17.15/§17.17 ownership notes. P7 is reclaiming its prompt/processor files after reconciling P2's temporary no-dispatch helper. P1/P9 must be resumed by the parent for integrated acceptance after source freeze. Queued P3, P4, P5 and P8 remain open; start whole-phase owners as slots free, based on dependency readiness.

No verification/provider/release/remote/Git mutation has occurred. Mixed working tree preserved. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.


**18:08 UTC integration finding:** Parent source inspection found the managed provider prepare input still contains caller-projected `guardChallengeID` and `capabilityLeaseDigest` (`ManagedProviderRouteProjectionV1` and the Rust `managed_provider_prepare` serializer/strict response shape). This conflicts with P1's HostKernel/EffectHost contract: HostKernel must create the challenge/effect only after prepare is durably recorded; callers cannot supply challenge or lease authority. P2 owns removing these input fields and exposing the host-minted prepare/approval response, then the post-approval one-use dispatch authorization. P6 will consume the exact new response in the existing Provider/SecretBroker sender. Provider sends remain disabled until P1/P2/P6 integration and final acceptance.


**18:10 UTC P7 continuation:** P2 has handed prompt.ts back to P7; the temporary managed follow-up seam is now P7-owned for reconciliation. P7's full source audit identified missing timezone-aware durable automation scheduling/invocation source and checkpoint capture/restore implementation beyond the existing preview UI/endpoint. P7 is implementing the schedulable/control source while keeping invocation gated until P1/P2 receipts are accepted, and will implement checkpoint lifecycle only where complete same-revision no-follow filesystem/Git observations and Guard routes exist; otherwise restore remains unavailable. P2 retains HostKernel. No tests or builds run.


**P7 source correction, 18:11 UTC:** A parent source search found that the canonical Rust automation already contains timezone-aware schedule fields, due-occurrence logic, missed-run handling, and deduplication in `kernel/src/automation.rs`. Therefore P7's earlier statement that a scheduler model was absent is superseded: P7 will reuse and wire that existing authority, not build a parallel scheduler. The production Guarded invocation boundary may still be missing and remains gated. P7 will also inspect the existing `kernel/src/checkpoint.rs` before changing checkpoint lifecycle source.


**18:13 UTC automation integration finding:** P7's source audit found `AutomationGuardContextV1` currently impersonates `SessionBatch`, which violates §§14.1/14.2; the action invocation also lacks stored/resolvable arguments. The canonical Rust scheduler exists, but effectful invocation still needs a dedicated host-selected `AutomationRun` Guard origin/policy (P1), plus exact HostKernel prepare/begin/settle/reconcile and canonical action resolution (P2). P7 will add only its durable schedule candidate/preview/payload projection and TUI source, leaving invocation unavailable until those contracts arrive. This supersedes no prior scheduler implementation; no duplicate scheduler is authorized.


**18:16 UTC provider authority update:** P2 has removed caller-projected Guard challenge/lease from the managed route projection and split the HostKernel-minted challenge (`prepare`) from approved lease/opaque send authorization (`begin`); OwnerLog no longer records a lease at PREPARED. P6 reports the sender contract is aligned, but HostKernel prepare/begin/settle still return `UNAVAILABLE`, and route consent still needs a trusted source. P2 now owns activating the actual Guard/EffectHost-backed durable lifecycle using P1 interfaces; P6 owns resolving authenticated user consent and the existing Provider/SecretBroker sender. No send is enabled.


**18:19 UTC managed inference consent decision:** Architecture review of §§14.24/.25, 16.17, 37.22/.23 found no accepted separate persistent provider-enable setting for inference routes. Use the exact HostKernel-created Guard approval challenge as per-effect route consent, bound to the selected provider/model/harness/endpoint revision, billing/budget class, live Attempt and request. Do not accept caller `consentRef`, infer consent from credentials, or add another config authority. Existing user-selected provider/model remains authoritative; persistent web-search route enablement stays a distinct setting. P2 is recording the contract in §14.25/§37.23 and implementing OwnerLog approval pins; P6 carries the host-issued challenge proof through the existing Provider/SecretBroker sender.


**Automation scheduler correction (18:22 UTC):** Parent's 18:11 source note was wrong and is superseded. `kernel/src/automation.rs` stores `schedule_expression`/`timezone` and processes externally resolved UTC `DueOccurrenceV1` records; it has no cron/timezone resolver or producer. §31 explicitly says not to add an ad hoc parser. P7 removed its TUI parser/preview. Scheduled execution remains blocked until an accepted canonical timezone-aware Rust scheduler source is available; no external fetch/dependency install is allowed under the repository-only boundary. P7 is documenting this exact limitation and can complete the fixed-input payload/Guarded invocation source, but must keep scheduling unavailable without the resolver. Proposed action inputs are immutable bounded user-authored payloads, versioned with the AutomationDefinition, validated against the canonical action schema at save and dispatch, and digest-bound to Guard approval/receipt; dynamic model args and raw secrets are forbidden.

## 2026-10-21 — provider authorization interface unblocker

The Rust managed provider prepare/authorization binding no longer includes caller-projected `consent_ref`; the accepted consent source is the per-request HostKernel Guard challenge created after PREPARED. Parent made the DTO/validation/digest correction in `kernel/src/http_execution.rs` as a narrow shared unblocker while the P1 slot is occupied. P2/P6 are aligning handlers and sender. This is source-only and does not unlock dispatch. Actual active whole-phase owners: P2, P6, P7; P1 next queued; P3/P4/P5/P8/P9 remain open. No checks ran; final integration and release remain pending.

**P7 automation delta (2026-10-21):** fixed action payload/schema pins, bounded canonical JSON, v2 OwnerLog migration, and Core/TUI projection are source-present. P2 HostKernel parser/Guard projection and P1 authenticated canonical schema validation/secret policy remain; dispatch is still disabled. The canonical timezone scheduler remains unresolved; no ad hoc cron parser is authorized. No checks ran.

**Provider Guard approval interface — 2026-10-21:** reuse authenticated `effects.resolve_approval_set`: HostKernel inserts the exact provider challenge into its challenge registry, TUI resolves the user's decision, and only then does P2 call begin. Caller cannot provide challenge or lease authority. P2's automation parser/summary now carries P7's schema/input fields; P1 canonical registry validation remains required. No tests ran.

**P1 dependency clarification — 2026-10-21:** the existing managed approval-set endpoint is verifier-only; provider inference needs a canonical `providers.infer` approval contract and trusted UI projection. P1 owns this exact Guard/HostKernel/UI path; P2/P6 may not synthesize a decision. This is the next critical queued phase when a child slot opens.

**P7 automation trust boundary — 2026-10-21:** caller-entered action schema digests cannot authorize create/update. P7 is adding a pre-prepare fail-closed gate until P1 provides authenticated canonical schema resolution; P2's parser is only transport, not authority. No tests ran.

**P6 transport update — 2026-10-21:** provider/model/environment credential resolution is denied for managed requests and prepared transport URLs reject credential-shaped query parameters. Existing SDK model selection is preserved. This does not enable dispatch.

P6's managed LLM unavailable reason now names the actual remaining Guard approval, one-use authorization, bounded transport and settlement prerequisites; the gate stays closed.

**Provider integration remainder — 2026-10-21:** source review found managed settle/UNKNOWN and the fresh authorization handle are still uncalled in production. P2/P6 own SDK fetch/Auth interception, final assistant-entry/usage settlement, and UNKNOWN recovery; keep dispatch disabled until integrated and accepted.

**Provider ownership split — 2026-10-21:** P2 owns Rust durable transitions, P6 owns SDK/Auth transport, and P7 owns prompt/processor final-entry settlement and UNKNOWN orchestration. P7 requested exact DTOs from P2 before implementation; P6 is preparing fetch integration. Automation create/update are fail-closed until P1 schema authority is available.

**Provider response receipt contract open — 2026-10-21:** no canonical responseDigest formula/source verifier is currently defined. Parent proposed hashing the exact final persisted `SessionMessage.Assistant` through the existing canonical MessagePack encoder under a versioned BLAKE3 domain; usageDigest remains §12-derived. P2 must confirm/source an authoritative digest contract before P7 wiring.

**Provider response digest resolved — 2026-10-21:** P2 recorded the canonical persisted Assistant-entry digest in §37 using the existing MessagePack encoder and a versioned BLAKE3 domain; usage remains a separate §12 digest. P7 may now implement the processor settlement callback against this exact contract.

**Managed route pinning requirement — 2026-10-21:** P2 found provider/model are Attempt-pinned but harness/route/endpoint revision/credential ref are not. Resolve through the existing Core Config owner at admission, persist immutable secret-free route pins/digest in the managed Attempt binding, and compare at prepare/begin. P6 is identifying the current canonical route resolver; do not add a second registry or enable dispatch before this is implemented.

**Route authority resolution — 2026-10-21:** existing `Provider.managedRouteProjection` and Auth metadata-only SecretBroker refs are the route source. P2/P6 will pin the exact six-field secret-free projection at Attempt admission from AgentProfileV2 and compare each request; endpoint revision is rechecked by the existing transport-target resolver. No parallel registry is needed.

## 2026-10-21 — source continuation roster

Following child usage-limit stops, the actual active whole-phase owners are P1 Guard/ExecutionHost, P2 managed/direct lifecycle, and P7 streaming/artifacts/automation/rewind. P6 is queued to resume on the first free slot; P3/P4/P5/P8/P9 remain open. Full V1, source-before-tests, local OpenCode/Codex reuse, repo-only boundary and mixed Git preservation remain controlling. No tests/builds/typechecks/audits/provider calls/release actions ran. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.

**P1 provider approval update — 2026-10-21:** dedicated `providers.infer` managed approval resolution is source-present in EffectHost with exact nonsecret projection; P2 owns HostKernel registration and source mapping. No verification or dispatch is implied.

## 2026-10-21 19:08 UTC — live implementation ledger addendum

| Owner | Current full-phase work | Next dependency / remaining proof |
|---|---|---|
| P1 Guard/ExecutionHost | `providers.infer` exact-binding approval resolver and strict nonsecret approval projection source reported landed; continue all P1 origin, ToolBatch, process, cancellation, UNKNOWN and recovery source closure. | P2 HostKernel route mapping; later integrated adversarial and OS acceptance. |
| P2 managed vertical | Own HostKernel challenge registration, HTTP mapping and prepare/begin/consume/settle/UNKNOWN lifecycle; continue reviewer/verifier/current-workspace/follow-up/restart acceptance source. | Consume P1 approval resolver; P7 final-entry settlement adapter; P8 success recovery seam. |
| P7 streaming/artifacts/automation/rewind | Strict persisted Assistant-entry digest adapter keyed to exact step-finish index; continue all render, replay, artifacts, analytics, automation and rewind source. | P1/P2 authenticated Guard/receipt seams. |
| P6 providers/settings/Doctor/S1 | Queued first when a slot opens. | Existing Provider/SecretBroker sender and route admission pins; no provider call until explicit release of implementation-first hold. |
| P3/P4/P5/P8/P9 and P0 | Open/partial; queue by dependency and next available phase slot. | Whole-phase source work, then integrated verification/release gates. |

Three child slots are actually occupied; no unlimited concurrency is assumed. No validation or release operation ran. Mixed Git state is preserved and only repository paths are in scope. Overall V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.

### Shared managed-provider contract decision — 2026-10-21

A provider turn can contain multiple SDK steps under one mutable Assistant message, with effects between steps. Do not disable tool use. Each actual send receives its own monotonic Attempt requestSequence/providerRequestID; Core durably records the indexed `step-finish` and point-in-time Assistant snapshot and settles before ToolBatch or another provider send. `responseDigest` covers the canonical schema-decoded persisted Assistant snapshot plus exact schema-decoded indexed step-finish projection; `usageDigest` remains the separate §12 step usage receipt. OwnerLog identity is per providerRequestID/sequence; completion binds the final response and ordered settled receipts. §37.22/§45.8 are updated. P2 owns Rust durable lifecycle; P7 owns Core persistence projection. Dispatch remains unavailable until full wiring and final acceptance.

**19:15 UTC roster:** P1 returned PARTIAL source handoff and retains integration regressions/acceptance. P6 was immediately resumed as a full-phase owner. Actual active owners are P2, P6, P7. P6 writes provider/auth/catalog/settings/offline Doctor/S1 except P7-owned Session LLM/processor/send settlement callsites and P2-owned HostKernel/managed-control. P3/P4/P5/P8/P9 remain open and queued. Effectful routes without authenticated authority stay disabled. No verification or provider calls.

**ToolBatch ordering correction (19:23 UTC):** the stream adapter buffers provider tool-call and finish events until `admitBatch`, so the ordinary processor step-finish handler cannot settle those provider sends before Guard. P7 owns a narrow callback DTO/callsite seam in `tool-batch.ts` only, carrying validated calls to the processor so it persists the exact pending call + step snapshot and settles before Guard; downstream events reconcile idempotently. P1's Guard admission algorithm remains P1-owned and unchanged. Keep effectful managed calls unavailable if this ordering cannot be safely wired.

**19:28 UTC provider implementation checkpoint:** P7 source now reports strict first-party step-finish schema and v2 `{assistantInfo,stepFinishPart,stepFinishIndex}` digest adapter. ToolBatch buffering requires P7's narrow callback seam so persistence/settlement precedes Guard; duplicate downstream events must reconcile idempotently. P2 is aligning Rust/TS settle and OwnerLog step index while wiring prepare/approval/consume. P6 is fixing anonymous OpenCode free route and waiting on P2's exact one-use transport RPC fields. No tests or network calls ran.

**19:35 UTC P6 handoff:** Auth consume/UNKNOWN adapter source now includes exact route/request and challenge/effect/lease/binding pins and forwards only retained fresh SecretUseContext. P2 is aligning begin-retained authorization. No tests/provider requests.

**Filesystem/network boundary correction (2026-10-21):** Root `AGENTS.md` now limits local filesystem access and task artifacts to `agentx`, while explicitly allowing web search and remote read-only research. External references may be cloned/downloaded only into repository-contained directories, with provenance and licensing respected. Earlier notes in this plan that prohibited all network access are historical and superseded. The user’s implementation-first instruction still defers tests/builds/typechecks/audits/provider calls until source implementation is complete.

## 2026-10-21 architecture freeze checkpoint

Architecture-first pass is complete for the current requested V1 scope. Read all 47 `arch_V1/*.md` files line-by-line across assigned reviews; reconciled cross-owner normative contracts and machine schemas before resuming source implementation. Settled decisions and full static schema evidence are recorded in the latest `CURRENT_RUN.md` and `HANDOFF.md` checkpoint. No HorizonCode product test/build/typecheck/provider call was run; source implementation remains incomplete and V1 is PARTIAL / NOT VERIFIED / NOT RELEASED.

Implementation owners to resume now (entire phases; exclusive source ownership): P1 Guard/ExecutionHost, P2 managed vertical, P5 web search and CodeMode. Queue P6 providers/settings/Doctor/S1 immediately when a slot opens, then P3, P4, P7, P8 and P9 according to the dependency graph. The contracts are design-frozen for this pass: DirectSessionGrantV1 low-friction scoped grants; CodeMode as existing interpreter behind `codemode.execute` using <=32-call Guarded waves / <=64 total; intent-only search request and HostKernel route plan with <=10 routes / <=20 attempts and route-local bounded retries; ContextService compiler V1 and snapcompact deferred. Any discovered source incompatibility should be reported with exact path/interface and the owner continues independent phase work; do not make unilateral contract changes.

## 2026-10-22 07:50 UTC — post-compaction implementation checkpoint

P1/P2/P3 are the currently active full-phase owners. P2 source now accepts an explicit RepoDocumentRead revision domain (`workspace` or `discovery_observation`) and performs no-follow descriptor-relative regular-file reads with before/after revision observation; P3 owns the Core DTO/caller path. P1/P2 aligned CodeMode nested-wave ownership: EffectHost owns private authority and aggregate wave tracking; HostKernel owns live authority mint/revalidation, journal binding and lease orchestration. CodeMode remains unavailable while the exact fixed helper launch/frame path and integrated P1/P2/P5 source are incomplete. P3 found the direct ContextSelection helper is not consumed by the provider payload; P7 owns the exact-payload callsite. Parent's P4 source map confirms protocol/lifecycle adapters exist but LSP/DAP runtime gates are false, DAP lacks a production callsite, and REPL remains unavailable pending OS-enforced quotas and Guarded HostKernel routing. Queue P5, P6, P7, P4, P8, P9 as slots free. No tests/builds/typechecks/provider calls were run; user deferred verification until source implementation closes. Preserve the mixed tree and defer publication/cleanup.

## 2026-10-22 07:52 UTC — P3 source pass and P5 phase refill

P3 completed its currently unblocked source paths: revision-domain-aware RepoDocumentRead DTO/callers, RepoDetect observation reads, workspace-domain LSP/structure reads, and bounded lexical definition candidates with truthful PARTIAL provenance. Tool exposure remains gated; parser-backed navigation, trusted overlays, cache/resource lifecycle, integrated P1/P2 acceptance and the direct ContextSelection provider-payload callsite remain open (the latter belongs to P7). P3's slot has been reassigned to whole-phase P5 search/CodeMode. Current owners are P1, P2 and P5. P5 is limited to its TypeScript/tool/UI surface; P1 owns Rust Guard/EffectHost, P2 owns HostKernel, P6 owns provider/Auth transport, and P7 owns LLM/prompt/tool-batch/processor. No tests/builds/typechecks/provider probes ran; preserve all mixed Git state.

## 2026-10-22 — V1 continuation and cross-phase CodeMode API

Current phase owners are P1 Guard/ExecutionHost, P2 managed/direct lifecycle, and P5 search/CodeMode. P1 reports private durable EffectHost run/wave APIs; P2 is wiring HostKernel integration and P5 is adding strict TypeScript lifecycle codecs and completing search source. Align start/next-frame/bind-wave/submit-wave-result/cancel DTOs across all three owners; every wave uses ordinary Guard admission and receipt/UNKNOWN fencing, and the model-visible registry remains gated until transport is authenticated. Corrected §12.9 from 22 to the canonical maximum of 20 search attempts. No product validation ran under the implementation-first hold. Refill freed slots with P6, then P4/P7/P8/P9 and P3 remaining source/integration work. Overall V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-22 07:58 UTC — CodeMode lane authority and receipt-digest reconciliation

Source integration exposed a direct-root CodeMode authority mismatch: the initial P1 EffectHost struct required `EffectAttemptScopeV1`, but direct root Sessions have explicit session/owner-epoch CodeMode enablement and no Attempt. Architecture/schema are now explicit: `DirectSession` authority uses authenticated session/workspace/grant pins and ordinary SessionBatch Guard; `ManagedAttempt` uses live Attempt/Spec/Profile/OwnerLog pins; `DirectTurnScope` is present only for an actual direct child. Synthetic Attempts are forbidden. The public helper `wave_result.receiptDigest` is HostKernel-derived from ordered durable `(callId, receiptRef, receiptDigest)` rows and Core verifies the rows/digest; P1's private EffectHost digest over batch/call/effect/receipt fields is separate and Rust-derived for settlement. P1 is adjusting its DTO, P2 owns HostKernel transport and independent verifier source gap, P5 owns strict Core codecs/search. No product validation ran under the implementation-first hold.
## 2026-10-22 — permission-mode decision and workspace UI source audit

User selected a low-friction Codex-style `/permissions` experience. DEC-V1-28 now separates sandbox mode from approval policy: default `workspace-write` + `on-request`; `always` prompts before every effect; `never` suppresses prompts inside the selected sandbox; Full access is explicit per direct Session as `danger-full-access` + `never`, with no HorizonCode file/network sandbox. Common Guard, current authenticated scope, budgets, one-use leases, receipts and UNKNOWN recovery remain mandatory; technical unavailability is reported rather than disguised as repeated approval; paid provider/search cost consent and managed Attempt authority remain separate. Parent added the versioned mode schema and reconciled §§03/04/12/14/16/17/32/37/42. P1/P2 are defining the source API seam; P6 TUI/Settings implementation awaits a free phase-owner slot.

Explorer/editor audit: the TUI has a Git diff tree but no general workspace Explorer pane. HostKernel-backed bounded `repo_tree`/`repo_detect` adapters are source-present yet hidden by `REPO_DISCOVERY_TOOL_ACCEPTANCE_READY=false`. The prompt editor exists; external editor process launch is disabled. LSP lifecycle/client source is present and root-session workspace scope is connected, while unsaved-buffer input, parser-backed navigation, guarded code actions/rename, DAP and REPL remain unavailable. Assign remaining P3/P4/P6 work to full-phase owners when slots become available. No product checks ran; implementation-first hold remains active.


**External editor scope decision (2026-10-22):** CLI/TUI may use user-owned, versioned
external-editor profiles for prompt scratch and explicit workspace-file editing, including
terminal and GUI wait-mode launchers. The capability is user-only and uses HostKernel,
Guard and the existing ExecutionHost. P1 owns the process boundary; P2 owns the HostKernel
launch/recovery path; parent owns Core/TUI adapter and final cross-phase review. The
profile schema and normative flows are in §§4.17/12.22/14.27/16.20/32.44/37.28. Current
implementation remains unavailable until integrated acceptance passes. No validation ran.

**Explorer/editor visibility clarification (2026-10-22):** User-directed single-pane
startup with no default Explorer/editor UI or persistent sidebar. `/editor` opens Explorer
as an overlay; `/editor --side` explicitly opts into a right-side pane for the session.
`/settings` → Editors selects the user-owned launch profile; prompt scratch editing is
inside `/editor`. Relevant architecture is DEC-V1-33 and §§16.2/16.3/16.20, 20.14, 32.44,
33.5, 37.28 and 45.28. This is design-only; implementation must stay gated until Guarded
launch and integrated acceptance pass. No tests/builds run.

**Owner refresh (2026-10-22):** P4 is active as a whole-phase owner for LSP/DAP/REPL and
P4-owned TUI command/layout integration, with write scope limited to TUI and the LSP/DAP/REPL
modules and their tests. P2 must leave P8 worker/resource modules untouched. The single-pane,
command-only `/editor` and explicit `/editor --side` behavior is frozen in DEC-V1-33. The
primary product objective is competitive engineering capability (DEC-V1-34); P8 evaluation
must use matched reproducible coding tasks. Testing remains deferred until implementation
is complete.

**Phase handoff (2026-10-22):** P2 source-handoff is PARTIAL after adding authenticated
permission-mode snapshot/CAS and mode digest/revision binding to terminal consent. Its
managed verifier/DAG aggregation, CodeMode helper authority and editor lifecycle remain
open. P8 worker files are reserved to P8. P6 has resumed as a whole-phase owner for
providers/settings/Doctor/S1; active owners are P1/P4/P6. No validation or provider probes
ran. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-22 — continued full V1 source execution

Live owner check: P1 Guard/ExecutionHost, P4 LSP/DAP/REPL plus TUI editor UX,
and P6 providers/settings/Doctor/S1 are the active whole-phase owners; all three
child slots are occupied. P1 reports EffectHost CodeMode operations named
`register_code_mode_execution`, `prepare_code_mode_wave`, `bind_code_mode_wave`,
settlement/rejection, cancel and complete; HostKernel lifecycle remains P2-owned.
P1 also found the editor-specific Guard/process identity was absent and is adding
only a non-runnable Rust foundation. P4 implements the single-pane default,
`/editor` overlay and explicit `/editor --side`; authenticated Explorer selection
stays unavailable until HostKernel projection exists. P6 owns provider/settings
dialogs and modules; P4 owns command registration/layout.

P2 is the next whole-phase owner to resume when capacity frees; its previous
permission-mode work is only a partial handoff. P5 is also open after a partial
handoff. P3 RepoIntel/context, P7 streams/artifacts, P8 workers/evaluation, and
P9 distribution/release source remain in the full V1 target. Continue in critical
path order and refill every child slot as it opens. User's implementation-first
hold remains active: no product tests/builds/typechecks/audits/benchmarks/provider
calls/release checks. Preserve mixed unstaged Git state and repo-only paths. V1
remains PARTIAL / NOT VERIFIED / NOT RELEASED.

**P4/P6 progress (2026-10-22):** P4 source now hides the startup sidebar,
removes the keybound/palette sidebar toggle and prompt scratch shortcut, adds
slash-only `/editor` overlay and explicit `/editor --side`, resets the optional
pane on session change, and removes export-triggered editor launch. It rejects
the legacy `file.list` route; authenticated HostKernel Explorer projection and
Guarded editor launch remain unavailable. LSP's client composition remains
present behind false runtime gates; DAP/REPL remain gated. P6 is adding a
ServerAuth-protected wrapper for SessionSupervisor permission-mode snapshot/CAS,
SDK methods and `/permissions`; `/settings` → Editors remains fail-closed until
P2's authenticated profile/launch path exists. No checks ran.

**P1 external-editor foundation (2026-10-22):** Guard now registers a separate
`EDITOR_LAUNCH_ID` broker action/policy and the existing stdio classifier accepts
a distinct `ExternalEditor` process-ref kind with root Session/profile/argv/mode/
process-tree/fence/one-use pins. This only creates a non-runnable P1 boundary;
profile parsing, PTY handoff, Full Access stdio supervision, HostKernel launch
lifecycle and crash recovery remain open. P2 owns HostKernel/profile orchestration.
The policy fixture was authored but not executed.

**P6 source handoff / P2 refill (2026-10-22):** P6 completed currently
unblocked source work, with no verification: exact anonymous free OpenCode
eligibility, local-only Doctor, provider/settings projections, owner-scoped
QuestionV2/SSE, ServerAuth permission-mode API/SDK/dialog, informational Editors
settings, and RepoIntel settings projection. Credentialed transport and secret
mutation remain blocked on P1 protected write/receipt and P1/P2 acceptance.
Parent added exact ignore exceptions for P6/P4 first-party files. P4 owns settings
route registration. The freed slot is now whole-phase P2 HostKernel/managed
lifecycle (`/root/p2_managed_hostkernel`); active owners are P1/P2/P4. P2 must
coordinate CodeMode and editor caller seams with P1. P5 remains open after its
partial handoff; P3/P7/P8/P9 remain in the V1 target. No checks ran.

**P2/P4 source continuation (2026-10-22):** P2 confirms managed start, plan/TUI
projection, coordinator, verifier challenges and final Inspect settlement are
already source-present, but `TRUSTED_VERIFIER_ADAPTER_AVAILABLE=false` keeps
approval/dispatch/finalize unavailable. P2's current source work connects
HostKernel to P1's private CodeMode lifecycle, resolves ExternalEditor profiles/
launch/recovery, and closes managed verifier artifact/caller seams.

P4 has an explicitly bounded DAP ingress extension: it may create a dedicated
`packages/opencode/src/tool/dap.ts` and edit only DAP import/registration/readiness
in `tool/registry.ts`, using existing canonical capability IDs and DAP adapters.
Every DAP effect remains false-gated until integrated Guard/HostKernel acceptance;
P5 retains the websearch/CodeMode registry areas. P2 owns DAP HostKernel RPCs.

**P1/P4 DAP and editor seam (2026-10-22):** P1 supplied P2 the current
`prepare_external_editor` supervisor API and CodeMode EffectHost operation
signatures. P4 added `tool/dap.ts` and a DAP-only `registry.ts` import/init/entry
using canonical `debug.start`, adapter-profile-only arguments, typed unavailable
output, and both false readiness and Guard-route gates. The adapter remains
unavailable until HostKernel resolves authenticated profile/scope/Attempt and
one-use lease pins; no random UI caller IDs may be fabricated. P5 must preserve
P4's isolated DAP registry hunks. No checks ran.

**P2/P4 provenance binding (2026-10-22):** P4 removed DAP authority fabrication;
`createSupervisedDapClientV1` now requires bounded producer-supplied `userActionID`
and `callID`, separate from random approval challenge correlation. P2 is the
trusted producer through HostKernel. P1/P2 are aligning the immutable
`ExternalEditorLaunchBindingV1` with Session/Attempt, principal/location/epoch/
generation, profile/executable, workspace/revision/file preimage, permission
mode, challenge/effect/lease, and process generation. No DAP/editor effect is
runnable until the RPC and shared supervisor are integrated and accepted.

**P4 handoff / P5 refill (2026-10-22):** P4 source-handoff is PARTIAL: startup
single-pane, slash-only `/editor` overlay, opt-in `/editor --side` and `--close`,
P6 Settings mounts, and DAP `debug.start` tool behind both readiness and Guard
route gates. The DAP caller requires trusted action/call IDs; no effect is
runnable. Explorer projection, external editor launch and LSP/DAP/REPL acceptance
remain P1/P2/P3/OS dependencies. P5 has resumed as a full-phase owner at
`/root/p5_search_codemode`; preserve P4's DAP-only registry lines and coordinate
P1/P2 authority APIs. Active owners P1/P2/P5; P6 unblocked source handoff is
complete; P3/P7/P8/P9 remain required. No checks ran.

**Single process/receipt authority decision (2026-10-22):** P1 owns the canonical
EffectHost/ExecutionHost journal for ExternalEditor prepare/begin/settle/UNKNOWN
and the fixed CodeMode helper selector plus executable/entrypoint/package digest
resolution. P2 consumes this authority through HostKernel-authenticated live
Session/Attempt bindings, RPC and durable projections; it must not create a
parallel receipt/process authority. P5 owns TS caller/codecs against the frozen
DTO, coordinating packaging identity with P1/P9. Effectful routes remain disabled
until integrated verification.

**P5 web-search Settings file ownership (2026-10-22):** P5 owns the dedicated
web-search Settings dialog and its authenticated HTTP config API/handler/group;
P4 owns only the session command/settings chooser mount. P6 has handed off. P5
must complete provider route enablement/order and separate query-sharing/cost
consent controls, keeping disabled routes and no-silent-paid-fallback truth.
Runtime dispatch remains P1/P2-gated.

**P5 settings source correction:** Existing `dialog-websearch-settings.tsx`
implements route order/toggles, anonymous query-sharing consent, separate BYO
auth/cost consent/revocation, local-only status and generic Config get/update.
`/websearch/providers` is authenticated, read-only and does not probe. No new
route is needed absent a concrete contract gap; P4 owns the mount.

**P1/P5 lifecycle refinement (2026-10-22):** P1's ExternalEditor EffectHost
journal exists in part but is missing returned receipt/binding digests and has a
`DecisionKindV1` typo; P1 is repairing those before finalizing P2's HostKernel
caller DTO. P1 continues fixed CodeMode helper resolution afterwards. P5's wave
outcome contract is confirmed: known reject/cancel terminates later-wave
admission and returns exactly one matching failed/cancelled completion; UNKNOWN
never claims completion. Source only.


### 2026-10-22 continuation: CodeMode nested ToolBatch dependency

P5's source audit found `tool/code-mode.ts` currently projects MCP definitions only, but §37.24 requires exact authorized current tool definitions and nested calls through ordinary ToolBatch. P5 owns the current-registry projection and continues all unblocked search work. P7 owns the typed reusable `dispatchNestedToolBatch` adapter in `session/tool-batch.ts`; no direct `Tool.Def` invocation or second dispatcher is allowed. Keep model-visible CodeMode gated until P7 wiring and the integrated P1/P2/P5 transport/receipt path are source-complete and later accepted. Active owners: P1/P2/P5. P3 is first queued for the next free slot, then P7 and remaining phase completion by dependencies and actual capacity. The user's implementation-first hold bars product tests, builds, typechecks, audits, provider calls, benchmarks and release checks. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.


**2026-10-22 — P2 managed DAG source gap:** P2 found run-plan admission was still functionally single-Task: roots were not made ready by `StartPlannedRun`, dependency readiness relied on disabled `mark_task_ready`, and concurrent workers could mutate one shared workspace. P2 is implementing Rust-derived root/dependency readiness and single-writer admission until distinct authenticated workspace leases exist, plus verifier support for prior verified Tasks alongside one current pending/live Task. Parent asked P2 to reconcile exact §11/DEC-V1-31 fan-out scope and use existing worktree leases for any required independent workers; serialized behavior must not be reported as parallel fan-out acceptance. P2 also found the fixed CodeMode helper still needs a normative owner-only package manifest path; P9 owns packaging and P1 is adding helper-digest authority. All gates remain closed. No tests/builds/typechecks/audits/provider calls/benchmarks/release checks. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.


**2026-10-22 — P5 CodeMode source delta:** `tool/code-mode.ts` now removes the old Core-side MCP interpreter/dispatcher and defines an immutable `CodeModeToolContextV1`, strict effective-tool projection, recursive CodeMode exclusion, and a required typed `dispatchWave` callback carrying the exact P2 HostKernel batch projection. Runtime stays unavailable when helper readiness or this context is missing. Parent source review confirmed the catalog must come from the post-filter/post-transform `SessionTools.resolve` active definitions, not raw ToolRegistry/MCP data. P7 owns supplying that exact projection and wiring the callback through ordinary ToolBatch. P5 continues search implementation and TS caller/package integration. No validation or provider/network action ran; all CodeMode/search effect paths remain gated until integrated acceptance.


**2026-10-22 — P1 CodeMode confinement source:** P1 reports CodeMode launch construction now binds only the fixed verified packaged helper (`horizoncode:codemode:bun`), fixed Bun `run <entrypoint>`, a read-only package mount, and no workspace/environment mount. EffectHost now returns the editor binding digest and terminal receipt, while CodeMode terminal reject/cancel/UNKNOWN semantics fence later waves/completion correctly. P1 is adding helper SHA-256 to persisted authority. No checks ran. P2/P9 must supply the trusted owner-only package manifest; no path or entrypoint may come from RPC/Core/model input. Exposure stays unavailable unless cgroup-v2 memory/CPU/PID and RLIMIT_NOFILE controls are each enforced and verified before first instruction, per DEC-V1-29/§37.24.

## 2026-10-22 live implementation checkpoint

| Phase | Owner/state | Current source work and remaining dependency |
|---|---|---|
| P1 Guard/ExecutionHost | Not active; resumption blocked by collaboration thread limit | Finish Guard/origin closure, process confinement and durable receipt/recovery wiring; do not enable unsupported paths. |
| P2 managed vertical/HostKernel | Not active; resumption blocked by collaboration thread limit | Finish authenticated Task/Attempt effects, verifier/current revision, managed lifecycle/recovery and cross-phase RPC. |
| P3 RepoIntel | Active whole-phase owner `/root/p3_repo_intel` | Reconcile RepoDocumentRead revision schema/prose; complete bounded authenticated discovery/context, source revision, cache and provider payload integration. |
| P4 LSP/DAP/REPL and command-only editor UX | Partial handoff | Complete Guarded supervised ingress and acceptance; preserve unavailable status until prerequisites pass. |
| P5 web search/CodeMode | Active whole-phase owner `/root/p5_search_codemode` | Finish cascade and CodeMode source integration against P1/P2/P7; preserve runtime gate pending integrated proof. |
| P6 providers/settings/Doctor/S1 | Partial handoff | Close remaining provider/auth/Doctor/S1 source and settings integration; no paid fallback. |
| P7 streams/artifacts/analytics/automation/rewind | Active whole-phase owner `/root/p7_streams_artifacts` | Complete stream/replay/render, artifact truth, provenance and guarded durable automation/checkpoint source; CodeMode ToolBatch adapter is in progress. |
| P8 resource limits/workers/worktrees/evaluation | Open | Complete safe resource accounting, independent workspace leases/fan-out and evaluation source; unsupported OS guarantees stay unavailable. |
| P9 packaging/release | Open | Complete distribution/install/license/readiness source. Run final verification only after implementation closes. |

Implementation-first hold remains active: no tests, builds, typechecks, audits, benchmarks, provider calls or release gates until source implementation closes. No claims of verification or release are accepted. Mixed Git state remains unstaged and unpublished.

**CodeMode zero-call alignment (2026-10-22):** `§12.18` and `§37.24` explicitly permit pure computation with an empty effective tool list. The worker-message schema now permits `start.tools=[]`; P5 aligned the TypeScript decoder/context. P1 must align the Rust Start validator's stale non-empty restriction, retaining canonical ordering, tool-set digest and byte validation. Runtime remains unavailable pending the full Guarded supervised path.

**Search retry boundary decision (2026-10-22):** User confirmed bounded network retry only when the trusted in-process transport durably proves no request bytes left the process. The exact `NOT_DISPATCHED` receipt has null HTTP status/retry delay/result count/body digest, zero body bytes and `responseComplete=false`; retry that route at most once. HTTP 408/425/5xx may retry once after their exact durable response receipt. Every possible-send ambiguity remains UNKNOWN and is never retried. Updated DEC-V1-26, §§12/37 and JSON contracts. Owners: P1 receipt/journal, P2 HostKernel continuation, P5 TypeScript cascade, P6 ProviderTransport. Paths remain unavailable until integrated acceptance.


**2026-10-22 — P7 whole-phase source checkpoint (PARTIAL; no checks):** Unblocked source is complete for bounded/redacted activity rendering and replay/resnapshot fences; artifact fidelity/render/resource limits; bounded provenance-aware analytics; ephemeral managed `session.context_ledger` emission and TUI context-bar rendering with request/source-generation fencing, a 48 KiB cap, no raw params and best-effort publication; authenticated read-only artifact/checkpoint preview adapters; and explicit managed lane in `compileManagedContextSelection`. P7 returns its slot for P2. Remaining integration depends on P2 authenticated CodeMode nested-wave source/settlement and direct ContextSelection/profile pins, P1/P2 guarded automation and checkpoint capture/restore/partial-recovery, and trusted direct artifact-search provenance. CodeMode remains unavailable. No validation evidence was generated; P7 is PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-22 source implementation checkpoint

The requested target remains all V1 phases P1–P9 plus parent-owned integrated acceptance. Active whole-phase owners are P1, P2 and P6. P5 has returned PARTIAL after all currently unblocked search/CodeMode work; P7's shared nested ToolBatch adapter and remaining phase work will be assigned as a child slot opens. P2 has routed both HostKernel MCP sends through the whole-handshake pre-send proof and is finishing keyless/resume terminal settlement. Route-plan digest authority is the canonical MessagePack digest of the exact approved ordered routes array (including attempt counts); EffectHost persists the HostKernel value and validates it against the request binding. §37.5 now recovers exact FAILED/CANCELLED/EXHAUSTED status. Implementation-first hold remains: no tests/builds/typechecks/audits/provider probes/benchmarks/release gates until source implementation closes. Git remains mixed and unchanged by staging/commit/push.

**P6 provider ownership clarification (2026-10-22):** Direct provider requests are not yet wired: `provider.getLanguage` still uses generic SDK `resolveSDK`/`timeoutFetch`, with no Core SessionStore request journal or selected-route ProviderTransport call. P6 now owns the direct Core request journal/API and ProviderTransport/Auth integration; P7 owns the frozen ContextSelection/provider payload producer; P2 owns managed HostKernel/Attempt provider authority and does not edit direct SessionStore/runner files. Keep all sends gated until the exact PINNED→DISPATCHING→SETTLED/UNKNOWN lifecycle and protected credential path are integrated. No tests/builds/provider probes under the implementation-first hold.

**P2/P1 read-only Git implementation item (2026-10-22):** General Git status/diff/log/history/tree calls still fail closed because Core's AppProcess port refuses spawn. P8's existing HostKernel Git status is narrower and only supports final child-root Inspect. P1 supplies the shared ExecutionHost/Guarded operation requirements; P2 owns the authenticated HostKernel read-only route and Core caller seam. Keep generic process origins closed and preserve a low-friction bounded-read UX; no per-read prompts. Runtime remains unavailable pending source integration and later acceptance.


## 2026-10-22 — live whole-phase implementation owners

Live owners: P1 Guard/ExecutionHost, P2 managed lifecycle/HostKernel/DAG, and P7 streaming/context/artifacts/analytics/automation/rewind. The platform currently permits four concurrent agents including the parent, so P6 provider journal/transport integration is next and slots must be refilled as owners finish. P1 has added managed CodeMode authority recovery tied to live Attempt scope, plus `list_direct_session_terminal_artifact_receipts(...)` and `active_code_mode_outer_effect(...)` for P2. P2 owns authenticated HostKernel/Core CodeMode start/resume/prepare-wave/settle/cancel/inspect and the root-session artifact projection. P7 owns frozen ContextSelection/provider-input production and ordinary ToolBatch nested-wave adapter; P6 owns the direct durable provider journal and selected-route ProviderTransport/Auth integration.

Root DirectSession artifact search is gated until authenticated Session→committed batch→settled effect receipt→ArtifactStore identity derivation is implemented. CodeMode, provider dispatch, guarded automation invocation and checkpoint restore remain unavailable where lifecycle/receipt dependencies are incomplete. User asked to defer tests until implementation closes; no tests/builds/typechecks/audits/provider calls/benchmarks/release checks are being run. V1 is PARTIAL / NOT VERIFIED / NOT RELEASED.


**Owner refill correction (2026-10-22):** P1 handed off its current source pass PARTIAL and retains integration/acceptance ownership. The freed slot is now assigned to the whole P6 phase. Current active owners: P2 managed lifecycle/HostKernel/DAG, P6 providers/settings/Doctor/S1, P7 streaming/context/artifacts/analytics/automation/rewind. P6's direct provider journal/transport is independent of P2's managed request lifecycle; P7 supplies frozen ContextSelection/profile/sourceRevision to P6 without duplicating provider normalization. P3/P4/P5/P8/P9 remain open. No tests/builds/typechecks/audits/provider probes under user instruction.


**P2/P7 interface delta (2026-10-22):** P2 has added the strict private `CodeModeCall` envelope in Rust protocol/Core supervisor and `SessionSupervisor.codeModeHostRequest(...)`, binding session/location/callID/lane/optional managed scope outside the frozen public request body. HostKernel now routes authenticated inspect and rehydrates exact current-epoch direct/managed authority through P1's recovery APIs; start/resume/cancel/enablement remain unavailable pending durable enablement, frame/tool-set validation and supervisor dispatch. P2 is wiring launch next. P7 will send P6 only the frozen directContext (request ID, source revision, profile ref/digest, ContextSelection); P6 captures and hashes the exact prepared selected-route payload once at RequestExecutor, with no credential/header bytes in the handoff or digest. No tests run.

### 2026-10-22 live integration assignments

- **P2**: implement the immutable authenticated root DirectSession ToolBatch admission index in the current HostKernel location-authority store; exact ordered call/effect mapping; PREPARING/ADMITTED/DENIED with restart ambiguity UNKNOWN; join only to P1 terminal EffectHost receipts and existing ArtifactStore metadata. No second receipt/artifact authority.
- **P6**: expose a Core-neutral selected route projection through the existing SessionRunnerModel/catalog resolution boundary, derived from selected trusted provider/model configuration and normalized fixed endpoint. Protected transport compares actual route identity and endpoint revision before dispatch.
- **P7**: consume the P6 DTO; do not use `model.route.id` or caller/model fields as route authority. Keep the request unavailable on missing/mismatched projection.
- Architecture now distinguishes HostKernel-authenticated direct permission-mode `permissionScopeDigest` from Core privacy/budget `policyDigest`; neither is a managed Attempt scope nor per-effect grant. Source implementation only; no tests/builds/typechecks/provider calls/audits until implementation closes.

**2026-10-22 current owner correction:** Active owners are P1 Guard/ExecutionHost, P2 managed lifecycle/HostKernel/DAG, and P7 streaming/context/artifacts/analytics/automation/rewind; root plus these three fills actual agent concurrency. P2 owns the managed DAG reducer after P8's partial source handoff and is resolving the stale capacity-one `max_workers.min(1)` gate subject to independent authenticated workspace leases. P1 owns root permission preflight and fixed-argv command-profile execution; P7 owns renderer redaction and remaining P7 source. User's Codex/OpenCode comparison request confirms verified durable cgroup cleanup, with 256 retained only as bounded UNKNOWN/unproven quarantine rather than a lifetime execution cap. Tests/builds/typechecks/audits/provider calls/benchmarks/release gates remain deferred until implementation closes. Git remains mixed/unstaged. V1 is PARTIAL / NOT VERIFIED / NOT RELEASED.

**2026-10-22 P2/P7 delta:** P2 removed the hard `max_workers.min(1)` reducer ceiling and added accepted `maxWorkers` accounting, active Attempt→Run/Task validation, unique Location enforcement and verified-dependency readiness. P7 identified that CodeMode nested results were hashed/forwarded before redaction; it is correcting the result digest and helper payload to share the exact bounded redacted projection. Source only, no acceptance checks.

**P2 HostKernel gap confirmation (2026-10-22):** Source review confirms CodeMode currently implements only `codemode_inspect`; start/resume/cancel/enablement and settlement/wave receipt handlers remain incomplete. DirectSession artifact list exists, but authenticated inspect/range dispatch is missing. P2 owns these HostKernel/Core seams. For P8 worker settlement, reuse the existing final-Inspect → `WorkerSettlementProofV1` → `settle_managed_worker` → disposition path and the existing owner-epoch disposition-recovery proof. No checks ran.

**P2 multi-Task settlement source correction (2026-10-22):** Recovery now emits one deterministic eligible Task terminal snapshot per call, carrying exact verifier ChallengeSet pins, and continues until `NO_SETTLEMENT_PENDING`. This permits P8 disposition settlement one Task at a time for a bounded DAG with multiple successful Tasks. Existing P8 success/quarantine and fresh-current-epoch reconcile APIs remain canonical. No checks ran.

**P2 mixed CodeMode wave contract seam (2026-10-22):** HostKernel routes `codemode_settle_tool_results` and `codemode_wave_receipts`, but source lacks their implementations; EffectHost call identities also need explicit parent-authorized `effect`/`host_callback` kind and exact receipt resolution. §37.24 is authoritative: no synthetic callback lease; normal Guard leases/receipts for effects; retain raw output in Core and return only the bounded redacted projection digest/byte count to helper. P1 supplies typed EffectHost APIs; P2 implements the handlers and continues independent DAG/artifact work. Runtime remains unavailable; no checks.

**P2/P7 recovery and artifact source delta (2026-10-22):** Managed settlement recovery now skips Attempts with durable P8 disposition, advances one deterministic pending Task and returns `NO_SETTLEMENT_PENDING` when all succeeded Tasks are released; old-epoch/unresolved cases remain uncertain. P7 added the authenticated typed root DirectSession artifact inspect/range producer and correlated CodeMode cancellation selectors `{callID,requestID,waveIndex,reason}` with aggregate digest validation. Matching P2 HostKernel cancellation handler is outstanding; routes remain closed. No checks.

**P2/P7 CodeMode name binding gap (2026-10-22):** Core's internal `prepareCodeModeToolBatch.calls` projection omits the exact resolved `toolName`, preventing HostKernel from comparing helper frame, normalized executor and authorized catalog identity. P7 supplies the canonical name from `SessionTools.resolve`; P2 performs exact comparison. No model-supplied override. Remains gated; no checks.

**P7/P2 CodeMode name projection update (2026-10-22):** P7's CodeMode-only internal ToolBatch DTO now includes the exact `toolName` from the trusted resolved executor; the ordinary ToolBatch API is unchanged. P2 is aligning strict Rust parsing and frame/catalog/executor equality. No checks.

**P1 Full Access capacity issue (2026-10-22):** Retain-only cleanup of every successful Full Access cgroup would eventually consume the 256 quarantine bound and disable later launches. P1 is evaluating a supervised no-persistent-cgroup path or safe cleanup after exact process-tree quiescence. Keep Full Access unsandboxed and avoid claiming containment; only UNKNOWN/unproven groups should consume the bounded quarantine. Source decision pending; no checks.

**P1 Full Access cgroup decision (2026-10-22):** A Full Access child can access the delegated cgroup hierarchy and migrate descendants; empty membership alone cannot prove quiescence, so do not remove visible Full Access cgroups. To avoid a lifetime 256-success cap, P1 is implementing Full Access with the existing supervisor/effect journal but without retained cgroup allocation. If restart cannot prove exact process quiescence, preserve UNKNOWN/no-replay and make no containment/escaped-child recovery claim. P1 is reconciling DEC/LLD/provenance. No checks.

### 2026-10-22 integration delta

P1 has accepted Full Access launch without persistent cgroups, preserving the existing live process-group supervisor and durable effect journal. When restart cannot prove exact process-tree quiescence, effect recovery is UNKNOWN/no-replay. Confined workspace profiles continue to use cgroup-v2 and verified cleanup. Codex/OpenCode scoped process-group patterns are useful lifecycle comparisons but do not provide durable cgroup recovery proof.

P1's typed EffectHost CodeMode APIs are now source-present. P2 owns HostKernel prepare/settle/receipt/cancel and exact frame/catalog/executor checks. A private prepare-body mismatch with ordinary effect-only ToolBatch admission remains under P1/P2 reconciliation; callbacks must be typed no-lease rows, effects must use ordinary Guard leases and receipts. No tests/builds/typechecks/audits ran under the implementation-first hold.
