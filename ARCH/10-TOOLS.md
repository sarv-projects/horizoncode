# 10 — Tool Plane

Module-level design for `CMP-tools` (Capability layer). This document owns tool
definitions, permission-filtered materialization, execution and settlement, and
the boundary between what the model sees and what the UI sees. It does not own
permission *decisions* (`CMP-guard`), sandboxing (`CMP-sandbox`), provider
transports (`CMP-provider`), or the step loop (`CMP-runner`).

## Purpose

Prove `REQ-TOOL-001..005` and `REQ-LOOP-003`. The tool plane is the single place
where a model-facing capability is defined, filtered by policy, executed under
the guard, and split into a model-visible result and a UI-visible record. One
registry, one execution path, no second tool engine (`DEC-001`, `DEC-003`).

## Responsibilities

Owns:

- the `Tool.make` contract (description, input/output/structured schemas,
  execute, model-output mapping);
- tool-name validation;
- the registry and the permission-filtered materialization that produces the
  model's advertised tool set;
- the built-in tool set;
- MCP-bridged tool registration (mirrored definitions, deduped per server connection and definition digest);
- permission assertion immediately before each execution;
- output bounding and managed-output spill;
- the parallel-safe vs exclusive declaration consumed by the scheduler;
- settlement (result encoding, structured output, error mapping);
- step/loop tool guards (max-steps tool disablement);
- the model/UI result split.

Never owns: allow/ask/deny evaluation or path policy (`CMP-guard`), confinement
(`CMP-sandbox`), HTTP/process transports (`CMP-provider`/host), or the number of
steps in a turn (`CMP-runner` sets the bound; tools enforce the final guard).

## Interfaces

| Counterpart | Direction | Contract |
|---|---|---|
| `CMP-runner` | caller | `materialize(permissions) -> { definitions, settle }`; `settle(call, context) -> Settlement` |
| `CMP-guard` | callee | `assert({ action, resources, save?, metadata?, sessionID, agent, source })` before any effect |
| `CMP-mcp` | provider | registers mirrored remote tools with a namespaced name and its own permission action |
| `CMP-sandbox` | callee | executes shell/patch effects through the confined process path |
| `CMP-session` | write | tool call/result events; managed output paths |
| `CMP-tui` | read | full result detail (diffs, patches, output paths, timing) distinct from model content |
| `CMP-provider` | read | tool schemas are counted into the context budget by `CMP-context` |

## The `Tool.make` contract

```
make({
  description: string,
  input:   Schema<Input>,                       // typed, required
  output:  Schema<Output>,                      // typed, required
  structured?: Schema<Structured>,              // optional machine-readable projection
  toStructuredOutput?: ({ input, output }) -> Structured,
  execute: (input, context: ToolContext) -> Result<Output, ToolFailure>,
  toModelOutput?: ({ input, output }) -> Content[],
})

ToolContext { threadID, runID?, taskID?, attemptID?, agent, assistantMessageID, toolCallID }
Content = { type: "text", text }                 // current model-visible variant
// Image/audio/file variants are proposed protocol work, not implemented content.
```

Runtime behavior of `settle`:

1. **Decode input** against `input`; a decode error becomes a typed
   `ToolFailure("Invalid tool input: …")` — never a panic and never an
   unvalidated call. Then **execute** with the typed input and context.
2. **Encode output** against `output`; a mismatch is a typed
   `ToolFailure("Tool returned an invalid value for its output schema: …")`.
3. **Structured projection** — when both `structured` and `toStructuredOutput`
   are present, encode the structured value; otherwise structured defaults to
   the encoded output.
4. **Model content** — `toModelOutput` wins when present; otherwise a string
   output maps to one text part and anything else maps to no content.
5. **Bound** — the settled output passes through the managed-output store before
   it is recorded (see below).

`withPermission(tool, action)` decorates a tool so its policy action differs from
its name (for example, `write`, `edit`, and `apply_patch` all assert `edit`).

