# A1 typecheck convergence — packages/core + packages/tui

Owner: A1 typecheck-convergence subagent. Date: 2026-10-24 (resumed after server restart).
Gate: `bun run horizoncode:typecheck` (`packages/opencode` && `packages/tui` && `packages/core`).

## Counts (initial resumed run; superseded by fresh verification below)

| Package | Start | Now | Residual |
|---|---|---|---|
| `packages/core` | 6 | **4** | P1 ×1, P7 ×2, P6 ×1 — 0 in A1-core scope |
| `packages/tui` | 1 | **1** | P1 ×1 (same `core/src/tool/bash.ts` row) |

Correction to the handoff note: `reports/typecheck-tui-a1.txt` is **not** empty. It contains
`../core/src/tool/bash.ts(68,36)` — TUI is at 1, not 0. Verified twice from current source
(06:32 and 07:0x runs).

Evidence logs: `reports/typecheck-core-a1.txt` (4), `reports/typecheck-tui-a1.txt` (1)
— both `tsgo --noEmit`, package-local `TMPDIR`, serialized against any `packages/opencode` tsgo.

## In-scope work (complete; 2 errors fixed, still intact and clean)

All in `packages/core/test/terminal-run-live.test.ts`:

1. **Stale kernel contract field (1)** — line 313 passed a bare `directAttempt` to
   `SessionSupervisor.prepareToolBatch`. No Attempt lane exists on `prepare_tool_batch`: the typed
   interface (HEAD *and* working tree) carries only
   `directTurnScope | managedAttempt | workspaceCommandProfiles`, and `kernel/src/host_kernel.rs::
   prepare_tool_batch`'s `strict_fields` allowlist matches. A direct Attempt scope enters a prepared
   batch only via the atomic `bind_direct_attempt_effects` transition
   (`EffectAdmission.attemptScopeTransition = "batch_bind"`). Dropped the stale field; the scope is
   still round-tripped through `directAttemptScopeToWire` at bind and in `executeWrite`; test
   retitled to describe the real path.
2. **Wire-type shape misuse (1)** — line 625 read `.length` off `artifactRef`, which is
   `ArtifactRefWireV1` (object), not a string. Now `artifactRef.artifactId.length > 0` **plus**
   `artifactRef.digest` pinned to `/^blake3:[0-9a-f]{64}$/` (stronger than before).

No `any`, `as unknown as`, `@ts-expect-error`; no test deleted or weakened.

## Residual — 5 rows, all outside this packet's write scope

### P1 — `packages/core/src/tool/bash.ts:68` (blocks BOTH packages)
`execute` returns `Effect<..., ToolFailure, TrustedPrincipalContext>` but `Tool.make`'s
`Config.execute` is deliberately service-free (`Effect<Output, ToolFailure>`, no `R`).
`Pty.runTool` — its only caller in `src/` — requires `TrustedPrincipalContext`.
The fix belongs in `bash.ts`, **not** `tool/tool.ts` (widening `Config.execute` would ripple through
every tool and break the invariant that tools get everything from `Context`;
`tool/registry.ts:108` already projects `trustedPrincipal` into it).

Verified patch (compiles to `R = never`; see "Probe" below):

```ts
const principal = context.trustedPrincipal
if (!principal)
  return yield* Effect.fail(new ToolFailure({ message: "Terminal execution requires an authenticated trusted principal" }))
const ptyResult = yield* pty.runTool({ /* unchanged */ }).pipe(
  Effect.provideService(TrustedPrincipalContext, { principal }),
  Effect.mapError(() => new ToolFailure({ message: "Guarded terminal execution failed" })),
)
```

`GUARDED_TERMINAL_RUN_READY` in `registry.ts` keeps the path unreachable until P1 acceptance, so
today this is type-only.

### P7 — `packages/opencode/src/agent/agent.ts:512` (`list`, declaration line 71)
Impl yields core `AgentProfileConflictError | AgentProfileNotFoundError |
AgentProfileSelectorConflictError` from `profiles.agentProfileSelectors()`, but `Interface.list`
declares `Effect<Info[], SessionSupervisorError>`. Preferred fix (consistent with
`primaryProfileDefinition` at 538–548): map them —
`Effect.mapError((error) => new SessionSupervisorError({ stage: "agent-profile", reason: error.message }))`.
Alternative: widen the declared channel and import the three classes from `@opencode-ai/core/config`.

