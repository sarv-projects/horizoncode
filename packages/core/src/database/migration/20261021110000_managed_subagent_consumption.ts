import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261021110000_managed_subagent_consumption",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`managed_subagent_inbox\` ADD COLUMN \`delivery_prompt_message_id\` text;`)
      yield* tx.run(`ALTER TABLE \`managed_subagent_inbox\` ADD COLUMN \`delivery_scope_digest\` text;`)
      yield* tx.run(`ALTER TABLE \`managed_subagent_inbox\` ADD COLUMN \`delivery_workspace_id\` text;`)
      yield* tx.run(`ALTER TABLE \`managed_subagent_inbox\` ADD COLUMN \`delivery_workspace_revision\` text;`)
      yield* tx.run(`ALTER TABLE \`managed_subagent_inbox\` ADD COLUMN \`consumption_ack_digest\` text;`)
      yield* tx.run(`ALTER TABLE \`managed_subagent_inbox\` ADD COLUMN \`host_consumed_ack_digest\` text;`)
      yield* tx.run(`ALTER TABLE \`managed_subagent_inbox\` ADD COLUMN \`wake_claim_request_id\` text;`)
      yield* tx.run(`ALTER TABLE \`managed_subagent_inbox\` ADD COLUMN \`wake_claim_digest\` text;`)
      yield* tx.run(`ALTER TABLE \`managed_subagent_inbox\` ADD COLUMN \`wake_claim_scope_digest\` text;`)
      yield* tx.run(`ALTER TABLE \`managed_subagent_inbox\` ADD COLUMN \`wake_claim_receipt_digest\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