The JSON schema exposed to the model is generated from the input schema; the
output/structured schema is advertised as the tool's output schema. Definitions
are cached per `(tool, advertised name)`.

## Name validation

`REQ-TOOL-005`: every registered name MUST match `^[A-Za-z][A-Za-z0-9_-]{0,63}$`.
Registration validates names before any entry is stored; a violation is a typed
registration error and the whole registration batch is rejected. MCP-bridged
names are namespaced/rewritten so the same rule holds.

## Registry and permission-filtered materialization

`REQ-TOOL-003`. Materialization is the security-relevant step: **a denied tool
is absent from the advertised definitions, not merely blocked at call time.**

```
materialize(permissions):
  entries = application registrations ⊕ scoped local registrations (last wins)
  for each entry: action = decorator-permission ?? name;
      if whollyDisabled(action): remove        // scope-closed calls answer stale
return { definitions, settle }
```

- **`whollyDisabled`** — the last rule matching the action has resource `*` and
  effect `deny`. A partial/pattern denial is *not* removal; it is enforced at
  call time by the guard (the tool stays advertised because it is usable for
  other resources).
- **Registration identity** — each materialization captures the registration
  identity it advertised. A call that arrives against a replaced/closed
  registration is answered with `Stale tool call: <name>`, never routed to a
  different implementation.
- **Scoped registration** — MCP servers and plugins register within a scope; the
  scope finalizer removes their entries, and any in-flight call for a removed
  tool answers `Unknown tool: <name>`.

The advertised set is the model's tool list. `CMP-context` counts these
definitions into the token budget; the registry never sends them itself.

## Built-in tools: source baseline and target

The table is split deliberately: source presence is not inferred from a target
contract. At HorizonCode Rust source baseline `23d4ce8` (confirmed unchanged for
Rust/Cargo manifests through HEAD `cbba87b`), these are the first-party tools
registered by `horizoncode-tools`; `question` is registered only when the caller
selects interactive mode. The registry has no model-visible skill, web, agent,
mailbox, LSP, or image tool at that baseline. See `ARCH/29` for exact files/tests.

| Tool | Status at baseline | Input (summary) | Mutates | Permission action | Model output |
|---|---|---|---|---|---|
| `read` | implemented | `path`, `offset`, `limit` | no | `read` | UTF-8 text page, directory listing, or binary-file notice |
| `write` | implemented | `path`, `content` | yes | `edit` | success line |
| `edit` | implemented | `path`, `oldString`, `newString`, `replaceAll?` | yes | `edit` | success line and bounded diff preview |
| `apply_patch` | implemented | `patchText` (add/update/delete hunks) | yes | `edit` | sequential `A/M/D <resource>` lines |
| `glob` | implemented | `pattern`, `path?`, `limit?` | no | `glob` | newline-joined relative paths |
| `grep` | implemented | `pattern`, `path?`, `include?`, `limit?` | no | `grep` | per-file grouped line previews |
| `list` | implemented | directory path/options | no | `list` | directory entries |
| `bash` | implemented | `command`, `workdir?`, `timeout?` | yes | `bash` | captured output and exit/timeout line |
| `todo` | implemented | `todos[]` | session-local | `todo` | validated progress snapshot; not durable Task truth |
| `question` | implemented, interactive-only registration | `questions[]` | no | `question` | answered labels; unavailable headless |

The current shared `ContentPart` type is text-only. Image/audio/file parts and
multimodal tool results are proposed protocol work; `read` does not return an
image part at the source baseline. Any future media path needs an explicit typed
representation, byte/pixel limits, artifact identity, provider capability check,
and evidence that previews are not mistaken for originals.

### Proposed capability candidates (not registered tools)

These are architecture candidates, not promises that all belong in the first
release. Each must use the existing capability registry and the same permission,
sandbox, audit, budget, and output-limiting paths; none may create a parallel tool
engine.

