import { Effect, Option } from "effect"
import * as Tool from "./tool"
import { InstanceState } from "@/effect/instance-state"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Shell } from "@opencode-ai/core/shell"
import { ShellPrompt } from "./shell/prompt"
import * as Truncate from "./truncate"
import { Pty } from "@opencode-ai/core/pty"
import { LocationServiceMap } from "@opencode-ai/core/location-services"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { TrustedPrincipalContext } from "@opencode-ai/core/trusted-principal"
import type { DirectAttemptScopeV1, EffectLease } from "@opencode-ai/core/session/supervisor"
import type { Parameters } from "./shell/prompt"

export { Parameters } from "./shell/prompt"

function isLease(value: unknown): value is EffectLease {
  if (typeof value !== "object" || value === null) return false
  return (
    "effectID" in value &&
    typeof value.effectID === "string" &&
    "capabilityLeaseDigest" in value &&
    typeof value.capabilityLeaseDigest === "string" &&
    /^blake3:[0-9a-f]{64}$/.test(value.capabilityLeaseDigest)
  )
}

export const ShellTool = Tool.define(
  "bash",
  Effect.gen(function* () {
    const config = yield* Config.Service
    const trunc = yield* Truncate.Service
    const flags = yield* RuntimeFlags.Service
    const locations = yield* Effect.serviceOption(LocationServiceMap.Service)
    const defaultTimeoutMs = flags.bashDefaultTimeoutMs ?? 2 * 60 * 1000

    return () =>
      Effect.gen(function* () {
        const cfg = yield* config.get()
        const shell = Shell.acceptable(cfg.shell)
        const limits = yield* trunc.limits()
        const prompt = ShellPrompt.render(Shell.name(shell), process.platform, limits, defaultTimeoutMs)

        return {
          description: prompt.description,
          parameters: prompt.parameters,
          capability: { id: "terminal.run", effectClass: "effect" },
          execute: (params: Parameters, ctx: Tool.Context) =>
            Effect.gen(function* () {
              const instance = yield* InstanceState.context
              const lease = ctx.extra?.guardedLease
              if (!isLease(lease)) return yield* Effect.fail(new Error("Shell denied: missing Rust Guard lease"))
              const trustedPrincipal = ctx.trustedPrincipal
              if (trustedPrincipal?.kind !== "server_auth" || !trustedPrincipal.subject) {
                return yield* Effect.fail(new Error("Shell denied: missing authenticated principal"))
              }
              const callID = ctx.callID
              if (typeof callID !== "string" || callID.length === 0) {
                return yield* Effect.fail(new Error("Shell denied: tool call has no callID to bind to its lease"))
              }
              if (!Option.isSome(locations))
                return yield* Effect.fail(
                  new Error("Shell unavailable: PTY location services are not bound in this runtime"),
                )

              yield* ctx.metadata({ metadata: { output: "", status: "running" } })
              const locationRef = Location.Ref.make({ directory: AbsolutePath.make(instance.directory) })
              const result = yield* Effect.gen(function* () {
                const terminal = yield* Pty.Service
                return yield* terminal.runTool({
                  sessionID: ctx.sessionID,
                  locationRef,
                  lease,
                  call: {
                    callID,
                    capabilityID: "terminal.run",
                    arguments: ctx.extra?.guardedPatch,
                  },
                  ...(ctx.extra?.directAttempt !== undefined
                    ? { directAttempt: ctx.extra.directAttempt as DirectAttemptScopeV1 }
                    : {}),
                })
              }).pipe(
                Effect.provide(locations.value.get(locationRef)),
                Effect.provideService(TrustedPrincipalContext, { principal: trustedPrincipal }),
              )
              return {
                title: params.command,
                metadata: {
                  output: result.preview,
                  status: result.status,
                  ...(result.exitCode === undefined ? {} : { exit: result.exitCode }),
                  artifactRef: result.artifactRef,
                  receiptRef: result.receiptRef,
                  previewTruncated: result.previewTruncated,
                  artifactTruncated: result.artifactTruncated,
                  artifactFidelity: result.artifactFidelity,
                  truncated: result.previewTruncated || result.artifactTruncated,
                },
                output: result.preview,
              }
            }).pipe(Effect.orDie),
        }
      })
  }),
)
