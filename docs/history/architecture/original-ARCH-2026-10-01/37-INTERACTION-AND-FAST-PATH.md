# 37 — Artifacts, Composer, Settings and Responsive Execution

Status: **proposed**; DEC-092/093. No interactive implementation or performance
acceptance is implied. ARCH/06 owns presentation, ARCH/27 actions, ARCH/28 bytes,
ARCH/07 Thread events, ARCH/08 execution, ARCH/09 context, ARCH/30 distribution.
This document owns the shared cross-feature contracts below; it adds no state owner.

## HLD and critical path

```text
Keyboard / paste / mouse
  -> TUI bounded input queue -> ControlService -> owning service -> durable receipt
  <- derived viewport / stream <- cursor events / bounded previews

Turn admission -> required policy + instruction snapshot -> context epoch
              -> provider stream -> admitted tool batch -> existing scheduler

Background: optional MCP / skills / VCS / intelligence / catalog / syntax caches
```

The UI becomes usable after mandatory local policy/config validation, without waiting
for irrelevant optional servers, catalog network access, embeddings or full history.
An unresolved required instruction or policy blocks dispatch with a visible reason.
Optional discovery reports loading/unavailable separately; it never grants authority.
Capabilities become model-visible only at a safe step boundary with a new snapshot.
One persistent runtime reuses service handles until explicitly closed. No detached
daemon, remote listener or background task is created merely to speed up startup.

Deterministic commands, completion, exact file lookup and explicit symbol queries use
local bounded services without a model call. Text matching is not semantic references;
label fallback results. Free-form requests retain normal reasoning and intent checks.
Prefetch reads need scope authorization, cancellation and a byte/time ceiling.

## Artifact catalog and immutable versions

```text
ArtifactDescriptorV1 {
  schema_version: 1, artifact_ref: ArtifactRef, title, kind,
  source_owner_kind, source_owner_id, source_event_cursor,
  version_parent_ref?, workspace_revision?, evidence_refs[],
  availability: available|missing|corrupt|unsupported|over_limit|denied,
  renderer_id?, renderer_version?, text_alternative_ref?
}
ArtifactFeedbackV1 {
  schema_version: 1, feedback_id, principal, artifact_ref,
  anchor?: {kind: line|cell|region, coordinates, source_digest},
  body_ref, created_at, state: open|resolved|withdrawn, event_cursor
}
RendererCapabilityV1 {
  renderer_id, version, accepted_mime[], max_encoded_bytes,
  max_decoded_bytes, max_pixels?, max_nodes?, max_duration_ms,
  presentation: text|syntax|image|diagram|external_browser,
  availability, unavailable_reason?, policy_digest
}
```

All variable text/arrays are bounded by the config schema, with finite compiled
ceilings; oversized records refuse before append. Catalogs are owner-scoped rebuildable
indexes, not a new artifact namespace. A version is a new immutable object plus an
owner event; never overwrite the previous bytes. Feedback is committed to its Thread
or Run owner, always attached to an exact version; it is untrusted input and cannot
approve a patch, settle an effect or create verification evidence.

`/artifacts [list|show <ref>|search <query>]` opens one pageable picker filtered by
Thread/Run/Task/type/date. Actions: Preview, Attach, Open, Copy reference, Export.
Empty, loading, offline index, incomplete coverage, denied, stale and corrupt states
have explicit text and retry/rebuild where safe. Enter previews; Attach is an explicit
action preserving the composer. Escape returns focus and scroll. Browser Open and
Export use separate guarded effects. Copy confirms success or offers local file output
on unavailable clipboard. No auto-publish/upload or browser opening on generation.

Rich text/diff/report/diagram/image previews are the proposed successor to metadata-only
v1, conditional on a verified bounded renderer. Metadata remains the fallback. Active
HTML/SVG/script is never executed in the TUI. Diagram rasterization is constrained;
interactive HTML uses an explicitly opened isolated local browser artifact with no
network, connector, filesystem or download authority unless separately granted.
Unimplemented isolation makes that renderer unavailable. Proof views share the picker,
but verifier verdicts stay independent of preview, comments and byte digests.

`/artifact-capabilities` loads a bundled skill with a current renderer/model/integration
capability snapshot, its scope and limitations. It cannot install or grant capabilities.
`/artifact-diagramming` loads a bundled authoring skill: choose the smallest useful
diagram, label relationships, support light/dark palettes, include a text alternative,
and export source plus bounded preview. Portable Markdown/Mermaid is the initial
authoring format; SVG is optional renderer input. Skills use the existing registration,
collision handling and digest checks, not special dispatchers.

## Composer schema and exact content

