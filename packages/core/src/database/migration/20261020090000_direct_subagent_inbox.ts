import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261020090000_direct_subagent_inbox",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`direct_subagent_inbox\` (
          \`message_id\` text PRIMARY KEY NOT NULL,
          \`parent_session_id\` text NOT NULL,
          \`child_session_id\` text NOT NULL,
          \`request_id\` text NOT NULL,
          \`payload\` text NOT NULL,
          \`payload_digest\` text NOT NULL,
          \`payload_bytes\` integer NOT NULL,
          \`delivery_mode\` text NOT NULL,
          \`mailbox_sequence\` text NOT NULL,
          \`child_attempt_id\` text NOT NULL,
          \`child_owner_epoch\` text NOT NULL,
          \`profile_id\` text NOT NULL,
          \`profile_revision\` text NOT NULL,
          \`profile_digest\` text NOT NULL,
          \`permission_scope_digest\` text NOT NULL,
          \`pins_digest\` text NOT NULL,
          \`mailbox_capacity\` integer NOT NULL,
          \`state\` text NOT NULL,
          \`challenge_id\` text,
          \`effect_id\` text,
          \`approval_expires_at_unix_ms\` integer,
          \`approval_argument_summary\` text,
          \`approval_policy_summary\` text,
          \`capability_lease_digest\` text,
          \`host_receipt_digest\` text,
          \`inbox_receipt_digest\` text NOT NULL,
          \`delivery_attempt_id\` text,
          \`delivery_owner_epoch\` text,
          \`delivery_prompt_message_id\` text,
          \`delivery_scope_digest\` text,
          \`delivery_workspace_id\` text,
          \`consumption_ack_digest\` text,
          \`host_consumed_ack_digest\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`direct_subagent_inbox_parent_fk\` FOREIGN KEY (\`parent_session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`direct_subagent_inbox_child_fk\` FOREIGN KEY (\`child_session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`direct_subagent_inbox_mode_ck\` CHECK (\`delivery_mode\` IN ('queue','follow_up')),
          CONSTRAINT \`direct_subagent_inbox_state_ck\` CHECK (\`state\` IN ('preparing','approval_required','admitted','appended','committed','delivering','consumed','unknown','denied')),
          CONSTRAINT \`direct_subagent_inbox_size_ck\` CHECK (\`payload_bytes\` BETWEEN 1 AND 16384),
          CONSTRAINT \`direct_subagent_inbox_identity_ck\` CHECK (\`parent_session_id\` <> \`child_session_id\`)
        );
      `)
      yield* tx.run(`CREATE UNIQUE INDEX \`direct_subagent_inbox_parent_child_request_idx\` ON \`direct_subagent_inbox\` (\`parent_session_id\`,\`child_session_id\`,\`request_id\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`direct_subagent_inbox_child_sequence_idx\` ON \`direct_subagent_inbox\` (\`child_session_id\`,\`mailbox_sequence\`);`)
      yield* tx.run(`CREATE INDEX \`direct_subagent_inbox_child_state_sequence_idx\` ON \`direct_subagent_inbox\` (\`child_session_id\`,\`state\`,\`mailbox_sequence\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
