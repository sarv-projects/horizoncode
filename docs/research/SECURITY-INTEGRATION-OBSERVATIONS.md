# Security and integration observations

The original specifications are preserved verbatim in [the architecture snapshot](../history/architecture/original-ARCH-2026-10-01/). These observations are research and historical evidence, not normative blueprint text.

**Source status after the `AX-370` fix (2026-09-30, source baseline `80400370c7898459f7e7c24642caba9af31379d1`).** `horizoncode-guard` now
resolves find-last-wins within the user/global base and within each restriction layer,
composes the layers monotonically (`deny > ask > allow`), applies the
external-directory floor after composition with an action-aware and user/global-only
deliberate-grant check, and limits reduced approval to eligible rule-raised asks
(`DEC-073`); the approval seam carries that eligibility
(`ApprovalRequest.reduced_approval_eligible`, `Guard::ask_is_eligible`) so a
reduced-approval resolver refuses ineligible asks instead of approving them.
Evidence: `crates/horizoncode-guard/tests/guard.rs`
(`lower_trust_layers_cannot_lower_an_upstream_ask_or_deny`,
`a_project_rule_cannot_widen_the_user_base`,
`a_deliberate_allow_is_action_specific`,
`a_lower_trust_deliberate_external_allow_cannot_waive_the_floor`, `reduced_approval::*`),
`crates/horizoncode-tools/tests/permission.rs`
(`reduced_approval_resolves_an_eligible_ask_without_the_resolver`,
`reduced_approval_leaves_an_external_reach_to_the_resolver`), plus
`cargo test --workspace --no-fail-fast` (519 passed, 0 failed) and
`cargo clippy --workspace --all-targets -- -D warnings`. The acceptance record
`ACC-P1-02` is still required before this behavior is `verified`/`accepted`.



**Source status (2026-09-28).** Steps 1–4 are now implemented: the CLI records access
in an independent `audit-access/` stream (own sequence, own `blake3` chain, own
advisory lock) and returns a dedicated exit code without printing record content when
that record cannot be persisted; `verify`, `replay`, and `census` open no writer path;
a directory or per-entry enumeration failure is a typed error instead of an empty
store; the head pointer is read as `Absent | Present | Malformed | Unreadable` and
ordinary startup refuses anything but a genuinely empty store; a torn tail is a typed
`RecoveryRequired` refusal repaired only by the explicit `audit repair` command, which
preserves the original bytes and emits a linked recovery artifact; and a writable
store holds an OS-backed advisory lock for its lifetime, taken before the head or
segments are read. Not implemented here: the global `audit_seq`/`segment_seq`
migration, per-effect prepare/terminal reconciliation, and the `census` coverage
evidence itself (`AX-346` remainder, `AX-311`).



**Source status at Rust baseline `80400370c7898459f7e7c24642caba9af31379d1` (2026-09-30).** The
read-only inspection defects recorded on 2026-09-27 were addressed by the AX-346
integrity slice: `AuditLog::open_read_only` does not repair; writable open refuses a
torn tail; malformed/unreadable heads and segment-enumeration errors are typed; and
the writer holds an OS-backed lock. See `crates/horizoncode-audit/src/store.rs` and
`TODO.md` AX-346. This does not close AX-346's global sequence migration, effect
prepare/terminal reconciliation, or key rotation. Analytics is a derived ledger, not
a second authority for whether an effect happened.




Module LLD for the three edge components `CMP-acp`, `CMP-mcp`, and `CMP-headless`, plus the language edge-SDK seam. Protocols are seams onto the one control plane; they never contain loop logic (`REQ-PROTO-005`, `DEC-003`).

**Implementation status at 2026-09-28 source snapshot (`23d4ce8`):** the Rust ACP
crate remains server-only. Its source handles `initialize`, `session/new`,
`session/close`, `session/prompt`, and
`session/cancel`; it does not currently implement session `load/list/resume/fork`,
`set-mode`, `set-model`, `set-config-option`, client-side ACP transport, MCP, or an edge
SDK, durable-goal preparation/approval, or ACP elicitation handling. The method tables
below specify target behavior, not shipped support. Only methods actually implemented
and tested may be advertised or invoked. The Rust SDK crate's semver and upstream
changelog version are not the ACP wire protocol version. The upstream changelog is at
1.9.1 as of this document date; it marks v2 changes unstable. Negotiate the actual
wire version and capabilities at runtime, pin a released v1 schema in fixtures, and
feature-gate drafts ([official changelog](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/CHANGELOG.md)).



Status: **proposed; the detached controller, IPC server, and shared client are
absent**. This design provides one versioned command/event boundary for the TUI,
CLI, headless client, ACP adapters, and later SDKs. `CMP-app-server` is a transport
and lifecycle boundary; it does not own task, session, policy, provider, or update
truth.



Status: **proposed LLD; installer, release pipeline, and self-update are absent** at
the source baseline recorded in `CURRENT_RUN.md`. This document owns installation,
update discovery, secure staging/application, and release automation. Provider/model
metadata refresh is a separate data-only flow owned by `ARCH/core/PROVIDERS.md`; an application
update is executable-code delivery and has a different trust root and lifecycle.



Registry availability was checked on 2026-09-28: the exact npm package lookup and the
crates.io sparse-index entry for `hzcode` returned HTTP 404. This is a point-in-time
availability result, not name reservation, trademark clearance, or a guarantee that a
publish will remain available; recheck and claim the canonical package immediately
before the first release. The current source checkout still builds the `horizoncode`
binary; this section specifies a future distribution rename/alias migration and does
not claim it is implemented.



## Sibling compatibility gates found during review

The sibling documents contain unresolved examples/contracts that Horizon must not
copy: JSON Schema `type: bool`; install-plan example fields excluded by the displayed
closed schema; `invalidated` grant state absent from shown SQL constraint; ambiguous
planHash self-exclusion/expiry binding; rollback versus forward-recovery inconsistency;
NORMAL SQLite durability versus power-loss claims; missing IPC framing/message limits;
hostId-based caller identity; conflicting secret-environment claims; and an MCP newer
profile whose stability differs from Horizon's selected released protocol.

Before adapter acceptance, pin a sibling release with valid schemas/golden plans,
explicit authenticated approval channel, bounded framing/cancellation/reconciliation,
resolved journal/durability guarantees and versioned MCP conformance. A generic
MCP probe can inspect capabilities before these gates pass, but cannot establish
unsupported effect, grant or confinement guarantees. The sibling repo is read-only in
this task; its defects remain named dependencies, not silently corrected here.



## Source URLs retained from original specifications

- https://github.com/agentclientprotocol/agent-client-protocol/blob/main/CHANGELOG.md
- https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/protocol/v1/overview.mdx
- https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/protocol/v1/session-setup.mdx
- https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/rfds/elicitation.mdx
- https://github.com/openai/codex/blob/368e5eae2f006a70a91dddfdc96e6b2d11498f81/codex-rs/app-server-client/README.md
- https://github.com/sarv-projects/horizoncode
- https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle
