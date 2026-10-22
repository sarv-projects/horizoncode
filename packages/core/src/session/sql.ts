import { sqliteTable, text, integer, index, primaryKey, real, uniqueIndex } from "drizzle-orm/sqlite-core"
import * as DatabasePath from "../database/path"
import { ProjectTable } from "../project/sql"
import type { SessionMessage } from "./message"
import type { Prompt } from "./prompt"
import type { SessionInput } from "./input"
import type { Snapshot } from "../snapshot"
import { PermissionV1 } from "../v1/permission"
import { ProjectV2 } from "../project"
import type { SessionSchema } from "./schema"
import type { MessageID, PartID, SessionV1 } from "../v1/session"
import { WorkspaceV2 } from "../workspace"
import { Timestamps } from "../database/schema.sql"
import type { SystemContext } from "../system-context/index"
import { AgentV2 } from "../agent"
import type { Revert } from "@opencode-ai/schema/revert"

type SessionMessageData = Omit<(typeof SessionMessage.Message)["Encoded"], "type" | "id">
type V1MessageData = Omit<SessionV1.Info, "id" | "sessionID">
type V1PartData = Omit<SessionV1.Part, "id" | "sessionID" | "messageID">

export const SessionTable = sqliteTable(
  "session",
  {
    id: text().$type<SessionSchema.ID>().primaryKey(),
    project_id: text()
      .$type<ProjectV2.ID>()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    workspace_id: text().$type<WorkspaceV2.ID>(),
    /** Durable source-lineage generation; process restarts and appends do not change it. */
    source_epoch: integer().notNull().default(1),
    parent_id: text().$type<SessionSchema.ID>(),
    slug: text().notNull(),
    directory: DatabasePath.directoryColumn().notNull(),
    path: DatabasePath.pathColumn(),
    title: text().notNull(),
    version: text().notNull(),
    share_url: text(),
    summary_additions: integer(),
    summary_deletions: integer(),
    summary_files: integer(),
    summary_diffs: text({ mode: "json" }).$type<Snapshot.LegacyFileDiff[]>(),
    metadata: text({ mode: "json" }).$type<Record<string, unknown>>(),
    cost: real().notNull().default(0),
    tokens_input: integer().notNull().default(0),
    tokens_output: integer().notNull().default(0),
    tokens_reasoning: integer().notNull().default(0),
    tokens_cache_read: integer().notNull().default(0),
    tokens_cache_write: integer().notNull().default(0),
    revert: text({ mode: "json" }).$type<Revert.State>(),
    permission: text({ mode: "json" }).$type<PermissionV1.Ruleset>(),
    agent: text(),
    model: text({ mode: "json" }).$type<{
      id: string
      providerID: string
      variant?: string
    }>(),
    ...Timestamps,
    time_compacting: integer(),
    time_archived: integer(),
  },
  (table) => [
    index("session_project_idx").on(table.project_id),
    index("session_workspace_idx").on(table.workspace_id),
    index("session_parent_idx").on(table.parent_id),
  ],
)

export const MessageTable = sqliteTable(
  "message",
  {
    id: text().$type<MessageID>().primaryKey(),
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    ...Timestamps,
    data: text({ mode: "json" }).notNull().$type<V1MessageData>(),
  },
  (table) => [index("message_session_time_created_id_idx").on(table.session_id, table.time_created, table.id)],
)

export const PartTable = sqliteTable(
  "part",
  {
    id: text().$type<PartID>().primaryKey(),
    message_id: text()
      .$type<MessageID>()
      .notNull()
      .references(() => MessageTable.id, { onDelete: "cascade" }),
    session_id: text().$type<SessionSchema.ID>().notNull(),
    ...Timestamps,
    data: text({ mode: "json" }).notNull().$type<V1PartData>(),
  },
  (table) => [
    index("part_message_id_id_idx").on(table.message_id, table.id),
    index("part_session_idx").on(table.session_id),
  ],
)

export const TodoTable = sqliteTable(
  "todo",
  {
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    content: text().notNull(),
    status: text().notNull(),
    priority: text().notNull(),
    position: integer().notNull(),
    ...Timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.session_id, table.position] }),
    index("todo_session_idx").on(table.session_id),
  ],
)

