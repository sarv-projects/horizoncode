# 33 — Built-in agents, tools, skills, jobs and integration catalog

**Status:** normative V1 product catalog. This file is the one place UI, prompt compilation, capability probing and test plans use to answer “what is built in?”

A capability being listed here means it belongs in the target product. It is **not** evidence that the current source already implements or verifies it. Runtime status must be one of `DESIGNED | CODE_PRESENT | WIRED | TESTED | VERIFIED | UNAVAILABLE`.

## 33.1 Catalog rules

- Built-in IDs are stable and versioned. A product built-in's stable ID/namespace, not a filesystem filename or display name, is its authority identity.
- Tool descriptions loaded into a model are a **filtered projection** of this catalog, not the whole catalog.
- Tools do work; skills describe reusable procedures; agents own context-bearing delegated reasoning; jobs perform lightweight maintenance; adapters connect optional external systems.
- Capability availability depends on current host, selected model, policy, project and connected integrations.
- Unsupported tools remain absent or visibly unavailable; the runtime never gives the model a fake tool that cannot execute.
- Any effect-capable tool still routes through Guard/EffectService/ExecutionHost.

## 33.2 Primary agents

| ID | Purpose | Default context | Default capability posture |
|---|---|---|---|
| `builtin.build` | implementation, debugging and direct engineering | current conversation | normal selected editing posture |
| `builtin.plan` | inspect, reason, produce plans/specs | current conversation, read-first | read-only except plan/spec artifacts |

Both are replaceable/customizable. Neither forces a particular provider/model.

## 33.3 Specialist agents

| ID | Purpose | Writes source? | Notes |
|---|---|---:|---|
| `builtin.explorer` | locate symbols/files/dependencies | no | optimized for fast/small models |
| `builtin.architect` | architecture/impact/migration analysis | no by default | deep reasoning specialist |
| `builtin.librarian` | official docs/web/repository research | no | citations/provenance required |
| `builtin.looker` | screenshots, UI, PDFs/images | no | only available with vision capability |
| `builtin.reviewer` | correctness/security/maintainability review | no | preferably different attempt/context from author |
| `builtin.test-debugger` | reproduce/fix test/runtime failures | scoped | can edit after diagnosis if allowed |
| `builtin.system-operator` | bounded local/system/service/process/environment diagnosis and repair | no source by default; system effects only when explicitly admitted | ordinary Guard/ExecutionHost authority; no implicit admin/production power |
| `builtin.browser-qa` | browser/DOM functional + visual QA, console/network inspection | no source by default | browser interactions only within explicit site/session/effect scope |
| `builtin.history-search` | recover prior messages/artifacts | no | retrieval-first, bounded synthesis |
| `builtin.verifier` | produce verification evidence | no subject edits | only under VerificationService permit |

Optional future specialist profiles are ordinary profiles, not hard-coded architecture.

## 33.4 Maintenance jobs

Built-in jobs, not default child agents:

| ID | Input | Output |
|---|---|---|
| `job.title.generate` | bounded initial thread content | title |
| `job.commit_message.generate` | staged/selected diff summary | commit message |
| `job.pr_summary.generate` | diff + evidence | PR summary |
| `job.query.rewrite` | intent + repository hints | search query |
| `job.context.trim` | context ledger | deterministic trim plan |
| `job.context.prune_propose` | context ledger | prune candidates |
| `job.context.summarize` | bounded history range | summary artifact |
| `job.artifact.retention_classify` | artifact metadata | retention proposal |
| `job.progress.recap` | durable task/run events | concise recap |
| `job.repo.detect` | manifests | language/framework/build summary |

Each job has hard input/output/time/token bounds and no implicit side-effect authority.

## 33.5 Repository and file tools

```text
repo.detect
repo.tree
repo.status
repo.dependencies
repo.impact

files.read
files.read_range
files.write
files.patch
files.move
files.create
files.delete
files.stat
files.watch

text.search
text.find_exact
glob.search

symbols.search
symbols.outline
symbols.read
definitions.find
references.find
diagnostics.get
tests.related
```

### Rules

- `files.write/patch/move/create/delete` are effects.
- search/read tools enforce path policy before returning data.
- `symbols.*` uses RepoIntel index first and reports source/confidence.
- text search remains fallback and exact-string primitive.

