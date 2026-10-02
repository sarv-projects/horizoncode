# Tool Plane

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
- the argument/resource classifier consumed by the scheduler;
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
| `CMP-guard` | callee | `assert({ action, resources, save?, metadata?, threadID, agent, source })` before any effect |
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

ToolContext { threadID, runID?, taskID?, attemptID?, agent, assistantMessageID, toolCallID, turnCancellation }
Content = Text | ImageRef | AudioRef | FileRef
// Media parts reference bounded artifacts and require negotiated route capability.
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

Before a streamed response batch can dispatch, `CMP-runner` calls the registry's
pure `validate_input` preflight for every proposed call. The validator checks
the registered input schema without executing the tool. Its supported JSON
Schema subset is `type`, `properties`, `required`, boolean
`additionalProperties`, `items`, numeric `minimum`/`maximum`, and `enum`.
Descriptive metadata is ignored. Any unsupported keyword, malformed schema, or
invalid argument rejects the whole unstarted response batch; partial validation
is never reported as success. This is not full JSON Schema support: adding a
keyword requires implementing its semantics and regression coverage before
schemas may use it (`REQ-LOOP-008`).

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
  entries = validated application registrations + scoped registrations (reserved built-ins protected; collisions rejected or explicitly source-qualified)
  for each entry: action = decorator-permission ?? name;
      if whollyDisabled(action): remove        // scope-closed calls answer stale
