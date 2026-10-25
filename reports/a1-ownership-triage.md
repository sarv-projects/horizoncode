# A1 ownership triage — typecheck diagnostics → proposed owner

**Provenance.** This file merges two writes: (a) the parent orchestrator's routing draft (owner
assignments govern — "if A1 publishes a differing assignment, the file:line ownership below governs
unless the parent changes it"), and (b) A1's full diagnostic inventory from
`reports/typecheck-integration-a1.txt`. Every parent-assigned owner below is retained verbatim in
intent; A1 rows the parent had not yet listed (the 15 A1-cleared fixtures, the 21 resolved sdk-next
rows, the 4 `routes.ts` rows) are added with their disposition. Nothing from the parent draft was
dropped: its "cleared during the session" attribution and its "remaining blockers" note are
reproduced in §4.

Authoritative run: **Run C** (`reports/typecheck-integration-a1.txt`) — 8 packages, 2 non-zero
exits, **25 diagnostics** (`packages/core` 4, `packages/opencode` 21); Run A baseline = 60.

Owner vocabulary: **P1** bash/process/Guard · **P2** HostKernel/managed · **P3** context/indexd ·
**P4** LSP/DAP/REPL/editor · **P5** search/CodeMode · **P6** provider/auth/settings/server ·
**P7** runner/TUI/activity/transfer · **P8** resource · **P9** release/identity ·
**A1 test-fixture** · **IN_FLIGHT**.

## 1. Run C residuals — 25 rows still open

| package | diagnostic | file:line | proposed owner |
|---|---|---|---|
| core | TS2345 `string` not assignable to `number` | `packages/core/test/session-direct-read-batch.test.ts:569,25` | P7 (parent-routed; new since Run A, P7 in-flight on `src/session/direct-read-batch.ts`) |
| core | TS2769 no overload matches this call | `packages/core/test/session-direct-read-batch.test.ts:585,31` | P7 (parent-routed; new since Run A) |
| core | TS2345 discriminated-lane argument mismatch (`lane:"managed_attempt"`) | `packages/core/test/session-direct-read-batch.test.ts:623,47` | P7 (parent-routed; new since Run A) |
| core | TS2769 no overload matches this call | `packages/core/test/session-direct-read-batch.test.ts:721,31` | P7 (parent-routed; new since Run A) |
| opencode | TS2353 `profileRevision` does not exist in `DirectScopeFacts` | `packages/opencode/src/tool/task.ts:545,9` | P7 (parent-routed; product source, task DAG — coordinate with P2) |
| opencode | TS7053 no index signature on the handoff binding object | `packages/opencode/src/tool/task.ts:1877,95` | P7 (parent-routed; product source, coordinate with P2) |
| opencode | TS2552 cannot find name `ProviderV2` | `packages/opencode/src/tool/task.ts:1962,42` | P7 (parent-routed; product source) |
| opencode | TS2552 cannot find name `ModelV2` | `packages/opencode/src/tool/task.ts:1962,88` | P7 (parent-routed; product source) |
| opencode | TS2322 error-branch `metadata {status,reason}` missing `SearchMetadata` fields | `packages/opencode/src/tool/managed-artifact-search.ts:248,126` | P7 (parent-routed; product source; P5 previously reported this as outside P5) |
| opencode | TS2322 error-branch `metadata {status,reason}` missing `RangeMetadata` fields | `packages/opencode/src/tool/managed-artifact-search.ts:338,124` | P7 (parent-routed; product source; P5 previously reported this as outside P5) |
| opencode | TS2322 branch returns `count: string`, declared `count: number` | `packages/opencode/src/tool/repo-tools.ts:496,3` | P7 (parent-routed: "repo-tools carved out to P7"; P5 previously reported this as outside P5) |
| opencode | TS2322 `CheckpointPreviewV1.classification` is `string`, response expects literal union | `packages/opencode/src/server/routes/instance/httpapi/handlers/checkpoint.ts:89,60` | P7 (parent-routed: checkpoint owner) |
| opencode | TS2345 `readonly string[]` selectedPaths not assignable to `string[]` | `packages/opencode/src/server/routes/instance/httpapi/handlers/checkpoint.ts:89,75` | P7 (parent-routed: checkpoint owner) |
| opencode | TS2345 `Effect<…, ConstructionService \| Scope>` not assignable to expected layer/effect parameter | `packages/opencode/test/effect/instance-state.test.ts:50,3` | P7 (parent-routed; **new since Run A**; P7 owns `src/effect/instance-state.ts`) |
| opencode | TS2322 Layer requirement `Service` not assignable to `RouteRequirements` | `packages/opencode/src/server/routes/instance/httpapi/server.ts:296,3` | P6 (server route wiring) |
| opencode | TS2322 `string` not assignable to `Option<string>` | `packages/opencode/test/server/httpapi-control-plane.test.ts:155,7` | P6 (control-plane QA) |
| opencode | TS2345 mock `AgentProfileService.Service` lacks `create, sessionWarp, list, syncList…` | `packages/opencode/test/server/httpapi-control-plane.test.ts:361,104` | P6 (control-plane QA) |
| opencode | TS2345 mock `AgentProfileService.Service` lacks `create, sessionWarp, list, syncList…` | `packages/opencode/test/server/httpapi-control-plane.test.ts:389,103` | P6 (control-plane QA) |
| opencode | TS2345 mock `AgentProfileService.Service` lacks `create, sessionWarp, list, syncList…` | `packages/opencode/test/server/httpapi-control-plane.test.ts:446,103` | P6 (control-plane QA) |
| opencode | TS2345 mock `AgentProfileService.Service` lacks `create, sessionWarp, list, syncList…` | `packages/opencode/test/server/httpapi-control-plane.test.ts:477,107` | P6 (control-plane QA) |
| opencode | TS2345 mock `AgentProfileService.Service` lacks `create, sessionWarp, list, syncList…` | `packages/opencode/test/server/httpapi-control-plane.test.ts:504,111` | P6 (control-plane QA) |
| opencode | TS2345 Layer requirements include `unknown`, target needs `never` | `packages/opencode/test/server/httpapi-v2-question-live.test.ts:223,23` | P6 (question route) |
| opencode | TS2769 `readonly string[]` not assignable to mutable `string[]` | `packages/opencode/test/identity/runtime-service-identity.test.ts:79,34` | P9 (identity test) |
| opencode | TS2322 `Promise<{data…}>` not assignable to generated `RequestResult<ProviderListResponses…>` | `packages/opencode/test/cli/run/runtime.boot.test.ts:203,7` | P9 (CLI/runtime boot) |
| opencode | TS2322 `Promise<{data…}>` not assignable to generated `RequestResult<ProviderListResponses…>` | `packages/opencode/test/cli/run/runtime.boot.test.ts:266,7` | P9 (CLI/runtime boot) |

