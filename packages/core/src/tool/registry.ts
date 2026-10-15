export * as ToolRegistry from "./registry"

import { ToolOutput, type ToolCall, type ToolDefinition, type ToolResultValue } from "@opencode-ai/llm"
import { Context, Effect, Layer, Scope } from "effect"
import { AgentV2 } from "../agent"
import { PermissionV2 } from "../permission"
import { SessionMessage } from "../session/message"
import { SessionSchema } from "../session/schema"
import { ToolOutputStore } from "../tool-output-store"
import { ApplicationTools } from "./application-tools"
import { Tools } from "./tools"
import { isBuiltinWrite } from "./write-provenance"
import { Wildcard } from "../util/wildcard"
import { capability, definition, permission, settle, validate as validateInput, validateName, type AnyTool, type Capability, type EffectLease, type RegistrationError } from "./tool"
import { makeLocationNode } from "../effect/app-node"

export type ExecuteInput = {
  readonly sessionID: SessionSchema.ID
  readonly agent: AgentV2.ID
  readonly assistantMessageID: SessionMessage.ID
  readonly call: ToolCall
  readonly effect?: EffectLease
}

export interface Interface {
  readonly materialize: (permissions?: PermissionV2.Ruleset) => Effect.Effect<Materialization>
  /** Internal registration capability exposed publicly only through Tools.Service. */
  readonly register: (tools: Readonly<Record<string, AnyTool>>) => Effect.Effect<void, RegistrationError, Scope.Scope>
}

export interface Materialization {
  readonly definitions: ReadonlyArray<ToolDefinition>
  /** Validate a completed call against the registration pinned into this materialization. */
  readonly validate: (call: ToolCall) => Effect.Effect<string | undefined>
  /** Resolve the canonical capability and fail-closed effect class for one completed call. */
  readonly classify: (call: ToolCall) => Capability
  readonly settle: (input: ExecuteInput) => Effect.Effect<Settlement, ToolOutputStore.Error>
}

export interface Settlement {
  readonly result: ToolResultValue
  readonly output?: ToolOutput
  readonly outputPaths?: ReadonlyArray<string>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/ToolRegistry") {}

const registryLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const applications = yield* ApplicationTools.Service
    const resources = yield* ToolOutputStore.Service
    type Registration = { readonly identity: object; readonly tool: AnyTool }
    const local = new Map<string, Array<{ readonly token: object; readonly registration: Registration }>>()

    const settleWith = Effect.fn("ToolRegistry.settle")(function* (input: ExecuteInput, advertised?: object) {
      const registration =
        local.get(input.call.name)?.at(-1)?.registration ?? applications.entries().get(input.call.name)
      if (!registration)
        return {
          result: {
            type: "error" as const,
            value: advertised ? `Stale tool call: ${input.call.name}` : `Unknown tool: ${input.call.name}`,
          },
        }
      if (advertised && registration.identity !== advertised)
        return { result: { type: "error" as const, value: `Stale tool call: ${input.call.name}` } }
      // The registry is also an execution boundary: a tool claiming EFFECT may
      // not execute without an admitted Rust challenge. Until one shared Guard
      // supports another effect class, do not dispatch it even if registered by
      // an application, plugin, or Location override. The file-write leaf
      // independently binds the challenge to the target and redeems it in Rust.
      const declared = capability(registration.tool, input.call.name)
      const localRegistration = local.get(input.call.name)?.at(-1)?.registration
      if (declared.effectClass === "unknown")
        return { result: { type: "error" as const, value: `Unclassified tool: ${input.call.name}` } }
      if (declared.effectClass === "effect") {
        // Application/plugin registrations do not get native effect authority
        // by self-declaring the ID of a first-party guarded tool.
        if (declared.id !== "files.write" || input.call.name !== "write" || localRegistration !== registration || !isBuiltinWrite(registration.tool))
          return { result: { type: "error" as const, value: `Rust Guard does not support: ${declared.id}` } }
        if (!input.effect)
          return { result: { type: "error" as const, value: "Rust Guard admission required" } }
      }
      const pending = yield* settle(registration.tool, input.call, {
        sessionID: input.sessionID,
        agent: input.agent,
        assistantMessageID: input.assistantMessageID,
        toolCallID: input.call.id,
        ...(input.effect ? { effect: input.effect } : {}),
      }).pipe(
        Effect.map((output) => ({ output })),
        Effect.catchTag("LLM.ToolFailure", (failure) =>
          Effect.succeed({ result: { type: "error" as const, value: failure.message } }),
        ),
      )
      if ("result" in pending) return pending
      const output = pending.output
      const bounded = yield* resources.bound({ sessionID: input.sessionID, toolCallID: input.call.id, output })
      const result = ToolOutput.toResultValue(bounded.output)
      if (result.type === "error")
        return bounded.outputPaths.length > 0 ? { result, outputPaths: bounded.outputPaths } : { result }
      return bounded.outputPaths.length > 0
        ? { result, output: bounded.output, outputPaths: bounded.outputPaths }
        : { result, output: bounded.output }
    })

