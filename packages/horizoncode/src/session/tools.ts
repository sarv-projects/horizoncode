import { Agent } from "@/agent/agent"
import { InstanceState } from "@/effect/instance-state"
import { SessionV1 } from "@horizoncode/core/v1/session"
import { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { Permission } from "@/permission"
import { Tool } from "@/tool/tool"
import { ToolJsonSchema } from "@/tool/json-schema"
import { ToolRegistry } from "@/tool/registry"

import type { TaskPromptOps } from "@/tool/task"
import { type Tool as AITool, tool, jsonSchema, type ToolExecutionOptions } from "ai"
import { Effect, Option, Schema } from "effect"
import type { JSONSchema7 } from "@ai-sdk/provider"
import { Session } from "./session"
import { SessionProcessor } from "./processor"
import { PartID } from "./schema"
import { EffectBridge } from "@/effect/bridge"
import { ModelV2 } from "@horizoncode/core/model"
import { isRecord } from "@/util/record"
import type { EffectLease } from "@horizoncode/core/session/supervisor"
import path from "node:path"
import { Buffer } from "node:buffer"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { WebSearchRuntime } from "@/tool/websearch-runtime"
import { builtinHarnessProfileV1, projectHarnessToolIDsV1 } from "@horizoncode/core/harness-profile"
import { HorizonCodingProfile } from "@horizoncode/core/config/coding-profile"
import {
  searchToolDescriptorsV1,
  toolSchemaRecordV1,
  TOOL_DISCOVERY_LIMITS_V1,
  toolsetGenerationV1,
  toolsetSourceRefsV1,
  type ToolDiscoveryDescriptorV1,
  type ToolsetSourceRefV1,
} from "@/tool/discovery"
import {
  failToolBatchLease,
  isStandaloneControlTool,
  requireToolExecution,
  resolveToolBatchLease,
  type DirectAttemptAuthority,
  type ToolBatchDefinition,
  toolBatchMemberChain,
  toolCallOutcome,
} from "./tool-batch"
import type { ManagedAttemptAuthority } from "./managed-control"
import { FSUtil } from "@horizoncode/core/fs-util"
import { preparePatchBatch } from "@/tool/apply_patch"
import { TrustedPrincipalContext } from "@horizoncode/core/trusted-principal"
import {
  canonicalizeCodeModeToolSetV1,
  CODE_MODE_TOOL_CONTEXT_KEY_V1,
  projectCodeModeEffectiveToolsV1,
  type CodeModeToolV1,
} from "@/tool/code-mode"
import { codeModeToolContextFromBatchContext } from "./tool-batch"
import { editToolBatchAdmission } from "./tool-admission"


// Mirrors the per-tool description bound enforced by the CodeMode start-frame
// validator (code-mode-protocol.ts validTool); the wire limit is normative and
// shared with kernel/src/codemode_protocol.rs.
const CODE_MODE_TOOL_DESCRIPTION_MAX_BYTES = 4096

/**
 * `HORIZON_DEBUG_TOOLS=1` dumps each projection stage of the model-facing tool
 * surface to stderr. A tool otherwise disappears between the registry and the
 * provider request without a trace: the model never sees it, and only a missing
 * `capability` declaration or an unclassified capability ID explains why.
 */
function debugToolSurface(stage: string, values: readonly string[]) {
  if (process.env.HORIZON_DEBUG_TOOLS !== "1") return
  console.error(`[DBG] ${stage} ${JSON.stringify([...values].toSorted())}`)
}

/**
 * Built-in tools whose omission is a recorded design decision rather than a
 * missing declaration. `webfetch` has no Guard-mediated outbound-HTTP capability
 * (the ToolBatch boundary admits only terminal.run, files.write, files.patch and
 * web.search) and its execute performs no I/O, so it stays fail-closed instead of
 * claiming read_only for a network egress. Everything else that loses its
 * capability declaration must be reported, not silently hidden.
 */
const INTENTIONALLY_UNCLASSIFIED_TOOLS: ReadonlySet<string> = new Set(["webfetch"])

/** Project the canonical tier policy over candidates that already passed registry and permission checks. */
export function exposeCodingProfileToolIDsV1(input: {
  readonly capabilities: readonly Tool.Capability[]
  readonly platform?: "linux" | "windows" | "darwin"
}): readonly string[] {
  return HorizonCodingProfile.exposeCapabilityIDsV1({
    available: input.capabilities.map((capability) => ({
      id: capability.id,
      implementationStatus: "wired" as const,
    })),
    skillCatalogSize: 0,
    platform: input.platform,
  })
}

/**
 * The only effect origins this resolver may project are canonical Core-tier
 * capabilities. The tier registry is authoritative: a hard-coded name table
 * here is a second capability registry and silently dropped newly wired Core
 * effect tools (the shipped 2026-10-13 CLI projected read_only tools plus
 * files.write only, so the model never saw bash or edit and Guard denied
 * every terminal call as an unsupported tool). Classification is exposure
 * only: Guard and ExecutionHost still admit each effect.
 */
/**
 * Wait for the same-path predecessor of a prepared batch member. Bounded: a member
 * the host never executes must not stall its successor forever. On timeout the
 * successor still runs and fails closed in its own pre-execute reconciliation.
 */
const BATCH_CHAIN_WAIT_MS = 60_000
function waitForBatchPredecessor(predecessor: Promise<void>): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, BATCH_CHAIN_WAIT_MS) as unknown as { unref?: () => void }
    if (typeof timer.unref === "function") timer.unref()
    const done = () => {
      clearTimeout(timer as unknown as ReturnType<typeof setTimeout>)
      resolve()
    }
    predecessor.then(done, done)
  })
}

