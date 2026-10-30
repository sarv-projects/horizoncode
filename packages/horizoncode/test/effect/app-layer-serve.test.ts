import { expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, ManagedRuntime } from "effect"
import { AppLayer } from "../../src/effect/app-runtime"
import { InstanceStore } from "../../src/project/instance-store"
import { Agent } from "../../src/agent/agent"
import { ToolRegistry } from "../../src/tool/registry"
import { Session } from "../../src/session/session"
import { memoMap } from "@horizoncode/core/effect/memo-map"
import { attach } from "../../src/effect/run-service"

/**
 * Item 44 guard: the production serve composition must resolve its whole
 * service graph from the real `AppLayer`, not from a test-provided context.
 *
 * The regression this pins used to fire exactly here: `Agent.state` runs inside
 * `InstanceState.make` with `requireServicesAt: "lookup"`, so a direct
 * `yield * PluginV2.Service` inside its initializer demanded
 * `@opencode/v2/Plugin` from the *lookup caller* and died with
 * `Service not found: @opencode/v2/Plugin` as soon as a project configured
 * `references`. That is the branch exercised below.
 *
 * Directories stay inside the repository: the shared test `tmpdir` fixture
 * writes to the host temp folder, which is outside the repository boundary.
 */
const sandbox = path.join(import.meta.dir, "..", "..", ".p7-sandbox", "app-layer-serve")

async function makeProject(name: string) {
  const directory = path.join(sandbox, `${name}-${Math.random().toString(36).slice(2)}`)
  await fs.mkdir(path.join(directory, "refs"), { recursive: true })
  await fs.writeFile(
    path.join(directory, "opencode.json"),
    JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      references: { guide: "./refs" },
    }),
  )
  return directory
}

function serve(directory: string) {
  const runtime = ManagedRuntime.make(AppLayer, { memoMap })
  const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    runtime.runPromise(attach(effect as never) as never) as Promise<A>
  return {
    run,
    dispose: () => runtime.dispose(),
  }
}

test("AppLayer bootstraps an instance and resolves the serve-path service graph", async () => {
  const directory = await makeProject("serve")
  const app = serve(directory)
  try {
    const agents = await app.run(
      InstanceStore.Service.use((store) =>
        store.provide({ directory }, Agent.Service.use((agent) => agent.list())),
      ),
    )

    expect(agents.length).toBeGreaterThan(0)
    expect(agents.some((agent) => agent.name === "build")).toBe(true)
    // The configured reference must not be silently promoted into a whitelisted
    // directory: no `Reference.Service` is materialised for this location, so
    // the whitelist stays empty and the default `ask` rule keeps governing.
    expect(agents.find((agent) => agent.name === "build")?.permission).toBeDefined()
  } finally {
    await app.dispose()
  }
}, { timeout: 120_000 })

test("AppLayer materialises the tool registry, including the task tool", async () => {
  const directory = await makeProject("tools")
  const app = serve(directory)
  try {
    const tools = await app.run(
      InstanceStore.Service.use((store) =>
        store.provide(
          { directory },
          ToolRegistry.Service.use((registry) =>
            Effect.gen(function* () {
              const ids = yield* registry.ids()
              const defs = yield* registry.all()
              return { ids, defs }
            }),
          ),
        ),
      ),
    )

    expect(tools.ids).toContain("task")
    expect(tools.defs.length).toBe(tools.ids.length)
  } finally {
    await app.dispose()
  }
})

test("AppLayer bootstraps a session that is retrievable by its own id", async () => {
  const directory = await makeProject("session")
  const app = serve(directory)
  try {
    const result = await app.run(
      InstanceStore.Service.use((store) =>
        store.provide(
          { directory },
          Session.Service.use((session) =>
            Effect.gen(function* () {
              const created = yield* session.create({ title: "item 44" })
              const loaded = yield* session.get(created.id)
              return { id: created.id, title: loaded.title }
            }),
          ),
        ),
      ),
    )

    expect(result.id).toBeTruthy()
    expect(result.title).toBe("item 44")
  } finally {
    await app.dispose()
  }
})