    return Service.of({
      register: Effect.fn("ToolRegistry.register")(function* (tools) {
        const entries = Object.entries(tools)
        if (entries.length === 0) return
        yield* Effect.forEach(entries, ([name]) => validateName(name), { discard: true })
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const token = {}
            for (const [name, tool] of entries)
              local.set(name, [...(local.get(name) ?? []), { token, registration: { identity: {}, tool } }])
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                for (const [name] of entries) {
                  const registrations = local.get(name)?.filter((registration) => registration.token !== token) ?? []
                  if (registrations.length > 0) local.set(name, registrations)
                  else local.delete(name)
                }
              }),
            )
          }),
        )
      }),
      materialize: Effect.fn("ToolRegistry.materialize")(function* (permissions = []) {
        const registrations = new Map(applications.entries())
        for (const [name, entries] of local) {
          const registration = entries.at(-1)?.registration
          if (registration) registrations.set(name, registration)
        }
        for (const [name, registration] of registrations) {
          const declared = capability(registration.tool, name)
          if (
            declared.effectClass === "unknown" ||
            (declared.effectClass === "effect" &&
              (declared.id !== "files.write" || name !== "write" || local.get(name)?.at(-1)?.registration !== registration || !isBuiltinWrite(registration.tool))) ||
            whollyDisabled(permission(registration.tool, name), permissions)
          ) {
            registrations.delete(name)
          }
        }
        return {
          definitions: Array.from(registrations, ([name, registration]) => definition(name, registration.tool)),
          validate: (call) => {
            const registration = registrations.get(call.name)
            if (!registration) return Effect.succeed(`Unknown tool: ${call.name}`)
            return validateInput(registration.tool, call.input).pipe(
              Effect.as(undefined),
              Effect.catchTag("LLM.ToolFailure", (failure) => Effect.succeed(failure.message)),
            )
          },
          classify: (call) => {
            const registration = registrations.get(call.name)
            return registration ? capability(registration.tool, call.name) : { id: call.name, effectClass: "unknown" }
          },
          settle: (input) => {
            const registration = registrations.get(input.call.name)
            if (registration) return settleWith(input, registration.identity)
            return Effect.succeed({ result: { type: "error", value: `Unknown tool: ${input.call.name}` } })
          },
        }
      }),
    })
  }),
)

const layer = Layer.effect(
  Tools.Service,
  Service.use((registry) => Effect.succeed(Tools.Service.of({ register: registry.register }))),
).pipe(Layer.provideMerge(registryLayer))

function whollyDisabled(action: string, rules: PermissionV2.Ruleset) {
  const rule = rules.findLast((rule) => Wildcard.match(action, rule.action))
  return rule?.resource === "*" && rule.effect === "deny"
}

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [ApplicationTools.node, ToolOutputStore.node],
})

export const toolsNode = makeLocationNode({
  service: Tools.Service,
  layer,
  deps: [ApplicationTools.node, ToolOutputStore.node],
})