```text
ComposerDraftV1 {
  schema_version: 1, draft_id, thread_id, draft_revision,
  parts: [TextPart|PastePart|AttachmentPart|ReferencePart],
  selection: {part_id, grapheme_start, grapheme_end}, updated_at
}
TextPart = {part_id, artifact_ref, encoding: utf8}
PastePart = {part_id, artifact_ref, display_folded, line_count, byte_count}
AttachmentPart = {part_id, artifact_ref, display_name, detected_mime,
                  admission_state, model_compatibility, text_alternative?}
ReferencePart = {part_id, reference_snapshot, intent: context|read_only|editable}
DraftCommitV1 = {delivery_id, draft_id, expected_revision, content_digest,
                admitted_parts[], context_epoch_id, policy_digest}
```

Each chip is keyed by part ID; display labels are never used to locate payloads.
Preserve original UTF-8 bytes, surrounding whitespace, CRLF and final newlines.
Display may normalize line endings with an explicit source-to-display map. Invalid
encoding has a typed refusal or explicit conversion review; never silently replace
bytes. User edits create a new object/version. Folding changes presentation only;
full expansion for the model still consumes context tokens. The token estimate includes
folded content and images. No raw base64 is shown or persisted as chat text.

Paste handling suppresses native insertion before awaiting clipboard/file work.
Stage once with an operation ID, show pending chip, then resolve or retain a retryable
failure. Bracketed paste, IME composition and terminal key repeats cannot submit or
execute slash/shell text accidentally. Empty clipboard does not submit an empty turn.
Expansion and copy use tracked part identity, including repeated identical labels.
Grapheme-aware navigation covers emoji, combining characters and CJK; byte caps remain
independent of character counts. Pasted paths are attachment candidates only after
explicit selection and authorized read; never implicit arbitrary file access.

Chip actions: Expand/Collapse, Edit text, Preview image, Remove, Copy original.
Focus is retained after async completion; removal before completion fences late results.
Images have byte/pixel/format caps and selected-model capability checks. Unsupported
clipboard platforms offer Attach file; unsupported model offers route selection or
removal, without silently changing model. A thumbnail never proves upload succeeded.
PDFs are conditional on route/decoder capability, not inferred from OpenCode support.

Drafts are durable owner records with leases over every referenced artifact. Autosave
is bounded/debounced with visible saved/unsaved status; acknowledgement follows durable
commit. Crash before save reports the last saved revision honestly. A draft survives
Thread switching, cancellation and failed send. Submission atomically admits one
delivery ID and exact revision before clearing only that revision from the composer;
typing during send creates a newer draft which remains. Retries with identical ID and
digest return the original receipt; different content conflicts. Startup reconciles
draft and admitted-input references before garbage collection.

## Queue, recap, branches and workflow skills

`/queue [list|show <delivery-id>|edit <delivery-id>|cancel <delivery-id>]` projects
existing input receipts. Edit is CAS against queue revision, permitted only while
unclaimed; replacement gets a new delivery ID and supersedes the old item atomically.
The controller wins any claim/edit race; the UI offers a new queued instruction after
conflict. Cancellation records a durable receipt, never erases history or rolls back a
consumed effect. Reorder is unavailable until a separate fairness contract exists.

`/recap` builds a bounded report from committed visible Thread/Task/Evidence records:
objective, changes, check outcomes, blockers and next action with source refs. It does
not compact or alter task truth. Deterministic recap is default; optional model prose
requires an explicit priced action and labels interpretation versus source facts.

`/branch [title]` creates a new Thread at a committed parent cursor, switching only
after creation receipt. `/fork [title]` creates without switching; it does not launch
work. Both require an explicit workspace choice: shared read-only until write lease,
or isolated WorkspaceProvider snapshot. Child history references are scope checked,
pinned/exportable, and never inherit approval tickets, pending effects or Run authority.
Pending queued inputs stay with their owner. Active tasks/effects must reconcile before
conflicting workspace edits. Worker context fork is a separate ARCH/16 concept.

Optional `simplify`, `deep-research`, diagramming and browser-verification skills are
versioned recipes over existing tools/worker profiles. They declare inputs, permitted
capabilities, budgets, cancellation and evidence needs. Browser screenshots/tests bind
to the exact served revision/environment. No skill auto-publishes changes or creates a
second scheduler. Missing prerequisites render unavailable with a concrete reason.

Skill inspection shows body/catalog/resource estimated token costs per tokenizer,
actual injection where observed, activation count and measurement scope. Disabling
visibility changes future snapshots; it cannot hide already supplied context or revoke
effects retroactively. Required instructions remain required. No effectiveness score
is inferred from invocation count.

