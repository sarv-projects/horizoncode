# Core source and baseline observations

These are historical/source observations retained during the 2026-10-01 blueprint consolidation. They are not canonical contracts or delivery claims. Original files remain byte-identical in the architecture archive.

## Compression clauses integrated

## compression interpretation 

Selection and summaries are lossy prompt projections even when canonical source bytes
remain intact. Exact recall refers to retained source, not proof that every detail
survived the summary. RAPTOR/embedding experiments remain prototypes pending quality,
privacy and cost evaluation; the ordinary context path requires no remote index.
Preserve the verbatim tail, compress only admitted historical content, then generate
and attest the bounded fresh ExecutionBrief at the new epoch. Injecting full planning
history every turn is prohibited. Recall retention is ARCH/product/ARTIFACTS.md policy, not another
archive store. All automatic paths share the eligibility gate and allowance in ARCH/core/CONTEXT.md.

## Integration boundaries

Selection is lossy in supplied context even when original bytes remain retrievable. RAPTOR stays prototype-only. Warm-prefix summary requests are optional route-specific optimization, tested against output validity and context limits; compaction ownership and 50% trigger remain unchanged.



## Source URLs retained

- https://github.com/anomalyco/opencode/blob/b471c2b4495747353af768fbf2e0790c9d820ce2/packages/opencode/src/tool/lsp.ts
- https://github.com/openai/codex/blob/67a709665ac7b50311b93e32612c9a8281684787/codex-rs/core/src/tools/handlers/tool_search.rs
- https://github.com/rtk-ai/rtk
- https://github.com/rusqlite/rusqlite/blob/v0.31.0/libsqlite3-sys/build.rs
- https://models.opencode.ai/api.json`
- https://models.opencode.ai/api.json`.
- https://opencode.ai/zen/go/v1/models`
- https://opencode.ai/zen/go/v1/models`,
- https://opencode.ai/zen/go/v1`.
- https://www.rfc-editor.org/rfc/rfc9110.html#section-10.2.3
- https://www.sqlite.org/fts5.html

## Original baseline sections

### 07-SESSION.md

**Source status (2026-09-28, `AX-358`).** The shared segmented framing is implemented in
`horizoncode-eventlog`, but `EventLog` is not yet integrated into the session or run
stores. The shared durability types are already used by the current flat-file session
store; do not confuse that primitive reuse with segmented-store migration. The framing
provides the canonical
event envelope with a `blake3` digest over a versioned domain and sorted object
keys, bounded segments that rotate on the `DEC-058` byte/event ceilings, seals
written and synchronized before a successor segment receives a record, an
atomically replaced committed head with typed absent/malformed/unreadable states,
an OS-backed writer lock, streaming replay with a per-line ceiling, refusal of a
newer schema version before any segment is decoded, preservation (never
truncation) of bytes beyond the head, and lower-only limits resolved from the
`horizoncode-config` storage schema. The commit order is pinned by tests: a line
is durable before the head acknowledges it, and a seal precedes the successor.

**Not covered here.** The thread store still uses its single-file layout until
the `AX-350` migration; the run/task/attempt/spec/evidence payloads and the
rebuildable projections are `AX-309`; explicit recovery of an uncommitted tail is
`AX-311`; the physically allocated control reserve and storage reservations are
`AX-350`/`AX-312`.

The current implementation's single-file/full-read behavior is recorded in
`docs/history/architecture/audits/2026-09-30-review.md` `F-61`; it does not meet this proposed contract.


### 07-SESSION.md

**Source status (2026-09-28).** The backend abstraction and two profiles live in
`horizoncode-eventlog/src/durability.rs`. The segmented `EventLog` uses them, and the
current flat-file session store imports `CommitSink`/`DurabilityProfile` and applies
the same file/directory sync ordering. Session-store integration is at
`horizoncode-session/src/store.rs`; tests in both crates assert ordering and failure
paths with injected backends. The physical control/recovery **reserve** and segmented
session/run-store integration are not implemented (`AX-350`), so the current
`run_durable` session profile promises file and namespace durability for the flat event
log only; it does not establish the full multi-hour run-store contract.


### 07-SESSION.md

