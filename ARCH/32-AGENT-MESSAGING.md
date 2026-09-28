# 32 — Agent messaging

Status: **proposed**. This is a bounded coordination channel for agents inside one
managed HorizonCode Run. It is not a second task tracker, execution scheduler, or
permission system. `ARCH/16` owns scheduling and message-tool authority; `ARCH/25`
owns canonical run/task/attempt state and cross-stream recovery; `ARCH/07` owns the
recipient Thread inbox; `ARCH/06` and `ARCH/27` own the panel and command surface.

## Goal and boundaries

Agents need to ask peers for a finding, share a bounded result, or coordinate a
handoff without routing every message through the root worker. A user/operator must
also be able to inspect and explicitly message an eligible worker. The target is a
run-scoped durable mailbox with bounded group delivery and replay.

The durable hierarchy remains:

```text
Run → Task DAG → Attempt → Agent Thread tree → WorkerExecution
```

The task DAG states what work exists; the Thread tree states which agents are
working; messages state what one run participant communicated. These are separate
graphs. A message, reply, delivery, acknowledgement, child Thread close, or peer
receipt never changes task state, grants permission, revises approved requirements,
or proves acceptance. Only `CMP-orch` changes task state, `CMP-guard` decides tool
authority, and `CMP-verifier` produces task evidence.

V1 sends text only, to explicit participants in the same Run. It has no external
network service, cross-run broadcast, attachments, implicit `@` delivery, hidden
transcript sharing, or background wake-up. Agent-to-agent messages are supported
only where both the sender and recipient have a negotiated message capability. An
opaque ACP/CLI peer is `unsupported` unless its adapter exposes an explicit,
versioned bridge; standard ACP session IDs or prompt methods do not imply one.

## Ownership

| Concern | Owner | Boundary |
|---|---|---|
| Membership, posting, recipient selection, ordering, delivery state, limits | `CMP-orch` | Run-stream facts; no task or permission authority |
| Message tool schema and per-call authorization | `CMP-tools` + `CMP-guard` | Capability `agent.message`; child authority is intersected with parent/run ceilings |
| Recipient durable inbox and safe-boundary promotion | `CMP-session` | Stores an untrusted message reference in the existing input inbox; does not own message truth |
| Native/external transport | `CMP-adapter` / `CMP-execution-host` | Use only negotiated, explicit capabilities; never infer delivery from process state |
| User panel, command, notification and settings rendering | `CMP-tui` / `CMP-command` / `CMP-config` | Read and mutate through `CMP-control-api`; no UI-owned message state |
| Durable payload and status | Existing Run and Thread streams | No new database or independent message event log; bounded body is inline in the Run event |

## Data model

The Run stream is authoritative. SQLite/search rows and per-operator read cursors
are rebuildable projections. Worker acknowledgement is not a UI read receipt. Each
event uses the shared event envelope and aggregate
sequence specified in `ARCH/25`.

```text
AgentMessage {
  message_id: MessageId,
  post_delivery_id: DeliveryId,       // canonical idempotency ID for post operation
  run_id: RunId,
  sender: { kind: OPERATOR | WORKER, attempt_id?, thread_id? },
  recipient_thread_ids: ThreadId[],  // explicit, unique, same-run participants
  task_id?: TaskId,                   // context/filter only, not ownership
  reply_to_message_id?: MessageId,
  body_utf8: string,                  // control characters retained as data, safely rendered
  body_digest: Digest,
  posted_seq: RunSeq,
  created_at: Timestamp
}

MessageDelivery {
  message_id: MessageId,
  recipient_thread_id: ThreadId,
  delivery_id: DeliveryId,            // stable: hash(message_id, recipient_thread_id)
  state: PENDING | ADMITTED | PROMOTED |
         UNSUPPORTED | UNDELIVERABLE | EXPIRED | CANCELLED,
  thread_input_receipt?: InputReceiptId,
  transition_seq?: RunSeq,
  acknowledged_seq?: RunSeq,          // orthogonal explicit worker acknowledgement
  acknowledged_by_attempt_id?: AttemptId,
  failure_code?: TypedCode
}

OperatorReadCursor {
  run_id: RunId, operator_scope: PrincipalOrDeviceRef, last_seen_run_seq: RunSeq
}
```