| Candidate | Fit and constraint | Status |
|---|---|---|
| Skill activation | Add a first-party invocation path for discovered skills: verify the listed digest, load only the selected body/references, frame all content as untrusted instructions/data, and run any script only through the governed process path. Discovery and `/skills list/show` currently exist; model invocation does not. | proposed; bounded under AX-110 follow-up |
| Symbol/LSP navigation | Reuse repository-intelligence's versioned LSP/SCIP interface for symbol, references, diagnostics, and optionally rename previews. Do not duplicate an LSP client in the tool crate; edits still go through `edit`/patch and guard. Serena may be an MCP integration. | proposed; prioritize read-only calls |
| Web search/fetch | Useful for documented tasks, but only through a mediated egress service with redirect revalidation, DNS/IP checks, private/link-local denial, byte/deadline caps, content provenance, and untrusted-result framing. | proposed; no direct arbitrary URL fetch |
| MCP resources/prompts | MCP tools are already the first integration surface. Add resources/prompts only with user-visible provenance, URI allowlists, size bounds, change notifications, and explicit selection; do not silently inject server content. | staged proposal; validate pinned MCP revision first |
| Code Mode / tool composition | Consider only after measured repeated-call overhead; generated code receives no ambient authority and every nested call goes through this registry, guard, sandbox, budget, and audit. | optional proposal; defer until benchmark |
| Independent verification | Tests may be run by workers through the normal shell path, but the worker must not manufacture its own PASS. Verification belongs to `CMP-verifier`, bound to the tested revision/specification. | control-plane component, not a worker tool |
| Extensions/plugins | Keep plugins disabled by default, provenance-pinned, isolated, permission-filtered, and versioned. Prefer MCP/skill interoperability before executable in-process plugin loading. | proposed; no unrestricted native plugins |

### Target built-in capability set

This is the intended first-party product surface, not a statement about current source
registration. Keep the set small and route every invocation through the one registry,
guard, sandbox, audit, budget, and output store.

| Capability group | Target built-ins | Boundary |
|---|---|---|
| Repository | `read`, `list`, `glob`, `grep`, `search`, `symbol`, `references`, `diagnostics`, `git_status`, `git_diff`, `git_log` | Symbol operations use one revision-aware repository-intelligence service; mutations remain `edit`/`write`/`apply_patch`. |
| Change/execution | `write`, `edit`, `apply_patch`, `bash`, `test`, `todo`, `question` | `test` is a safe command-profile wrapper over governed process execution, not a bypass around shell policy. |
| Web | `websearch`, `webfetch` | Search and fetch are distinct; results carry URL, retrieval time, redirects, provider, and content digest. All egress uses the one mediated network boundary. |
| Agent/workflow | `task` (controller-owned delegation), `skill` (progressive instruction activation), `workflow` (validated saved workflow invocation) | A call returns a typed durable receipt; it does not self-verify or change permission. |
| Media | image input/attachment references and image metadata inspection | Treat media as bounded artifacts with declared MIME, size, digest, and model-route capability; no raw base64 in transcript/context. |
| Optional integrations | MCP tools/resources/prompts, plugins, and Code Mode | Catalogs are selected/lazy; each nested capability uses the same policy and resource ceilings. Code Mode is deferred until tool-roundtrip evaluation shows a measurable win. |

Do not add a second-purpose `fixer` tool, hidden browsing browser, local shell escape,
or overlapping semantic index. A built-in persona is a profile/role recipe using this
same set, not a second agent runtime (`ARCH/27`). A useful initial profile set is
**Architect/Planner** (read-only planning and task decomposition), **Implementer**
(bounded write scope), **Explorer** (read-only repository research), and **Reviewer**
(read-only evidence review). A focused test/debug profile can be offered as a preset,
but it must not get extra permissions by persona name. The scheduler chooses among
these based on task contract, capability, independence, cost, and available budget;
users can choose model/profile per role in `/subagents`.

