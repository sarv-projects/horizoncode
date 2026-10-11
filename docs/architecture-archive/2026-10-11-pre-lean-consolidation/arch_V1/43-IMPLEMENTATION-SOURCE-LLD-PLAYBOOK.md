# 43 — Converged source-to-HLD/LLD implementation playbook

**Implementation target, NOT code shipped.** Read normative §17 first, then [exact pinned external source paths §42](42-EXTERNAL-SOURCE-PROVENANCE-REGISTER.md), [OMP core §38](38-OMP-SOURCE-COMPETITIVE-AUDIT.md), [OMP UI §39](39-OMP-TUI-SLASH-MODEL-SETTINGS-AUDIT.md), [Horizon UI proposal §40](40-HORIZONCODE-OMP-INSPIRED-UI-PROPOSAL.md), [visual streaming §41](41-OMP-STREAMING-VISUAL-ARTIFACTS-AUDIT.md). Source use still needs license and transitive dependency review. Current modified local code outranks older implementation guesses.

## 43.1 Exactly one authority per aggregate

| Aggregate | Canonical owner | Non-owners / invariants |
|---|---|---|
| Conversational Session/Input/Message/Part/tool result/provider continuation | Existing OpenCode Core V2 Session | Rust cannot create another Thread transcript; UI is only a projection |
| Managed Goal/SpecVersion/Run/Task/Attempt/evidence | Rust managed control OwnerLog | direct sessions never require a managed Goal |
| ToolBatch authorization/EffectIntent/lease/receipt | Rust Guard / authorized ExecutionHost (P1.3 not complete) | Bun, LSP, browser, plugin, UI cannot dispatch effects elsewhere |
| Provider/model/harness config/auth | Existing OpenCode provider and Horizon config owner | no OMP secondary OAuth/registry; no surprise paid route |
| Terminal/desktop visual UI and streaming display | Derived read-only UI projection | graphic placement ACK is NOT effect ACK |
| Durable original artifact bytes and permissions | Authorized typed artifact store | transient figure raster/Kitty image ID is NOT file identity |

## 43.2 Source placement verification requirements

Existing roots: packages/core/src/session, packages/core/src/tool, packages/core/src/horizon, packages/opencode/src, packages/llm/src, packages/schema/src, kernel/src, indexd/src, packages/tui/src, packages/app/src. Check paths in actual checkout before changing; do not invent OMP crates or parallel Tauri apps. Existing OpenCode providers, streaming and tool registry must be reused. New src filename and function names in §§37/40/43 are PROPOSED until source and tests establish them. New TS/Rust bindings must derive from a reviewed single contract; schemas alone are not runtime code.

## 43.3 Gate B0: preserve live implementation

1. Inspect git status, modified/open files, active tools and worktrees. Never reset, clean, prune, overwrite, commit, push, install paid APIs or delete user content without permission.
2. Run existing design + source contract baseline and log test framework, exact commands, git head and output. A passing narrow projection or RPC test is not a universal EffectBroker acceptance.
3. Confirm OpenCode Core v2 single provider runner and tool-call result owner; pin each handler and test with source line/file before modifying.
4. Continue P1.2-B observer/supervisor before any new effectful OMP components, then P1.3 full broker.

## 43.4 Gate B1: P1.2-B SessionLink projection/supervisor

- Source: existing packages/core/src/session, packages/core/src/horizon, kernel/src/messagepack.rs, kernel/src/subscription.rs, kernel/src/session_projection.rs, kernel/tests.
- Identity: original OpenCode Session ID, source event cursor, projection epoch, content digest and redaction scope. Rust projection MUST be rebuildable and cannot mutate canonical messages or act as a provider loop.
- Process: authenticate local peer; version/epoch handshake; snapshot latest page; replay ordered deltas; exact-ACK; bounded in-flight; reconnect/dispose on owner shutdown; resnapshot on cursor gap. Preserve direct-turn semantics.
- Test: malformed credentials/payloads, stale peer/process epoch, stopped observer, replay and cursor gap, crash/restart, secret redaction, no duplicate accepted event. Existing Bun/Rust tests plus live supervisor test required.

## 43.5 Gate B2: P1.3 universal ToolBatch effect broker

Inspect every tool entrypoint: core provider tools, legacy opencode shell/edit/Git, user scripts, MCP/plugins/skills/hooks, browser/desktop, LSP code actions, DAP Eval, outside agents, and hosted provider tool calls.

Logical control (must be adapted to real code, not blindly pasted):