### P7 — `packages/opencode/src/agent/agent.ts:552` (`generate`, declaration line 76)
`provider.getLanguage()` (`provider.ts:1419-1421`, edited by P6) now returns
`ModelNotFoundError | CredentialTransportUnavailableError`. `ModelNotFoundError` is already inside
`Provider.DefaultModelError`, so `CredentialTransportUnavailableError` is the sole new member against
the declared `Provider.DefaultModelError | SessionSupervisorError`. Fix: add
`Provider.CredentialTransportUnavailableError` to the declared channel (honest — it is not a
"model not found"), or map it into `DefaultModelError` if the public surface must stay narrow.

### P6 — `packages/opencode/src/effect/instance-state.ts:35`
Effect v4 beta.83 drift: `requireServicesAt: "lookup"` no longer exists on `ScopedCache.make`
(the property type is `undefined`; zero hits in `node_modules/effect` d.ts and it is the only call
site in the repo, so the beta default already resolves services at lookup). Fix: delete the option
line (and the sentence in the comment that names it).

The three `packages/opencode` rows enter core's program only because
`packages/core/test/session-runner-recorded.test.ts` relatively imports
`../../opencode/src/{effect/instance-ref,background/job,session/run-state,session/status}`.
That test deliberately assembles the real Core graph, so this coupling is legitimate: **core's gate
cannot be green while those owner files fail**, and no core-side edit should paper over it.

## Probe — the P1 patch was compiler-verified, not guessed

`reports/probe-bash-fix/probe.ts` mirrors `Pty.runTool`'s exact requirement
(`Effect<Output, Error, TrustedPrincipalContext>`), applies the fail-closed + `provideService`
composition, and asserts the result is assignable to `Effect<Output, Error, never>`.
Run from a package-local scratch dir so `effect` resolves to the workspace install:

```
PROBE_EXIT=0     # zero diagnostics: the composition really is service-free
```

Scratch dir removed afterwards; the final core run is still 4, so nothing leaked into the program.

## Additional finding (runtime, not typecheck)

Test "Core forwards stale direct Attempt revision and HostKernel denies before Guard admission"
(line 396) also passes `directAttempt` to a raw `requestHostKernel("effects.v2",
"prepare_tool_batch", ...)`. `requestHostKernel` is untyped, so it produces no typecheck row, but
kernel `strict_fields` rejects the unknown key with `invalid` — so
`expect(String(failure)).toContain("Attempt revision changed")` will fail once P2 produces
`kernel/target/debug/hz-kernel`. The security outcome (deny, no write) still holds via
`strict_fields`. Re-base the negative onto `bind_direct_attempt_effects`, or extend the kernel +
typed supervisor contract — owner P1/P2. Untouched: rewriting a security negative's premise cannot
be verified without a runnable kernel and Cargo is out of bounds here.

## Verification run

- `packages/core` `tsgo --noEmit`: **4** (stable across three runs today).
- `packages/tui` `tsgo --noEmit`: **1** (P1 row only).
- `bun test test/terminal-run-live.test.ts -t "binds to a Core-prepared batch"`: file loads, test is
  discovered under its new title, fails only at
  `expect(existsSync(kernel/target/debug/hz-kernel)).toBe(true)`. Both edited cases are therefore
  typecheck-green but **runtime-unverified** — reported as unverified, not passing.
- No worktrees, no agent-owned processes left running, `packages/{core,tui}/.tmp` are gitignored.

## A1 status for Core + TUI (initial resumed run; superseded below)

**NOT green — 5 rows, none in this packet's scope.**
- P1 fixes `core/src/tool/bash.ts:68` → **TUI = 0**, core = 3.
- P7 clears `agent.ts:512` + `agent.ts:552` and P6 clears `instance-state.ts:35` → **core = 0**.
- A1 then passes for Core + TUI, subject to `packages/opencode` itself reaching zero — outside this
  packet.

## Fresh closure verification (2026-10-24, after P1/P7 updates)

Re-read the latest P1/P7 phase reports and A1 logs before checking. The old typecheck logs were
header-only, so they were not used as evidence. No `tsgo`/`tsc` process was running at start; checks
were run serially, Core first and TUI second, using the workspace binary directly (package `tsgo`
script resolution is not present in a bare shell).