### Web search/fetch caching and source history

Search provider selection belongs to `CMP-web`, not model-provider routing. The target
supports an OpenCode-like provider abstraction (provider-specific adapters and
capability/price evidence), but never assumes a provider is available or free. Search
returns source URLs and snippets; `webfetch` retrieves one explicit URL after redirect
and DNS/IP revalidation. Results are untrusted data. A fetch can be cited and cached
only after the final URL and content digest are recorded.

Keep two caches distinct:

1. A process-local bounded response cache for page bytes, with short configurable TTL,
   size cap, content digest, and no persistence by default. Do not cache credentialed,
   personalized, no-store, or otherwise private responses. Never serve stale bytes as
   current without an explicit stale label.
2. A local project-associated **source history** containing canonical URL, title,
   access time, source/provider, status, content digest, and optional run/task reference.
   It stores no fetched body and no raw search query by default. Strip credentials and
   sensitive query parameters before persistence; the user can disable, inspect, and
   purge it. Project identity is the canonical workspace ID, not the directory name.

This adopts the useful project-level “where did the agent read this?” affordance while
avoiding a persistent web-content mirror. A future content cache requires a separate
privacy, retention, disk-quota, license, and freshness decision. Provider quotas,
search charges, and cache hits/misses flow into `CMP-analytics` with actual/estimated/
unknown provenance.

Behavioral rules per tool:

- **Paths** — relative paths resolve within the active location; absolute paths
  inside it are accepted; an external absolute path is carried into the guard
  request as an `fs.*` resource, where the built-in external-directory floor rule
  produces the single `external_directory` ask (`DEC-024`, `REQ-SEC-025`). The
  tool plane never returns that decision itself.
- **Mutations** — `write`, `edit`, and `apply_patch` share one governed write
  path: re-read + hash + compare against the approved base, then write; a
  changed file returns a typed re-read/conflict result. `edit` rejects empty or
  identical `oldString`/`newString` and multiple matches without `replaceAll`.
- **`apply_patch`** — all targets are resolved and approved before contents are
  read; hunks apply sequentially and a later failure reports which earlier
  operations remain applied (no silent atomicity claim).
- **`bash`** — runs with host authority through the sandbox; the tool extracts
  path-shaped arguments as additional `fs.*` resources for the guard request; the
  scan may escalate, never de-escalate; it is not the control (`REQ-SEC-003`,
  `REQ-SEC-025`, `DEC-024`). The hard target control is spawn-time confinement —
  scoped roots plus the selected backend's tested read/write denial over the confined process tree.
  Timeout is bounded; output is captured up to a byte cap.
- **`question` / `skill` / `task`** — `question` gathers user decisions
  (unavailable headless, see below); `skill` injects instructions as data; `task`
  returns a receipt, never a raw transcript (`REQ-ORCH-001`).

### Structured agent questions

The current built-in `question` tool has a small callback contract with a header,
question text, string options, and one string answer per question. It is interactive
only; the current tool has no stable option IDs, cardinality rules, durable pending
request, answer receipt, or headless continuation. These source facts are recorded in
`ARCH/29`/AX-380. The following is the target contract, not current behavior.

```text
QuestionRequest = {
  request_id, origin: {run_id?, task_id?, attempt_id?, thread_id, turn_id,
                        tool_call_id?, requester_thread_id?},
  questions: [{question_id, header, prompt, selection: SINGLE | MULTIPLE | TEXT,
               options: [{option_id, label, description?}],
               min_selections?, max_selections?, allow_other_text, required}],
  created_seq, state: OPEN | ANSWERED | DELIVERING | DELIVERED |
         CANCELLED | EXPIRED | UNKNOWN,
  deadline?, capability_snapshot_id?
}
QuestionAnswer = {
  answer_id, request_id, delivery_id,
  responses: [{question_id, selected_option_ids[], free_text?}],
  payload_digest, answered_at, receipt_ref
}
```

