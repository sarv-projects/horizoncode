import { describe, expect, spyOn, test } from "bun:test"
import {
  LanguageServiceProcessError,
  assertLanguageServiceProcessAllowed,
  languageServiceProcessRouteAvailable,
} from "../../src/lsp/launch"
import * as LSPServer from "@/lsp/server"
import { Process } from "@/util/process"
import { Filesystem } from "@/util/filesystem"
import { Module } from "@opencode-ai/core/util/module"
import * as Which from "@opencode-ai/core/util/which"
import { Npm } from "@opencode-ai/core/npm"

const OPERATIONS = ["server.spawn", "server.install", "server.restart", "server.stop", "server.probe"] as const

describe("lsp.launch guard mediation", () => {
  test("refuses process effects without exposing a raw launch API", () => {
    const bunSpawn = spyOn(Bun, "spawn")
    const processSpawn = spyOn(Process, "spawn")
    try {
      expect(() => assertLanguageServiceProcessAllowed("server.spawn")).toThrow(LanguageServiceProcessError)
      expect(bunSpawn).not.toHaveBeenCalled()
      expect(processSpawn).not.toHaveBeenCalled()
    } finally {
      bunSpawn.mockRestore()
      processSpawn.mockRestore()
    }
  })

  test("every language-service process operation is gated and typed", () => {
    for (const operation of OPERATIONS) {
      let thrown: unknown
      try {
        assertLanguageServiceProcessAllowed(operation)
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(LanguageServiceProcessError)
      expect((thrown as LanguageServiceProcessError).operation).toBe(operation)
      expect((thrown as LanguageServiceProcessError).reason).toBe("guard_not_verified")
    }
    expect(languageServiceProcessRouteAvailable()).toBe(false)
  })

  test("a server spawn implementation cannot start an unmediated process", async () => {
    const resolve = spyOn(Module, "resolve").mockReturnValue("/fake/typescript/lib/tsserver.js")
    const which = spyOn(Npm, "which").mockResolvedValue("/fake/typescript-language-server")
    const processSpawn = spyOn(Process, "spawn")
    try {
      await expect(
        LSPServer.Typescript.spawn("/workspace", { directory: "/workspace" } as never, {} as never),
      ).rejects.toThrow(LanguageServiceProcessError)
      expect(processSpawn).not.toHaveBeenCalled()
    } finally {
      resolve.mockRestore()
      which.mockRestore()
      processSpawn.mockRestore()
    }
  })

  test("the ESLint installer is denied before fetching or writing an archive", async () => {
    const resolve = spyOn(Module, "resolve").mockReturnValue("/fake/eslint")
    const exists = spyOn(Filesystem, "exists").mockResolvedValue(false)
    const fetch = spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected network request"))
    const writeStream = spyOn(Filesystem, "writeStream")
    try {
      await expect(
        LSPServer.ESLint.spawn(
          "/workspace",
          { directory: "/workspace", worktree: "/workspace" } as never,
          {
            disableLspDownload: false,
          } as never,
        ),
      ).rejects.toBeInstanceOf(LanguageServiceProcessError)
      expect(fetch).not.toHaveBeenCalled()
      expect(writeStream).not.toHaveBeenCalled()
    } finally {
      resolve.mockRestore()
      exists.mockRestore()
      fetch.mockRestore()
      writeStream.mockRestore()
    }
  })

  test("Vue package resolution is denied before Npm.which can install a package", async () => {
    const which = spyOn(Which, "which").mockReturnValue(null)
    const npmWhich = spyOn(Npm, "which").mockResolvedValue(undefined)
    try {
      await expect(
        LSPServer.Vue.spawn(
          "/workspace",
          { directory: "/workspace", worktree: "/workspace" } as never,
          {
            disableLspDownload: false,
          } as never,
        ),
      ).rejects.toBeInstanceOf(LanguageServiceProcessError)
      expect(npmWhich).not.toHaveBeenCalled()
    } finally {
      which.mockRestore()
      npmWhich.mockRestore()
    }
  })

  test("language-service lifecycle uses the canonical Guarded action names only", async () => {
    const path = await import("node:path")
    const guard = await Bun.file(path.resolve(import.meta.dir, "../../../../kernel/src/guard.rs")).text()
    const catalog = await Bun.file(
      path.resolve(import.meta.dir, "../../../../arch_V1/33-BUILTIN-CAPABILITIES-CATALOG.md"),
    ).text()
    const registry = await Bun.file(
      path.resolve(import.meta.dir, "../../../../arch_V1/contracts-v2/capability-registry-v1.json"),
    ).text()
    for (const action of ["language.start", "language.stop"]) {
      expect(guard).toContain(`"${action}"`)
      expect(catalog).toContain(action)
      expect(registry).toContain(`"${action}"`)
    }
    // No second/legacy action family may become a parallel authority.
    for (const obsolete of ["language.server.start", "language.server.stop"]) {
      expect(guard).not.toContain(obsolete)
      expect(catalog).not.toContain(obsolete)
      expect(registry).not.toContain(obsolete)
    }
    expect(languageServiceProcessRouteAvailable()).toBe(false)
  })
})