## Settings, palette, highlighting and motion

`/settings` is HorizonCode's native surface. OpenCode's documented TUI configuration,
theme and keybind flows are inspiration; no upstream `/settings` implementation is
assumed. Categories: Appearance, Composer, Models, Context, Agents, Extensions,
Permissions, Notifications, Storage, Performance, Installation. Search uses labels
and effective keys. Show requested/effective value, scope/source, lock, apply boundary
and validation. Controls: Preview, Apply, Cancel, Restore defaults, Show source.
Preview is ephemeral; cancel restores the persisted settings, not an old stale value.
Writes use CAS and atomic persistence; external edits cause a conflict with rebase view.
Secret values use broker forms only. Managed limits cannot be widened.

```text
InteractionSettingsV1 {
  schema_version: 1,
  appearance: {theme: system|dark|light|high_contrast|custom,
               accent, color_depth: auto|truecolor|ansi256|ansi16|none,
               density: comfortable|compact, syntax_theme, diff_style},
  motion: {level: off|reduced|subtle, frame_cap, feedback_duration_ms},
  composer: {fold_paste, fold_bytes, fold_lines, image_previews,
             autosave_delay_ms, submit_binding},
  streaming: {follow_tail, show_tool_details, syntax_highlight,
              frame_coalesce_ms},
  performance: {background_jobs, tool_parallelism, cache_bytes},
  extensions: {manager: native|litepsm, adapter_profile_id?}
}
```

Finite numeric ceilings and defaults must be published in the config implementation
and acceptance fixture before release. Proposed initial interaction defaults: subtle
motion, 30 FPS active rendering cap, 80–140 ms selection feedback, 120–180 ms overlay
feedback; off/reduced shows final state immediately. Never animate permission expiry,
delay cancellation, or use animation as completion evidence. Stop timers when hidden,
idle, detached or replaying history. Replay/resume never replays arrival animations.
Input remains live during transitions and rapidly reversed actions cancel prior motion.
Terminal capability fallback uses immediate redraw rather than unsupported effects.

Semantic tokens cover background/surface/text/muted/border/focus/selection/accent/
success/warning/error/diff-added/diff-removed/syntax. Status always includes text/glyph.
Ship validated dark/light/high-contrast palettes, system inheritance and a preview grid
showing all statuses, diff and code. Unknown terminal colors report contrast unverified;
provide a controlled high-contrast fallback. Do not claim measured contrast from ANSI
indices alone. Theme parsing is bounded inert data, rejects cycles/escape sequences,
and never changes task meaning. Syntax workers parse only changed visible ranges;
unfinished streamed fences initially render plain text and remain selectable.

## Streaming, scheduler and cache contracts

Stream chunks carry attempt ID, monotonic sequence, channel and terminal marker.
Coalesce only repaint deltas, never canonical events, authorization or durable inputs.
Render dirty visible regions with bounded line/layout caches. Preserve selection and
user scroll position; follow tail only when opted in/already at bottom. Offer Jump to
latest and New output count. A missing event cursor triggers resnapshot; late chunks
from cancelled/replaced attempts cannot merge into a new response. Markdown parsing,
syntax highlighting and image decoding stay off the input/event dispatcher.

The scheduler uses a bounded rolling pool within explicitly independent call groups,
exclusive barriers, and model-order observation slots. Settle each effect durably as
it finishes; ordered model observations must not delay effect/audit receipts. Whole
response admission remains mandatory before any execution (REQ-LOOP-008). Snapshot
schemas/identity never widen midbatch. Recheck live revocations and runtime availability
before dispatch; a narrowed concurrency mode inserts a barrier. Unknown mode is
exclusive. Cancellation stops replenishment, cancels/drains started calls with finite
deadlines, and records skipped/cancelled/unknown separately; never fabricates successful
results. Guard/audit/storage failure fences effect dispatch rather than becoming a
routine recoverable tool error. Recoverable tool errors remain structured observations.

Cache keys bind workspace/revision/dirty digest, policy, config, schema generation,
route/tokenizer and source versions. Persistent caches are rebuildable and incomplete
entries are never current truth. Filesystem events coalesce invalidations; overflow
forces rescan with stale status. Optional startup jobs run in a bounded pool and cannot
starve input/cancel/approval. Stable prompts order reusable identity/instructions/tool
contracts and project rules before volatile runtime tail. Security-required content
is never relocated or omitted merely to improve cache hits. Provider in-history system
updates/incremental tools require explicit negotiated support and equivalence tests;
unsupported routes rebuild a fresh epoch. Preserve mandatory provider continuation
fields privately; never expose hidden reasoning through UI/export.

