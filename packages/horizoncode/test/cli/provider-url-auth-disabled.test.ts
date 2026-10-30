import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { Effect } from "effect"
import { Auth } from "../../src/auth"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Process } from "../../src/util/process"
import { ProvidersLoginCommand, ProvidersLogoutCommand } from "../../src/cli/cmd/providers"

const originalFetch = globalThis.fetch
let fetchSpy: ReturnType<typeof spyOn> | undefined
let spawnSpy: ReturnType<typeof spyOn> | undefined
let authSpies: Array<ReturnType<typeof spyOn>> = []

afterEach(() => {
  fetchSpy?.mockRestore()
  spawnSpy?.mockRestore()
  for (const spy of authSpies) spy.mockRestore()
  authSpies = []
  globalThis.fetch = originalFetch
})

describe("URL-based provider login", () => {
  test("is denied before metadata fetch, process launch, or credential mutation", async () => {
    const auth = await AppRuntime.runPromise(Auth.Service)
    const authGet = spyOn(auth, "get").mockImplementation(() => Effect.succeed(undefined))
    const authAll = spyOn(auth, "all").mockImplementation(() => Effect.succeed({}))
    const authSet = spyOn(auth, "set").mockImplementation(() => Effect.void)
    const authRemove = spyOn(auth, "remove").mockImplementation(() => Effect.void)
    authSpies = [authGet, authAll, authSet, authRemove]
    fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected provider metadata fetch"))
    spawnSpy = spyOn(Process, "spawn").mockImplementation(() => {
      throw new Error("unexpected provider process launch")
    })

    await expect(
      ProvidersLoginCommand.handler({ url: "https://provider.example.invalid", _: [], "--": [] } as never),
    ).rejects.toThrow("Provider login is unavailable until guarded execution is implemented")

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(spawnSpy).not.toHaveBeenCalled()
    expect(authGet).not.toHaveBeenCalled()
    expect(authAll).not.toHaveBeenCalled()
    expect(authSet).not.toHaveBeenCalled()
    expect(authRemove).not.toHaveBeenCalled()
  })
})

describe("provider credential mutation CLI", () => {
  test("denies interactive login before provider discovery, plugin auth, prompts, or credential access", async () => {
    const auth = await AppRuntime.runPromise(Auth.Service)
    const authGet = spyOn(auth, "get").mockImplementation(() => Effect.succeed(undefined))
    const authAll = spyOn(auth, "all").mockImplementation(() => Effect.succeed({}))
    const authSet = spyOn(auth, "set").mockImplementation(() => Effect.void)
    const authRemove = spyOn(auth, "remove").mockImplementation(() => Effect.void)
    authSpies = [authGet, authAll, authSet, authRemove]
    fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected provider discovery"))

    await expect(
      ProvidersLoginCommand.handler({ _: [], "--": [] } as never),
    ).rejects.toThrow("Provider login is unavailable until guarded execution is implemented")

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(authGet).not.toHaveBeenCalled()
    expect(authAll).not.toHaveBeenCalled()
    expect(authSet).not.toHaveBeenCalled()
    expect(authRemove).not.toHaveBeenCalled()
  })

  test("denies logout before reading or deleting provider credentials", async () => {
    const auth = await AppRuntime.runPromise(Auth.Service)
    const authAll = spyOn(auth, "all").mockImplementation(() => Effect.succeed({}))
    const authRemove = spyOn(auth, "remove").mockImplementation(() => Effect.void)
    authSpies = [authAll, authRemove]

    await expect(
      ProvidersLogoutCommand.handler({ provider: "provider-a", _: [], "--": [] } as never),
    ).rejects.toThrow("Provider logout is unavailable until guarded execution is implemented")

    expect(authAll).not.toHaveBeenCalled()
    expect(authRemove).not.toHaveBeenCalled()
  })
})
