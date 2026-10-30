import { rm } from "fs/promises"
import { Database } from "@horizoncode/core/database/database"
import { disposeAllInstances } from "./fixture"

export async function resetDatabase(databasePath = Database.path()) {
  await disposeAllInstances().catch(() => undefined)
  await rm(databasePath, { force: true }).catch(() => undefined)
  await rm(`${databasePath}-wal`, { force: true }).catch(() => undefined)
  await rm(`${databasePath}-shm`, { force: true }).catch(() => undefined)
}