## 33.6 Git/source-control tools

```text
git.status
git.diff
git.log
git.show
git.branch.list
git.branch.create
git.branch.switch
git.commit
git.restore_selected
git.worktree.list
git.worktree.acquire
git.worktree.release
git.merge_stage
git.conflicts
```

No built-in `git.push` or destructive remote operation is automatically safe. Remote effects require the same permission path as any external side effect.

## 33.7 Terminal/process tools

```text
terminal.run
terminal.start
terminal.input
terminal.cancel
terminal.status
terminal.output_range

process.list_owned
process.inspect_owned
process.stop_owned

ports.reserve
ports.release
services.start_local
services.stop_local
```

Outputs are bounded and large output becomes an artifact. Process ownership is explicit.

## 33.8 Build/test tools

```text
build.detect
build.run
test.discover
test.run
test.run_related
lint.run
format.check
format.apply
benchmark.run
coverage.read
```

These are wrappers over authorized terminal/execution operations that add structured results and evidence links.

## 33.9 Browser, DOM and preview tools

```text
preview.start
preview.stop
preview.status

browser.open
browser.navigate
browser.back
browser.reload
browser.snapshot
browser.screenshot
browser.console
browser.network_errors
browser.wait
browser.assert

dom.query
dom.get
dom.click
dom.type
dom.select
dom.source_candidates
```

Bundled backend may be Playwright or another tested implementation. Optional browser MCPs are adapters to the same normalized capability family, not a separate permission model.

## 33.10 Context and history tools

```text
context.status
context.entries
context.add_ref
context.remove_ref
context.trim_preview
context.trim
context.prune_preview
context.prune
context.compact_preview
context.compact
context.clear

history.search
history.read_range
history.attach

artifacts.list
artifacts.inspect
artifacts.read_range
artifacts.export
```

No context tool deletes canonical history unless an explicit separate data-deletion action is invoked.

## 33.11 Goal/run/work tools

```text
goal.status
goal.propose
goal.revise
goal.pause
goal.resume
goal.clear

run.status
run.pause
run.resume
run.cancel
run.verify

tasks.list
tasks.inspect
tasks.propose
tasks.block
tasks.verify

checkpoint.create
checkpoint.list
checkpoint.restore_preview
checkpoint.restore
```

The model may propose transitions; authoritative services validate/commit them.

## 33.12 Agent/subagent tools

```text
agents.list
agents.inspect
agents.capabilities
agents.spawn
agents.message
agents.result
agents.cancel
agents.wait
agents.graph
```

The tool presented to a model may collapse these into a smaller `subagent` interface for tiny models.

## 33.13 Skills and documentation tools

```text
skills.search
skills.inspect
skills.load
skills.invoke

docs.horizon.search
docs.horizon.read
docs.external.search
docs.external.read
```

`docs.horizon.*` is implemented by the built-in Horizon Docs skill/service over installed versioned docs.

External docs tools prefer official/version-matched documentation where possible.

## 33.14 MCP/integration tools

```text
mcp.servers
mcp.server_status
mcp.tools
mcp.invoke

connectors.list
connectors.status
connectors.invoke
```

Model-visible MCP tools may be flattened/aliased for compatibility, but every invocation maps back to server/tool generation and Guard policy.

## 33.15 Permissions and control tools

```text
permissions.status
permissions.request
permissions.explain

approvals.pending
approvals.respond

resources.status
budget.status
usage.status
healing.status
evidence.list
events.tail
trace.inspect
```

Read-only observability tools must not leak secrets or content outside caller scope.

## 33.16 Automation tools

```text
automations.list
automations.inspect
automations.create
automations.update
automations.enable
automations.disable
automations.run_now
automations.history
```

Creating/updating an automation is itself a persisted effect; execution does not bypass the target action's normal authorization.

## 33.17 Built-in skills

V1 target skills:

| ID | Purpose |
|---|---|
| `builtin.horizon-docs` | targeted HorizonCode documentation/architecture retrieval |
| `builtin.repo-onboarding` | identify repo stack, commands, rules, architecture entrypoints |
| `builtin.plan-change` | scoped implementation plan with acceptance criteria |
| `builtin.review-change` | correctness/regression/architecture review |
| `builtin.test-debug` | reproduce/classify/debug failing tests |
| `builtin.refactor-safely` | impact-first behavior-preserving refactor |
| `builtin.dependency-migration` | version-aware dependency/API migration |
| `builtin.browser-smoke-test` | run browser journey and collect evidence |
| `builtin.performance-profile` | profile/benchmark with before-after evidence |
| `builtin.security-review` | defensive code/config review; no offensive exploitation workflow |
| `builtin.release-readiness` | build/test/license/config/release checklist |
| `builtin.commit-pr` | prepare bounded commit/PR summary and evidence |
| `builtin.context-recovery` | inspect pressure and recommend trim/prune/compact |
| `builtin.plugin-audit` | inspect extension provenance/capabilities/permissions |
| `builtin.worktree-hygiene` | inventory leases/processes/dirty state; propose safe cleanup |

A skill may be unavailable if required tools/capabilities are absent.

## 33.18 Built-in hook handlers

Deterministic internal hooks:

- stale-file version precondition;
- workspace/resource lease validation;
- tool batch whole-response barrier;
- secret-output redaction;
- large-output artifactization;
- post-patch diagnostics scheduling;
- final-verification gate;
- worktree release hygiene;
- context-pressure monitor;
- usage/latency telemetry;
- crash/restart reconciliation trigger.

These are product invariants or internal handlers, not model-written scripts.

## 33.19 Built-in renderers/artifact viewers

- Markdown/CommonMark/GFM;
- syntax-highlighted code;
- diff/merge;
- JSON/YAML tree/table;
- Mermaid;
- image;
- PDF/document metadata/preview where supported;
- test/JUnit-like report;
- benchmark charts;
- terminal/log viewer;
- proof/evidence pack.

Every renderer has byte/time/memory limits and safe fallback.

## 33.20 Default tool exposure by agent

### Build

Start with:
`repo.detect, symbols.search, files.read, files.patch, terminal.run, test.run_related, git.diff, context.status, skills.search`.

Load more through tool search/capability need.

### Plan

Read/index/history/docs, no source writes by default.

### Explorer

`repo.*, symbols.*, text.search, files.read_range, diagnostics.get`; no terminal/write unless a custom profile grants a narrow diagnostic command.

### Librarian

docs/web/repository fetch tools only; no project writes.

### Reviewer

diff/read/symbol/test-evidence tools; no source write.

### Tiny-model profile

Prefer a compressed meta-tool surface:

```text
repo(query)
read(ref)
edit(patch)
run(command-or-test)
search_tools(query)
finish(status,evidence)
```

The harness maps these to typed underlying actions. This is an explicit harness choice, not a hidden change of model.

### Built-in harness families

| ID | Purpose | Default tool surface |
|---|---|---|
| `harness.native-rich` | strongest native Horizon/OpenCode tool-calling surface | filtered rich typed tools |
| `harness.native-minimal` | small-context / lower-capability models with native tool calling | compact meta-tools + lazy discovery |
| `harness.bash-only` | models that perform better with a simple shell/action loop or lack reliable function calling | one guarded terminal/action schema plus bounded retrieval |
| `harness.compatibility:<name>` | versioned provider/model-tuned prompt/tool/message shaping while staying on Horizon's runtime | exact declared compatibility projection |

Harnesses are **not models and not providers**. Switching a harness does not change endpoint/model,
does not authorize paid fallback, and does not grant additional effects. Incompatibility is
reported rather than silently routed around. The UI shows provider, model and harness as separate
selections/derived profile fields.

## 33.21 Tool discovery and prompt budget

The catalog can contain hundreds of capabilities without putting hundreds of schemas in the prompt.

`tools.search` index fields:
- ID;
- concise description;
- tags;
- side-effect class;
- availability;
- required capability;
- input/output schema digest.

Results are top-K bounded and can expose a requested family at the next safe toolset boundary.

## 33.22 Product/UI synchronization

The following all read the same catalog/projections:
- Settings → Agents/Tools/Skills/MCP;
- slash/palette completion;
- model prompt compiler;
- permission UI;
- Doctor;
- developer SDK;
- test catalog.

