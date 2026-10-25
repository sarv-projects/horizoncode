import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261025022602_cheerful_gamma_corps",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`direct_provider_request\` (
          \`owner_binding\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`request_id\` text NOT NULL,
          \`source_revision\` text NOT NULL,
          \`profile_id\` text NOT NULL,
          \`profile_revision\` text NOT NULL,
          \`profile_digest\` text NOT NULL,
          \`permission_scope_digest\` text NOT NULL,
          \`context_selection_json\` text NOT NULL,
          \`context_selection_digest\` text NOT NULL,
          \`provider_id\` text NOT NULL,
          \`model_id\` text NOT NULL,
          \`account_ref\` text,
          \`harness_id\` text NOT NULL,
          \`harness_revision\` text NOT NULL,
          \`route_revision\` text NOT NULL,
          \`endpoint_revision\` text NOT NULL,
          \`policy_digest\` text NOT NULL,
          \`normalized_input_digest\` text NOT NULL,
          \`transport_request_digest\` text NOT NULL,
          \`pin_digest\` text NOT NULL,
          \`state\` text NOT NULL,
          \`assistant_message_id\` text,
          \`usage_json\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`direct_provider_request_pk\` PRIMARY KEY(\`owner_binding\`, \`session_id\`, \`request_id\`),
          CONSTRAINT \`fk_direct_provider_request_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`direct_subagent_inbox\` (
          \`message_id\` text PRIMARY KEY,
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
          \`consumption_proof_json\` text,
          \`host_consumed_ack_digest\` text,
          \`wake_claim_request_id\` text,
          \`wake_claim_digest\` text,
          \`wake_claim_scope_digest\` text,
          \`wake_claim_receipt_digest\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_direct_subagent_inbox_parent_session_id_session_id_fk\` FOREIGN KEY (\`parent_session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_direct_subagent_inbox_child_session_id_session_id_fk\` FOREIGN KEY (\`child_session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`managed_subagent_inbox\` (
          \`message_id\` text PRIMARY KEY,
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
          CONSTRAINT \`fk_managed_subagent_inbox_parent_session_id_session_id_fk\` FOREIGN KEY (\`parent_session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_managed_subagent_inbox_child_session_id_session_id_fk\` FOREIGN KEY (\`child_session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE INDEX IF NOT EXISTS \`direct_provider_request_session_state_idx\` ON \`direct_provider_request\` (\`session_id\`,\`state\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX IF NOT EXISTS \`direct_subagent_inbox_parent_child_request_idx\` ON \`direct_subagent_inbox\` (\`parent_session_id\`,\`child_session_id\`,\`request_id\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX IF NOT EXISTS \`direct_subagent_inbox_child_sequence_idx\` ON \`direct_subagent_inbox\` (\`child_session_id\`,\`mailbox_sequence\`);`,
      )
      yield* tx.run(
        `CREATE INDEX IF NOT EXISTS \`direct_subagent_inbox_child_state_sequence_idx\` ON \`direct_subagent_inbox\` (\`child_session_id\`,\`state\`,\`mailbox_sequence\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX IF NOT EXISTS \`managed_subagent_inbox_parent_child_request_idx\` ON \`managed_subagent_inbox\` (\`parent_session_id\`,\`child_session_id\`,\`request_id\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX IF NOT EXISTS \`managed_subagent_inbox_attempt_sequence_idx\` ON \`managed_subagent_inbox\` (\`attempt_id\`,\`mailbox_sequence\`);`,
      )
      yield* tx.run(
        `CREATE INDEX IF NOT EXISTS \`managed_subagent_inbox_attempt_state_sequence_idx\` ON \`managed_subagent_inbox\` (\`attempt_id\`,\`state\`,\`mailbox_sequence\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
