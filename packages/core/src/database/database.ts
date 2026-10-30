export * as Database from "./database"

import { EffectDrizzleSqlite } from "@horizoncode/effect-drizzle-sqlite"
import { layer as sqliteLayer } from "#sqlite"
import { Context, Effect, Layer } from "effect"
import { Global } from "../global"
import { Flag } from "../flag/flag"
import { isAbsolute, join } from "path"
import { DatabaseMigration } from "./migration"
import { InstallationChannel } from "../installation/version"
import { makeGlobalNode } from "../effect/app-node"
import { randomUUID } from "node:crypto"
import { sql } from "drizzle-orm"

const makeDatabase = EffectDrizzleSqlite.makeWithDefaults()
type DatabaseShape = Effect.Success<typeof makeDatabase>

export interface Interface {
  db: DatabaseShape
  readonly path: string
  readonly sourceStoreID: string
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/storage/Database") {}

const layerFromFilename = (filename: string) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const db = yield* makeDatabase

      yield* db.run("PRAGMA journal_mode = WAL")
      yield* db.run("PRAGMA synchronous = NORMAL")
      yield* db.run("PRAGMA busy_timeout = 5000")
      yield* db.run("PRAGMA cache_size = -64000")
      yield* db.run("PRAGMA foreign_keys = ON")
      yield* db.run("PRAGMA wal_checkpoint(PASSIVE)")
      yield* DatabaseMigration.apply(db)

      // SQLite has no cross-platform UUID default. Insert a cryptographically
      // random identity once; OR IGNORE makes concurrent process startup stable.
      yield* db.run(sql`
        INSERT OR IGNORE INTO core_source_identity (singleton_id, source_store_id)
        VALUES (1, ${`store_${randomUUID().replaceAll("-", "")}`})
      `)
      const sourceIdentity = yield* db.get<{ source_store_id: string }>(sql`
        SELECT source_store_id FROM core_source_identity WHERE singleton_id = 1
      `)
      if (!sourceIdentity || !/^[A-Za-z0-9._-]{1,256}$/.test(sourceIdentity.source_store_id)) {
        return yield* Effect.die("Core source-store identity is missing or malformed")
      }

      return { db, path: filename, sourceStoreID: sourceIdentity.source_store_id }
    }).pipe(Effect.orDie),
  ).pipe(Layer.provide(sqliteLayer({ filename })))

export function layerFromPath(filename: string) {
  return layerFromFilename(filename)
}

export function path() {
  if (Flag.OPENCODE_DB) {
    if (Flag.OPENCODE_DB === ":memory:" || isAbsolute(Flag.OPENCODE_DB)) return Flag.OPENCODE_DB
    return join(Global.Path.data, Flag.OPENCODE_DB)
  }
  if (
    ["latest", "beta", "prod"].includes(InstallationChannel) ||
    process.env.OPENCODE_DISABLE_CHANNEL_DB === "1" ||
    process.env.OPENCODE_DISABLE_CHANNEL_DB === "true"
  )
    return join(Global.Path.data, "opencode.db")
  return join(Global.Path.data, `opencode-${InstallationChannel.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`)
}

export const node = makeGlobalNode({ service: Service, layer: layerFromPath(path()), deps: [] })