A tool/skill/agent cannot exist only in a hidden prompt and not in the capability catalog.

## 33.23 Language-service and log-search capability family

Normalized model tools stay small:

```text
language.status
language.sources
language.diagnostics

terminal.search
artifacts.search_text
```

Definitions/references/outline remain the existing `definitions.find`, `references.find` and
`symbols.*` tools; their result metadata says whether the source was editor LSP, supervised LSP,
persistent index, parser or lexical fallback.

Human/control actions may additionally expose:
- attach/use a discovered compatible editor language service;
- start/restart/stop a **Horizon-supervised** language service;
- show version/root/configuration/health;
- choose a preferred source for one language/workspace.

A model cannot restart or reconfigure an editor-owned language service merely by calling a query
tool. Any server process start/restart is an effect and follows ExecutionHost/Guard.

`terminal.search` and `artifacts.search_text` search bounded artifact/log indexes and return
stable line/range refs. They are read-only and do not load full log content into model context.

## 33.24 Plan/handoff capabilities

Plan profile has explicit:
- `plan.handoff.create`
- `plan.handoff.inspect`
- `plan.handoff.revise`
- `plan.handoff.render`

Build consumes a pinned `PlanHandoffV1` through normal context/reference machinery. Rendering to
Markdown/HTML is presentation only; task dependencies and acceptance criteria remain structured.

The Plan profile's read-only posture is enforced by effect classification/Guard, including shell,
LSP code actions, package managers, scripts and MCP aliases. Disabling write tools alone is not
the safety boundary.

## 33.25 Capability implementation status anchors

At the 2026-10-11 audit:
- `indexd` is CODE_PRESENT only for a bounded in-memory lexical slice and overlay/cursor logic;
  persistent symbol/reference/LSP orchestration remains DESIGNED/unverified until source proves
  otherwise;
- `builtin.horizon-docs` has a **Horizon-owned canonical product asset** at
  `packages/core/src/horizon/skills/horizon-docs/SKILL.md`; the current
  `.opencode/skills/horizon-docs/SKILL.md` is only a development compatibility shim.
  Embedded/bundled runtime registration, UI discovery and acceptance remain unverified;
- browser/DOM, Mission Control, analytics, automation and rich custom profiles similarly retain
  their runtime status separately from catalog membership.

The product UI should make these states visible during development/diagnostics so incomplete
capabilities cannot masquerade as supported.

## 33.26 Acceptance

- catalog IDs unique/stable;
- UI and prompt compiler agree on enabled tools;
- unavailable capability has exact reason;
- tiny model receives bounded starter catalog;
- tool search cannot expose denied secret/internal tools;
- every effectful built-in maps to Guard/Effect owner;
- all built-in skills pass manifest/resource validation;
- a project/user/plugin skill with a colliding display name cannot shadow a sealed `builtin.*` skill ID; replacement requires an explicit compatible Composition/Profile decision;
- specialist defaults cannot silently select a paid model;
- System Operator profile grants no implicit admin/production authority and every system mutation still crosses Guard/ExecutionHost;
- Browser QA has no source-write capability unless the parent explicitly delegates the matching scoped capability;
- docs skill returns installed-version docs;
- no maintenance job spawns a worktree unless its declared implementation actually needs one;
- language-service queries report source/generation and do not duplicate healthy editor servers;
- editor-owned LSP cannot be restarted by a model query;
- terminal/artifact search returns bounded refs rather than whole logs;
- Plan→Build handoff preserves structured DAG/scope/criteria across renderings/profiles;
- catalog runtime status matches actual implementation evidence, including the lexical-only
  current `indexd` slice.

## 33.27 Canonical naming, aliases and unknown effect class

The §33 tool IDs are the sole canonical names. contracts-v2/capability-registry-v1.json is a design-time inventory/alias seed derived from this catalog; it is NOT evidence that all listed tools work. Prior fs.*, exec.*, agent.* spellings and impact.analyze are mapped to existing canonical targets with their same effect classification, authorization and schema generation. Ambiguous/missing aliases deny. UNKNOWN effect class is fail-closed; the source owner must classify it before use. The service method/error/generation requirements are §37.