~~~ts
async function handleProviderToolBatch(turn, completeProviderResponse) {
  const batch = collectFinalWholeResponse(completeProviderResponse);
  const frozen = pinTurnConfiguration(turn); // selected model/harness/tool registry/settings
  const proposed = parseAndValidateAll(batch.calls, frozen);
  const decision = await rustKernel.preflightBatch(proposed, frozen);
  if (decision.status !== "ADMITTED") return rejectBatch(decision);
  const result = await rustKernel.executeWithOneUseLeases(decision.leases);
  return persistConversationalResultsInOpenCode(result);
}
~~~

PREPARE durable immutable effect intents with arguments digest, workspace revision, authorized scope and one-use lease; execute only through kernel ExecutionHost; record receipt; classify failure vs UNKNOWN vs partial. Never blindly retry non-idempotent UNKNOWN. Provider-executed effects that cannot be preflighted must be disabled or explicitly unsupported. Read-only fast path still validates scopes. Test all three permission modes and all external adapters with deliberate bypass attempts. No control-path duplication.

## 43.6 Gate B3: managed Goal/Run owner after P1.3

Implement additive Rust records GoalDraft, SpecVersion, Run, Task, Attempt, EffectReceipt, Evidence, Verification. OpenCode SessionLink provides reference IDs only. Logical methods:
- prepareGoalDraft(draft,expectedRevision) checks objective, criteria, workspace constraints, spending/time budgets; makes NO tool effect.
- acceptSpecVersion(goalId,digest,approval) freezes the user-approved goal and revision.
- startRun(goalId,specVersion,sessionRef) schedules only accepted scoped work; no fake background worker after host shutdown.
- pause/resume/cancel fences new tasks; in-flight effects reconcile separately, with UNKNOWN if unsettled.
- verifyRun(finalRepoRevision,evidence,acceptanceCriteria) uses independent tests/proof; produces PASS/FAIL/NeedsYou and stop reason.

The old P2 Rust-canonical Thread cutover plan is historical and NOT executable as written. Use the dedicated 2026-10-11 converged P2 plan and adopted §17 OpenCode canonical Session. Tests: restart, session vs goal lifetime, permissions, SpecVersion conflict, idempotent replay, final revision proof, no goals on ordinary turns.

## 43.7 Gate C1: edit/index/LSP/DAP adaptations

| Candidate | Algorithm and state machine | Forbidden shortcut | End-to-end proof |
|---|---|---|---|
| OMP Hashline edit | observed line anchors, stale target rejection, safe rebase attempt, full content SHA/workspace revision and no-op detection | 16-bit edit tag as correctness/security authority | stale/conflicting edits never overwrite new content; Guard permission per write |
| Rust walker/grep/AST/diff | bounded ignore-aware traversal, symbol graph, search and digest-based invalidation | new unmeasured index daemon or symlink escape | benchmark OpenCode/indexd parity, language coverage and 100K file repo |
| Shared LSP broker | workspace/language/config process identity, read-only diagnostics, versioned code action and mutation | LSP write outside broker | cross-session reuse, server crash, renamed file/guard deny |
| DAP debugger | adapter lifecycle, scopes, stop/breakpoint/step, variables/evaluate with OS boundaries | unrestricted debugger Eval/attach | debugger crash, process death, eval denied, receipt |

All exact OMP upstream source URLs are in §42 SRC-003, 004, 008; local source targets in §20/24. Preserve OpenCode LSP where present.

## 43.8 Gate C2: Browser/desktop/web-search contracts

BrowserBackendV1/desktop: identify managed vs attached browser, tab/window ownership, screenshot+AX/DOM observation generation, permission, stale result invalidation, worker restart, retries and crash cleanup. Mutating action uses one-use authorized receipt. Network request interception alone is NOT a sandbox. Desktop input, clipboard and background window control are privileged; OS support must be tested individually.

WebSearchProviderProfileV1: normalized query, provider capabilities, explicit credential provenance, stable URL/citation/time, rate limit and timeout, privacy scope, paid/free/trial/unknown classification, fallback policy and last verified state. Separate direct search provider from model-grounded search (OMP has 20 direct, 6 grounded at pin). Never switch to a metered endpoint without prior user policy approval. Preserve optional provider-specific interfaces rather than locking to OMP.

Exact files: §42 SRC-005 to SRC-008. Test offline, stale reference, malformed DOM, OS permissions, domain isolation, paid denial, provider failure and citation provenance.

## 43.9 Gate C3: OMP-inspired commands/models/settings/goal UI

All slash/menu/shortcut/API dispatch resolves ONE canonical ActionDescriptor, including iconKey, typed args, alias conflict check, owner, Guard effect class, dynamic status and help. Unicode/Nerd/ASCII icon resolver with grapheme widths, disabled status and keyboard shortcuts.