Run C clean (EXIT 0 / 0 diagnostics): `packages/schema`, `packages/tui`, `packages/llm`,
`packages/server`, `packages/protocol`, `packages/sdk-next`.

## 2. Run A baseline rows cleared during this session — 40 rows

| package | diagnostic | file:line | proposed owner |
|---|---|---|---|
| schema | TS2769 `string` not assignable to `string & Brand<"Horizon.AgentProfileV2.ProfileId">` | `packages/schema/test/agent-profile-v2.test.ts:73,36` | A1 test-fixture — **A1 FIXED** |
| schema | TS18048 `decoded.data.usageProvenance` possibly undefined | `packages/schema/test/session-usage-provenance.test.ts:42,10` | A1 test-fixture — **A1 FIXED** |
| schema | TS2769 `{status:string}` outside the usage-provenance union | `packages/schema/test/session-usage-provenance.test.ts:42,53` | A1 test-fixture — **A1 FIXED** |
| schema | TS18048 `decoded.data.usageProvenance` possibly undefined | `packages/schema/test/session-usage-provenance.test.ts:43,10` | A1 test-fixture — **A1 FIXED** |
| schema | TS2769 `{status:string}` outside the usage-provenance union | `packages/schema/test/session-usage-provenance.test.ts:43,66` | A1 test-fixture — **A1 FIXED** |
| schema | TS2769 `estimated` literal widened (`status`/`algorithm`) | `packages/schema/test/session-usage-provenance.test.ts:103,99` | A1 test-fixture — **A1 FIXED** |
| schema | TS2769 fixture ids are plain strings, decoded type is branded `SessionID` | `packages/schema/test/subagent-status-v1.test.ts:29,110` | A1 test-fixture — **A1 FIXED** |
| opencode | TS2345 `Config.Interface` requires `getRepoIntelProfile`, fixture lacks it | `packages/opencode/test/fixture/config.ts:14,28` | A1 test-fixture — **A1 FIXED** |
| opencode | TS1117 duplicate key `getExternalEditorProfiles` | `packages/opencode/test/fixture/config.ts:30,5` | A1 test-fixture — **A1 FIXED** |
| opencode | TS1117 duplicate key `updateExternalEditorProfiles` | `packages/opencode/test/fixture/config.ts:31,5` | A1 test-fixture — **A1 FIXED** |
| opencode | TS7006 implicit `any` param `serviceID` on the supervisor mock | `packages/opencode/test/tool/task.test.ts:390,25` | A1 test-fixture — **A1 FIXED** |
| opencode | TS7006 implicit `any` param `operation` | `packages/opencode/test/tool/task.test.ts:390,36` | A1 test-fixture — **A1 FIXED** |
| opencode | TS7006 implicit `any` param `body` | `packages/opencode/test/tool/task.test.ts:390,47` | A1 test-fixture — **A1 FIXED** |
| opencode | TS7006 implicit `any` param `options` | `packages/opencode/test/tool/task.test.ts:390,53` | A1 test-fixture — **A1 FIXED** |
| opencode | TS2503 `SessionSupervisor` is a const, not a namespace (`SessionSupervisor.Interface` invalid) | `packages/opencode/test/tool/task.test.ts:398,19` | A1 test-fixture — **A1 FIXED** |
| sdk-next | TS2307 cannot find module `@horizoncode/client/effect` | `packages/sdk-next/src/index.ts:4,29` | P9 — cleared by the authorized `bun install --frozen-lockfile` (workspace link materialized) |
| sdk-next | TS2307 cannot find module `@horizoncode/client/effect` | `packages/sdk-next/src/index.ts:16,8` | P9 — cleared as above |
| sdk-next | TS2307 cannot find module `@horizoncode/client/effect` | `packages/sdk-next/src/index.ts:17,36` | P9 — cleared as above |
| sdk-next | TS2307 cannot find module `@horizoncode/client/effect` | `packages/sdk-next/src/opencode.ts:1,26` | P9 — cleared as above |
| sdk-next | TS2554 expected 2 arguments, but got 1 (missing local `TrustedPrincipalContext` branch) | `packages/sdk-next/src/opencode.ts:32,85` | P1/P6 — **not present in Run C**; treat as resolved-or-rerun-dependent until P1's `TrustedPrincipalContext` fail-closed fix lands (parent note, §4) |
| sdk-next | TS18046 `event` is of type `unknown` (client-module cascade) | `packages/sdk-next/test/embedded.test.ts:49,34` | P9 — cascade cleared with the link |
| sdk-next | TS18046 `event` is of type `unknown` (client-module cascade) | `packages/sdk-next/test/embedded.test.ts:49,76` | P9 — cascade cleared with the link |
| sdk-next | TS2345 `Option.getOrUndefined` fed `unknown` (cascade) | `packages/sdk-next/test/embedded.test.ts:52,20` | P9 — cascade cleared with the link |
| sdk-next | TS2345 `Option.getOrUndefined` fed `unknown` (cascade) | `packages/sdk-next/test/embedded.test.ts:57,58` | P9 — cascade cleared with the link |
| sdk-next | TS7006 implicit `any` param `message` (cascade) | `packages/sdk-next/test/embedded.test.ts:58,63` | P9 — cascade cleared with the link |
| sdk-next | TS7006 implicit `any` param `session` (cascade) | `packages/sdk-next/test/embedded.test.ts:85,30` | P9 — cascade cleared with the link |
| sdk-next | TS7006 implicit `any` param `message` (cascade) | `packages/sdk-next/test/embedded.test.ts:90,28` | P9 — cascade cleared with the link |
| sdk-next | TS18046 `error` is of type `unknown` (cascade) | `packages/sdk-next/test/embedded.test.ts:93,37` | P9 — cascade cleared with the link |
| sdk-next | TS18046 `missingMessage` is of type `unknown` (cascade) | `packages/sdk-next/test/embedded.test.ts:98,14` | P9 — cascade cleared with the link |
| sdk-next | TS2345 `Effect<…,unknown,unknown>` not assignable to `Effect<…,unknown,never>` | `packages/sdk-next/test/embedded.test.ts:100,29` | P9 — cascade cleared with the link |
| sdk-next | TS18046 `event` is of type `unknown` (cascade) | `packages/sdk-next/test/embedded.test.ts:121,11` | P9 — cascade cleared with the link |
| sdk-next | TS18046 `event` is of type `unknown` (cascade) | `packages/sdk-next/test/embedded.test.ts:123,15` | P9 — cascade cleared with the link |
| sdk-next | TS18046 `event` is of type `unknown` (cascade) | `packages/sdk-next/test/embedded.test.ts:123,57` | P9 — cascade cleared with the link |
| sdk-next | TS2345 `Effect<…,unknown,unknown>` not assignable to `Effect<…,unknown,never>` | `packages/sdk-next/test/embedded.test.ts:139,29` | P9 — cascade cleared with the link |
| sdk-next | TS2345 `Effect<…,unknown,unknown>` not assignable to `Effect<…,unknown,never>` | `packages/sdk-next/test/embedded.test.ts:182,29` | P9 — cascade cleared with the link |
| sdk-next | TS2345 `Effect<any,unknown,unknown>` not assignable to `Effect<any,unknown,never>` | `packages/sdk-next/test/embedded.test.ts:198,7` | P9 — cascade cleared with the link |
| sdk-next | TS2739 `{username, password}` missing `reviewerPassword`, `reviewerUsername` | `packages/server/src/routes.ts:42,39` (cross-import) | P6 — cleared by P6's `ServerAuth.primaryOnlyInfo` |
| sdk-next | TS2739 `{username, password}` missing `reviewerPassword`, `reviewerUsername` | `packages/server/src/routes.ts:48,51` (cross-import) | P6 — cleared by P6's `ServerAuth.primaryOnlyInfo` |
| server | TS2739 `{username, password}` missing `reviewerPassword`, `reviewerUsername` | `packages/server/src/routes.ts:42,39` | P6 — cleared by P6's `ServerAuth.primaryOnlyInfo` |
| server | TS2739 `{username, password}` missing `reviewerPassword`, `reviewerUsername` | `packages/server/src/routes.ts:48,51` | P6 — cleared by P6's `ServerAuth.primaryOnlyInfo` |

