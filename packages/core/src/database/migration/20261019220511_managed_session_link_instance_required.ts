import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261019220511_managed_session_link_instance_required",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`PRAGMA foreign_keys=OFF;`)
      yield* tx.run(`
        CREATE TABLE \`__new_project_directory\` (
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
      yield* tx.run(
        `INSERT INTO \`__new_project_directory\`(\`project_id\`, \`directory\`, \`type\`, \`strategy\`, \`source_instance_id\`, \`time_created\`) SELECT \`project_id\`, \`directory\`, \`type\`, \`strategy\`, \`source_instance_id\`, \`time_created\` FROM \`project_directory\`;`,
      )
      yield* tx.run(`DROP TABLE \`project_directory\`;`)
      yield* tx.run(`ALTER TABLE \`__new_project_directory\` RENAME TO \`project_directory\`;`)
      yield* tx.run(`PRAGMA foreign_keys=ON;`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`project_directory_source_instance_unique\` ON \`project_directory\` (\`source_instance_id\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
