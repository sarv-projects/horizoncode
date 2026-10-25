import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

/** Managed follow-up recovery replays the exact durable ACK proof for a
 * consumed inbox row. The direct inbox already persists the proof JSON; the
 * managed inbox must store the same replayable receipt so recovery can
 * reconcile it against the live HostKernel scope without trusting caller
 * memory. */
export default {
  id: "20261023120000_managed_subagent_inbox_consumption_proof",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`managed_subagent_inbox\` ADD COLUMN \`consumption_proof_json\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