## 3. Owner roll-up

| proposed owner | Run A baseline rows | cleared in session | still open (Run C) | new since Run A |
|---|---|---|---|---|
| A1 test-fixture | 15 | 15 (all A1) | 0 | 0 |
| P7 (parent-routed: task/managed/repo-tools/checkpoint) | 9 | 0 | 9 | 5 |
| P6 provider/auth/settings/server | 12 | 4 | 8 | 0 |
| P9 release/identity | 23 | 20 | 3 | 0 |
| P1/P6 (sdk-next `TrustedPrincipalContext` arity) | 1 | 1 (rerun-dependent) | 0 | 0 |
| **total** | **60** | **40** | **20** | **5** → **25 in Run C** |

Baseline rows with zero diagnostics: `packages/core` 0, `packages/tui` 0, `packages/llm` 0,
`packages/protocol` 0.

## 4. Parent notes carried over verbatim (unchanged intent)

- `packages/sdk-next` **23 → 0**: `@horizoncode/client` workspace link materialized by the authorized
  `bun install --frozen-lockfile` (P9); `TS2739` reviewer fields cleared by P6's
  `ServerAuth.primaryOnlyInfo`.
- `packages/server` **2 → 0** (same P6 fix), `packages/schema` **7 → 0** (A1 fixture corrections),
  `test/tool/task.test.ts` 5 rows and 3 fixture/config rows cleared by A1 test-fixture edits.
