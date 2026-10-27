import "../preload"
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"

const fallbackTmp = path.resolve(import.meta.dir, "../../.p7-sandbox")

export async function tmpdir() {
  const base = process.env.TMPDIR || fallbackTmp
  await mkdir(base, { recursive: true })
  const directory = await realpath(await mkdtemp(path.join(base, "opencode-tui-test-")))
  return {
    path: directory,
    async [Symbol.asyncDispose]() {
      await rm(directory, { recursive: true, force: true })
    },
  }
}