`AgentMessage` is an append-only `AgentMessagePosted` Run event that includes the
stable `post_delivery_id` and canonical payload digest. A uniqueness constraint on
`(run_id, post_delivery_id)` makes retry/status resolve the original post after
restart; the same ID with a changed digest conflicts. Delivery changes
are `AgentMessageDeliveryChanged` events. For each accepted recipient, the outbox
derives the stable `delivery_id` and calls `CMP-session.admit_input` with an
`AGENT_MESSAGE` origin and `{run_id, message_id, body_digest, sender, task_id}`
reference. The Thread log stores that reference, not a second body copy. The
recipient obtains the body through a membership-checked controller read. The
`InputReceipt` is canonical for inbox admission/promotion; the Run event is canonical
for the message and its user-visible delivery projection. Recovery reconciles the
two records by stable ID and digest before retrying. Same ID with a different digest
is a hard conflict.

`acknowledged_seq` means the recipient explicitly invoked the acknowledgement
action after an inbox receipt exists. It does not prove that the model understood
or acted on the content. It is orthogonal to delivery state. Operator unread state
is derived from `OperatorReadCursor`; it is not inferred from worker acknowledgement.
Acknowledgement is optional and cannot be required for run completion.

## Interfaces and message flow

```text
worker tool or operator panel
  → typed control API: post_message(run, recipient_threads, task?, reply_to?, body, delivery_id)
  → verify principal, run membership, recipient status, `agent.message` capability,
    payload/rate/storage budgets and guard decision
  → atomically append AgentMessagePosted + bounded delivery outbox records
  → recipient Thread inbox admits stable AGENT_MESSAGE reference
  → append delivery transition; promote only at a safe provider-turn boundary
  → render as explicitly untrusted peer content with sender/attempt/task provenance
  → optional explicit acknowledgement
```

The run append is the linearization point for a message. The operation is idempotent
by `delivery_id` and payload digest. A caller timeout is resolved through the same
delivery ID/status query, never by making a new post. Event budget for message,
delivery transitions, and reconciliation is reserved before accepting the post. If
the canonical append succeeds but inbox delivery fails, the UI shows `PENDING` or a
typed terminal failure while the outbox retries under the original finite budget.
The system never tells the sender “delivered” until the matching Thread receipt is
durable.

`ACTIVE` and `WAITING` sessions may accept a bounded durable inbox item if their
session owner supports it; `WAITING` items remain queued and do not wake the worker.
Only `ACTIVE` sessions promote at a safe provider-turn boundary. `PAUSED`,
`CANCELLED`, `CLOSED`, terminal, stale-fenced, and unknown external workers are not
woken or given an implicit restart; their delivery is an explicit typed terminal
state. A message arriving while a model step runs is promoted at the
next safe boundary; it never mutates a request already sent to a provider. A user
steering message remains a separate `USER` input lane and takes precedence over peer
messages according to `REQ-HORIZON-014`.

## Bounds, budgets, and retention

- UTF-8 body limit is 4 KiB by default and 16 KiB absolute. No binary payloads or
  attachments in v1. Reject invalid encoding, oversize payloads, empty recipient
  sets, duplicate recipients, self-delivery, unknown/foreign sessions, and stale
  attempt membership before append.
- A post may target at most 8 recipient sessions. Each session has a configurable
  finite pending-message cap (default 64). Run event bytes and per-attempt tool-call
  ceilings provide additional hard bounds. Each setting has a schema-level maximum;
  the run-start review pins its effective digest.
- Posting reserves the bounded Run-event and recipient-inbox bytes. Promotion
  reserves the recipient's model/token allowance before materialization; rejected
  promotion remains visible and does not exceed the user's budget. Sender tool usage
  and recipient provider usage are recorded separately with actual/estimated/unknown
  provenance; no hidden external-agent quota is fabricated.
- Delivery retries are idempotent, finite, and charged to the Run recovery allowance.
  When that allowance is exhausted, mark the delivery `UNDELIVERABLE` with the last
  observed cause; never keep polling or retrying indefinitely.
- Each sender has a configured token-bucket rate and bounded burst, in addition to
  the per-recipient queue cap. Admission is fair across worker senders and reserves
  capacity for operator control messages. Limits are finite and schema-capped;
  exact defaults require product sign-off before implementation.
- Message body retention follows the owning Run's retention and deletion policy.
  Message indexes can be rebuilt; deleting a Run follows `ARCH/25` event/artifact
  integrity rules and cannot leave dangling cross-run references.

## Security and trust

1. `CMP-guard` is the sole allow/ask/deny authority for the `agent.message` tool.
   The effective scope is the intersection of Run permission, sender Attempt
   ceiling, profile capability, recipient membership, and active settings. A child
   cannot grant itself or another child broader scope. Operator send is authenticated
   through the trusted control session.
