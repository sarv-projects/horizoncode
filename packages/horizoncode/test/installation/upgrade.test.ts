import { expect } from "bun:test"
import { AppNodeBuilder } from "@horizoncode/core/effect/app-node-builder"
import { AppProcess } from "@horizoncode/core/process"
import { Effect, Layer } from "effect"
import { HttpClient } from "effect/unstable/http"
import { httpClient } from "@horizoncode/core/effect/app-node-platform"
import { Installation } from "../../src/installation"
import { testEffect } from "../lib/effect"

let processCalls = 0
let networkCalls = 0

const processLayer = Layer.succeed(
  AppProcess.Service,
  AppProcess.Service.of({
    run: () => {
      processCalls += 1
      return Effect.succeed({ exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) })
    },
  } as never),
)

const networkLayer = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make(() => {
    networkCalls += 1
    return Effect.die(new Error("unexpected installation network request"))
  }),
)

const it = testEffect(AppNodeBuilder.build(Installation.node, [[AppProcess.node, processLayer], [httpClient, networkLayer]]))

it.effect("rejects direct installation upgrade before network or process effects", () =>
  Effect.gen(function* () {
    processCalls = 0
    networkCalls = 0
    const service = yield* Installation.Service
    const result = yield* service.upgrade("curl", "9.9.9").pipe(
      Effect.catchTag("UpgradeFailedError", (error) => Effect.succeed(error.stderr)),
    )

    expect(result).toBe("installation upgrade is unavailable in this release")
    expect(networkCalls).toBe(0)
    expect(processCalls).toBe(0)
  }),
)
