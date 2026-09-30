# Final architecture audit — 2026-09-30

## Scope and evidence

Read every line of all **36 current ARCH Markdown files**, totaling **15,183 lines
before this pass’s edits**, in 89 bounded ranges. Truncated reads were reread before
being counted. ARCH/17 is intentionally unused. The
[coverage record](source-audit-coverage/architecture-final-2026-09-30.json) contains
input hashes, contiguous read ranges, and resulting file hashes/counts. It records
read coverage, not behavioral proof or a guarantee that no future defect can exist.

Repository HEAD: `42466aa410d50d5135195ba8823636a397524f95`; Rust baseline:
`80400370c7898459f7e7c24642caba9af31379d1`. This pass changed documentation only.
Pre-existing user changes and the dirty cline-probe submodule were preserved.
No product tests/builds, live-provider calls, commits, pushes or publications occurred.

## What the review found and changed

| Architecture owner | Findings and disposition |
|---|---|
| [00-INDEX](../ARCH/00-INDEX.md) | Authority, full coverage, proposed status and reconciliation precedence. |
| [01-VISION](../ARCH/01-VISION.md) | First use, direct coding, optional managed depth, human outcomes versus technical mechanics. |
| [02-REQUIREMENTS](../ARCH/02-REQUIREMENTS.md) | Pane guarantees, attention availability, recovery eligibility, enforceable budget/redaction claims; REQ-UI-033. |
| [03-ARCHITECTURE](../ARCH/03-ARCHITECTURE.md) | Directory/worker/controller ownership, host versus confinement, index versus context, Markdown versus WASM, platform evidence. |
| [04-DECISIONS](../ARCH/04-DECISIONS.md) | DEC-090/091; historical naming/reduced-approval/capacity claims kept within their original evidence scope. |
| [05-SOURCE-LEDGER](../ARCH/05-SOURCE-LEDGER.md) | System Git license versus library clearance; no blanket permissive-license claim or upstream copying. |
| [06-UI](../ARCH/06-UI.md) | Mode-aware focus, actual diff viewport, workspace manifests, task-list default, progressive details, Needs You, all journey states and action receipts. |
| [07-SESSION](../ARCH/07-SESSION.md) | One Thread creation event, slash vocabulary, model-attempt identity, epoch attestation, read-only listing, fork boundaries and explicit resumed binding. |
| [08-LOOP](../ARCH/08-LOOP.md) | Admission/task ownership, shared recovery eligibility, exact cancellation, effect reconciliation, server wait, native step setting. |
| [09-CONTEXT](../ARCH/09-CONTEXT.md) | Single intelligence owner, context/provider dependency, complete epoch, bounded deterministic brief, stale semantic fallback, repaired settings table. |
| [10-TOOLS](../ARCH/10-TOOLS.md) | Preflight versus partial publication, post-execution failures, typed tool failure, ProjectId, todo naming, collisions, artifact output and scoped locking. |
| [11-PROVIDER](../ARCH/11-PROVIDER.md) | Generic provider port, auth mechanism versus credential state, RFC Retry-After units/deadlines, controller retry ownership and resolved failover question. |
| [12-GUARD](../ARCH/12-GUARD.md) | Immutable grants versus consumption state, fail-closed policy parse, user-owned saved scopes, challenge selection versus ticket minting. |
| [13-SANDBOX](../ARCH/13-SANDBOX.md) | Single process launch seam, explicit runtime roots, environment identity/probes, no unsupported confinement or remote lease guarantees. |
| [14-AUDIT](../ARCH/14-AUDIT.md) | Execution/effect linkage, terminal append failure, filtered chain export proof/privacy, MAC versus public proof and sequence overflow. |
| [15-PROTOCOLS](../ARCH/15-PROTOCOLS.md) | ACP callback direction, internal Thread types, released MCP initialized lifecycle, terminal-frame limits, disabled authenticated IPC-only AG-UI. |
| [16-ORCH](../ARCH/16-ORCH.md) | Provider-qualified lifecycle and integration, one profile/worker registry, generated config bounds, restart-safe lease clocks and retained Run ownership. |
| [18-CONFIG](../ARCH/18-CONFIG.md) | Memory settings versus store, fail-closed required hooks, restrictive parse recovery, scope order, qualified skills, compiled provider adapters and canonical setting names. |
| [19-COMPRESSION](../ARCH/19-COMPRESSION.md) | Lossy selection versus durable exact recall, experimental indexing status, bounded epoch rehydration and one retention owner. |
| [20-ANALYTICS](../ARCH/20-ANALYTICS.md) | Downstream analytics versus budget authority, direct-turn IDs, trigger/environment provenance, honest strategy metrics and paginated export. |
| [21-DISCOVERY](../ARCH/21-DISCOVERY.md) | Composite CapabilityPack without catalog count inflation, bounded MCP discovery/materialization, disconnected metadata, scoped credential release gate. |
| [22-SECURITY](../ARCH/22-SECURITY.md) | Exact-byte package pins, safe retention, shell scripts versus unsafe interpolation, post-effect uncertainty, terminal-only updates, integrated edge threat register. |
| [23-VERIFICATION](../ARCH/23-VERIFICATION.md) | Fixture/platform/live test scope, no status promotion from absent source or mock, read-only metadata limits, quarantine gate, conditional feature gates and ACC-UX-08. |
| [24-ARCHITECTURE-REVIEW](../ARCH/24-ARCHITECTURE-REVIEW.md) | F-103..F-109 with design dispositions and open delivery evidence; historical findings retained. |
| [25-LONG-HORIZON-CONTROL](../ARCH/25-LONG-HORIZON-CONTROL.md) | Spent-aware reservation formula and durable linearization, exact execution/launch keys, direct-turn schema, generic revisions, clock identity, semantic progress, typed controls and read contexts. |
| [26-CORE-AGENT-CROSSWALK](../ARCH/26-CORE-AGENT-CROSSWALK.md) | Focused upstream evidence versus runtime/usability claims and revised intelligence ownership; crosswalk is not code clearance. |
| [27-COMMANDS-AGENTS-SETTINGS](../ARCH/27-COMMANDS-AGENTS-SETTINGS.md) | ActionDescriptor, buttons/key/palette/command mapping, proof/remember registration, scope/receipt failures, provider workspaces and post-accept disconnect semantics. |
| [28-ARTIFACT-STORE](../ARCH/28-ARTIFACT-STORE.md) | Viewer hints versus safe decoding, retained capture versus unlimited output, byte identity versus evidence verdict, reserve/GC status. |
| [29-SOURCE-TRACEABILITY](../ARCH/29-SOURCE-TRACEABILITY.md) | Full read coverage and task-to-owner/source navigation; no local absences promoted. |
| [30-DISTRIBUTION-UPDATES](../ARCH/30-DISTRIBUTION-UPDATES.md) | Exact update-target consent, safe Later/cancel, paused Run deferral, stale metadata and probe invalidation. |
| [31-CONTROL-API-APP-SERVER](../ARCH/31-CONTROL-API-APP-SERVER.md) | Pause/resume/stop/read/layout/proof method descriptors, authenticated scope, durable receipt and listener refusal. |
| [32-AGENT-MESSAGING](../ARCH/32-AGENT-MESSAGING.md) | Non-one-to-one task/thread/execution relation, WorkerAdapter message transport, durable read preference and no peer verification authority. |
| [33-MEMORY](../ARCH/33-MEMORY.md) | Remember candidate, source-kind versus acceptance, candidate review UX and canonical SQLite memory exception. |
| [34-MODULARITY-AND-BOUNDARIES](../ARCH/34-MODULARITY-AND-BOUNDARIES.md) | One directory, scheduler, index and process authority; common value types, seven clusters and architectural boundary fixtures. |
| [35-CAPABILITY-PARITY-AND-EVOLUTION](../ARCH/35-CAPABILITY-PARITY-AND-EVOLUTION.md) | Capability schema and separate health/evidence axes; five delivery statuses preserved; bounded authorized radar. |
| [36-CODE-INTELLIGENCE](../ARCH/36-CODE-INTELLIGENCE.md) | Dirty files plus unsaved buffers, query coverage/limits, missing intelligence methods, host/confinement launch and multi-root freshness. |