**Source status (2026-09-28).** One pure scanner now backs `read_only`, `scan`,
`inspect`, and enumeration: it never truncates a torn tail, never appends, and never
advances any pointer, and it reports an incomplete final row as `RECOVERY_PENDING`
with its byte count. The repairing load path is separate and is reachable only from an
explicit write-capable call. The `recover(thread_id, expected_head, recovery_id)`
operation itself is **not** implemented: effect reconciliation and the quarantined
new-generation append are `AX-311`, so a torn tail is currently retained and reported
rather than repaired by a read.


### 10-TOOLS.md tool baseline

## Built-in tools: source baseline and target

The table is split deliberately: source presence is not inferred from a target
contract. At HorizonCode Rust source baseline `80400370c7898459f7e7c24642caba9af31379d1`, these are the first-party tools
registered by `horizoncode-tools`; `question` is registered only when the caller
selects interactive mode. The registry has no model-visible skill, web, agent,
mailbox, LSP, or image tool at that baseline. See `docs/research/SOURCE-TRACEABILITY.md` for exact files/tests.

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


### 18-CONFIG.md

**Source status (2026-09-28).** `horizoncode-config` now owns the implemented slice:
the discovery walk (global first, then project outer to nearest; a path that exists
but is unusable is reported as an issue rather than skipped), the one JSONC reader
(the guard's document validator consumes it instead of keeping a copy), the typed
settings merge with per-key provenance (`SettingView` as above, with `contributors`
added so an accumulating key can list every contributing layer), and hierarchical
`AGENTS.md` discovery with canonical-path and content-digest dedupe, the exact
`Instructions from: <path>` rendering, and the fail-closed unreadable case. One
`state_root()` resolves `$HORIZONCODE_HOME` → `~/.horizoncode` → `.` and is consumed
by the session, audit, analytics, guard, and CLI roots, so the documented layout is
the implemented one (`F-67`). The discovery and activation half of skill handling is
implemented (`AX-110`, first slice): `SKILL.md` (or a sibling `<name>.md`) is discovered under the global
`<state>/skills` directory and the project walk, frontmatter is parsed with a
YAML parser, `{name, description, slash}` alone enter the catalog, and the body
is returned only by `activate`, which re-reads the file and verifies its digest
against the listing. A malformed skill file is a diagnostic, never a silent
omission; a symlinked skill file is refused. The schema now carries the
instruction key, the two accessibility flags, the terminal-bell preference, and
the storage ceilings and defaults published in `DEC-058` (`session.log.*`,
`run.log.*`, `session.artifacts.*`, `run.artifacts.*`) with typed limit views and
lower-only validation: a configuration or project may lower a limit, never raise the compiled
ceiling, and a nonzero rule rejects zero. Every other key group above registers in
the same registry as its owner lands, so no second settings engine appears. **Not covered:** managed locks (`locked_by`) and capability status
(`capability_status`) arrive with managed policy; injection of the rendered
instruction source into the assembled context is `AX-319`; permission rules remain
validated and evaluated by `CMP-guard`.

`session.artifacts.*` is a first-class schema group for maximum inline-event bytes,
per-object and per-Thread encoded bytes, decoder expansion/pixel/time ceilings,
artifact retention, orphan-cleanup grace, and required durability mode. Expose
requested/effective values, current/reserved storage, and effective filesystem
durability in `/settings`; managed policy and compiled resource ceilings win, and no
default may be unbounded. `session.log.*` and `run.log.*` expose finite event/segment/
session-or-run limits, replay batch size, durability profile, and protected
control/recovery bytes plus physical-reserve allocation profile separately from
artifact bytes. Multi-hour runs require the
crash-durable profile; user settings and agent profiles cannot turn off required syncs
or raise compiled ceilings, and a limit cannot be reduced below committed plus
reserved use. `providers.<id>.termination_profile` is route-fingerprint
bound evidence, not a user-authored capability flag;
`models.output_truncation_recovery` is only a user preference between disabled and
once-per-logical-step recovery for routes with a validated remaining-context cap
profile. Unsupported/unknown finish semantics remain non-retrying.

Security-relevant parse/read failure blocks activation of the new configuration. A
previously validated snapshot may be retained only with an explicit stale warning and
without widening authority; a silently restored broader rule is prohibited. Effective
config digest is pinned to the run and changes create a new context/policy epoch.


