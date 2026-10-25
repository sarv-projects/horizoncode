import path from "path"
import { Context, Effect, Layer } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import { FSUtil } from "../fs-util"
import { Global } from "../global"
import { which } from "../util/which"

export namespace RipgrepBinary {
  interface Interface {
    readonly filepath: Effect.Effect<string, Error>
  }

  export class Service extends Context.Service<Service, Interface>()("@opencode/RipgrepBinary") {}

  // Archive extraction would create a raw child-process origin (tar/PowerShell).
  // Keep bootstrap disabled until it is owned by the authenticated HostKernel path.
  export function extractionRouteAvailable(): boolean {
    return false
  }

  const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service

      return Service.of({
        filepath: yield* Effect.cached(
          Effect.gen(function* () {
            const system = yield* Effect.sync(() => which(process.platform === "win32" ? "rg.exe" : "rg"))
            if (system && (yield* fs.isFile(system).pipe(Effect.orDie))) return system

            const target = path.join(Global.Path.bin, `rg${process.platform === "win32" ? ".exe" : ""}`)
            if (yield* fs.isFile(target).pipe(Effect.orDie)) return target

            throw new Error("ripgrep binary bootstrap is unavailable until HostKernel Guarded process execution is wired")
          }),
        ),
      })
    }),
  )

  export const node = makeGlobalNode({ service: Service, layer: layer, deps: [FSUtil.node] })
}