Code Mode is optional and evaluation-gated, not automatic for every multi-tool request.
Programs run in a bounded isolated runtime without ambient filesystem/network/process
access. Every nested call uses the same registry, Guard, budget, sandbox and effect
path; caps cover total nested calls, concurrency, output, memory, execution and wall
time. Outstanding calls reconcile on timeout/cancel; retry does not replay settled
effects. A warm prefix and fewer model calls are measured possibilities, not universal
provider cache or speed guarantees. Persistent PTYs retain supervised scoped process
state, recheck authority per command and cannot survive revocation as a bypass.

## Performance acceptance targets

Proposed targets on a named reference machine/terminal with local stub provider:
warm prompt usable p95 <=300 ms; input-to-visible feedback p95 <=50 ms; warm admission
to provider-dispatch excluding policy waits/fsync/provider/network p95 <=50 ms;
visible stream-lag p95 <=100 ms; cancel acknowledgement p95 <=100 ms. Record inclusive
durable-admission time separately so exclusions do not hide actual user latency.
Active frame work p95 <=8 ms at the proposed cap; idle UI has no periodic animation
wakeups. These are unverified targets requiring named fixtures and measured baselines.
Report cold/warm startup, replay, first-byte, model rounds, provider latency, tool
latency, rendering, queue wait, fsync, CPU/RSS and cache hit observations separately.
Measure 100k-message paged history, 10k-line paste, concurrent output and resize load;
do not claim startup speed by delaying mandatory safety validation.

Acceptance: ACC-UX-09..12 and ACC-PERF-01 in ARCH/23; delivery AX-401..406/408.
Source paths and distinctions are recorded in ARCH/29. No third-party implementation
is copied by this design.

## Additional coding interactions (proposed)

`/btw <question>` opens a bounded read-only side Thread linked to a committed parent
cursor, with its own spend ceiling. It cannot steer the parent or modify its workspace.
Attach answer explicitly creates an untrusted parent input receipt. Closing the side
view preserves the main draft; optional ephemeral retention is clearly disclosed.
`/context` shows the next epoch's selected files/instructions/skills/tools, source,
inclusion reason and estimated tokenizer cost. Exclude/include edits future selections
only, retains required policy/instructions, and never promises to remove prior provider
context. Read-only file intent narrows Guard; editable intent requests existing policy,
never grants it. Unsaved editor buffers are explicitly distinguished from on-disk bytes.

Proposal-only edits stage an immutable patch bound to workspace/base/dirty digests and
paths. Apply revalidates expected bytes, authority and overlap under a workspace fence;
Reject preserves a rejection event; Revise creates a new candidate. No preview renderer
applies patches. Structured findings use `{finding_id, artifact_ref, revision, path,
range, severity, explanation_ref, check_refs[], resolution}`; resolving a UI finding
does not mark tests passed. Notebook tools operate on stable cell IDs and document
revision, preserve metadata/outputs by explicit policy, validate structure and cap
cell/output bytes; execution is a separate authorized process effect.

Session import validates a versioned manifest, scope/path/byte limits and source
provenance, then creates a new Thread; never inherits permissions or executes imported
instructions automatically. Feedback bundles preview selectable redacted logs and
save locally; upload requires an explicit destination/effect. Prompt recipes are
bounded inert templates with named validated inputs; reserved command collisions and
shell interpolation are rejected. Workflow semantics stay in ARCH/25.

Copy response/code block, raw transcript, config source inspection, process inspection
and reload skills/plugins all share the action catalog. Raw means committed displayable
content, not hidden reasoning/secrets. Reload builds a new future generation without
changing in-flight attempts. Unsupported formats/actions remain visibly unavailable.
Delivery AX-409; acceptance ACC-UX-13. These are Horizon synthesis, not assertions that
every item in the supplied competitor inventory was independently source verified.

## AX-405 first implementation slice: offline skill inspection

The existing headless `/skills show <name>` reads and digest-validates the selected
body only for inspection; it neither injects content nor starts a session or executes
a skill. `/skills` listing remains metadata-only. The shared config owner returns
a content-free inspection record: body UTF-8 bytes and ceiling(bytes / 4) approximate
tokens. This fallback is labelled a heuristic, not a tokenizer measurement or upper
bound; Unicode and code can differ substantially. Catalog/resource token measurements,
activation counts and observed injection remain unknown until their owners supply
evidence. This slice does not traverse linked resources. Changed, missing, invalid
or symlinked skill files fail through the existing validated-read path.

Regression checks cover provider-free CLI output without body disclosure or session
creation, empty/Unicode bodies, digest drift, missing files and symlink replacement.
No new settings, permissions, persistence schema or dependencies are introduced.
