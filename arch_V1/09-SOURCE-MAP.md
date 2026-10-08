# 9. Pinned source map and coverage limits

## 9.1 Baseline and inventory

Primary upstream source is the local [`opencode/` checkout at pinned revision
`b1fe25ab5ecc9f9bc911a8a2e6a51565cc764322`](https://github.com/anomalyco/opencode/tree/b1fe25ab5ecc9f9bc911a8a2e6a51565cc764322); it was detached and clean at the start of
the review. The initial HorizonCode architecture/source review began at
`9fd96b07a65b3c2faf3380c4fd24069cc993598a`; the current local implementation seams
listed in §9.6 were re-inspected at commit
`5c20a65ee6c05c7771fbcbe1e2cde8fc192b8a34`. These are bounded source checks, not a
whole-repository semantic review. The mechanically generated path inventory
is [`opencode-b1fe25ab-path-inventory.jsonl`](opencode-b1fe25ab-path-inventory.jsonl).
It records tracked path, file kind, bytes and line count; it is not semantic review.

Inventory result: **6,629 tracked paths**: 6,233 text files (1,435,757 newline
records), 336 binary files and 60 symlinks. Symlink targets are not counted as
reviewed. The inventory is tied to the pinned revision and must be regenerated after
any upstream revision change.

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
