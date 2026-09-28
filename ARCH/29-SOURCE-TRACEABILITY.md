# 29 — Source trail for implementation

Snapshot: HorizonCode `692eba1` (2026-09-28), before this documentation change.
This is a **navigation map**, not proof that a design works. `TODO.md` is the delivery
ledger; each task links here to the *first* design owner. Follow every other owner
linked in its TODO row as well. Recheck paths and call sites at the checked-out
revision before editing. An absent implementation is written **absent** rather than
inferred from a neighboring module. `ARCH/24` and `CURRENT_RUN.md` record dated
findings; `research docs/tests.md` defines the intended checks.

## How to use a source trail

1. Read the task's requirement, owner design and decision records. Read its source
   trail below, then inspect the named local files and their callers/tests at **HEAD**.
2. A peer link is an **observed pattern**, not a HorizonCode contract or an instruction
   to copy code. Check its pinned revision and actual behavior. The HorizonCode design
   and acceptance criteria decide whether to adapt it. If the evidence conflicts,
   record the discrepancy and amend the design rather than inventing an API.
3. `absent` means there is no identified local implementation for that component at
   this snapshot. Start at the named integration seam, establish a versioned contract,
   and update this map after code lands. Never promote a TODO row to verified from
   this map, an upstream example, or the presence of a test file.
4. Before copying any upstream code, schema, tests or assets, satisfy the license and
   attribution gate in [05](05-SOURCE-LEDGER.md). The links below record research
   influence only; **no source code was copied for this document**.

## Pinned upstream file index

These links point to exact Git commits where the research notes identified concrete
files. Each note states its coverage limits. The OpenCode and Aider file pages were
reopened on 2026-09-28; Codex and Cline pinned pages could not be fetched by the web
tool on that date, so those paths retain the prior research note's evidence level
until rechecked. The URLs are for human inspection; an implementer must recheck file
content and license at the pin before reuse.