export const SessionMessageTable = sqliteTable(
  "session_message",
  {
    id: text().$type<SessionMessage.ID>().primaryKey(),
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    type: text().$type<SessionMessage.Type>().notNull(),
    seq: integer().notNull(),
    ...Timestamps,
    data: text({ mode: "json" }).notNull().$type<SessionMessageData>(),
  },
  (table) => [
    uniqueIndex("session_message_session_seq_idx").on(table.session_id, table.seq),
    index("session_message_session_type_seq_idx").on(table.session_id, table.type, table.seq),
    index("session_message_session_time_created_id_idx").on(table.session_id, table.time_created, table.id),
    index("session_message_time_created_idx").on(table.time_created),
  ],
)

export const SessionInputTable = sqliteTable(
  "session_input",
  {
    id: text().$type<SessionMessage.ID>().primaryKey(),
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    prompt: text({ mode: "json" }).notNull().$type<Prompt>(),
    delivery: text().$type<SessionInput.Delivery>().notNull(),
    admitted_seq: integer().notNull(),
    promoted_seq: integer(),
    time_created: integer()
      .notNull()
      .$default(() => Date.now()),
  },
  (table) => [
    index("session_input_session_pending_delivery_seq_idx").on(
      table.session_id,
      table.promoted_seq,
      table.delivery,
      table.admitted_seq,
    ),
    uniqueIndex("session_input_session_admitted_seq_idx").on(table.session_id, table.admitted_seq),
    uniqueIndex("session_input_session_promoted_seq_idx").on(table.session_id, table.promoted_seq),
  ],
)

export const SessionContextEpochTable = sqliteTable("session_context_epoch", {
  session_id: text()
    .$type<SessionSchema.ID>()
    .primaryKey()
    .references(() => SessionTable.id, { onDelete: "cascade" }),
  baseline: text().notNull(),
  snapshot: text({ mode: "json" }).notNull().$type<SystemContext.Snapshot>(),
  baseline_seq: integer().notNull(),
})

/** Durable direct model-request pins. Contains references/digests only; never prompt or credential bytes. */
export const DirectProviderRequestTable = sqliteTable(
  "direct_provider_request",
  {
    owner_binding: text().notNull(),
    session_id: text().$type<SessionSchema.ID>().notNull().references(() => SessionTable.id, { onDelete: "cascade" }),
    request_id: text().notNull(),
    source_revision: text().notNull(),
    profile_id: text().notNull(),
    profile_revision: text().notNull(),
    profile_digest: text().notNull(),
    permission_scope_digest: text().notNull(),
    context_selection_json: text({ mode: "json" }).notNull().$type<Record<string, unknown>>(),
    context_selection_digest: text().notNull(),
    provider_id: text().notNull(),
    model_id: text().notNull(),
    account_ref: text(),
    harness_id: text().notNull(),
    harness_revision: text().notNull(),
    route_revision: text().notNull(),
    endpoint_revision: text().notNull(),
    policy_digest: text().notNull(),
    normalized_input_digest: text().notNull(),
    transport_request_digest: text().notNull(),
    pin_digest: text().notNull(),
    state: text().notNull(),
    assistant_message_id: text(),
    usage_json: text({ mode: "json" }).$type<Record<string, unknown>>(),
    time_created: integer().notNull(),
    time_updated: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.owner_binding, table.session_id, table.request_id] }),
    index("direct_provider_request_session_state_idx").on(table.session_id, table.state),
  ],
)

