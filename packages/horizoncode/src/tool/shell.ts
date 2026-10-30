import { Effect, Option } from "effect"
import * as Tool from "./tool"
import { InstanceState } from "@/effect/instance-state"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Shell } from "@horizoncode/core/shell"
import { ShellPrompt } from "./shell/prompt"
import * as Truncate from "./truncate"
import { Pty } from "@horizoncode/core/pty"
import { LocationServiceMap } from "@horizoncode/core/location-services"
import { Location } from "@horizoncode/core/location"
import { AbsolutePath } from "@horizoncode/core/schema"
import { TrustedPrincipalContext } from "@horizoncode/core/trusted-principal"
import type { EffectLease } from "@horizoncode/core/session/supervisor"
import {
  acceptDirectAttemptReceipt,
  acceptDirectTurnBatchReceipt,
  settleToolBatchLease,
  type ToolBatchDirectAttemptAuthority,
} from "@/session/tool-batch"
import { formatVerifyOutput, verificationStatus } from "./verify/parameters"
import { effectMutationPrincipalAllowed } from "@/util/effect-mutation-principal"
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
              const admitted = ctx.extra?.guardedPatch as Record<string, unknown> | undefined
              // `terminal.run` is admitted with exactly three arguments. A patch
              // shaped any other way is refused by the kernel with a bare tag, so
              // check it here where we can still explain what is missing.
              if (admitted === undefined || admitted === null || typeof admitted !== "object") {
                return yield* Effect.fail(new Error("Shell denied: no admitted terminal.run arguments"))
              }
              if (admitted.mode !== "workspace_profile") {
                const problems: string[] = []
                if (typeof admitted.command !== "string" || admitted.command.length === 0) problems.push("command")
                if (typeof admitted.cwd !== "string" || admitted.cwd.length === 0) problems.push("cwd")
                if (!Number.isSafeInteger(admitted.timeoutMs)) problems.push("timeoutMs")
                if (problems.length > 0)
                  return yield* Effect.fail(
                    new Error(
                      `Shell denied: admitted terminal.run arguments are incomplete (missing or invalid: ${problems.join(", ")}; keys present: ${Object.keys(admitted).join(", ") || "none"})`,
                    ),
                  )
              }
              const trustedPrincipal = ctx.trustedPrincipal
              if (!effectMutationPrincipalAllowed(trustedPrincipal)) {
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
              const directAttempt = ctx.extra?.directAttempt as ToolBatchDirectAttemptAuthority | undefined
              const directAttemptScope = directAttempt?.currentScope()
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
                  ...(directAttempt?.directTurn ? { directTurnScope: directAttempt.directTurn.currentScope() } : {}),
                })
              }).pipe(
                Effect.provide(locations.value.get(locationRef)),
                Effect.provideService(TrustedPrincipalContext, { principal: trustedPrincipal }),
              )
              if (directAttemptScope) {
                if (!result.directAttempt || result.attemptScopeTransition !== "effect_receipt") {
                  return yield* Effect.fail(new Error("Shell denied: HostKernel omitted direct Attempt receipt scope"))
                }
                acceptDirectAttemptReceipt(directAttempt, directAttemptScope, result)
                if (directAttempt?.directTurn && result.directTurnScope) {
                  yield* Effect.promise(() => acceptDirectTurnBatchReceipt(directAttempt, result))
                }
              }
              yield* Effect.promise(() => settleToolBatchLease(lease, { effectID: lease.effectID }))
              // Give the model the opaque receipt-bound ref needed to search
              // captured output. Raw artifact contents remain available only
              // through the existing authenticated ArtifactControl range path.
              const searchableArtifact = result.artifactRef &&
                result.artifactRef.classification !== "sensitive" &&
                (result.artifactFidelity === "FULL" || result.artifactFidelity === "SAMPLE")
                ? `\n[Captured output artifact: ${JSON.stringify(result.artifactRef)}. Use terminal_search or artifacts_search_text to search its text.]`
                : ""
              const label = typeof params.label === "string" ? params.label.trim() : ""
              const preview = `${result.preview}${searchableArtifact}`
              if (label) {
                const status = verificationStatus(result.exitCode)
                return {
                  title: `${label}: ${status}`,
                  metadata: {
                    label,
                    verificationStatus: status,
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
                  output: formatVerifyOutput(label, status, preview),
                }
              }
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
                output: preview,
              }
            }).pipe(Effect.orDie),
        }
      })
  }),
)