return { definitions, settle }
```

- **`whollyDisabled`** — the composed Guard snapshot denies the entire action scope. A partial/pattern denial is *not* removal; it is enforced at
  call time by the guard (the tool stays advertised because it is usable for
  other resources).
- **Registration identity** — each materialization captures the registration
  identity it advertised. A call that arrives against a replaced/closed
  registration is answered with `Stale tool call: <name>`, never routed to a
  different implementation.
- **Scoped registration** — MCP servers and plugins register within a scope; the
  scope finalizer removes entries. Unstarted removed calls fail typed; started calls retain their original identity and must settle or reconcile UNKNOWN.

The advertised set is the model's tool list. `CMP-context` counts these
definitions into the token budget; the registry never sends them itself.

### Deferred tool discovery

Large MCP and other extension catalogs MUST keep full schemas out of the default
model request. `CMP-tools` owns one bounded searchable catalog containing exact
tool identity, source/server, short description, and schema digest. A model-facing
`tool_search` operation searches that metadata and returns bounded candidate
summaries; it never executes a candidate and never treats tool-provided text as
instructions. Search results use opaque registry IDs plus the display name and
provenance, so a guessed name cannot select a different implementation.

The bounded candidate IDs selected by search become the only schema-load candidates
for the next model step. `CMP-runner` asks this same registry to materialize those
schemas, applies the current permission filter and context budget, and pins
registration identity, schema digests, catalog generation, and the permission
snapshot for that model step. Calls outside the pinned set, unstarted removed/changed registrations and newly denied calls fail typed before execution. Started calls retain their pinned schema/identity until settled or reconciled. A refresh
can affect a later model step only; it cannot mutate the active step's advertised
contract. Search ranking is an implementation choice and MUST be evaluated on exact
identifier and natural-language queries before it is enabled by default; no particular
retrieval algorithm is required by this architecture (`REQ-CTX-010`, `SRC-032`).
This is deferred materialization inside the existing registry and guard path, not a
second tool registry or permission system. Search metadata and returned summaries are
untrusted bounded data; schema selection does not authorize execution.

## Command-shell profiles and process I/O

`exec.run` supports user-configured interpreter profiles rather than assuming one
shell. A profile names the executable, typed argv template, quoting/command-string
convention, environment allowlist, working-directory policy, platform, and default I/O
mode. Profiles may target PowerShell (`pwsh`/`powershell`), Bash, zsh, fish, cmd, or
another configured shell. The exact command text is passed as one profile-defined
argument without constructing a second shell command around it. Shell selection is a
user preference, not confinement; the same command resource extraction, Guard,
spawn-time sandbox, audit receipt, and output bounds apply to every profile.

Use pipe-based execution by default for noninteractive commands. Offer a PTY only
when the user or a reviewed tool profile explicitly requests interactive terminal
semantics. PTY mode streams terminal output and accepts bounded input, but may change
color/progress/buffering behavior and can expose interactive prompts; it is not a
security boundary. Both modes retain full bounded output in the managed-output store,
produce a concise status row, and support inspection of complete captured output.

Every child execution is tracked as a process tree. Cancellation sends a graceful
signal/request, then force-terminates after a configured deadline using the platform's
supported process-group/job mechanism. Do not promise POSIX `killpg` on Windows; use a
Windows job/console mechanism where available. Process/descriptor or handle budgets
must cap concurrent commands/workers and reserve capacity for the controller,
operator control, cleanup, and audit. If a descendant escapes supervision or its
effect cannot be reconciled, mark it unknown and fence conflicting follow-up work.

## Hook IPC contract

Hooks are optional extension effects dispatched through the existing registry and
`CMP-tools`/extension confinement. `/hooks` inspects registered definitions, source
digest, event, argv, environment, limits, trust state, and recent typed outcomes. A
project hook is not executable until the user trusts the exact reviewed source
digest; edits invalidate that trust.

The hook receives a bounded versioned JSON event on stdin and returns one typed JSON
decision on stdout; human diagnostics belong on stderr. Unknown fields, extra output,
invalid JSON, timeout, oversized output, or nonzero exit become a typed failure. Hook
environment is constructed from an allowlist; inherited `HORIZONCODE_*`, credential,
control-socket, and approval variables are removed unless a specific nonsecret,
read-only field is explicitly defined by the contract. Hooks may observe, deny, or
make a policy decision stricter. They cannot convert deny to allow, mint a ticket,
rewrite audit facts, hide tool output, or create verifier evidence. Required hooks fail
closed; optional observers may fail open only for their non-authoritative annotation,
with failure visible and audited. A generic safety hook may impose bounded command
limits, but it is not a second path-policy or resource-authority evaluator.

## Patch relocation and stale-base handling

Patch application first validates the entire patch and all file digests before any
mutation. When a captured file base has shifted, the reconciler may locate a hunk by
its exact surrounding context only if that context occurs uniquely in the exact
captured base/current-file comparison. It must not apply a hunk from approximate line
numbers alone or use a fixed search radius as proof. Unique, non-overlapping hunks may
be rebased through the guarded three-way merge in `ARCH/product/UI.md`; ambiguous or overlapping
matches return typed stale/conflict details for review. Stage validated content and compare-and-swap every final write against the current raw digest. Preflight all files before publication, but report/reconcile per-file receipts if publication is partial; no atomic multi-file filesystem transaction is claimed.

## Built-in capabilities

### Capability groups

This is the first-party capability surface. Keep the set small and route every invocation through the one registry,
guard, sandbox, audit, budget, and output store.

| Capability group | Target built-ins | Boundary |
|---|---|---|
| Repository | `repo_query`, `repo_context`, `repo_impact`, `repo_expand`; raw `read`, `list`, `glob`, `grep`; `git_status`, `git_diff`, `git_log` | Coarse queries call the single repository-intelligence owner. Definitions, references, symbols and diagnostics remain internal provider primitives and UI operations; mutations use `edit`/`write`/`apply_patch`. |
| Change/execution | `write`, `edit`, `apply_patch`, `bash`, `test`, `todo`, `question` | `test` is a safe command-profile wrapper over governed process execution, not a bypass around shell policy. |
| Web | `websearch`, `webfetch` | Search and fetch are distinct; results carry URL, retrieval time, redirects, provider, and content digest. All egress uses the one mediated network boundary. |
| Agent/workflow | `task` (controller-owned delegation), `skill` (progressive instruction activation), `workflow` (validated saved workflow invocation) | A call returns a typed durable receipt; it does not self-verify or change permission. |
| Media | image input/attachment references and image metadata inspection | Treat media as bounded artifacts with declared MIME, size, digest, and model-route capability; no raw base64 in transcript/context. |
| Optional integrations | MCP tools/resources/prompts, plugins, and Code Mode | Catalogs are selected/lazy; each nested capability uses the same policy and resource ceilings. Code Mode is enabled only for a supported isolated runtime under the same nested-call controls. |

### Repository intelligence tools

These four tools batch useful repository work without another index, LSP manager or
permission evaluator (`REQ-REPO-008`). `CMP-tools` owns their schemas/materialization;
`CMP-repo-intel` executes retrieval, and `CMP-context` budgets the resulting projection.

| Tool | Input and result contract |
|---|---|
| `repo_query` | A bounded ordered list of typed questions: exact text/path/symbol, definition, references, diagnostics, dependency neighborhood or conceptual retrieval. Returns one result per question with source method, coverage and limitations; a failed question is never an empty successful answer. |
| `repo_context` | Bounded hints plus a controller-approved task or direct-turn intent reference, permitted scope and byte/token/result limits. Builds the bounded `RepoBriefV1`/`TaskPackageV1` projection defined in [Context](CONTEXT.md#repository-task-projections), preserving exclusions and explicit omissions. |
| `repo_impact` | Exact changeset/base/current revision references and bounded expansion limits. Returns advisory callers/interfaces/configs/tests and unresolved edges. It cannot establish required verification or authorize writes. |
| `repo_expand` | An opaque retrieval handle, requested detail level and limits. Resolves only within the originating workspace, source view, policy and pinned generation; stale/expired handles return refresh/unavailable status, never silently resolve into another revision. |

Every request includes a controller-supplied workspace binding, expected source/index
generation, cancellation and deadline. Model arguments cannot select another actor,
permission snapshot or unauthorized root. Finite limits cover question count, search
work, result count, encoded bytes, range bytes and expansion depth; resolved configuration
provides exact ceilings and the server enforces them before allocation. Results carry
workspace/revision/buffer identity, index generation, source ranges/digests, retrieval
method, freshness, coverage, limitations and optional continuation handles. Handles
are scoped references, never authority. Retrieval rechecks current read authorization,
including policy narrowing after indexing; cached content cannot bypass a denied read.

Raw file tools remain available for unsupported languages, unindexed/dirty paths and
direct source validation. A model need not issue a separate call for every internal
definition/reference lookup. Query planning chooses the cheapest sufficient permitted
source; vector retrieval is optional. Whole-response admission, question boundaries,
ordered observations and cancellation apply identically to these tools. Acceptance is
`ACC-REPO-TOOLS-01` alongside `ACC-REPO-01` and `ACC-TOOL-DISCOVERY-01`.

Do not add a second-purpose `fixer` tool, hidden browsing browser, local shell escape,
or overlapping semantic index. A built-in persona is a profile/role recipe using this
same set, not a second agent runtime (`ARCH/product/COMMANDS-AND-SETTINGS.md`). A useful initial profile set is
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
   purge it. Project identity is ProjectId; WorkspaceId identifies a mutable instance, not the directory name.

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
- **Mutations** — `write` and `edit` share the governed direct-write helper:
  re-read + hash + compare against the approved base, then write; a changed file
  returns a typed re-read/conflict result. `apply_patch` uses the separately
  specified all-file preflight and staged per-file publication below. `edit`
  rejects empty or identical `oldString`/`newString` and multiple matches
  without `replaceAll`.
- **`apply_patch`** — parse the whole request, resolve every target, authorize
  every raw path, and check confinement for every target before reading any file
  contents. Bound patch text to 4,194,304 bytes, lines to 131,072, processed
  target lines per update to 1,000,000, operations to 256, hunks to 4,096, each
  captured base file to 16,777,216 bytes, combined captured bases to 67,108,864
  bytes, and aggregate transformation/comparison work to 134,217,728 bytes;
  return a typed refusal beyond any cap before publication.
  Snapshot raw base bytes and simulate
  operations in request order in
  memory; every target type, existence rule, UTF-8 decode, and unique hunk match
  must validate before publication begins. Repeated operations on one resolved
  target retain their ordered meaning and publish only the final target state.
  Stage every changed replacement file in its target directory. On Unix, create
  staging files with owner-only permissions before writing replacement bytes,
  then apply the target's basic permission bits after the write. Revalidate all
  captured bases before the first publish,
  then revalidate each target immediately before its per-file rename/removal.
  Each file replacement is atomic only where the platform's rename primitive
  provides that property; the patch as a whole is not an atomic filesystem
  transaction. If a later publication fails after earlier files committed,
  return `TOOL_PARTIAL_EFFECT` with committed digests/removals, the failed path,
  and pending paths. Staging files are cleaned on ordinary error/cancellation;
  process death can leave staging files or a partially published patch and must
  be reconciled through the durable effect journal (`AX-311`). Replacing a file
  can change ownership, ACLs, extended attributes, or other metadata beyond the
  basic permission bits; platform acceptance must record that residual. A
  non-cooperating process can still race the final compare and publish boundary.
- **`bash`** — runs with host authority through the sandbox; the tool extracts
  path-shaped arguments as additional `fs.*` resources for the guard request; the
  scan may escalate, never de-escalate; it is not the control (`REQ-SEC-003`,
  `REQ-SEC-025`, `DEC-024`). The hard target control is spawn-time confinement —
  scoped roots plus the selected backend's tested read/write denial over the confined process tree.
  Timeout is bounded; output is captured up to a byte cap.
- **`question` / `skill` / `task`** — `question` gathers user decisions through the durable broker; `skill` injects instructions as data; `task`
  returns a receipt, never a raw transcript (`REQ-ORCH-001`).

### Structured agent questions

Questions have stable option IDs, explicit cardinality, durable pending state and idempotent answer receipts across interactive and headless surfaces.

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

**Question and tool batch arbitration (`REQ-TOOL-006`).** Validate the full bounded
provider response before any member can dispatch. If one valid `question` call shares
the batch with other tool calls, persist the batch as `SUSPENDED_FOR_INPUT`, dispatch
only the question request, and mark every sibling `SUPPRESSED_BY_QUESTION`; this
includes otherwise-safe reads, since their results could influence effects that should
wait for the user's clarification. After the durable answer receipt is committed,
settle siblings with typed `not_run_question_boundary` results and resume the model so
it can replan from the answer. The batch may contain only one question-tool call (that
call may contain several question items). A malformed question, more than one question
call, or any other malformed member rejects the whole unstarted batch and dispatches
zero calls. Record the provider response/usage and the suppression receipts. Do not
replay or infer sibling effects. An external ACP elicitation that arrives after calls
have begun first fences new dispatch and requests cancellation; in-flight effects are
reconciled individually and never assumed rolled back. This supplements, and does not
replace, normal per-effect authorization.

Answers are untrusted user content. They cannot grant effect authority, approve a
goal, change policy, or pass a task. The question card is visually and behaviorally
distinct from a permission request and goal-start confirmation (`ARCH/product/UI.md`, `ARCH/execution/LONG-HORIZON.md`).
Bound request size/count, pending-request count, answer bytes, and concurrent waiters;
reserve cancel/control capacity so a blocked question cannot make stop or permission
replies unresponsive.

## MCP-bridged tools

`REQ-PROTO-003`. The MCP host registers remote tools into the same registry as a
scoped batch. Their names are namespaced, their schemas are mirrored from the
server, and their permission action is derived from the server + tool identity so
policy can allow/ask/deny them independently. Per-MCP-connection deduplication means a
server connected twice contributes one definition. A vanished server removes future registrations. Unstarted calls reject; started calls preserve stable identity and receipts, then settle or reconcile UNKNOWN.

## Permission assertion before execution

Every `execute` calls the guard *before* touching any effect:

```
assert({ action, resources, save?, metadata?, threadID, agent, source })
```

The tool's pre-effect re-assertion **consumes** the authorization issued by CMP-guard; it is not a second decision and is never recorded as
one. The identity it consumes against is the turn plus the call id, and a request
that names no resource is a whole-action request whose grant is the wildcard grant the
guard evaluated (`ARCH/security/GUARD.md` §Tickets).

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

## Read-only repository traversal

`REQ-TOOL-011`. `glob` and `grep` check the resolved search root before traversal,
then check every directory before allowing the walk to descend and every matched
file before exposing its path or opening its contents. A confinement denial or an
unreadable traversal/read operation aborts the entire call; a partial result is
never returned as a successful search. The `.git` directory is pruned. `grep`
opens regular files only and shares `read`'s opened-handle metadata check and
16,777,216-byte raw-file ceiling, including the limit-plus-one growth check.
The entry filter is capped at 100,000 delivered entries. The combined contents
of local ignore files consulted by one search are capped at 16,777,216 bytes,
with a separate 1,048,576-byte cap per file. `grep` also caps aggregate file
input at 67,108,864 bytes. Aggregate search budgets return `TOOL_SEARCH_LIMIT`;
an individual ignore file over its per-file byte ceiling returns
`TOOL_OUTPUT_LIMIT`. Every limit failure discards accumulated hits. The
entry-filter budget does not bound entries the walker internally skips before
invoking the filter, so it is not a total filesystem-work, cancellation-latency,
or process-memory guarantee.

Search observes turn cancellation between entries delivered by the walker and
yields to the runtime every 64 delivered entries; `grep` also yields every 256
scanned lines. Cancellation may be delayed by one bounded file read or by the
walker internally skipping an unbounded number of ignored entries before
returning. Cancellation returns a typed `TOOL_ABORTED` failure with no partial
successful result.

Ignore-file behavior is explicit product behavior: `.ignore` and `.gitignore`
rules are applied within the selected search root; parent-directory, global Git,
and `.git/info/exclude` rules are not consulted. Hidden files remain searchable
unless excluded by an applicable ignore rule or an explicit `include` pattern.
`.ignore` rules take precedence over all `.gitignore` rules regardless of
directory depth; within each file type, rules in deeper directories take
precedence over parent rules. Negation follows ignore-file semantics. Ignore
files are checked against the resolved read-confinement profile
before the walker reads them, must be regular files, and are capped at 1 MiB each.
Ignore parsing and filesystem errors fail the search with a typed diagnostic.
`ACC-TOOL-SEARCH-01` covers nested rules,
negation, directory rules, precedence, hidden files, and selected-root isolation.

## Output bounding and managed output

Model-visible content is bounded so one tool cannot exhaust the window
(`REQ-CTX-004` interaction):

- If the textual content fits `max_lines` (default 2000) and `max_bytes`
  (default 51200), it is passed through unchanged.
- Otherwise the full content is committed to `CMP-artifact` before the owning
  canonical event is acknowledged, and the model receives a bounded head/marker/tail
  preview citing the immutable artifact reference and digest; the reference is
  returned in `outputPaths` for the UI. The preview is not the complete result and
  is not sufficient evidence by itself. The full bytes remain retrievable through
  the governed artifact read/grep path for the retention period while pinned.
- Media is bounded before context assembly by provider- and format-aware byte, pixel,
  frame, and item caps. Oversized media is rejected or deterministically resized /
  sampled when that transformation is supported; the durable artifact and digest stay
  available through a managed reference. A preview or pointer MUST NOT be represented
  as the full original media, and transformations are recorded in the request receipt.
- Structured output is retained even when text is previewed.
- `CMP-artifact` owns managed-output retention, pin/release, and garbage collection
  (`ARCH/product/ARTIFACTS.md`); `CMP-tools` emits bounded owner references and never deletes artifact
  bytes itself. Checkpoint creation pins every reachable required output; rewind keeps
  any object still referenced by another retained generation or evidence record.
- Compaction may remove an old completed tool result from the model-context
  projection only after its exact result is committed and referenced as above. It
  cannot clear the canonical Thread event, rewrite the transcript, delete artifact
  bytes, or clear open/unsettled output or evidence with an active pin. Expiry or a
  failed read produces typed `EXPIRED`/`UNAVAILABLE`; it never becomes an empty
  successful result (`REQ-CTX-006`, `ARCH/core/CONTEXT.md`, `ARCH/product/ARTIFACTS.md`).
- Managed files use the configured retention (default target: 7 days) only after
  all owner pins are released. Active attempts, unresolved effects, pending
  verification, and evidence artifacts hold explicit pins; TTL alone cannot
  remove bytes needed for recovery or a verifier. Once retention expires, an
  unavailable artifact makes dependent verification `INSUFFICIENT_EVIDENCE`, not
  a silent lookup miss. `CMP-artifact` owns pin/release/GC policy (`ARCH/product/ARTIFACTS.md`).
- Transport-specific caps apply before output bounding. The native `read` tool
  lists directories without opening them as file content and reads regular files
  only. Its raw file-byte ceiling is 16,777,216 bytes: the opened file handle's
  metadata is checked before content is read, and the reader consumes at most
  limit + 1 bytes to detect growth after that check. An oversized file fails with
  `TOOL_OUTPUT_LIMIT` carrying the observed/reported byte count and limit; it
  returns no partial file content as success. A file exactly at the limit is
  allowed. Non-regular targets fail with `TOOL_UNSUPPORTED_TARGET`; binary files
  are reported without content. The ceiling bounds bytes admitted by this reader,
  not process RSS, text-decoding/page allocations, or path races; filesystem reach
  remains enforced by the sandbox tier. Shell capture, fetch bodies, and search
  bodies have separate transport-specific ceilings.

## Parallel-safe vs exclusive

Scheduling is classified per invocation using arguments, dependencies, effect/resource scopes, workspace fences and current authority. No tool-name boolean grants concurrency. The bounded rolling pool, barriers and deterministic model-result order are defined in [Scheduling](../execution/SCHEDULING.md). Unknown resource scope is exclusive; conflicting mutations serialize. Independent fenced scopes may overlap. Waiting for input or a child releases locks needed by control/child operations.

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

`REQ-PROTO-005`. `REQ-UI-021`, `REQ-ORCH-010`. If a durable question broker is
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
  recipient Thread's safe-boundary promotion (`ARCH/product/AGENT-MESSAGING.md`).

## Data / state model

- **`ToolDefinition`** — `{ name, description, input_schema, output_schema?,
  resource_classifier_ref, permission_action, schema_epoch, definition_digest }`; `input_schema`/`output_schema` are
  generated, not hand-written.
- **`Materialization`** — `{ definitions, settle }`. `definitions` is the
  model's advertised set; `settle` is bound to the identities advertised here.
- **`Settlement`** — `{ result, output?, outputPaths? }`, where `result` is the
  encoded model result (success or typed error) and `output` is the full
  UI-facing value.
- **`ToolFailureV1`** — `{ code, phase, safe_message, effect_id?, execution_certainty: NOT_STARTED | SETTLED | UNKNOWN, retry_disposition: NEVER | REVALIDATE | RECONCILE, reconciliation_ref? }`. Internal errors and secrets are not model output. Post-effect failures retain receipts or UNKNOWN and cannot authorize a retry.
- **Managed output** — immutable ArtifactRef plus bounded preview and capture-limit/expiry metadata; retention, pins and GC are owned by CMP-artifact, never another file-cleanup store.

## Lifecycle & flows

```
register (validate names, scope-bound)
  → materialize(permissions) (filter wholly-denied, freeze identities)
  → model emits a call
  → settle(call)
      → reject stale/unknown name
      → decode input
      → guard assert (command-prefix + extracted fs.* resources)
      → budget reservation and sandbox preparation
      → durable effect-prepare and authorization consumption
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
| Concurrent mutation | Conflicting resource scopes serialize; independent fenced mutations may overlap; stale base returns a typed re-read result. |
| Oversized output | Managed spill; model gets a head/tail preview + path. |
| Interrupted mid-execution | Typed aborted result; partial work inspectable; no fabricated success. |
| Max steps reached | Tools disabled; text-only summary enforced. |
| MCP server disappears | Unstarted removed calls reject; already-started calls retain stable identities and must settle or reconcile UNKNOWN. |