- `packages/sdk-next/src/opencode.ts(32,85) TS2554` reported by P9's own run is **not** in Run C;
  Run C shows sdk-next at 0. Treat it as resolved-or-rerun-dependent until P1's
  `TrustedPrincipalContext` fail-closed fix lands and the suite is rerun.
- Typecheck is **not** green: 2/8 packages still fail. Do not claim the B1 gate.

## 5. Routed runtime findings (not typecheck diagnostics)

| finding | file:line | proposed owner |
|---|---|---|
| strict JSON contract test fails: emitted contract resolves `PositiveDecimalU64` `$ref` where the test expects plain `integer` (42 vs 40 lines); 11 pass / 1 fail before **and** after A1's edits | `packages/schema/test/agent-profile-v2.test.ts:92,23` | P6 (agent-profile schema/Rust parity) |
| 14 `tool.task authenticated dispatch` product failures (e.g. `task_id does not identify a child session for this parent and agent`, `src/tool/task.ts:276`) | `packages/opencode/test/tool/task.test.ts` | P7 (parent-routed owner of `src/tool/task.ts`, coordinate with P2) — A1's hunks there are type-level only |

## 6. A1 changes made (exact files; test-fixture/type only)

- `packages/schema/test/agent-profile-v2.test.ts` — 1 line (assertion operand widened)
- `packages/schema/test/session-usage-provenance.test.ts` — 7 lines (`as const` fixtures, optional chaining)
- `packages/schema/test/subagent-status-v1.test.ts` — 3 lines (branded `SessionID.descending` fixture)
- `packages/opencode/test/fixture/config.ts` — removed 2 shadowed duplicate keys; added
  `getRepoIntelProfile` / `updateRepoIntelProfile` fixture defaults (both required by `Config.Interface`)
- `packages/opencode/test/tool/task.test.ts` — import type alias + explicit mock parameter types

Evidence: `packages/schema` typecheck 7 → 0 (EXIT 0); `packages/opencode` typecheck 28 → 20 → Run C 21
(the +1 is P7's new `instance-state` row); fixture consumers green
(`test/session/instruction.test.ts` 9 pass / 0 fail, `test/tool/repo-tools.test.ts` 13 pass / 0 fail);
schema tests 11 pass / 1 fail both before and after (the fail is §5 row 1).

No product source, no `tsconfig`, no Cargo, no Git writes, no provider/network calls, no release or
verification claim. Raw per-package evidence: `reports/typecheck-integration-a1.txt`.
