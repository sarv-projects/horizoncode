import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261019220242_managed_session_link_identity_indexes",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(
        `CREATE UNIQUE INDEX \`core_source_store_identity_unique\` ON \`core_source_identity\` (\`source_store_id\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`project_directory_source_instance_unique\` ON \`project_directory\` (\`source_instance_id\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
