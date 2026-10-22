import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261021100000_managed_subagent_inbox",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`managed_subagent_inbox\` (
          \`message_id\` text PRIMARY KEY NOT NULL,
          \`parent_session_id\` text NOT NULL,
          \`child_session_id\` text NOT NULL,
          \`request_id\` text NOT NULL,
          \`goal_id\` text NOT NULL,
          \`run_id\` text NOT NULL,
          \`task_id\` text NOT NULL,
          \`attempt_id\` text NOT NULL,
          \`owner_epoch\` text NOT NULL,
          \`binding_digest\` text NOT NULL,
          \`profile_id\` text NOT NULL,
          \`profile_revision\` text NOT NULL,
          \`profile_digest\` text NOT NULL,
          \`permission_scope_digest\` text NOT NULL,
          \`payload\` text NOT NULL,
          \`payload_digest\` text NOT NULL,
          \`payload_bytes\` integer NOT NULL,
          \`delivery_mode\` text NOT NULL,
          \`mailbox_sequence\` text NOT NULL,
          \`mailbox_capacity\` integer NOT NULL,
          \`pins_digest\` text,
          \`inbox_receipt_digest\` text NOT NULL,
          \`state\` text NOT NULL,
          \`challenge_id\` text,
          \`effect_id\` text,
          \`capability_lease_digest\` text,
          \`host_receipt_digest\` text,
          \`completed_turn_receipt_digest\` text,
          \`wake_receipt_digest\` text,
          \`next_request_sequence\` text,
          \`wake_claim_request_id\` text,
          \`wake_claim_digest\` text,
          \`wake_claim_scope_digest\` text,
          \`wake_claim_receipt_digest\` text,
          \`delivery_owner_epoch\` text,
          \`delivery_attempt_id\` text,
          \`delivery_prompt_message_id\` text,
          \`delivery_scope_digest\` text,
          \`delivery_workspace_id\` text,
          \`delivery_workspace_revision\` text,
          \`consumption_ack_digest\` text,
          \`consumption_proof_json\` text,
          \`host_consumed_ack_digest\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`managed_subagent_inbox_parent_fk\` FOREIGN KEY (\`parent_session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`managed_subagent_inbox_child_fk\` FOREIGN KEY (\`child_session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`managed_subagent_inbox_mode_ck\` CHECK (\`delivery_mode\` IN ('queue','follow_up')),
          CONSTRAINT \`managed_subagent_inbox_state_ck\` CHECK (\`state\` IN ('preparing','approval_required','admitted','appended','committed','delivering','consumed','unknown','denied')),
          CONSTRAINT \`managed_subagent_inbox_size_ck\` CHECK (\`payload_bytes\` BETWEEN 1 AND 16384),
          CONSTRAINT \`managed_subagent_inbox_capacity_ck\` CHECK (\`mailbox_capacity\` BETWEEN 1 AND 32),
          CONSTRAINT \`managed_subagent_inbox_identity_ck\` CHECK (\`parent_session_id\` <> \`child_session_id\`)
        );
      `)
      yield* tx.run(`CREATE UNIQUE INDEX \`managed_subagent_inbox_parent_child_request_idx\` ON \`managed_subagent_inbox\` (\`parent_session_id\`,\`child_session_id\`,\`request_id\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`managed_subagent_inbox_attempt_sequence_idx\` ON \`managed_subagent_inbox\` (\`attempt_id\`,\`mailbox_sequence\`);`)
      yield* tx.run(`CREATE INDEX \`managed_subagent_inbox_attempt_state_sequence_idx\` ON \`managed_subagent_inbox\` (\`attempt_id\`,\`state\`,\`mailbox_sequence\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
