import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261022120000_direct_provider_request_journal",
  up(tx) {
    return Effect.gen(function* () {
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
          PRIMARY KEY (\`owner_binding\`, \`session_id\`, \`request_id\`),
          CONSTRAINT \`direct_provider_request_state_ck\` CHECK (\`state\` IN ('PINNED','DISPATCHING','SETTLED','UNKNOWN')),
          CONSTRAINT \`direct_provider_request_digest_ck\` CHECK (
            length(\`pin_digest\`) = 71 AND \`pin_digest\` LIKE 'blake3:%' AND
            length(\`normalized_input_digest\`) = 71 AND \`normalized_input_digest\` LIKE 'blake3:%' AND
            length(\`transport_request_digest\`) = 71 AND \`transport_request_digest\` LIKE 'blake3:%' AND
            length(\`context_selection_digest\`) = 71 AND \`context_selection_digest\` LIKE 'blake3:%'
          ),
          CONSTRAINT \`direct_provider_request_session_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`CREATE INDEX \`direct_provider_request_session_state_idx\` ON \`direct_provider_request\` (\`session_id\`,\`state\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