The controller validates option IDs and selection cardinality, persists the answer
receipt, then resumes the exact waiting tool call using the same idempotency identity.
An identical retry returns the same receipt; changed payload conflicts. A pending
question survives client disconnect/restart. It suspends only the requesting call at
its tool boundary; unrelated Tasks can continue when scheduler policy permits. On a
child question, preserve requester Thread and exact parent/run route. Peer adapters
may issue questions only when the capability is negotiated and the method is actually
observable; otherwise report `UNSUPPORTED`/`UNKNOWN` without inventing a local answer
surface. Headless execution returns `NEEDS_INPUT` plus the stable request reference;
it never guesses an answer, including under `--yes`.

Answers are untrusted user content. They cannot grant effect authority, approve a
goal, change policy, or pass a task. The question card is visually and behaviorally
distinct from a permission request and goal-start confirmation (`ARCH/06`, `ARCH/25`).
Bound request size/count, pending-request count, answer bytes, and concurrent waiters;
reserve cancel/control capacity so a blocked question cannot make stop or permission
replies unresponsive.

## MCP-bridged tools

`REQ-PROTO-003`. The MCP host registers remote tools into the same registry as a
scoped batch. Their names are namespaced, their schemas are mirrored from the
server, and their permission action is derived from the server + tool identity so
policy can allow/ask/deny them independently. Per-MCP-connection deduplication means a
server connected twice contributes one definition. A vanished server's scope
finalizer removes its tools; in-flight calls fail typed (`Unknown tool`).

## Permission assertion before execution

Every `execute` calls the guard *before* touching any effect:

```
assert({ action, resources, save?, metadata?, sessionID, agent, source })
```

The tool's re-assertion immediately before its effect **consumes** the authorization
the registry's decision issued; it is not a second decision and is never recorded as
one. The identity it consumes against is the turn plus the call id, and a request
that names no resource is a whole-action request whose grant is the wildcard grant the
guard evaluated (`ARCH/12` §Tickets).

- A deny is returned to the model as a typed failure; the effect never runs.
- **Resource extraction, not decision.** A `bash` request carries the
  **command-token-prefix** resource for `exec.run` **and** any extracted
  path-shaped arguments as `fs.*` resources, in one request. `CMP-guard` owns the
  combined decision: exactly one allow/ask/deny over the whole resource set, using
  the one path matcher shared with the sandbox deny globs. An extracted path may
  only *raise* the outcome — it can escalate to `ask` or `deny` and can never lower
  a decision, and the tool plane may not return a path decision at all
  (`DEC-024`, `DEC-025`, `REQ-SEC-025`). A path-shaped `exec.run` resource is a
  configuration error and never reaches this call.
- "Always allow" persists the exact `save` pattern (or `*` where the tool has no
  meaningful pattern), shown to the user before confirmation (`REQ-GUARD-003`).
- `metadata` carries the non-secret context the approval UI needs (root, limit,
  include, provider), never credentials (`REQ-PROV-004`).
- The `source` records the tool call id so approvals and audit entries tie back
  to the exact call.

No tool may bypass this path; the guard/sandbox/audit sequence is universal
(`DEC-005`).

## Output bounding and managed output

Model-visible content is bounded so one tool cannot exhaust the window
(`REQ-CTX-004` interaction):

- If the textual content fits `max_lines` (default 2000) and `max_bytes`
  (default 51200), it is passed through unchanged.
- Otherwise the full content is written to a managed `tool-output` file and the
  model receives a head/marker/tail preview citing the saved path; the path is
  returned in `outputPaths` for the UI.
- Media is bounded before context assembly by provider- and format-aware byte, pixel,
  frame, and item caps. Oversized media is rejected or deterministically resized /
  sampled when that transformation is supported; the durable artifact and digest stay
  available through a managed reference. A preview or pointer MUST NOT be represented
  as the full original media, and transformations are recorded in the request receipt.