## Cross-cutting conclusions

1. Ordinary coding needs a useful composer and concise result, with optional managed
   control. A permanent graph, technical hash list, storage ledger or agent catalog
   creates unnecessary default work. Default human summaries now retain inspectable
   detail and expose material uncertainty immediately; no preference claim is measured.
2. Controls need an exact owner/target/receipt, not just labels. The shared action schema
   now covers availability, command/key/palette routes, confirmation, pending outcome,
   idempotency, status query and events; attention responds without focus theft.
3. Completion is a domain verdict. Idle, turn end, worker exit, message acknowledgement,
   model prose, timestamps and changing strategy labels cannot establish progress/PASS.
4. Budgets and recovery must be durable and conservative. Spent resources were missing
   from the admission formula; worker relaunch identity was missing from outbox keys;
   automatic recovery gates and post-effect failure semantics differed across sketches.
5. Replacement ports require consistent ownership in the main lifecycle. Git-specific
   convenience fields, duplicate profile/index/process ownership, restart-unsafe clocks
   and context/provider cycles were explicitly scoped or replaced by generic bindings.
6. Integrity depends on exact bytes and source authority. Lossy package normalization,
   active-history pruning, filtered audit chain claims and mock-derived status promotion
   were corrected with fail-closed boundaries and explicit proof limitations.

