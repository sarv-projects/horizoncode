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
- MCP-bridged tool registration (mirrored definitions, deduped per session);
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

ToolContext { sessionID, agent, assistantMessageID, toolCallID }
Content = { type: "text", text } | { type: "file", data, mime, name? }
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

## Built-in tool set

| Tool | Input (summary) | Mutates | Permission action | Model output |
|---|---|---|---|---|
| `read` | `path`, `offset`, `limit` | no | `read` | text page, directory listing, or image content part |
| `write` | `path`, `content` | yes | `edit` | `Wrote/Created file successfully: <resource>` |
| `edit` | `path`, `oldString`, `newString`, `replaceAll?` | yes | `edit` | success line + bounded `-`/`+` diff preview |
| `apply_patch` | `patchText` (add/update/delete hunks) | yes | `edit` | sequential `A/M/D <resource>` lines |
| `glob` | `pattern`, `path?`, `limit?` | no | `glob` | newline-joined relative paths |
| `grep` | `pattern`, `path?`, `include?`, `limit?` | no | `grep` | per-file grouped line previews |
| `bash` / shell | `command`, `workdir?`, `timeout?` | yes | `bash` | captured output + exit/timeout line |
| `todowrite` | `todos[]` | controller-managed attempt-local progress | `todowrite` | validated progress snapshot |
| `webfetch` | `url`, `format?`, `timeout?` | no | `webfetch` | fetched text/markdown/html |
| `websearch` | `query`, `numResults?`, … | no | `websearch` | search result text |
| `question` | `questions[]` | no | `question` | answered labels (interactive only) |
| `skill` | `name` | no | `skill` | skill instructions + sampled file list |
| `task` / subagent | task + role/bounds | spawns | `task` | receipt (summary + metadata) |

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

## MCP-bridged tools

`REQ-PROTO-003`. The MCP host registers remote tools into the same registry as a
scoped batch. Their names are namespaced, their schemas are mirrored from the
server, and their permission action is derived from the server + tool identity so
policy can allow/ask/deny them independently. Per-session deduplication means a
server connected twice contributes one definition. A vanished server's scope
finalizer removes its tools; in-flight calls fail typed (`Unknown tool`).

## Permission assertion before execution

Every `execute` calls the guard *before* touching any effect:

```
assert({ action, resources, save?, metadata?, sessionID, agent, source })
```

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
- Managed files are pruned by retention (default 7 days).
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

## Headless restrictions

`REQ-PROTO-005`. Tools that block on a human are unavailable or degraded in
non-interactive mode:

- `question` is not advertised in headless runs; the model is instructed to
  proceed or fail explicitly rather than wait.
- Permission prompts use the run's explicit headless policy and never block on stdin.
  The default is deny for effectful actions requiring an interactive decision; only
  actions already eligible under an explicitly configured, run-scoped approval policy
  may proceed. No headless `allow all` fallback exists. Under ACP, permission requests
  are forwarded to the client when supported and the returned decision is honored;
  unavailable, timed-out, or malformed replies fail closed.
- `task`/subagent and background jobs are bounded by configuration; headless
  runs surface receipts through structured stdout/JSON rather than a UI panel.

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
| `REQ-TOOL-001` | Built-in set including read/write/edit/apply-patch/glob/grep/shell/todo/question/webfetch/websearch. |
| `REQ-TOOL-002` | `Tool.make` typed input + output + optional structured schema. |
| `REQ-TOOL-003` | Permission-filtered materialization removes wholly-denied tools. |
| `REQ-TOOL-004` | Settlement splits model content from UI detail. |
| `REQ-TOOL-005` | Name validation `^[A-Za-z][A-Za-z0-9_-]{0,63}$`. |
| `REQ-LOOP-003` | Parallel-safe vs exclusive declarations + scheduler barriers. |
| `REQ-LOOP-005` | Aborted calls yield typed partial results. |
| `REQ-GUARD-001..004` | Guard asserted per call; fail closed; remembered patterns. |
| `REQ-PROTO-003` | MCP-bridged registration with per-session dedupe. |
| `REQ-PROTO-005` | Headless/ACP behavior with no surface-owned loop logic. |
| `REQ-SEC-002/003` | Tool output is untrusted. Targets are validated before use, but the ownership is split: `CMP-guard` authorizes (allow/ask/deny) and `CMP-sandbox` enforces reach — the tool plane only extracts resources and may raise, never lower, a decision. |
| `REQ-SEC-025` | Path-shaped shell arguments are extracted into `fs.*` resources on one guard request alongside the command-prefix resource; deny-glob → `deny`, outside-root → `ask`, unconfineable tier → refuse, all decided by the guard (`DEC-024`, `DEC-025`). |

## Open questions

1. **`tool.max_steps` default** and whether it is per-turn, per-task, or
   per-agent; and whether the limit scales with budget.
2. **Parallel-safe classification of `task`.** Whether sub-agent spawn is
   parallel-safe (independent worktrees) or always exclusive (shared session).
3. **Managed-output retention and cleanup ownership.** Whether `CMP-tools`,
   `CMP-session`, or a background sweep owns pruning, and whether paths survive
   checkpoint/rewind.
4. **MCP permission-action derivation.** The exact scheme that maps a server+tool
   identity to an allow/ask/deny rule without leaking server specifics into the
   model-visible name.
5. **Structured-output adoption for read/glob/grep.** Which tools benefit from a
   stable structured projection (for UI and eval) versus text only.
6. **Headless `question` substitute.** Whether the model gets a synthetic
   guidance result or the tool is fully absent, and the effect on model behavior.