- Structured output is retained even when text is previewed.
- `CMP-artifact` owns managed-output retention, pin/release, and garbage collection
  (`ARCH/28`); `CMP-tools` emits bounded owner references and never deletes artifact
  bytes itself. Checkpoint creation pins every reachable required output; rewind keeps
  any object still referenced by another retained generation or evidence record.
- Managed files use the configured retention (default target: 7 days) only after
  all owner pins are released. Active attempts, unresolved effects, pending
  verification, and evidence artifacts hold explicit pins; TTL alone cannot
  remove bytes needed for recovery or a verifier. Once retention expires, an
  unavailable artifact makes dependent verification `INSUFFICIENT_EVIDENCE`, not
  a silent lookup miss. `CMP-artifact` owns pin/release/GC policy (`ARCH/28`).
- Transport-specific caps apply before bounding: shell capture, fetch body,
  search body, and page reads each have their own byte ceiling; binary files and
  oversized files are handled by an explicit read-only/refusal path.

## Parallel-safe vs exclusive

`REQ-LOOP-003`. Each tool declares `supports_parallel`:

- **Parallel-safe** (read-only tools: `read`, `glob`, `grep`, `webfetch`,
  `websearch`) take a shared read lock; independent calls run concurrently.
- **Exclusive** (mutating/session tools: `write`, `edit`, `apply_patch`, `bash`,
  `todowrite`, `task`) take an exclusive write lock, serializing against every
  other tool call.
- **Ordering barriers** are declared by the step/loop, not inferred by the
  registry. The registry only exposes the declaration; `CMP-runner`'s scheduler
  partitions calls into parallel-safe groups separated by barriers.

The declaration is fixed per tool definition; it cannot be overridden per call.

### Tool-call order and replay

Every fully admitted provider response assigns each call a stable `call_ordinal` in
the order it appeared in that response, alongside its unique call ID. Safe calls may
execute concurrently, and durable completion events record their actual completion
times/order; however, the next model-visible conversation projection emits each
call/result pair in `call_ordinal` order, with typed failure/cancellation results in
the original slot. Do not infer call order from completion time or reorder canonical
event history. A crash may therefore replay the same ordered projection from durable
call IDs and receipts without re-running a settled effect. Reused IDs are rejected
before any call in the malformed response is dispatched (`ARCH/25` ToolBatch).

`todowrite` is a typed, bounded progress update for the current attempt, not a
filesystem or general session-store write. `CMP-runner` validates and appends the
attempt-local progress event; workers cannot write canonical session/run events,
change task/evidence states, approve requirements, or mint verification evidence
through this tool. Its projection is recoverable from the event and never becomes the
completion source of truth.

## Step / loop guards

The step loop runs a bounded number of model steps (`REQ-LOOP-001`). When the
bound is reached, the loop injects a final, tools-disabled instruction: the model
MUST answer with text only, summarizing work and remaining tasks. Any tool call
after that point is refused. This is the loop guard; the registry still validates
every call it receives, so a stale or late call cannot re-enable tools.

Cancellation/interruption (`REQ-LOOP-005`) aborts in-flight dispatch; an aborted
tool produces a typed aborted result rather than a fabricated success, and the
partial work remains inspectable.

## Model output vs UI detail (split results)

`REQ-TOOL-004`. One execution yields two projections:

- **Model-facing** — the bounded `Content[]` from `toModelOutput` plus the
  structured value. Terse: success line, preview, relative paths.
- **UI/record-facing** — the full settled output: complete diffs/patches,
  absolute resources, `outputPaths` to managed files, timing, and the permission
  decision source.

The model never receives UI-only detail (raw patches, full logs, telemetry);
the UI never depends on the model's truncated view. The split is produced at
settlement, so both projections are derived from one execution.

## Headless question delivery