| Package | Exact command | Result |
|---|---|---|
| `packages/core` | `TMPDIR="$PWD/.tmp-a1" ../../node_modules/.bin/tsgo --noEmit` | **exit 0; 0 diagnostics** |
| `packages/tui` | `TMPDIR="$PWD/.tmp-a1" ../../node_modules/.bin/tsgo --noEmit` | **exit 0; 0 diagnostics** |

Full output, including command and exit status, is in `reports/typecheck-core-a1.txt` and
`reports/typecheck-tui-a1.txt`. Both full-package checks include their config and test TypeScript
sources; there are no remaining Core/TUI diagnostics to route to P1, P7 or another owner. No
suppression or cast was introduced by this verification.

### Runtime-only test limitation

Ran from `packages/core`:

```
TMPDIR="$PWD/.tmp-a1" bun test test/terminal-run-live.test.ts -t 'direct child Attempt scope binds to a Core-prepared batch|Core forwards stale direct Attempt revision'
```

Result: **0 pass / 2 fail**. Both fail before exercising the assertions because the test environment
rejects direct process execution (`Guarded HostKernel capability: Direct process execution is
unavailable; use a Guarded HostKernel capability`, stage `host-digest`). The user explicitly
excluded Cargo and the test does not provide a valid HostKernel capability, so this remains
runtime-unverified and is not an A1 typecheck blocker. No kernel build or guard bypass was attempted.

**A1 Core + TUI typecheck closure: VERIFIED (0/0 diagnostics).** Runtime acceptance for those two
terminal tests remains blocked as described. P1/P7 retain their respective broader phase acceptance;
this check does not claim `packages/opencode` or full workspace convergence.

## OpenCode typecheck handoff map (2026-10-24)

Compared the latest P1/P2/P3/P4/P6/P7/P8/P9 phase reports with retained
`reports/typecheck-opencode-p7*` logs. **The retained logs do not contain the
claimed current 63-row snapshot:** P7 continuation 7 reports 65 total / 0 P7-
owned after its fixes; `typecheck-opencode-p7-c9.txt` contains 88 diagnostic
headers and still has stale rows (notably P3 discovery). Thus 63 is the handoff
target (65 minus two resolved discovery rows), not a count independently
reconstructible from the retained c9 artifact. No compiler was launched.

### Exact owner dispatch (log locations; stale rows marked)

| Owner / routing | File:line(s) | Count | Evidence |
|---|---|---:|---|
| P1 | `packages/core/src/tool/bash.ts:68` | 1 stale | P1 reports this fixed; fresh Core/TUI checks are 0/0. |
| P2 / cross-owner confirm | `packages/core/src/tool/registry.ts:29`; `packages/core/src/tool/tool.ts:34`; `packages/core/src/tool/write.ts:101` (2), `:102` (2) | 6 | Core source; not listed in P2's latest explicit TS-clean set. Do not assign OpenCode `src/tool/write.ts` here. |
| P3 | `packages/opencode/src/tool/discovery.ts:164,175` (175 has 2) | 3 stale | P3 reports its owned boundaries clean; these rows explain the 65→63 handoff adjustment. |
| P4 | `packages/opencode/src/lsp/repo-document-reader.ts:74` | 1 stale | P4's latest scoped check has 0 P4 diagnostics. |
| P6 / confirm | `packages/opencode/src/server/routes/instance/httpapi/handlers/config.ts:155`; `test/config/config.test.ts:1554`; `test/fake/provider.ts:55`; `test/fixture/config.ts:7`; `test/server/httpapi-v2-question-live.test.ts:228` | 5 | P6 owns provider/config/S1; its latest report says config tests 112/112, so the config fixture row is stale or revision-mismatched. |
| P7 historical rows — don't dispatch without current reproduction | `src/agent/agent.ts:512,552`; `src/effect/instance-state.ts:35`; `src/session/prompt.ts:1530,1811`; `handlers/artifact.ts:32`; `handlers/goal-review.ts:738`; `test/session/compaction.test.ts:208,215,306`; `test/session/processor-effect.test.ts:191,214`; `test/cli/run/stream.transport.test.ts:175,338,1596,1597,1600,1675,1717,1737`; `test/acp/event.test.ts:117`; `test/acp/service-session.test.ts:1401` | 24 | P7 continuation 7 says agent/instance-state were fixed and final OpenCode check was 65/0 P7-owned. This c9 subset is stale relative to that report. |
| P8 / confirm | `packages/opencode/src/v1/config/resource-policy.ts:93`; `test/server/httpapi-control-plane.test.ts:155,274,360,388,445,476,503` | 8 | P8 owns resource policy/Rust, but the HTTP test files are not stated as exclusive P8 scope; parent should arbitrate. |
| P9 | No confidently attributable row in c9 | 0 | P9's separate `sdk-next` diagnostics (`src/opencode.ts:32`, `packages/server/src/routes.ts:42,48`) are outside this OpenCode package log and have unknown baseline. |

