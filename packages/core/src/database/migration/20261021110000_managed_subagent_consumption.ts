import { Effect } from "effect"
import { sql } from "drizzle-orm"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261021110000_managed_subagent_consumption",
  up(tx) {
    return Effect.gen(function* () {
      const existing = new Set(
        (yield* tx.all<{ name: string }>(sql`SELECT name FROM pragma_table_info('managed_subagent_inbox')`)).map(
          (row) => row.name,
        ),
      )
      const addColumn = (name: string) =>
        Effect.gen(function* () {
          if (existing.has(name)) return
          yield* tx.run(sql`ALTER TABLE \`managed_subagent_inbox\` ADD COLUMN ${sql.identifier(name)} text;`)
        })
      for (const column of [
        "delivery_prompt_message_id",
        "delivery_scope_digest",
        "delivery_workspace_id",
        "delivery_workspace_revision",
        "consumption_ack_digest",
        "host_consumed_ack_digest",
        "wake_claim_request_id",
        "wake_claim_digest",
        "wake_claim_scope_digest",
        "wake_claim_receipt_digest",
      ]) {
        yield* addColumn(column)
      }
    })
  },
} satisfies DatabaseMigration.Migration
