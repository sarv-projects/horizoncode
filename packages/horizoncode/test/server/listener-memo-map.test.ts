import { afterEach, describe, expect, test } from "bun:test"
import net from "node:net"
import { Context, Effect, Exit, Layer, Scope } from "effect"
import { memoMap } from "@horizoncode/core/effect/memo-map"
import { LayerNode } from "@horizoncode/core/effect/layer-node"
import { SessionSupervisor } from "@horizoncode/core/session/supervisor"
import { WebSocketTracker } from "../../src/server/routes/instance/httpapi/websocket-tracker"
import { Server } from "../../src/server/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances } from "../fixture/fixture"

/**
 * Source-run `hzcode serve` died with
 * `acquire host owner lease: supervisor lease Busy`: `ManagedRuntime.make(AppLayer,
 * { memoMap })` (AppRuntime) constructs `SessionSupervisor.layer` — which spawns
 * `hz-kernel` and takes the process-exclusive host-owner lease — in the
 * process-wide memo map, while the listener built the whole route tree in a
 * private map. Effect memoizes per MemoMap, so the listener constructed a second
 * supervisor whose child correctly refused the lease already held.
 *
 * `createListenerRoutes` fixes exactly that split:
 *
 * - the **app-service graph** (supervisor, Database, EventV2, …) is built
 *   through the process-wide memo map, so `SessionSupervisor` is constructed
 *   once per process — witnessed here by the supervisor's layer showing up in
 *   the process map as soon as a listener starts;
 * - the **route tree** stays local to the listener attempt, so each listener
 *   keeps its own cors/auth/ConfigProvider wiring — witnessed here by
 *   `WebSocketTracker.node`, which only `listenerLayer` builds, *not* showing
 *   up in the process map.
 */
const listenerOnlyLayer = layerImplementation(WebSocketTracker.node)
const supervisorLayer = layerImplementation(SessionSupervisor.node)

function layerImplementation(node: LayerNode.Node<unknown, unknown, any>): Layer.Layer<unknown, unknown, never> {
  const implementation = node.implementation
  if (implementation === undefined) throw new Error(`node ${node.name} has no implementation`)
  return implementation as unknown as Layer.Layer<unknown, unknown, never>
}

/**
 * Is `layer` currently memoized in `map`?
 *
 * `MemoMap.get` bumps the entry's observer count synchronously, so the probe
 * runs the returned effect (the entry is already built, so this only registers
 * the matching finalizer on the probe scope) and then closes that scope to
 * hand the observer straight back.
 */
function memoized(layer: Layer.Layer<unknown, unknown, never>, map: Layer.MemoMap = memoMap): boolean {
  const probeScope = Scope.makeUnsafe()
  const hit = map.get(layer, probeScope)
  if (hit === undefined) return false
  try {
    Effect.runSync(hit)
  } finally {
    Effect.runSync(Scope.close(probeScope, Exit.void))
  }
  return true
}

function closeScope(scope: Scope.Scope) {
  return Effect.runPromise(Scope.close(scope, Exit.void))
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("listener layer memoization", () => {
  test("a listener shares the process-wide service graph and keeps its route graph private", async () => {
    const supervisorBefore = memoized(supervisorLayer)

    const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
    try {
      // RED before the fix: the listener built the app-service graph in a
      // private map, so the process-wide map never saw the SessionSupervisor —
      // and the listener constructed a second one (second hz-kernel, `Busy`).
      expect(memoized(supervisorLayer), "SessionSupervisor must be memoized process-wide").toBe(true)
      // The route tree must NOT be shared: a process-wide route entry lets a
      // previously built webHandler satisfy this listener and drop the
      // listener's own cors/auth/ConfigProvider wiring.
      expect(memoized(listenerOnlyLayer), "the listener route graph must stay private").toBe(false)
    } finally {
      await listener.stop(true)
    }

    // Stopping the listener closes its scope, which drops its observations:
    // whatever the process map held before this test is what it holds after.
    expect(memoized(supervisorLayer)).toBe(supervisorBefore)
    expect(memoized(listenerOnlyLayer)).toBe(false)
  })

  test("a failed port attempt releases its observation before the fallback listener starts", async () => {
    const blocker = await occupyPort(4096)
    if (!blocker) return
    try {
      const before = memoized(supervisorLayer)
      // port 0 tries 4096 first, fails to bind, closes that attempt's scope,
      // and only then builds the fallback listener.
      const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
      try {
        expect(listener.port).not.toBe(4096)
        expect(listener.port).toBeGreaterThan(0)
        expect(memoized(supervisorLayer)).toBe(true)
        expect(memoized(listenerOnlyLayer)).toBe(false)
      } finally {
        await listener.stop(true)
      }
      expect(memoized(supervisorLayer)).toBe(before)
      expect(memoized(listenerOnlyLayer)).toBe(false)
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()))
    }
  })

  test("service builds routed through the process map are constructed once across private builds", async () => {
    let constructions = 0
    class Probe extends Context.Service<Probe, { readonly count: number }>()("p1/ListenerMemoProbe") {}
    const implementation = Layer.sync(Probe)(() => {
      constructions += 1
      return Probe.of({ count: constructions })
    })
    const node = LayerNode.make({ name: "p1.listener-memo-probe", layer: implementation, deps: [] })

    // Mirrors `share(...)` in `createListenerRoutes`: the outer build runs in a
    // private memo map, the service build is delegated to the process-wide one.
    const share = <A, E, R>(build: Layer.Layer<A, E, R>): Layer.Layer<A, E, R> =>
      Layer.fromBuild((_, scope) => Layer.buildWithMemoMap(build, memoMap, scope))

    const scopes: Scope.Scope[] = []
    const build = async <A, E>(services: Layer.Layer<A, E, never>) => {
      const scope = Scope.makeUnsafe()
      scopes.push(scope)
      await Effect.runPromise(Layer.buildWithMemoMap(services, Layer.makeMemoMapUnsafe(), scope))
    }

    await build(share(LayerNode.compile(LayerNode.group([node]))))
    expect(constructions).toBe(1)
    await build(share(LayerNode.compile(LayerNode.group([node]))))
    expect(constructions).toBe(1)

    // Pre-fix behavior: the same graph compiled and built directly in a private
    // map — a second construction, and for SessionSupervisor a second hz-kernel
    // competing for the host-owner lease.
    await build(LayerNode.compile(LayerNode.group([node])))
    expect(constructions).toBe(2)

    await Promise.all(scopes.map(closeScope))
  })
})

function occupyPort(port: number) {
  return new Promise<net.Server | undefined>((resolve) => {
    const server = net.createServer()
    server.once("error", () => resolve(undefined))
    server.listen(port, "127.0.0.1", () => resolve(server))
  })
}
