---
contract: canonical
owner: CMP-control-api
---
# Interactions

## Purpose and ownership

Define user input, draft, queue and navigation behavior across CLI, TUI and authenticated clients. CMP-tui owns presentation; CMP-session owns Thread input and drafts; CMP-orch owns managed steering, queue transitions and Runs; CMP-config owns settings; CMP-artifact owns bytes; CMP-memory owns learned records. ControlService dispatches typed actions to those owners. Rendering creates no domain authority. Shared identities and state vocabulary are defined in [Domain model](../04-DOMAIN-MODEL.md), [Ownership](../contracts/OWNERSHIP.md) and [State machines](../contracts/STATE-MACHINES.md).

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
One persistent runtime reuses service handles until explicitly closed. Background work is bounded and owned; startup never implicitly enables a remote listener or detached daemon.

Deterministic commands, completion, exact file lookup and explicit symbol queries use
local bounded services without a model call. Text matching is not semantic references;
label fallback results. Free-form requests retain normal reasoning and intent checks.
Prefetch reads need scope authorization, cancellation and a byte/time ceiling.

## Actions and receipts

Every button, menu, shortcut, palette entry and slash command resolves the same ActionDescriptor from [Actions](../contracts/ACTIONS.md). Navigation changes UI state only. A mutation declares authenticated principal, target, delivery ID, expected revision and applicable policy binding. Unknown or malformed commands return an error; they never become model prompts. A response timeout is uncertain, not failure evidence: query operation status with the same identity and disable duplicate mutation while keeping Cancel/Status reachable. Stale responses cannot replace newer state.

Opening a card, selecting a suggestion, hiding a pane, muting a notification or dismissing an overlay never approves, rejects, completes, cancels or resumes work. Escape dismisses without answering and restores opener focus. Pending cards remain in Needs You. Goal confirmation, permission reply, question answer, message post and ordinary steering are different typed actions. Model or peer text cannot fabricate operator consent.

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
conflicting workspace edits. Worker context fork is separately specified in [Workers](../execution/WORKERS.md).

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

## Artifact actions

[Artifacts](ARTIFACTS.md) owns ArtifactDescriptorV1, immutable versions, ArtifactFeedbackV1 and RendererCapabilityV1. `/artifacts [list|show <ref>|search <query>]` opens a pageable authorized picker. Preview reads a bounded supported renderer; Attach inserts a scoped reference into a draft; Open invokes a guarded external viewer; Copy reference reports actual clipboard outcome; Export invokes a guarded destination write. Enter previews and never auto-attaches. Generation never auto-publishes. Feedback is version-bound untrusted input and cannot approve a patch or create evidence.

`/artifact-capabilities` supplies the selected renderer/model/integration availability snapshot and limitations through the normal bundled skill path. `/artifact-diagramming` supplies concise diagram-choice/label/theme/text-alternative/export guidance. Neither installs or grants capability. Markdown/Mermaid authoring is portable; optional SVG decoding remains bounded and inert.

## Settings contract

InteractionSettingsV1 is the CMP-config-owned settings schema referenced by [Config](../core/CONFIG.md). It defines appearance theme/accent/color depth/density/syntax/diff style; motion off/reduced/subtle; composer folding/thresholds/image preview/autosave/submit binding; streaming tail/details/highlighting; bounded background/cache/concurrency preferences; and explicit extension manager native/litepsm. Numerical defaults and caps are defined once in [Performance](../contracts/PERFORMANCE.md) and config validation. Appearance preview changes no Run authority. Disable, reload and mode changes affect future generations; previously supplied provider context and settled effects cannot be erased retroactively.

## Coding interactions

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
shell interpolation are rejected. Workflow semantics stay with [Long-horizon control](../execution/LONG-HORIZON.md).

Copy response/code block, raw transcript, config source inspection, process inspection
and reload skills/plugins all share the action catalog. Raw means committed displayable
content, not hidden reasoning/secrets. Reload builds a new future generation without
changing in-flight attempts. Unsupported formats/actions remain visibly unavailable.

## Normal product journeys

