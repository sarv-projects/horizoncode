import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

/** One random immutable source identity per Core session database. */
export const CoreSourceIdentityTable = sqliteTable(
  "core_source_identity",
  {
    singleton_id: integer().primaryKey(),
    source_store_id: text().notNull(),
  },
  (table) => [uniqueIndex("core_source_store_identity_unique").on(table.source_store_id)],
)

export const Timestamps = {
  time_created: integer()
    .notNull()
    .$default(() => Date.now()),
  time_updated: integer()
    .notNull()
    .$onUpdate(() => Date.now()),
}
