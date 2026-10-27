import { Effect } from "effect"
import { sql } from "drizzle-orm"
import type { DatabaseMigration } from "../migration"

/** Managed follow-up recovery replays the exact durable ACK proof for a
 * consumed inbox row. The direct inbox already persists the proof JSON; the
 * managed inbox must store the same replayable receipt so recovery can
 * reconcile it against the live HostKernel scope without trusting caller
 * memory.
 *
 * The add is conditional: `20261021100000_managed_subagent_inbox` now creates the
 * table with `consumption_proof_json` already present, so an unconditional
 * "ALTER TABLE ... ADD COLUMN" fails with "duplicate column name" on every
 * database that ran the current create migration. Databases created before that
 * definition still need the column added here. */
export default {
  id: "20261023120000_managed_subagent_inbox_consumption_proof",
  up(tx) {
    return Effect.gen(function* () {
      const existing = new Set(
        (yield* tx.all<{ name: string }>(sql`SELECT name FROM pragma_table_info('managed_subagent_inbox')`)).map(
          (row) => row.name,
        ),
      )
      if (existing.has("consumption_proof_json")) return
      yield* tx.run(sql`ALTER TABLE \`managed_subagent_inbox\` ADD COLUMN \`consumption_proof_json\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