### Unowned or exclusive writer not established — dispatch these first

| File:line(s) in c9 | Count | Current report-backed status |
|---|---:|---|
| `packages/opencode/src/tool/task.ts:151,541,795,905,1223,1226,1871,1956,2010` | 9 | P7 explicitly calls it P2-shared with no P2 marker; P2 latest report does not claim it. Assign a single owner. |
| `packages/opencode/src/tool/managed-artifact-search.ts:217,300` | 2 | No exclusive phase owner identified; P7 artifact tests do not confer source ownership. |
| `packages/opencode/src/server/routes/instance/httpapi/handlers/checkpoint.ts:89` (2) | 2 | P7 owns checkpoint control/tests, but not expressly this handler file. Confirm/assign. |
| `packages/opencode/src/tool/apply_patch.ts:382`; `src/tool/write.ts:84` | 2 | No exclusive source owner identified. |
| `packages/opencode/test/tool/task.test.ts:378,409,518,865` | 4 | P7 explicitly marks this P2-shared and unedited; parent must designate one writer. |
| `packages/opencode/test/tool/apply_patch.test.ts:23`; `test/tool/write.test.ts:34` | 2 | No exclusive owner identified. |
| `packages/opencode/test/tool/shell.test.ts:247,248,253,271,327` | 5 | P1 terminal and P7 shell/artifact boundary; no exclusive test-file owner stated. |
| `packages/opencode/test/session/snapshot-tool-race.test.ts:62`; `test/tool/lsp.test.ts:37` | 2 | P4 owns LSP behavior, but these test files are not explicitly in its write grant. Confirm with P4. |
| `packages/opencode/test/session/compaction.test.ts:208,215,306`; `test/session/processor-effect.test.ts:191,214` | 5 | Interfaces are P7-adjacent; phase report does not claim these test-file writers. |
| `packages/schema/src/agent-message-v1.ts:49,51,75`; `repo-intelligence-v1.ts:186`; `subagent-status-v1.ts:32` | 5 | Schema owner, outside P1–P9 source assignments. |
| `packages/sdk/js/src/v2/gen/sdk.gen.ts:4612` (2); `packages/server/src/handlers/question.ts:41,44,55` | 5 | Generated SDK / server ownership not established by the phase reports. |

This is an ownership/unblock manifest, not evidence that c9's stale rows remain
present. Parent should request the exact current 63-row artifact before using
these file counts as a per-revision acceptance ledger.

## Fresh full OpenCode-package snapshot (2026-10-24)

The earlier 63 estimate and the 88-header c9 log are superseded. Before starting
this run, a targeted process check found no active `tsgo` compiler. P9's separate
`sdk-next` identity/typecheck work is outside this package; this run touched no
workspace manifests or lockfiles. The compiler was run serially with package-local
temporary storage and no source files were edited. A post-run process check found
no lingering `tsgo` process.

| Package / command | Result |
|---|---|
| `packages/opencode`: `TMPDIR="$PWD/.tmp-a1-opencode" bun run typecheck` | **exit 2; 62 diagnostic headers at 60 distinct file:line locations** |

Full unabridged compiler output and `TYPECHECK_EXIT=2` are in
`reports/typecheck-opencode-current.txt`. A repeated diagnostic at a location is
counted as a separate header (for example `httpapi-control-plane.test.ts:360`
has one diagnostic; the two `httpapi-provider.test.ts:322` columns are two).
This is the dispatchable current snapshot, not an estimate. The current package
has no diagnostics in `agent/agent.ts` or `effect/instance-state.ts`; the old
P7/P6 rows there were fixed. `discovery.ts` and the old P4 repo-document-reader
row are also absent.