function isCoreEffectCapability(capability: Tool.Capability): boolean {
  return capability.effectClass === "effect" && HorizonCodingProfile.classifyCapability(capability.id) === "core"
}

export const resolve = Effect.fn("SessionTools.resolve")(function* (input: {
  agent: Agent.Info
  model: Provider.Model
  session: Session.Info
  processor: Pick<SessionProcessor.Handle, "message" | "updateToolCall" | "completeToolCall">
  bypassAgentCheck: boolean
  messages: SessionV1.WithParts[]
  promptOps: TaskPromptOps
  directAttempt?: DirectAttemptAuthority
  managedAttempt?: ManagedAttemptAuthority
}) {
  const allTools: Record<string, AITool> = {}
  const definitions: Record<string, ToolBatchDefinition> = {}
  const run = yield* EffectBridge.make()
  const instance = yield* InstanceState.context
  const fs = yield* FSUtil.Service
  const flags = yield* RuntimeFlags.Service
  const webSearchRuntime = yield* WebSearchRuntime.Service
  const permission = yield* Permission.Service
  const registry = yield* ToolRegistry.Service
  const authenticatedPrincipal = yield* Effect.serviceOption(TrustedPrincipalContext)

  const context = (
    args: Record<string, unknown>,
    options: ToolExecutionOptions,
    effect?: Tool.Context["effect"],
    guardedPatch?: unknown,
    searchExecution?: unknown,
    guardedLease?: EffectLease,
    directAttempt?: unknown,
    includeCodeModeContext = false,
  ): Tool.Context => {
    const codeModeToolContext = includeCodeModeContext
      ? codeModeToolContextFromBatchContext(options.experimental_context, options.toolCallId)
      : undefined
    return ({
    sessionID: input.session.id,
    abort: options.abortSignal!,
    messageID: input.processor.message.id,
    callID: options.toolCallId,
    ...(Option.isSome(authenticatedPrincipal) ? { trustedPrincipal: authenticatedPrincipal.value.principal } : {}),
    extra: {
      model: input.model,
      bypassAgentCheck: input.bypassAgentCheck,
      promptOps: input.promptOps,
      ...(guardedPatch !== undefined ? { guardedPatch } : {}),
      ...(searchExecution !== undefined ? { searchExecution } : {}),
      ...(guardedLease !== undefined ? { guardedLease } : {}),
      // Read-only artifact search has no Guard effect lease to carry the
      // per-call outcome authority. In a direct child turn, pass the same
      // authenticated live Attempt authority captured by the prompt owner;
      // never derive it from model arguments or Session metadata.
      ...(directAttempt !== undefined
        ? { directAttempt }
        : input.directAttempt !== undefined ? { directAttempt: input.directAttempt } : {}),
      ...(input.managedAttempt !== undefined ? { managedAttempt: input.managedAttempt } : {}),
      ...(codeModeToolContext
        ? { [CODE_MODE_TOOL_CONTEXT_KEY_V1]: codeModeToolContext }
        : {}),
    },
    effect,
    agent: input.agent.name,
    messages: input.messages,
    metadata: (val) =>
      input.processor.updateToolCall(options.toolCallId, (match) => {
        if (!["running", "pending"].includes(match.state.status)) return match
        return {
          ...match,
          state: {
            title: val.title,
            metadata: val.metadata,
            status: "running",
            input: args,
            time: match.state.status === "running" ? match.state.time : { start: Date.now() },
          },
        }
      }),
    ask: (req) =>
      permission
        .ask({
          ...req,
          sessionID: input.session.id,
          tool: { messageID: input.processor.message.id, callID: options.toolCallId },
          ruleset: Permission.merge(input.agent.permission, input.session.permission ?? []),
        })
        .pipe(Effect.orDie),
    })
  }

  // Every registry tool that cannot be projected is recorded so a missing
  // capability declaration reports itself instead of silently shrinking the
  // model-facing surface.
  const droppedTools: string[] = []

  for (const item of yield* registry.tools({
    modelID: ModelV2.ID.make(input.model.api.id),
    providerID: input.model.providerID,
    agent: input.agent,
    permission: input.session.permission,
  })) {
    const internal = item.id === "invalid"
    const capability: Tool.Capability = internal
      ? { id: "tool.invalid", effectClass: "control" }
      : (item.capability ?? { id: item.id, effectClass: "unknown" })
    const supported =
      internal ||
      capability.effectClass === "read_only" ||
      isCoreEffectCapability(capability) ||
      isStandaloneControlTool(item.id, { capability, internal })
    // Unknown/default effect class and unclassified plugin or project tools fail closed:
    // they are not projected into the model-facing tool list or its batch definitions.
    if (!supported) {
      droppedTools.push(`${item.id}:${capability.id}/${capability.effectClass}`)
      continue
    }

    const schema = ProviderTransform.schema(input.model, ToolJsonSchema.fromTool(item))
    const normalize =
      item.id === "write"
        ? (value: unknown) => {
            if (!isRecord(value) || typeof value.filePath !== "string" || typeof value.content !== "string")
              throw new Error("Invalid files.write arguments")
            return { path: value.filePath, content: value.content }
          }
        : undefined
    // `edit` admission (published schema + files.patch preparation) is shared
    // with test/session/tool-batch-edit-admission.test.ts so a drift in this
    // projection fails there first instead of surfacing as an opaque batch deny.
    const editAdmission =
      item.id === "edit"
        ? editToolBatchAdmission({ directory: instance.directory, fs, promise: run.promise })
        : undefined
    const prepare =
      item.id === "apply_patch"
        ? async (value: unknown) => {
            if (!isRecord(value) || typeof value.patchText !== "string") throw new Error("Invalid apply_patch arguments")
            const prepared = await run.promise(preparePatchBatch(value.patchText, instance.directory, fs))
            return {
              arguments: {
                operations: prepared.operations,
                ...(value.repoIntelFence !== undefined ? { repoIntelFence: value.repoIntelFence } : {}),
              },
              execution: prepared.operations,
            }
          }
        : item.id === "edit"
          ? editAdmission!.prepare
          : item.id === "write"
            ? async (value: unknown) => {
                if (!normalize) throw new Error("Invalid files.write arguments")
                const normalized = normalize(value) as { path: string; content: string }
                // Identical arguments to the normalized projection, plus the exact
                // operation a same-path successor must chain behind.
                return {
                  arguments: normalized,
                  execution: [
                    {
                      operation: "write",
                      path: path.resolve(instance.directory, normalized.path),
                      expectedBeforeBase64: null,
                      contentBase64: Buffer.from(normalized.content, "utf8").toString("base64"),
                    },
                  ],
                }
              }
          : item.id === "bash"
            ? async (value: unknown) => {
                if (
                  !isRecord(value) ||
                  typeof value.command !== "string" ||
                  (value.label !== undefined && typeof value.label !== "string") ||
                  (value.workdir !== undefined && typeof value.workdir !== "string") ||
                  (value.timeout !== undefined &&
                    (typeof value.timeout !== "number" || !Number.isSafeInteger(value.timeout) || value.timeout <= 0))
                )
                  throw new Error("Invalid terminal.run arguments")
                const execution = {
                  command: value.command,
                  cwd: path.resolve(instance.directory, value.workdir ?? "."),
                  timeoutMs: value.timeout ?? flags.bashDefaultTimeoutMs ?? 2 * 60 * 1000,
                }
                return { arguments: execution, execution }
              }
            : capability.id === "web.search"
              ? async (value: unknown) => run.promise(webSearchRuntime.prepareEffectArguments(value))
            : undefined
    definitions[item.id] = {
      capability,
      schema,
      validate:
        editAdmission?.validate ??
        ((value) => run.promise(Schema.decodeUnknownEffect(item.parameters)(value))),
      ...(normalize ? { normalize } : {}),
      ...(prepare ? { prepare } : {}),
      ...(internal ? { internal: true } : {}),
    }
    allTools[item.id] = tool({
      description: item.description,
      inputSchema: jsonSchema(schema),
      execute(args, options) {
        return run.promise(
          Effect.gen(function* () {
            const outcome = toolCallOutcome(options.experimental_context, options.toolCallId)
            const effect = requireToolExecution({
              context: options.experimental_context,
              callID: options.toolCallId,
              toolName: item.id,
              capability,
              internal,
            })
            const guardedPatch =
              outcome?.status === "prepared" || outcome?.status === "admitted" || outcome?.status === "no_effect"
                ? outcome.execution
                : undefined
            const searchExecution = capability.id === "web.search" ? guardedPatch : undefined
            const outcomeLease = outcome?.status === "prepared" ? outcome.lease : undefined
            // A serial Attempt member has no host lease yet: block here until the
            // previous member's receipt settles and the host issues this one.
            const guardedLease = outcomeLease
              ? yield* Effect.promise(() => resolveToolBatchLease(outcomeLease))
              : undefined
            const directAttempt =
              outcome?.status === "prepared" || outcome?.status === "admitted" ? outcome.directAttempt : undefined
            const ctx = context(
              args,
              options,
              effect && "challengeID" in effect ? effect : undefined,
              capability.id === "web.search" ? undefined : guardedPatch,
              searchExecution,
              guardedLease,
              directAttempt,
              item.id === "execute",
            )
            // A member that fails before producing a receipt cannot hand off its
            // serial lease; reject later members instead of leaving them pending.
            // A same-path member was prepared against the content its predecessor
            // will write, so it must not execute before that predecessor lands or
            // the kernel CAS rejects the stale preimage.
            const memberChain = toolBatchMemberChain(options.toolCallId)
            if (memberChain?.predecessor)
              yield* Effect.promise(() => waitForBatchPredecessor(memberChain.predecessor!))
            const result = yield* item.execute(args, ctx).pipe(
              Effect.ensuring(Effect.sync(() => memberChain?.settle())),
              Effect.onError((cause) =>
                Effect.sync(() => failToolBatchLease(guardedLease ?? outcomeLease, cause)),
              ),
            )
            const output = {
              ...result,
              attachments: result.attachments?.map((attachment) => ({
                ...attachment,
                id: PartID.ascending(),
                sessionID: ctx.sessionID,
                messageID: input.processor.message.id,
              })),
            }
            if (options.abortSignal?.aborted) {
              yield* input.processor.completeToolCall(options.toolCallId, output)
            }
            return output
          }),
        )
      },
    })
  }

  debugToolSurface("allTools", Object.keys(allTools))
  debugToolSurface("dropped", droppedTools)
  const unexpectedDrops = droppedTools.filter(
    (entry) => !INTENTIONALLY_UNCLASSIFIED_TOOLS.has(entry.slice(0, entry.indexOf(":"))),
  )
  if (unexpectedDrops.length > 0) {
    yield* Effect.logWarning("tools withheld from the model surface: no Guard-admissible capability", {
      tools: unexpectedDrops,
    })
  }

  if (Object.keys(allTools).length > TOOL_DISCOVERY_LIMITS_V1.maxCandidates) {
    throw new RangeError("Harness registry exceeds the bounded tool-discovery candidate count")
  }

  const configuredHarness = input.agent.options.horizonHarness
  const harnessID = typeof configuredHarness === "string" ? configuredHarness : "native-rich"
  const harness = builtinHarnessProfileV1(harnessID)
  if (!harness) throw new Error(`Unknown HorizonCode harness profile: ${harnessID}`)

  const permissionRules = Permission.merge(input.agent.permission, input.session.permission ?? [])
  const deniedToolNames = Permission.disabled(Object.keys(allTools), permissionRules)
  debugToolSurface("disabled", [...deniedToolNames])
  const permissionAction = (name: string, capabilityID: string) => {
    const actions = [
      Permission.evaluate(name, "*", permissionRules).action,
      Permission.evaluate(capabilityID, "*", permissionRules).action,
    ]
    if (actions.includes("deny")) return "deny" as const
    if (actions.includes("ask")) return "ask" as const
    return "allow" as const
  }
  const candidates = Object.entries(allTools)
    .filter(([name]) => name !== "invalid" && !deniedToolNames.has(name))
    .map(([name, definition]) => ({
      name,
      definition,
      batch: definitions[name]!,
    }))
    .filter((item) => item.batch && item.batch.internal !== true && item.batch.capability.effectClass !== "unknown" &&
      permissionAction(item.name, item.batch.capability.id) !== "deny")

  debugToolSurface("candidates", candidates.map((item) => `${item.name}:${item.batch.capability.id}`))
  const codingProfileIDs = new Set(exposeCodingProfileToolIDsV1({
    capabilities: candidates.map((item) => item.batch.capability),
  }))
  const tierDropped = candidates
    .filter((item) => !codingProfileIDs.has(item.batch.capability.id))
    .map((item) => `${item.name}:${item.batch.capability.id}`)
  for (let index = candidates.length - 1; index >= 0; index--) {
    if (!codingProfileIDs.has(candidates[index]!.batch.capability.id)) candidates.splice(index, 1)
  }
  debugToolSurface("afterTier", candidates.map((item) => `${item.name}:${item.batch.capability.id}`))
  if (tierDropped.length > 0) {
    yield* Effect.logWarning("tools withheld from the model surface: capability outside the enabled exposure tiers", {
      tools: tierDropped,
    })
  }

  if (candidates.length > TOOL_DISCOVERY_LIMITS_V1.maxCandidates) {
    throw new RangeError("Authorized tool registry exceeds the bounded tool-discovery candidate count")
  }

  const byCapability = new Map<string, (typeof candidates)[number]>()
  const schemaDigests = new Map<string, string>()
  let aggregateSchemaBytes = 0
  let aggregateSchemaNodes = 0
  let aggregateDescriptionBytes = 0
  for (const item of candidates) {
    const id = item.batch.capability.id
    if (byCapability.has(id)) throw new Error(`Duplicate canonical tool capability in registry: ${id}`)
    byCapability.set(id, item)
    const schema = toolSchemaRecordV1(item.batch.schema)
    aggregateSchemaBytes += schema.bytes
    aggregateSchemaNodes += schema.nodes
    aggregateDescriptionBytes += Buffer.byteLength(item.definition.description ?? "", "utf8")
    if (aggregateSchemaBytes > TOOL_DISCOVERY_LIMITS_V1.maxAggregateSchemaBytes ||
      aggregateSchemaNodes > TOOL_DISCOVERY_LIMITS_V1.maxAggregateSchemaNodes ||
      aggregateDescriptionBytes > TOOL_DISCOVERY_LIMITS_V1.maxAggregateDescriptionBytes) {
      throw new RangeError("Authorized tool registry exceeds aggregate discovery schema or description bounds")
    }
    schemaDigests.set(id, schema.digest)
  }
  const projection = projectHarnessToolIDsV1(harness, [...byCapability.keys()])
  const activeCapabilities = new Set(projection.starter)
  const deferredCapabilities = new Set(projection.deferred)
  const stagedCapabilities = new Set<string>()
  const descriptors: ToolDiscoveryDescriptorV1[] = [...deferredCapabilities]
    .map((id): ToolDiscoveryDescriptorV1 => {
      const item = byCapability.get(id)!
      const action = permissionAction(item.name, item.batch.capability.id)
      return {
        id,
        description: (item.definition.description ?? "").slice(0, TOOL_DISCOVERY_LIMITS_V1.maxDescriptorDescriptionBytes),
        tags: [id.split(".")[0]!, item.batch.capability.effectClass],
        sideEffectClass: item.batch.capability.effectClass as ToolDiscoveryDescriptorV1["sideEffectClass"],
        availability: action === "ask" ? "requires_approval" : "available",
        requiredCapability: id,
        schemaDigest: schemaDigests.get(id)!,
      }
    })
    .toSorted((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)

  // Tool-search results are durable assistant tool outputs. Rehydrate expansion
  // from those committed results after restart instead of relying on this
  // resolver's in-memory closure state.
  const descriptorByID = new Map(descriptors.map((descriptor) => [descriptor.id, descriptor]))
  for (const message of input.messages) {
    for (const part of message.parts) {
      if (part.type !== "tool" || part.tool !== "tools_search" || part.state.status !== "completed") continue
      const output = part.state.output
      if (typeof output !== "string" || output.length > 32 * 1024) continue
      try {
        const result: unknown = JSON.parse(output)
        if (!isRecord(result) || !Array.isArray(result.tools)) continue
        for (const descriptor of result.tools) {
          if (!isRecord(descriptor) || typeof descriptor.id !== "string" || typeof descriptor.schemaDigest !== "string") continue
          if (descriptorByID.get(descriptor.id)?.schemaDigest === descriptor.schemaDigest) activeCapabilities.add(descriptor.id)
        }
      } catch {
        // Malformed or legacy tool output cannot expand the current registry projection.
      }
    }
  }

  const buildToolset = (ids: ReadonlySet<string>) => {
    const selected = [...ids].filter((id) => byCapability.has(id)).toSorted()
    if (selected.length > 32) throw new RangeError("Harness tool projection exceeds the 32-tool HostKernel bound")
    const tools: Record<string, AITool> = {}
    const members = selected.map((id) => {
      const item = byCapability.get(id)!
      const toolName = item.name
      tools[toolName] = allTools[toolName]!
      return { id, schemaDigest: schemaDigests.get(id)! }
    })
    const generation = toolsetGenerationV1({ harnessID, harnessRevision: harness.revision, members })
    return {
      tools,
      generation,
      sourceRefs: toolsetSourceRefsV1({ harnessID, harnessRevision: harness.revision, generation, members }),
      // CodeMode gets the request's exact authorized catalog, including bounded
      // deferred candidates for its own progressive search. This does not add
      // them to the provider tool list: each nested call still re-enters the
      // normal ToolBatch/Guard admission path.
      codeModeTools: canonicalizeCodeModeToolSetV1(projectCodeModeEffectiveToolsV1([...byCapability.keys()].toSorted().map((id) => {
        const item = byCapability.get(id)!
        if (!isRecord(item.batch.schema)) {
          throw new TypeError(`CodeMode cannot project a non-record input schema for ${item.batch.capability.id}`)
        }
        return {
          toolName: item.name,
          capabilityId: item.batch.capability.id,
          effectClass: item.batch.capability.effectClass,
          description: item.definition.description ?? "",
          inputSchema: item.batch.schema,
          internal: item.batch.internal,
        }
      // A tool whose description cannot fit the bounded wire frame stays in the
      // normal provider tool list but is withheld from the nested CodeMode
      // catalog; the strict frame validator rejects the whole set otherwise.
      }).filter((tool) => Buffer.byteLength(tool.description, "utf8") <= CODE_MODE_TOOL_DESCRIPTION_MAX_BYTES))),
      codeModeExecutors: Object.fromEntries([...byCapability.values()].map((item) => [item.name, allTools[item.name]!])) as Readonly<Record<string, AITool>>,
    }
  }

  if (harness.toolProjection === "minimal" && descriptors.length > 0 && !byCapability.has("tools.search") &&
    exposeCodingProfileToolIDsV1({
      capabilities: [...candidates.map((item) => item.batch.capability), { id: "tools.search", effectClass: "read_only" }],
    }).includes("tools.search") &&
    permissionAction("tools_search", "tools.search") !== "deny") {
    if (allTools.tools_search !== undefined) throw new Error("Built-in tools.search collides with a registry tool")
    const searchCapability = { id: "tools.search", effectClass: "read_only" as const }
    const searchSchema: JSONSchema7 = {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, maxLength: 256 },
        limit: { type: "integer", minimum: 1, maximum: 20 },
      },
      required: ["query"],
      additionalProperties: false,
    }
    const searchSchemaRecord = toolSchemaRecordV1(searchSchema)
    aggregateSchemaBytes += searchSchemaRecord.bytes
    aggregateSchemaNodes += searchSchemaRecord.nodes
    aggregateDescriptionBytes += Buffer.byteLength("Find authorized deferred tools. Results become available at the next provider request boundary; this does not grant permission.", "utf8")
    if (aggregateSchemaBytes > TOOL_DISCOVERY_LIMITS_V1.maxAggregateSchemaBytes ||
      aggregateSchemaNodes > TOOL_DISCOVERY_LIMITS_V1.maxAggregateSchemaNodes ||
      aggregateDescriptionBytes > TOOL_DISCOVERY_LIMITS_V1.maxAggregateDescriptionBytes) {
      throw new RangeError("Tool discovery profile exceeds aggregate schema or description bounds")
    }
    definitions.tools_search = {
      capability: searchCapability,
      schema: searchSchema,
      validate: (value) => run.promise(Schema.decodeUnknownEffect(Schema.Struct({
        query: Schema.String.check(Schema.isMinLength(1)).check(Schema.isMaxLength(256)),
        limit: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(20))),
      }))(value)),
    }
    allTools.tools_search = tool({
      description: "Find authorized deferred tools. Results become available at the next provider request boundary; this does not grant permission.",
      inputSchema: jsonSchema(searchSchema),
      execute(args) {
        const found = searchToolDescriptorsV1({ query: args.query, limit: args.limit, descriptors })
        const text = JSON.stringify({ tools: found, activatedAt: "next_provider_request", generationChange: found.length > 0 })
        if (Buffer.byteLength(text, "utf8") > TOOL_DISCOVERY_LIMITS_V1.maxSearchResultBytes) {
          throw new RangeError("Tool discovery result exceeds its serialized byte bound")
        }
        for (const item of found) stagedCapabilities.add(item.id)
        return {
          content: [{ type: "text", text }],
        }
      },
    })
    byCapability.set("tools.search", {
      name: "tools_search",
      definition: allTools.tools_search,
      batch: definitions.tools_search!,
    })
    schemaDigests.set("tools.search", searchSchemaRecord.digest)
    activeCapabilities.add("tools.search")
  }

  const initial = buildToolset(activeCapabilities)
  const toolDiscovery = {
    harnessID,
    harnessRevision: harness.revision,
    generation: initial.generation,
    sourceRefs: initial.sourceRefs as readonly ToolsetSourceRefV1[],
    codeModeTools: initial.codeModeTools,
    codeModeExecutors: initial.codeModeExecutors,
    prepareNextProviderRequest() {
      for (const id of stagedCapabilities) activeCapabilities.add(id)
      stagedCapabilities.clear()
      return buildToolset(activeCapabilities)
    },
  }
  return { tools: initial.tools, definitions, toolDiscovery }
})


export * as SessionTools from "./tools"
