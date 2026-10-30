import { describe, expect, spyOn, test } from "bun:test"
import { PluginShellUnavailableError, unavailablePluginShell } from "../../src/plugin"
import { Process } from "@/util/process"

/**
 * C16 plugin-shell origin closure: plugin hook code no longer receives an unguarded host
 * shell runner. The capability object still implements the `BunShell` surface, but every
 * entry point refuses with a typed error before any process exists.
 */
describe("plugin shell origin", () => {
  test("refuses invocation and every configuration method with a typed error", () => {
    const shell = unavailablePluginShell()
    const bunSpawn = spyOn(Bun, "spawn")
    const processSpawn = spyOn(Process, "spawn")
    try {
      expect(() => shell`echo guarded`).toThrow(PluginShellUnavailableError)
      expect(() => shell.env({ EXAMPLE: "1" })).toThrow(PluginShellUnavailableError)
      expect(() => shell.cwd("/tmp")).toThrow(PluginShellUnavailableError)
      expect(() => shell.nothrow()).toThrow(PluginShellUnavailableError)
      expect(() => shell.throws(false)).toThrow(PluginShellUnavailableError)
      expect(() => shell.braces("{a,b}")).toThrow(PluginShellUnavailableError)
      expect(() => shell.escape("a b")).toThrow(PluginShellUnavailableError)
      expect(bunSpawn).not.toHaveBeenCalled()
      expect(processSpawn).not.toHaveBeenCalled()
    } finally {
      bunSpawn.mockRestore()
      processSpawn.mockRestore()
    }
  })

  test("the refusal is typed and names the missing Guard route", () => {
    try {
      unavailablePluginShell()`touch forbidden`
      throw new Error("expected refusal")
    } catch (error) {
      expect(error).toBeInstanceOf(PluginShellUnavailableError)
      expect((error as PluginShellUnavailableError)._tag).toBe("PluginShellUnavailableError")
      expect((error as PluginShellUnavailableError).reason).toBe("guard_not_verified")
      expect((error as Error).message).toContain("Guard/ExecutionHost")
    }
  })
})