### Current diagnostic ownership / assignment

| Current file:line(s) | Headers | Owner / routing |
|---|---:|---|
| `src/tool/task.ts:151,541,795,905,1223,1226,1871,1956,2010` | 9 | **P2-shared** per latest P7 report; P2 has not claimed exclusive ownership of this file. Parent must designate one writer before repair. |
| `test/tool/task.test.ts:378,409,518,865` | 4 | **P2-shared** per latest P7 report; parent must designate one test-file writer. |
| `src/server/routes/instance/httpapi/handlers/config.ts:155`; `test/fake/provider.ts:55`; `test/fixture/config.ts:7`; `test/server/httpapi-v2-question-live.test.ts:223` | 4 | P6-related config/provider/S1 surfaces, but the latest P6 report does not explicitly claim all four current diagnostic files/lines. **Parent: confirm with P6 and assign any unclaimed row.** The prior P6 config-test line 1554 is not present now. |
| `test/tool/lsp.test.ts:37` | 1 | P4 LSP test domain; P4 owns LSP behavior. Route to P4 (confirm test-file write scope before editing). |
| `test/session/snapshot-tool-race.test.ts:62` | 1 | P4-adjacent LSP fixture, but no exclusive test-file owner in latest phase reports. **Unowned: parent assignment required.** |
| `test/acp/event.test.ts:117`; `test/acp/service-session.test.ts:1401`; `test/cli/run/stream.transport.test.ts:175,338,1596,1597,1600,1675,1717,1737`; `test/session/compaction.test.ts:208,215,306`; `test/session/processor-effect.test.ts:191,214` | 15 | P7-adjacent event/session/stream tests, but the latest P7 report states its 65 residuals are other-owner or fixture rows (0 P7-owned). **No exclusive owner established for these exact test rows: parent assignment required.** |
| `src/server/routes/instance/httpapi/handlers/artifact.ts:32` | 1 | Artifact surface is P7-adjacent, but this handler's exclusive source ownership is not established in the latest P7 report. **Unowned: parent assignment required.** |
| `src/server/routes/instance/httpapi/handlers/checkpoint.ts:89` (two columns) | 2 | P7 owns checkpoint control/tests, not explicitly this handler source file. **Parent: confirm/assign a single source owner.** |
| `src/server/routes/instance/httpapi/handlers/event.ts:184`; `handlers/global.ts:98`; `server.ts:296` | 3 | No current P1–P9 report establishes exclusive ownership for these exact route/layer rows. **Unowned: parent assignment required.** |
| `src/tool/apply_patch.ts:382`; `src/tool/write.ts:84`; `test/tool/apply_patch.test.ts:23`; `test/tool/write.test.ts:34` | 4 | No exclusive source/test writer established in the latest phase reports. **Unowned: parent assignment required.** |
| `src/tool/managed-artifact-search.ts:217,300` | 2 | No exclusive owner established; P7 artifact work does not by itself grant source ownership. **Unowned: parent assignment required.** |
| `src/tool/shell.test.ts:247,248,253,271,327` | 5 | P1 terminal and P7 shell/artifact boundaries overlap; no exclusive owner for this test file is stated. **Parent must arbitrate and designate one writer.** |
| `test/cli/run/runtime.boot.test.ts:203,266` | 2 | P9's latest package-identity work is in `sdk-next`/installer and does not claim these OpenCode tests; no current phase report establishes an owner. **Unowned: parent assignment required.** |
| `test/server/httpapi-control-plane.test.ts:155,274,360,388,445,476,503` | 7 | P2/P8 control-plane adjacency, but latest reports do not assign this test file exclusively. **Parent must arbitrate and designate one writer.** |
| `test/server/httpapi-provider.test.ts:322` (two columns) | 2 | Provider-related, but no latest report explicitly assigns this exact OpenCode test row. **P6 to confirm; otherwise parent assignment required.** |

Counts above total **62 diagnostic headers**. Phase association is not an exclusive
write grant: every row marked confirm/unowned/shared needs parent coordination
before edits. P1/P8/P9 have no otherwise confidently attributable current row;
the prior c9-only rows attributed to them are not present in this fresh compiler
output. Do not use stale P7 continuation counts or the prior 63 estimate as a
current acceptance ledger.