2. A worker may read only messages addressed to its current Session and explicitly
   visible Run metadata. It cannot list other Runs, inspect non-member sessions, or
   impersonate another sender. Stale attempt IDs and cross-run IDs fail closed.
3. Every message is untrusted data, including messages from another first-party
   worker. It is clearly wrapped with provenance in model context. It cannot add
   instructions, tools, recipients, permissions, task requirements, approval, or
   evidence. The receiving agent must retrieve/verify code and artifacts directly.
4. TUI output escapes terminal control/escape sequences, bounds wrapped rendering,
   and exposes sender, recipient, timestamp, delivery state, and task reference as
   text. No color-only, sound-only, or model-generated status. Notification mute
   changes presentation only.
5. External message delivery is refused unless adapter capability/version,
   recipient identity, workspace binding, and usage limitations are explicit and
   pinned in the Attempt. Unsupported/unknown capabilities remain visible as such.

## UI and command contract

The Agents panel has a **Messages** view scoped to the current Run, with filters for
sender, recipient, Attempt, Task, time, delivery state, and unread projection. A
message detail shows the full bounded text, provenance, reply chain, and per-recipient
delivery history. The unread projection is scoped by operator/device read cursor;
worker ack only means the worker invoked an acknowledgement action. The composer
requires explicit recipients; `@agent` text does not
send a message. Send returns a receipt immediately with `posted`, `pending`, or a
typed rejection; later transitions appear from the Run event cursor. Slow clients
replay from a sequence or receive an explicit gap/resnapshot state.

`/agents message send <session-ref> <text>` and
`/agents message list [--task <id>] [--agent <ref>] [--state <state>]` are typed
`CMP-command` descriptors. `<text>` is parsed as the remaining literal text, never
shell syntax. Help/completion comes from the same registry. The native UI command
opens the composer; headless output is structured and does not start a run implicitly.

Settings control availability, bounded limits, warning thresholds, and visual/sound
notifications. Muting or hiding badges cannot suppress failed delivery, alter
budgets, auto-wake agents, or waive a guard decision. Run-level enablement and
effective message limits are displayed in the goal-start review and pinned to the
approved policy/config digest.

## Failure handling and acceptance evidence

| Case | Required result |
|---|---|
| Duplicate post, same ID and digest | Return original receipt; create one message and one delivery per recipient |
| Duplicate ID, changed digest | Typed conflict; no second event or budget reservation |
| Crash after Run append, before Thread inbox receipt | Recovery finds the outbox, admits once, reconciles by ID/digest |
| Crash after Thread admission, before Run delivery transition | Recover Thread receipt and append the missing transition; do not duplicate model input |
| Concurrent senders to one recipient | Run sequence defines order; inbox promotion remains deterministic and bounded |
| Recipient state at post | `ACTIVE` → admit/promote at safe boundary; `WAITING` → admit but queue without wake; `PAUSED`/`CANCELLED`/`CLOSED`/terminal/stale/unknown → typed `UNDELIVERABLE` or `UNSUPPORTED`; no implicit restart |
| Budget/storage full, recipient queue full | Reject before append or produce an explicit terminal result; preserve control/recovery reserve |
| Cross-run/foreign recipient or forged sender | Guarded typed denial; no message body leaks |
| Prompt injection in peer message | Treated as untrusted context; cannot mutate requirements, task state, tools, or policy |
| ANSI/control payload | Safely escaped in TUI, exact bounded data retained, no terminal command execution |
| External adapter has no message method | `UNSUPPORTED`; do not treat ACP prompt/session ID as a bridge |
| Ack absent, forged, duplicated, or contradictory | Absence never blocks the Run; only authenticated explicit ack is shown; duplicate is idempotent |
| Slow UI / reconnect / cursor expiry | Ordered replay or explicit resnapshot; no hidden event loss |
| Compaction with pending message | Message reference and receipt survive; exact pending order remains inspectable |

Acceptance uses deterministic controller/session fixtures and a real process-kill
matrix around each cross-stream boundary. It asserts event counts, order, idempotent
receipts, queue/resource ceilings, recipient isolation, pending replay, and that no
message event changes Task/Run verification state. TUI tests cover keyboard and
screen-reader labels, small terminal widths, color-disabled mode, literal search,
ANSI escape payloads, notification preferences, and delivery-state recovery. External
ACP adapter tests use a fake peer that lacks and then advertises the explicit bridge;
no live provider is required. `research docs/tests.md` owns the exact suite plan.