`REQ-PROTO-005`. **Current source status at `23d4ce8`:** `question` is registered only
when `BuiltinOptions::interactive` is true; headless `QuestionTool` returns
`Unavailable` and there is no durable `NEEDS_INPUT` broker. This is an implementation
gap recorded by `AX-380`, not the target contract.

**Target behavior (`REQ-UI-021`, `REQ-ORCH-010`).** If a durable question broker is
available, headless mode exposes `question` as a suspending capability. It returns a
stable `NEEDS_INPUT` receipt, persists the request, and exits or waits according to the
headless invocation mode; an authorized operator can answer by request ID and resume.
If the broker is unavailable, omit the capability and pause/report a typed
`QUESTION_UNSUPPORTED`; do not prompt stdin, invent an answer, or tell the model to
continue as if the clarification were optional. `--yes` never answers a question.

Other effectful tools needing human permission remain governed separately:
- Permission prompts use the run's explicit headless policy and never block on stdin.
  The default is deny for effectful actions requiring an interactive decision; only
  actions already eligible under an explicitly configured, run-scoped approval policy
  may proceed. No headless `allow all` fallback exists. Under ACP, permission requests
  are forwarded to the client when supported and the returned decision is honored;
  unavailable, timed-out, or malformed replies fail closed.
- `task`/subagent and background jobs are bounded by configuration; headless
  runs surface receipts through structured stdout/JSON rather than a UI panel.
- Agent-message tools are materialized only in an enabled managed Run when the
  profile and current guard policy permit them. The runner supplies `runID`,
  `taskID`, and `attemptID` from authenticated execution context; model arguments
  cannot choose the sender, widen recipient membership, or forge principal identity.
  Message body is untrusted, size-bounded, and never sent to a provider until the
  recipient Thread's safe-boundary promotion (`ARCH/32`).

## Data / state model

- **`ToolDefinition`** — `{ name, description, input_schema, output_schema?,
  supports_parallel, permission_action }`; `input_schema`/`output_schema` are
  generated, not hand-written.
- **`Materialization`** — `{ definitions, settle }`. `definitions` is the
  model's advertised set; `settle` is bound to the identities advertised here.
- **`Settlement`** — `{ result, output?, outputPaths? }`, where `result` is the
  encoded model result (success or typed error) and `output` is the full
  UI-facing value.
- **`ToolFailure`** — `{ message }`; the only failure shape crossing into model
  output (failures are never raw internal errors).
- **Managed output file** — `tool-output/<ascending-id>`, retention-pruned.

## Lifecycle & flows

```
register (validate names, scope-bound)
  → materialize(permissions) (filter wholly-denied, freeze identities)
  → model emits a call
  → settle(call)
      → reject stale/unknown name
      → decode input
      → guard assert (command-prefix + extracted fs.* resources)
      → sandboxed execute
      → encode output / structured
      → bound content (spill if over budget)
      → split model content from UI output
  → record tool/result event (model content + outputPaths)
```

## Failure modes

| Failure | Behavior |
|---|---|
| Invalid tool name / unknown-stale call | Registration rejected; a stale/unknown call gets a typed result and is never routed. |
| Invalid input / output mismatch | Typed `Invalid tool input` (execute never entered) or `Tool returned an invalid value…` (effect already recorded). |
| Guard deny | Typed failure; the effect never runs; approval/audit recorded. |
| External path | The path travels as an extracted `fs.*` resource and the guard's external-directory floor rule decides: deny-glob or protected-subpath match → `deny`; outside the granted roots and not explicitly allowed → `ask` (external-directory); a tier that cannot confine the reach → the effect is **refused**, not run unconfined. The tool plane never decides any of these (`DEC-024`, `REQ-SEC-025`). |
| Concurrent mutation | Exclusive lock serializes; a dirty/conflicted base returns a typed re-read result. |
| Oversized output | Managed spill; model gets a head/tail preview + path. |
| Interrupted mid-execution | Typed aborted result; partial work inspectable; no fabricated success. |
| Max steps reached | Tools disabled; text-only summary enforced. |
| MCP server disappears | Scope finalizer removes tools; in-flight calls fail typed. |

## Configuration

| Key | Meaning | Default |
|---|---|---|
| `tool_output.max_lines` | model-visible line bound | `2000` |
| `tool_output.max_bytes` | model-visible byte bound | `51200` |
| `tool_output.retention_days` | managed-file retention | `7` |
| `tool.bash.default_timeout_ms` / `max_timeout_ms` | shell timeout default / ceiling | `120000` / `600000` |
| `tool.fetch.max_bytes` / `tool.search.max_bytes` | fetch / search body ceilings | `5242880` / `262144` |
| `tool.max_steps` | per-turn model step bound | design default (see open questions) |

Headless posture is configured under the guard's policy, not here; the tool plane
only reflects the resulting advertised set.

## Requirements mapping

| Requirement | Where satisfied |
|---|---|
| `REQ-TOOL-001` | Built-in set including read/write/edit/apply-patch/glob/grep/shell/todo/question/webfetch/websearch; managed-run agent messaging is gated by `REQ-HORIZON-031`. |
| `REQ-TOOL-002` | `Tool.make` typed input + output + optional structured schema. |
| `REQ-TOOL-003` | Permission-filtered materialization removes wholly-denied tools. |
| `REQ-TOOL-004` | Settlement splits model content from UI detail. |
| `REQ-TOOL-005` | Name validation `^[A-Za-z][A-Za-z0-9_-]{0,63}$`. |
| `REQ-LOOP-003` | Parallel-safe vs exclusive declarations + scheduler barriers. |
| `REQ-LOOP-005` | Aborted calls yield typed partial results. |
| `REQ-GUARD-001..004` | Guard asserted per call; fail closed; remembered patterns. |
| `REQ-PROTO-003` | MCP-bridged registration with per-server-connection tool dedupe; protocol sessions are not HorizonCode Thread IDs. |
| `REQ-PROTO-005` | Headless/ACP behavior with no surface-owned loop logic. |
| `REQ-SEC-002/003` | Tool output is untrusted. Targets are validated before use, but the ownership is split: `CMP-guard` authorizes (allow/ask/deny) and `CMP-sandbox` enforces reach — the tool plane only extracts resources and may raise, never lower, a decision. |
| `REQ-SEC-025` | Path-shaped shell arguments are extracted into `fs.*` resources on one guard request alongside the command-prefix resource; deny-glob → `deny`, outside-root → `ask`, unconfineable tier → refuse, all decided by the guard (`DEC-024`, `DEC-025`). |
| `REQ-HORIZON-031` | Agent-message tools use controller-authenticated run/attempt identity, explicit same-Run recipients, guarded bounded posting, and safe-boundary Session inbox promotion (`ARCH/32`). |

## Open questions

1. **`tool.max_steps` default** and whether it is per-turn, per-task, or
   per-agent; and whether the limit scales with budget.
2. **Parallel-safe classification of `task`.** Whether sub-agent spawn is
   parallel-safe (independent worktrees) or always exclusive (shared session).
3. **Managed-output retention ownership — resolved.** `CMP-artifact` owns pins,
   release, and GC; checkpoints/evidence retain every reachable required output.
   See `ARCH/28` and the invariant above.
4. **MCP permission-action derivation.** The exact scheme that maps a server+tool
   identity to an allow/ask/deny rule without leaking server specifics into the
   model-visible name.
5. **Structured-output adoption for read/glob/grep.** Which tools benefit from a
   stable structured projection (for UI and eval) versus text only.
6. **Headless question delivery — resolved target.** Use durable `NEEDS_INPUT` when
   the question broker is available; otherwise omit the tool and pause with typed
   `QUESTION_UNSUPPORTED`. Do not synthesize an answer or ask the model to continue.
   Current code remains interactive-only; see the source-status block and AX-380.