/** Private durable Core inbox for Guarded direct child messages; never projected as transcript text. */
export const DirectSubagentInboxTable = sqliteTable(
  "direct_subagent_inbox",
  {
    message_id: text().primaryKey(),
    parent_session_id: text().notNull().references(() => SessionTable.id, { onDelete: "cascade" }),
    child_session_id: text().notNull().references(() => SessionTable.id, { onDelete: "cascade" }),
    request_id: text().notNull(),
    payload: text().notNull(),
    payload_digest: text().notNull(),
    payload_bytes: integer().notNull(),
    delivery_mode: text().notNull(),
    mailbox_sequence: text().notNull(),
    child_attempt_id: text().notNull(),
    child_owner_epoch: text().notNull(),
    profile_id: text().notNull(),
    profile_revision: text().notNull(),
    profile_digest: text().notNull(),
    permission_scope_digest: text().notNull(),
    pins_digest: text().notNull(),
    mailbox_capacity: integer().notNull(),
    state: text().notNull(),
    challenge_id: text(),
    effect_id: text(),
    approval_expires_at_unix_ms: integer(),
    approval_argument_summary: text(),
    approval_policy_summary: text(),
    capability_lease_digest: text(),
    host_receipt_digest: text(),
    inbox_receipt_digest: text().notNull(),
    delivery_attempt_id: text(),
    delivery_owner_epoch: text(),
    delivery_prompt_message_id: text(),
    delivery_scope_digest: text(),
    delivery_workspace_id: text(),
    consumption_ack_digest: text(),
    consumption_proof_json: text(),
    host_consumed_ack_digest: text(),
    wake_claim_request_id: text(),
    wake_claim_digest: text(),
    wake_claim_scope_digest: text(),
    wake_claim_receipt_digest: text(),
    time_created: integer().notNull(),
    time_updated: integer().notNull(),
  },
  (table) => [
    uniqueIndex("direct_subagent_inbox_parent_child_request_idx").on(table.parent_session_id, table.child_session_id, table.request_id),
    uniqueIndex("direct_subagent_inbox_child_sequence_idx").on(table.child_session_id, table.mailbox_sequence),
    index("direct_subagent_inbox_child_state_sequence_idx").on(table.child_session_id, table.state, table.mailbox_sequence),
  ],
)

/** Durable managed child mailbox. It intentionally has a separate table from
 * direct child delivery because managed rows are bound to Rust Goal/Run/Task/
 * Attempt and DelegationBinding authority, not a DirectAttempt. */
export const ManagedSubagentInboxTable = sqliteTable(
  "managed_subagent_inbox",
  {
    message_id: text().primaryKey(),
    parent_session_id: text().notNull().references(() => SessionTable.id, { onDelete: "cascade" }),
    child_session_id: text().notNull().references(() => SessionTable.id, { onDelete: "cascade" }),
    request_id: text().notNull(),
    goal_id: text().notNull(),
    run_id: text().notNull(),
    task_id: text().notNull(),
    attempt_id: text().notNull(),
    owner_epoch: text().notNull(),
    binding_digest: text().notNull(),
    profile_id: text().notNull(),
    profile_revision: text().notNull(),
    profile_digest: text().notNull(),
    permission_scope_digest: text().notNull(),
    payload: text().notNull(),
    payload_digest: text().notNull(),
    payload_bytes: integer().notNull(),
    delivery_mode: text().notNull(),
    mailbox_sequence: text().notNull(),
    mailbox_capacity: integer().notNull(),
    pins_digest: text(),
    inbox_receipt_digest: text().notNull(),
    state: text().notNull(),
    challenge_id: text(),
    effect_id: text(),
    capability_lease_digest: text(),
    host_receipt_digest: text(),
    completed_turn_receipt_digest: text(),
    wake_receipt_digest: text(),
    next_request_sequence: text(),
    wake_claim_request_id: text(),
    wake_claim_digest: text(),
    wake_claim_scope_digest: text(),
    wake_claim_receipt_digest: text(),
    delivery_owner_epoch: text(),
    delivery_attempt_id: text(),
    delivery_prompt_message_id: text(),
    delivery_scope_digest: text(),
    delivery_workspace_id: text(),
    delivery_workspace_revision: text(),
    consumption_ack_digest: text(),
    host_consumed_ack_digest: text(),
    time_created: integer().notNull(),
    time_updated: integer().notNull(),
  },
  (table) => [
    uniqueIndex("managed_subagent_inbox_parent_child_request_idx").on(table.parent_session_id, table.child_session_id, table.request_id),
    uniqueIndex("managed_subagent_inbox_attempt_sequence_idx").on(table.attempt_id, table.mailbox_sequence),
    index("managed_subagent_inbox_attempt_state_sequence_idx").on(table.attempt_id, table.state, table.mailbox_sequence),
  ],
)
