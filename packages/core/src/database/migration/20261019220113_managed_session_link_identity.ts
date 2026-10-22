import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261019220113_managed_session_link_identity",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`core_source_identity\` (
          \`singleton_id\` integer PRIMARY KEY,
          \`source_store_id\` text NOT NULL
        );
      `)
      yield* tx.run(`ALTER TABLE \`project_directory\` ADD \`source_instance_id\` text;`)
      yield* tx.run(`UPDATE \`project_directory\` SET \`source_instance_id\` = 'instance_' || lower(hex(randomblob(16))) WHERE \`source_instance_id\` IS NULL;`)
      yield* tx.run(`ALTER TABLE \`session\` ADD \`source_epoch\` integer DEFAULT 1 NOT NULL;`)
    })
  },
} satisfies DatabaseMigration.Migration