Main prompt bar keeps AGENT/HARNESS picker AND a dependent MODEL picker. Compact picker applies to current Session only; fullscreen catalog shows provider/model kind, auth source, context, cost/unknown, live/cached observations and 15 possible workload role bindings. Role/fallback global/project scope requires explicit apply. No silent harness switch, provider billing or account OAuth reauthorization. OAuth/device/API key/env/keyless local connection uses existing secret owner and never exposes raw token.

Settings: typed hierarchy from the current ConfigDescriptor; requested/effective/shadowed/locked values, conditional fields, per-scope apply, text/numeric/enum/array/record validation, undo/reset, theme live preview and keyboard search. OMP's 85 slash commands/409 static setting registrations are REFERENCE COUNTS, not mandatory clone parity. Goal dialog must preserve draft and external editor; submit prepares/revises Goal; user approval is needed before Rust starts effects. UI action semantics same across TUI and desktop.

Source: §42 SRC-009 and §39/§40; tests: aliases, role scope, credential secrecy, no unwanted charge, model-dependent picker, login failure, draft retention, modal resize, disabled state, non-regression of current OpenCode UX.

## 43.10 Gate C4: streaming visuals, charts, terminal graphics and durable artifacts

Model provider produces text/thinking/tool deltas; existing OpenCode owns source Part and continuation. UI figure recognizer segments ordinary Markdown into prose, top-level SVG fence, closed Mermaid, and COMPLETE numeric GFM table. Partial SVG is trimmed to a valid parseable prefix with auto-closing tags; run bounded off-thread isolated Rust resvg with NO host filesystem/network/script loading. Throttle streaming previews (200ms is a starting baseline, benchmark required), keep the previous successful raster, render final promptly, ignore stale source/width/theme epochs. If render fails, show source.

Mermaid: safe ASCII/Unicode Rust parser after closing fence only; unsupported syntax/source not blank. Tables: typed numerical analysis -> deterministic ChartSpec -> theme SVG underneath original table; optional separately consented paid judge in Smart mode; no chart until table closes, no invented/converted units. SVG may render PNG via Kitty/SIXEL terminal graphics; Tern native vector/renderer is OPTIONAL, not a universal terminal protocol. Image budget: placement leases, old image eviction/purge, per-surface memory, transmit once/place many and height-preserving fallback.

Rendering and artifact persistence are different. Canonical source artifact identity includes owner+SHA256+MIME+revision and security; derived figure/raster may be ephemeral. The artifact store returns success only after atomic staged persistence, with FULL vs HEAD_TAIL_SAMPLE vs FAILED fidelity; bounded read API and source evidence preserved. OMP's default 50KiB inline, 16MiB artifact cap, 8MiB full read cap are reference behavior, not automatic Horizon constants. Effectful export/upload goes through Guard.

Stream reliability: stable rendered prefix, replaceable mutable suffix/viewport, ACK-once append-only history; do not steal focus/scroll. UI display lane may coalesce bounded presentation deltas, but MUST not drop durable events/receipts. OMP's upstream event queue is unbounded; don't copy that. Public terminal screen streaming (OMP omp stream) is a separate optional, opt-in, best-effort-redacted capability and deferred. Include accessibility text fallback and no terminal graphics support baseline.

Source: §42 SRC-010 through SRC-016; compare §§31,37,41. Tests: malicious SVG, 1000 tiny chunks, raster cancellation and stale image race, source fallback, complete/incomplete chart tables, judge consent, Mermaid error, image budget/multiplexer/WinTerm, upload denial, crash during atomic artifact write, exact ACK and no scroll jump.

## 43.11 Contract/test/release truth and dependency gates

- Define a single typed contract version per feature, then verify generated TS and Rust types against the SAME positive/negative fixture. Schemas parsing alone is not cross-language conformance.
- Test cases must use real existing Core+kernel calls, no simulated acceptance for absent adapters. Use §32 and §26 UAT; instrument stage latencies, CPU/memory, quotas, retries, file counts, and per-platform results.
- Complete checklist for each module: source pin + licensing; existing file maps; tests RED; adapter GREEN; negative security; restart/replay; offline/local; UI keyboards/focus; artifact reliability; P95 benchmarks; source and Run provenance; handoff updated.
- A newly designed feature is NOT CODE_PRESENT. A unit test is NOT E2E VERIFIED. Mark NOT_IMPLEMENTED, BLOCKED, WIRED, VERIFIED separately per source evidence.
- No secret tokens in logs/docs, no paid endpoint without permission, no unbounded worktree creation, no second session owner, no premature post-V1 P10 identity migration or autonomous self-improvement.

**Offline source provenance test:** python3 scripts/architecture/validate_external_sources.py (also included in scripts/architecture/run_contract_tests.py). It verifies source pins/URLs/owner fields and handoff links; it does not fetch or compile competitor code.