| Journey | Default surface and available actions | Authoritative result |
|---|---|---|
| First use | Composer, recent history, concise guidance; provider setup only when needed | Typing preserves draft; Send admits once; setup cancellation returns to draft |
| Direct coding | Objective, activity, changed files/check summary; Interrupt, View changes, Details | Interrupt targets this turn; reconciliation precedes terminal outcome |
| Managed work | Outcomes/tasks and Needs You; inspect, pause/resume, cancel exact target, Stop now | Owner transition and receipt; resume never repeats the previous prompt |
| Permission/question | Cause/requester/affected work; Review/Answer with exact scope | Distinct owner reply schema and durable receipt |
| Conflict/recovery | Affected bytes/work, known and unknown effects; inspect safe choices | Preserve user edits; restore cannot undo external effects |
| Offline/stale | Last confirmed state and retained draft; reconnect/status | Snapshot/replay revalidation before mutation |
| End of work | Changes, checks, limitations and next action; diff/proof | Turn end is distinct from independently verified Task PASS |
| Empty/unavailable | Complete no-match or explicit coverage/capability reason | No silent no-op or fabricated result |

## Goal preparation and activation

Goal Set records exact user request and selected workspace/base without inventing requirements. Prepare presents a read-only planner route and finite cost/time/token allowance; planning cannot edit or launch coding workers. Review leads with outcome, scope, assumptions/questions, permission consequences, spend/time limits and expected checks. Exact spec/graph/plan/policy/route/capability/workspace/budget bindings remain inspectable. Start is disabled for unresolved blockers or stale bindings.

Opening review issues a durable expiring challenge bound to the authenticated control connection. New review invalidates the previous challenge. Start requires explicit operator confirmation; models, tools, plugins, peers and recovery principals cannot synthesize it. Confirmation precedes durable atomic execution/verification/recovery reservations; activation commits before outbox dispatch. Denial, expiry, stale reply, disconnection or reservation failure leaves work undispatched with a reason. Escape dismisses only. ACP clients can confirm only through an explicitly trusted authenticated operator integration; unsupported clients direct the user to trusted local controls. [Long-horizon control](../execution/LONG-HORIZON.md) owns activation.

## Editor and patch interactions

Normal edits use [UI's native editor bridge](UI.md). Small quick patches stage immutable base/current/proposed bytes and use Preview then guarded Apply. Editing, review, restore and proposal rejection have distinct receipts. A detached editor's operator-edit acknowledgement is not proof of process exit or unsaved-buffer stability; recheck digests at the actual write boundary. Never release workspace fences while an effect is unknown. Notebook execution and feedback upload are independently authorized effects.

## Failure and recovery

| Condition | Required behavior |
|---|---|
| Paste operation completes after Remove | Generation/part fence rejects late attachment; no draft resurrection |
| Send races with more typing | Clear only admitted revision; preserve newer draft |
| Send acknowledgement lost | Query durable receipt; same ID/digest is idempotent |
| Queue edit races with claim | Owner CAS decides; offer a fresh queued input after conflict |
| Branch workspace conflicts with active writer | Fence writes and reconcile; history creation never grants write access |
| Renderer or clipboard unavailable | Honest metadata/copy-file fallback; no pretend success |
| Required policy/instructions unavailable | Visible dispatch blocker; optional discovery cannot bypass it |
| Stream gap/replaced attempt | Show uncertainty and resnapshot; never concatenate retry fragments |
| User rejects a patch | Persist rejection; subsequent context cannot silently restore that proposal |
| Import malformed or over limits | Refuse safely; no partial trusted history or instruction execution |
| Settings change/reload during execution | Future generation only; no widening in-flight authority |
| Update waiting for safe boundary | Apply only after all Runs terminal and the maintenance fence is acquired |

## Acceptance

Test byte-accurate multiline/Unicode/CRLF paste; repeated chip labels; IME/bracketed-paste submission; removal races; media limits/capability failure; draft autosave/lease/send crash boundaries; CAS queue claim races; recap scope; branch authorization and workspace choices; recipe bounds; structured findings; notebook cell identity; import provenance; feedback preview; stable action identities; authenticated goal review; and no destructive behavior on dismiss/navigation. Shared [Acceptance matrix](../acceptance/ACCEPTANCE-MATRIX.md) binds cases to exact revision/environment.