| Ref | Repository and precise file | Observed concern; HorizonCode disposition |
|---|---|---|
| U-OC-LOOP | [OpenCode `session/processor.ts`](https://github.com/anomalyco/opencode/blob/b471c2b4495747353af768fbf2e0790c9d820ce2/packages/opencode/src/session/processor.ts) | Model/tool response processing; bounded batch admission remains HorizonCode's own contract. |
| U-OC-SESSION | [OpenCode `session/session.ts`](https://github.com/anomalyco/opencode/blob/b471c2b4495747353af768fbf2e0790c9d820ce2/packages/opencode/src/session/session.ts), [`packages/core/src/session/sql.ts`](https://github.com/anomalyco/opencode/blob/b471c2b4495747353af768fbf2e0790c9d820ce2/packages/core/src/session/sql.ts) | Session/message persistence; do not equate its session tables with a verified task DAG. |
| U-OC-TOOLS | [OpenCode `tool/registry.ts`](https://github.com/anomalyco/opencode/blob/b471c2b4495747353af768fbf2e0790c9d820ce2/packages/opencode/src/tool/registry.ts), [`tool/task.ts`](https://github.com/anomalyco/opencode/blob/b471c2b4495747353af768fbf2e0790c9d820ce2/packages/opencode/src/tool/task.ts) | Dynamic tool selection and child sessions; peer completion needs independent verification. |
| U-OC-ACP | [OpenCode `acp/agent.ts`](https://github.com/anomalyco/opencode/blob/b471c2b4495747353af768fbf2e0790c9d820ce2/packages/opencode/src/acp/agent.ts) | Inbound ACP translation; outbound client is a separate adapter. |
| U-CX-PROTO | [Codex `app-server-protocol/src/protocol/v2/thread.rs`](https://github.com/openai/codex/blob/67a709665ac7b50311b93e32612c9a8281684787/codex-rs/app-server-protocol/src/protocol/v2/thread.rs) | Versioned client contracts and event shapes. See [Codex research](../research%20docs/codex.md) for runtime and rollout paths. |
| U-CX-AGENT | [Codex `core/src/agent` tree](https://github.com/openai/codex/tree/67a709665ac7b50311b93e32612c9a8281684787/codex-rs/core/src/agent), [`agent-graph-store/src` tree](https://github.com/openai/codex/tree/67a709665ac7b50311b93e32612c9a8281684787/codex-rs/agent-graph-store/src) | Child-agent identity and graph persistence; controller/evidence gate is a separate HorizonCode proposal. |
| U-CL-TASK | [Cline `tasks/store/task-schema.ts`](https://github.com/cline/cline/blob/787ad1b077d8b697892dc3bfcd42e7c65b88789e/sdk/packages/core/src/tasks/store/task-schema.ts), [`sqlite-task-store.ts`](https://github.com/cline/cline/blob/787ad1b077d8b697892dc3bfcd42e7c65b88789e/sdk/packages/core/src/tasks/store/sqlite-task-store.ts) | Revisions, task runs, claims and leases; evidence-gated dependencies remain proposed here. |
| U-CL-TEAM | [Cline `sqlite-team-store.ts`](https://github.com/cline/cline/blob/787ad1b077d8b697892dc3bfcd42e7c65b88789e/sdk/packages/core/src/services/storage/sqlite-team-store.ts), [hub/spoke design](https://github.com/cline/cline/blob/787ad1b077d8b697892dc3bfcd42e7c65b88789e/docs/sdk/architecture/hub-spoke.mdx) | Team events, snapshots and detached worker ownership; not proof of HorizonCode reconnect or recovery. |
| U-AI-MAP | [Aider `repomap.py`](https://github.com/Aider-AI/aider/blob/a4be6ccd87ebaa59b361f3f028d116ce1761b626/aider/repomap.py) | Small ranked source map; needs revision binding and direct-read fallback. |
| U-AI-CODER | [Aider `coders/base_coder.py`](https://github.com/Aider-AI/aider/blob/a4be6ccd87ebaa59b361f3f028d116ce1761b626/aider/coders/base_coder.py), [`repo.py`](https://github.com/Aider-AI/aider/blob/a4be6ccd87ebaa59b361f3f028d116ce1761b626/aider/repo.py) | Edit feedback, lint/test and Git checkpoint patterns; independently verify final integrated revision. |
| U-CLAUDE | [Claude Code public research note](../research%20docs/claude.md) | Public behavior/docs only. Internal source is unavailable; never cite it as a source-code pattern. |
| U-DSR | [DeepSeek-Reasonix research note](../research%20docs/deepseek-reasonix.md) | Plan/transcript/editor behavior; follow its pinned primary links before choosing a file-level pattern. |

Other peers and tools ([research index](../research%20docs/README.md)) are
investigation candidates, not blanket requirements. This map intentionally leaves
an upstream cell blank when no precise inspected file supports that component.

## Local design-owner map

`Current entry` points to a source file or the nearest integration seam. It does
not imply the complete feature exists. Tests are examples to inspect, **not**
current-revision pass claims. The primary TODO link for each AX row lands on one
of these anchors.

| Owner | Current entry at snapshot | Test/evidence entry | Upstream file refs and status |
|---|---|---|---|
| <a id="arch00"></a>[00 Index](00-INDEX.md) | [workspace manifest](../Cargo.toml) | [test plan](../research%20docs/tests.md) | HorizonCode document/status convention; no upstream implementation source. |
| <a id="arch02"></a>[02 Requirements](02-REQUIREMENTS.md) | [CLI composition](../crates/horizoncode-cli/src/app.rs), [runner](../crates/horizoncode-runner/src/runner.rs); many proposed requirements have **absent** implementations | [acceptance plan](23-VERIFICATION.md) | Product contract is HorizonCode-original; peer patterns are indexed by component below. |
| <a id="arch03"></a>[03 Architecture](03-ARCHITECTURE.md) | [workspace manifest](../Cargo.toml), [CLI composition](../crates/horizoncode-cli/src/app.rs) | [CLI E2E](../crates/horizoncode-cli/tests/e2e_binary.rs) | U-CX-PROTO for versioned boundary comparison; no architecture copied wholesale. |
| <a id="arch05"></a>[05 Source ledger](05-SOURCE-LEDGER.md) | [notice generator](../crates/horizoncode-cli/src/notices.rs), [dependency lock](../Cargo.lock) | [notice CLI cases](../crates/horizoncode-cli/tests/notices_cli.rs) | License/provenance gate is local; peer links here authorize no copying. |
| <a id="arch06"></a>[06 UI](06-UI.md) | **absent TUI**; [CLI surface](../crates/horizoncode-cli/src/surfaces.rs), [command registry](../crates/horizoncode-commands/src/command.rs) are integration seams | [command CLI cases](../crates/horizoncode-cli/tests/commands_cli.rs); terminal acceptance **absent** | U-CX-PROTO, U-OC-ACP are protocol references, not a TUI design. |
| <a id="arch07"></a>[07 Session](07-SESSION.md) | [current session store](../crates/horizoncode-session/src/store.rs), [segmented event-log core](../crates/horizoncode-eventlog/src/log.rs) | [session log cases](../crates/horizoncode-session/tests/log.rs), [event-log cases](../crates/horizoncode-eventlog/tests/log.rs) | U-OC-SESSION, U-CX-PROTO; session migration onto event log **open** (`AX-350`). |
| <a id="arch08"></a>[08 Loop](08-LOOP.md) | [runner](../crates/horizoncode-runner/src/runner.rs), [provider transport](../crates/horizoncode-provider/src/compatible.rs) | [loop E2E](../crates/horizoncode-runner/tests/e2e_loop.rs) | U-OC-LOOP, U-AI-CODER; controller is **absent**. |
| <a id="arch09"></a>[09 Context](09-CONTEXT.md) | [instruction discovery](../crates/horizoncode-config/src/instructions.rs); revision-bound repo index **absent** | [instruction cases](../crates/horizoncode-config/tests/instructions.rs) | U-AI-MAP, U-OC-SESSION; projected context injection remains open. |
| <a id="arch10"></a>[10 Tools](10-TOOLS.md) | [tool registry](../crates/horizoncode-tools/src/registry.rs), [edit](../crates/horizoncode-tools/src/builtin/edit.rs), [patch](../crates/horizoncode-tools/src/builtin/patch.rs) | [mutation cases](../crates/horizoncode-tools/tests/mutations.rs) | U-OC-TOOLS, U-AI-CODER; `AX-314` preflight remains open. |
| <a id="arch11"></a>[11 Provider](11-PROVIDER.md) | [compatible transport](../crates/horizoncode-provider/src/compatible.rs), [SSE](../crates/horizoncode-provider/src/sse.rs), [retry](../crates/horizoncode-provider/src/retry.rs); registry/catalog **absent** | [mock transport](../crates/horizoncode-provider/tests/mock_transport.rs) | [OpenCode provider research](../research%20docs/opencode.md) for catalog/connector split; exact connector choice requires new source inspection. |
| <a id="arch12"></a>[12 Guard](12-GUARD.md) | [guard decision](../crates/horizoncode-guard/src/guard.rs), [ticket](../crates/horizoncode-guard/src/ticket.rs), [tool gate](../crates/horizoncode-tools/src/guard_gate.rs) | [guard cases](../crates/horizoncode-guard/tests/guard.rs), [permission cases](../crates/horizoncode-tools/tests/permission.rs) | Local policy design; U-OC-TOOLS offers a comparison, not an enforcement guarantee. |
| <a id="arch13"></a>[13 Sandbox](13-SANDBOX.md) | [profile](../crates/horizoncode-sandbox/src/profile.rs), [Linux](../crates/horizoncode-sandbox/src/linux.rs), [macOS](../crates/horizoncode-sandbox/src/macos.rs); Windows confinement **absent** | [sandbox cases](../crates/horizoncode-sandbox/tests/sandbox.rs) | No peer file adopted; platform acceptance controls claim strength. |
| <a id="arch14"></a>[14 Audit](14-AUDIT.md) | [audit store](../crates/horizoncode-audit/src/store.rs), [verify](../crates/horizoncode-audit/src/verify.rs) | [integrity cases](../crates/horizoncode-audit/tests/integrity.rs), [writer race](../crates/horizoncode-audit/tests/writer_race.rs) | HorizonCode-specific chain/anchor design; no peer implementation copied. |
| <a id="arch15"></a>[15 Protocols](15-PROTOCOLS.md) | [inbound ACP server](../crates/horizoncode-acp/src/server.rs), [CLI](../crates/horizoncode-cli/src/app.rs); outbound ACP and MCP **absent** | [ACP E2E](../crates/horizoncode-cli/tests/e2e_acp.rs) | U-OC-ACP, U-CX-PROTO; confirm actual ACP schema/version before implementation. |
| <a id="arch16"></a>[16 Orchestration](16-ORCH.md) | **absent** scheduler/peer runtime; [runner](../crates/horizoncode-runner/src/runner.rs) is only an execution seam | [long-horizon acceptance plan](23-VERIFICATION.md) | U-CX-AGENT, U-CL-TASK, U-CL-TEAM, U-OC-TOOLS; none supplies the whole proposed controller. |
| <a id="arch18"></a>[18 Config](18-CONFIG.md) | [settings merge](../crates/horizoncode-config/src/settings.rs), [discovery](../crates/horizoncode-config/src/discovery.rs) | [settings cases](../crates/horizoncode-config/tests/settings.rs) | [OpenCode research](../research%20docs/opencode.md), [Cline research](../research%20docs/cline.md); many key groups still **absent**. |
| <a id="arch19"></a>[19 Compression](19-COMPRESSION.md) | [runner](../crates/horizoncode-runner/src/runner.rs) is seam; durable projection/compaction **absent** | [test plan](../research%20docs/tests.md) | U-OC-SESSION, U-AI-CODER; do not compress canonical history. |
| <a id="arch20"></a>[20 Analytics](20-ANALYTICS.md) | [ledger](../crates/horizoncode-analytics/src/ledger.rs), [cost](../crates/horizoncode-analytics/src/cost.rs) | [ledger cases](../crates/horizoncode-analytics/tests/ledger.rs) | [Codeburn research](../research%20docs/codeburn.md) as observational comparison; peer quota may be unavailable. |
| <a id="arch21"></a>[21 Discovery](21-DISCOVERY.md) | [skill discovery](../crates/horizoncode-config/src/skills.rs); MCP/plugin registries **absent** | [skill unit cases](../crates/horizoncode-config/src/skills.rs) | U-OC-TOOLS and [Serena research](../research%20docs/serena.md); no extension code adopted. |
| <a id="arch22"></a>[22 Security](22-SECURITY.md) | [guard](../crates/horizoncode-guard/src/guard.rs), [sandbox profile](../crates/horizoncode-sandbox/src/profile.rs) | [security acceptance plan](23-VERIFICATION.md) | HorizonCode authority boundary; peers are threat-model comparisons only. |
| <a id="arch23"></a>[23 Verification](23-VERIFICATION.md) | [testkit](../crates/horizoncode-testkit/src/lib.rs); independent evaluator/controller **absent** | [test inventory](../research%20docs/tests.md) | U-AI-CODER is diagnostic feedback, not independent acceptance. |
| <a id="arch24"></a>[24 Review](24-ARCHITECTURE-REVIEW.md) | Dated findings; follow each finding's current code reference | [test inventory](../research%20docs/tests.md) | Local review evidence; do not infer open/closed status from peer implementations. |
| <a id="arch25"></a>[25 Long horizon](25-LONG-HORIZON-CONTROL.md) | [event-log core](../crates/horizoncode-eventlog/src/log.rs), [artifact core](../crates/horizoncode-artifact/src/lib.rs); run/task/lease/controller **absent** | [event-log cases](../crates/horizoncode-eventlog/tests/log.rs), [artifact cases](../crates/horizoncode-artifact/tests/store.rs) | U-CL-TASK, U-CL-TEAM, U-CX-AGENT, U-OC-SESSION; proposed synthesis requires its own acceptance. |
| <a id="arch26"></a>[26 Crosswalk](26-CORE-AGENT-CROSSWALK.md) | Research disposition only | [test plan](../research%20docs/tests.md) | Follow the pinned file index above; do not implement from a summary alone. |
| <a id="arch27"></a>[27 Commands/settings](27-COMMANDS-AGENTS-SETTINGS.md) | [command parser](../crates/horizoncode-commands/src/command.rs), [reference parser](../crates/horizoncode-commands/src/reference.rs), [settings](../crates/horizoncode-config/src/settings.rs); agent panel **absent** | [command CLI cases](../crates/horizoncode-cli/tests/commands_cli.rs) | [Aider commands](https://github.com/Aider-AI/aider/blob/a4be6ccd87ebaa59b361f3f028d116ce1761b626/aider/commands.py), U-CX-PROTO; UI/agent contracts are local. |
| <a id="arch28"></a>[28 Artifact store](28-ARTIFACT-STORE.md) | [artifact core](../crates/horizoncode-artifact/src/lib.rs); consumer migration **open** | [artifact cases](../crates/horizoncode-artifact/tests/store.rs) | HorizonCode storage contract; no peer file adopted. |

## Direct trails for cross-cutting tasks

These TODO rows start with `ARCH/02` because they change several components. The
owner-group row above is too broad to guide implementation by itself.

| Task | Current local path to inspect | Pinned peer evidence and remaining distinction |
|---|---|---|
| <a id="ax317"></a>AX-317 intent/spec revisions | [CLI request entry](../crates/horizoncode-cli/src/app.rs), [session payload](../crates/horizoncode-session/src/payload.rs); versioned intent/task store **absent** | U-CL-TASK for task revisions. User intent validation and dependency invalidation are proposed HorizonCode contracts. |
| <a id="ax347"></a>AX-347 scoped cancellation | [cancel token](../crates/horizoncode-types/src/cancel.rs), [runner cancellation](../crates/horizoncode-runner/src/runner.rs), [provider cancellation](../crates/horizoncode-provider/src/compatible.rs); durable effect reconciliation **absent** | U-CX-PROTO for client interrupt shapes, U-CL-TEAM for worker status; neither proves effect rollback. |
| <a id="ax348"></a>AX-348 artifacts | [artifact core](../crates/horizoncode-artifact/src/lib.rs), [limits](../crates/horizoncode-config/src/settings.rs), [session store](../crates/horizoncode-session/src/store.rs) | No peer file adopted for content-addressed storage; binding consumers and migration remain open. |
| <a id="ax349"></a>AX-349 output truncation | [SSE decoder](../crates/horizoncode-provider/src/sse.rs), [provider transport](../crates/horizoncode-provider/src/compatible.rs), [runner admission](../crates/horizoncode-runner/src/runner.rs); typed one-shot recovery **absent** | [Cline research](../research%20docs/cline.md) records versioned release behavior, not a verified file-level implementation path; inspect its pinned code before adapting. |
| <a id="ax350"></a>AX-350 segmented session store | [current session store](../crates/horizoncode-session/src/store.rs), [event-log core](../crates/horizoncode-eventlog/src/log.rs), [artifact core](../crates/horizoncode-artifact/src/lib.rs); session migration **open** | U-OC-SESSION and [Codex rollout decoder](https://github.com/openai/codex/blob/67a709665ac7b50311b93e32612c9a8281684787/codex-rs/rollout/src/lib.rs) are comparisons; commit-head semantics are local. |
| <a id="ax351"></a>AX-351 read-only recovery | [session store read/recovery paths](../crates/horizoncode-session/src/store.rs), [audit verify](../crates/horizoncode-audit/src/verify.rs) | HorizonCode-specific byte-preserving read contract; no peer file adopted. |
| <a id="ax352"></a>AX-352 commit durability | [event-log durability](../crates/horizoncode-eventlog/src/durability.rs), [session store](../crates/horizoncode-session/src/store.rs), [event-log head](../crates/horizoncode-eventlog/src/head.rs) | Platform guarantees must follow local filesystem evidence; no peer file is a substitute. |
| <a id="ax353"></a>AX-353 typed listing | [session listing](../crates/horizoncode-session/src/listing.rs), [store enumeration](../crates/horizoncode-session/src/store.rs), [CLI display](../crates/horizoncode-cli/src/surfaces.rs) | HorizonCode-specific visibility contract; no peer file adopted. |

## Source-refresh rule

When a task lands, update its TODO gap, this row's entry/test paths, and the
revision in `CURRENT_RUN.md`. For a peer-derived decision, add the exact pinned
upstream path and evidence limit in [26](26-CORE-AGENT-CROSSWALK.md) or this index,
then record the local deviation in a `DEC-*` if it changes a boundary. If no file
backs a proposed idea, label it **proposed synthesis** and design a falsifiable
acceptance check. Do not fabricate a peer source to justify it.