## Remaining implementation and release decisions

Documentation refinements are **proposed**. TUI, durable controller, attention views,
provider workspace abstraction, AG-UI and complete code intelligence still require
source and acceptance under the linked TODO owners. No task became verified/accepted.

Finite ExecutionBrief/candidate-memory bounds, per-strategy no-progress thresholds,
architecture lint implementation, OS confinement, real container/remote host support,
portable audit proof, production TUF bootstrap and scoped service-credential injection
need their named implementation/release decisions and executable evidence. Any HTTP/
SSE/WebSocket listener—including loopback—requires the separate edge security decision.
These are explicit gates, not silently assumed features. Current source observations
remain historical and are not rewritten into target compliance.

ACC-UX-08 and the updated test plan specify the product/action failure checks.
Controller fixtures additionally need durable reservation crash boundaries, spent and
unknown exposure, execution redelivery, lease clocks, metadata-only progress churn,
policy/hook failure and effect-receipt reconciliation. No usability testing occurred;
attractiveness and ease remain hypotheses until tested on the actual interactive build.

## Primary-source checks in this pass

- [Git COPYING](https://github.com/git/git/blob/master/COPYING): system Git licensing
  cannot be represented as permissive library clearance.
- [RFC 9110 §10.2.3](https://www.rfc-editor.org/rfc/rfc9110.html#section-10.2.3):
  Retry-After has integer seconds/date semantics; millisecond hints are vendor-specific.
- [MCP 2025-11-25 lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle):
  initialization includes notifications/initialized for that selected baseline.

Existing ecosystem pins and license/source coverage remain in ARCH/05, ARCH/29 and
[the earlier evolution review](architecture-evolution-review-2026-09.md). No external
code/schema/test/assets were copied. The checks above are focused primary-reference
checks, not a fresh audit of every upstream source or external URL.

## Documentation verification

Passed: 42 Markdown files, 1,164 local links/fragments (zero broken), unique ledger
definitions (261 requirements, 90 decisions, 41 sources, 144 tasks), closed fences,
contiguous input read ranges/final hashes and git diff --check. Final ARCH size is
15,949 lines. Results are also recorded in CURRENT_RUN. These checks validate links,
identifiers, whitespace and coverage only; they do not prove runtime
correctness, platform security, production trust or user satisfaction.
