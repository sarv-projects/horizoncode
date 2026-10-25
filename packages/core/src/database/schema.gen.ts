import { Effect } from "effect"
import type { DatabaseMigration } from "./migration"

export default {
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`workspace\` (
          \`id\` text PRIMARY KEY,
          \`type\` text NOT NULL,
          \`name\` text DEFAULT '' NOT NULL,
          \`branch\` text,
          \`directory\` text,
          \`extra\` text,
          \`project_id\` text NOT NULL,
          \`time_used\` integer NOT NULL,
          CONSTRAINT \`fk_workspace_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`data_migration\` (
          \`name\` text PRIMARY KEY,
          \`time_completed\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`core_source_identity\` (
          \`singleton_id\` integer PRIMARY KEY,
          \`source_store_id\` text NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`account_state\` (
          \`id\` integer PRIMARY KEY,
          \`active_account_id\` text,
          \`active_org_id\` text,
          CONSTRAINT \`fk_account_state_active_account_id_account_id_fk\` FOREIGN KEY (\`active_account_id\`) REFERENCES \`account\`(\`id\`) ON DELETE SET NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`account\` (
          \`id\` text PRIMARY KEY,
          \`email\` text NOT NULL,
          \`url\` text NOT NULL,
          \`access_token\` text NOT NULL,
          \`refresh_token\` text NOT NULL,
          \`token_expiry\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`control_account\` (
          \`email\` text NOT NULL,
          \`url\` text NOT NULL,
          \`access_token\` text NOT NULL,
          \`refresh_token\` text NOT NULL,
          \`token_expiry\` integer,
          \`active\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`control_account_pk\` PRIMARY KEY(\`email\`, \`url\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`credential\` (
          \`id\` text PRIMARY KEY,
          \`integration_id\` text,
          \`label\` text NOT NULL,
          \`value\` text NOT NULL,
          \`connector_id\` text,
          \`method_id\` text,
          \`active\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`event_sequence\` (
          \`aggregate_id\` text PRIMARY KEY,
          \`seq\` integer NOT NULL,
          \`owner_id\` text
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`event\` (
          \`id\` text PRIMARY KEY,
          \`aggregate_id\` text NOT NULL,
          \`seq\` integer NOT NULL,
          \`type\` text NOT NULL,
          \`data\` text NOT NULL,
          CONSTRAINT \`fk_event_aggregate_id_event_sequence_aggregate_id_fk\` FOREIGN KEY (\`aggregate_id\`) REFERENCES \`event_sequence\`(\`aggregate_id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`permission\` (
          \`id\` text PRIMARY KEY,
          \`project_id\` text NOT NULL,
          \`action\` text NOT NULL,
          \`resource\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_permission_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`project_directory\` (
          \`project_id\` text NOT NULL,
          \`directory\` text NOT NULL,
          \`type\` text,
          \`strategy\` text,
          \`source_instance_id\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`project_directory_pk\` PRIMARY KEY(\`project_id\`, \`directory\`),
          CONSTRAINT \`fk_project_directory_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`project\` (
          \`id\` text PRIMARY KEY,
          \`worktree\` text NOT NULL,
          \`vcs\` text,
          \`name\` text,
          \`icon_url\` text,
          \`icon_url_override\` text,
          \`icon_color\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_initialized\` integer,
          \`sandboxes\` text NOT NULL,
          \`commands\` text
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`direct_provider_request\` (
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
        CREATE TABLE \`direct_subagent_inbox\` (
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
        CREATE TABLE \`managed_subagent_inbox\` (
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
      yield* tx.run(`
        CREATE TABLE \`message\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`data\` text NOT NULL,
          CONSTRAINT \`fk_message_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`part\` (
          \`id\` text PRIMARY KEY,
          \`message_id\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`data\` text NOT NULL,
          CONSTRAINT \`fk_part_message_id_message_id_fk\` FOREIGN KEY (\`message_id\`) REFERENCES \`message\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_context_epoch\` (
          \`session_id\` text PRIMARY KEY,
          \`baseline\` text NOT NULL,
          \`snapshot\` text NOT NULL,
          \`baseline_seq\` integer NOT NULL,
          CONSTRAINT \`fk_session_context_epoch_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_input\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`prompt\` text NOT NULL,
          \`delivery\` text NOT NULL,
          \`admitted_seq\` integer NOT NULL,
          \`promoted_seq\` integer,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_session_input_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_message\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`type\` text NOT NULL,
          \`seq\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`data\` text NOT NULL,
          CONSTRAINT \`fk_session_message_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session\` (
          \`id\` text PRIMARY KEY,
          \`project_id\` text NOT NULL,
          \`workspace_id\` text,
          \`source_epoch\` integer DEFAULT 1 NOT NULL,
          \`parent_id\` text,
          \`slug\` text NOT NULL,
          \`directory\` text NOT NULL,
          \`path\` text,
          \`title\` text NOT NULL,
          \`version\` text NOT NULL,
          \`share_url\` text,
          \`summary_additions\` integer,
          \`summary_deletions\` integer,
          \`summary_files\` integer,
          \`summary_diffs\` text,
          \`metadata\` text,
          \`cost\` real DEFAULT 0 NOT NULL,
          \`tokens_input\` integer DEFAULT 0 NOT NULL,
          \`tokens_output\` integer DEFAULT 0 NOT NULL,
          \`tokens_reasoning\` integer DEFAULT 0 NOT NULL,
          \`tokens_cache_read\` integer DEFAULT 0 NOT NULL,
          \`tokens_cache_write\` integer DEFAULT 0 NOT NULL,
          \`revert\` text,
          \`permission\` text,
          \`agent\` text,
          \`model\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_compacting\` integer,
          \`time_archived\` integer,
          CONSTRAINT \`fk_session_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`todo\` (
          \`session_id\` text NOT NULL,
          \`content\` text NOT NULL,
          \`status\` text NOT NULL,
          \`priority\` text NOT NULL,
          \`position\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`todo_pk\` PRIMARY KEY(\`session_id\`, \`position\`),
          CONSTRAINT \`fk_todo_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_share\` (
          \`session_id\` text PRIMARY KEY,
          \`id\` text NOT NULL,
          \`secret\` text NOT NULL,
          \`url\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_session_share_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`core_source_store_identity_unique\` ON \`core_source_identity\` (\`source_store_id\`);`,
      )
      yield* tx.run(`CREATE UNIQUE INDEX \`event_aggregate_seq_idx\` ON \`event\` (\`aggregate_id\`,\`seq\`);`)
      yield* tx.run(`CREATE INDEX \`event_aggregate_type_seq_idx\` ON \`event\` (\`aggregate_id\`,\`type\`,\`seq\`);`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`permission_project_action_resource_idx\` ON \`permission\` (\`project_id\`,\`action\`,\`resource\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`project_directory_source_instance_unique\` ON \`project_directory\` (\`source_instance_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`direct_provider_request_session_state_idx\` ON \`direct_provider_request\` (\`session_id\`,\`state\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`direct_subagent_inbox_parent_child_request_idx\` ON \`direct_subagent_inbox\` (\`parent_session_id\`,\`child_session_id\`,\`request_id\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`direct_subagent_inbox_child_sequence_idx\` ON \`direct_subagent_inbox\` (\`child_session_id\`,\`mailbox_sequence\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`direct_subagent_inbox_child_state_sequence_idx\` ON \`direct_subagent_inbox\` (\`child_session_id\`,\`state\`,\`mailbox_sequence\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`managed_subagent_inbox_parent_child_request_idx\` ON \`managed_subagent_inbox\` (\`parent_session_id\`,\`child_session_id\`,\`request_id\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`managed_subagent_inbox_attempt_sequence_idx\` ON \`managed_subagent_inbox\` (\`attempt_id\`,\`mailbox_sequence\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`managed_subagent_inbox_attempt_state_sequence_idx\` ON \`managed_subagent_inbox\` (\`attempt_id\`,\`state\`,\`mailbox_sequence\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`message_session_time_created_id_idx\` ON \`message\` (\`session_id\`,\`time_created\`,\`id\`);`,
      )
      yield* tx.run(`CREATE INDEX \`part_message_id_id_idx\` ON \`part\` (\`message_id\`,\`id\`);`)
      yield* tx.run(`CREATE INDEX \`part_session_idx\` ON \`part\` (\`session_id\`);`)
      yield* tx.run(
        `CREATE INDEX \`session_input_session_pending_delivery_seq_idx\` ON \`session_input\` (\`session_id\`,\`promoted_seq\`,\`delivery\`,\`admitted_seq\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_input_session_admitted_seq_idx\` ON \`session_input\` (\`session_id\`,\`admitted_seq\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_input_session_promoted_seq_idx\` ON \`session_input\` (\`session_id\`,\`promoted_seq\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_message_session_seq_idx\` ON \`session_message\` (\`session_id\`,\`seq\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_message_session_type_seq_idx\` ON \`session_message\` (\`session_id\`,\`type\`,\`seq\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_message_session_time_created_id_idx\` ON \`session_message\` (\`session_id\`,\`time_created\`,\`id\`);`,
      )
      yield* tx.run(`CREATE INDEX \`session_message_time_created_idx\` ON \`session_message\` (\`time_created\`);`)
      yield* tx.run(`CREATE INDEX \`session_project_idx\` ON \`session\` (\`project_id\`);`)
      yield* tx.run(`CREATE INDEX \`session_workspace_idx\` ON \`session\` (\`workspace_id\`);`)
      yield* tx.run(`CREATE INDEX \`session_parent_idx\` ON \`session\` (\`parent_id\`);`)
      yield* tx.run(`CREATE INDEX \`todo_session_idx\` ON \`todo\` (\`session_id\`);`)
    })
  },
} satisfies Omit<DatabaseMigration.Migration, "id">