## Configuration

| Key | Meaning | Default |
|---|---|---|
| `tool_output.max_lines` | model-visible line bound | `2000` |
| `tool_output.max_bytes` | model-visible byte bound | `51200` |
| `tool_output.retention_days` | managed-file retention | `7` |
| `tool.bash.default_timeout_ms` / `max_timeout_ms` | shell timeout default / ceiling | `120000` / `600000` |
| `tool.fetch.max_bytes` / `tool.search.max_bytes` | fetch / search body ceilings | `5242880` / `262144` |
| `loop.maxSteps` | native per-turn model step bound | finite config-owned ceiling |

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
| `REQ-TOOL-006` | Question calls form a tool-batch control boundary; valid mixed batches suspend without siblings, invalid/multiple calls dispatch nothing, and external elicitation fences/reconciles. |
| `REQ-TOOL-007` | Optional bounded history retrieval uses the shared CMP-session owner; only current Thread visible committed records, with stable references and untrusted-data framing. |
| `REQ-TOOL-010` | Native file reads enforce the 16,777,216-byte raw-file ceiling before content read and again while reading; non-regular targets fail typed, directories remain listings, and overflow cannot produce partial success. |
| `REQ-TOOL-011` | Recursive `glob`/`grep` enforce confinement at traversal roots, directories, and matched files; errors stop the call without partial success; grep uses the bounded regular-file reader; ignore rules are workspace-local and have an explicit acceptance matrix. |
| `REQ-LOOP-008` | `validate_input` preflights every tool argument against the supported schema subset before dispatch; unsupported constraints fail closed for the complete unstarted batch. |
| `REQ-LOOP-003` | Argument/resource-aware invocation classification, rolling pool and barriers. |
| `REQ-LOOP-005` | Aborted calls yield typed partial results. |
| `REQ-GUARD-001..004` | Guard asserted per call; fail closed; remembered patterns. |
| `REQ-PROTO-003` | MCP-bridged registration with per-server-connection tool dedupe; protocol sessions are not HorizonCode Thread IDs. |
| `REQ-PROTO-005` | Headless/ACP behavior with no surface-owned loop logic. |
| `REQ-SEC-002/003` | Tool output is untrusted. Targets are validated before use, but the ownership is split: `CMP-guard` authorizes (allow/ask/deny) and `CMP-sandbox` enforces reach — the tool plane only extracts resources and may raise, never lower, a decision. |
| `REQ-SEC-025` | Path-shaped shell arguments are extracted into `fs.*` resources on one guard request alongside the command-prefix resource; deny-glob → `deny`, outside-root → `ask`, unconfineable tier → refuse, all decided by the guard (`DEC-024`, `DEC-025`). |
| `REQ-HORIZON-031` | Agent-message tools use controller-authenticated run/attempt identity, explicit same-Run Thread recipients, guarded bounded posting, and safe-boundary Thread-inbox promotion (`ARCH/product/AGENT-MESSAGING.md`). |


## Effect and result integrity

Admission is model proposal → schema/registry/capability validation → Guard authorization → atomic budget reservation → sandbox preparation → durable effect preparation → authorization consumption and execution → settlement/audit → bounded artifact output → model/UI observation. Failed pre-effect stages prevent execution. Failed post-effect encoding/capture still preserves receipts or UNKNOWN; it never makes a retry safe by itself.

Every admitted call has an immutable call ID, schema identity and call_ordinal. Durable receipts record actual completion order; the next model projection emits original call_ordinal order without rewriting history or replaying settled effects. Unknown resource scope is exclusive, conflicting writes serialize with stable lock ordering, and waiting for child/input releases locks needed by those operations. A todo invocation submits bounded AttemptProgress only; it cannot commit canonical task/evidence state.

CapabilityPack is a finite versioned set of tool/skill/verifier references with individual source, compatibility, trust and enablement. It cannot install/enable members or grant authority. Generated Code Mode receives no ambient filesystem, network or credential access; every nested call uses the same registry, Guard, sandbox, effect journal, budget and bounded output path.
