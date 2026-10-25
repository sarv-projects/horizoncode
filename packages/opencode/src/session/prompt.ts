import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { createHash } from "node:crypto"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import path from "path"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Pty } from "@opencode-ai/core/pty"
import { LocationServiceMap, locationServiceMapNode } from "@opencode-ai/core/location-services"
import { TrustedPrincipalContext } from "@opencode-ai/core/trusted-principal"
import { SessionV2 } from "@opencode-ai/core/session"
import os from "os"
import { SessionID, MessageID, PartID } from "./schema"
import { MessageV2 } from "./message-v2"
import { SessionRevert } from "./revert"
import { Session } from "./session"
import { Agent, agentProfileDirectoryFailure, isAgentProfileDirectoryError } from "../agent/agent"
import { Provider } from "@/provider/provider"

import { type Tool as AITool, tool, jsonSchema } from "ai"
import type { JSONSchema7 } from "@ai-sdk/provider"
import { SessionCompaction } from "./compaction"
import { SystemPrompt } from "./system"
import { Instruction } from "./instruction"
import { Plugin } from "../plugin"
import { MAX_STEPS_PROMPT } from "@opencode-ai/core/session/runner/max-steps"
import { ToolRegistry } from "@/tool/registry"
import { WebSearchRuntime } from "@/tool/websearch-runtime"
import { MCP } from "../mcp"
import { LSP } from "@/lsp/lsp"
import * as LSPServer from "@/lsp/server"
import { createSupervisedLspClientV1 } from "@/lsp/supervised"
import { projectGlobalLspConfigProfileV1 } from "@/lsp/launch-profile"
import { ulid } from "ulid"
import * as Stream from "effect/Stream"
import { Command } from "../command"
import { pathToFileURL, fileURLToPath } from "url"
import { Config } from "@/config/config"
import { ConfigMarkdown } from "@/config/markdown"
import { SessionSummary } from "./summary"
import { NamedError } from "@opencode-ai/core/util/error"
import { SessionProcessor } from "./processor"
import { Tool } from "@/tool/tool"
import { Permission } from "@/permission"
import { SessionStatus } from "./status"
import { LLM } from "./llm"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Truncate } from "@/tool/truncate"
import { Image } from "@/image/image"
import { decodeDataUrl } from "@/util/data-url"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Option, Ref, Scope, Context, Schema, Types } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { EffectBridge } from "@/effect/bridge"
import { TaskTool, runManagedTaskPrompt, type ManagedTaskPromptInput, type TaskPromptOps } from "@/tool/task"
import type { ManagedAttemptAuthority, ManagedProviderTurnCompletionV1 } from "./managed-control"
import * as ManagedControl from "./managed-control"
import type { ManagedReadyTaskSelectionV1, ManagedWorktreeTargetV1 } from "./managed-control"
import type { TrustedPrincipal } from "@opencode-ai/core/trusted-principal"
import {
  compileManagedContextSelection,
  sameManagedContextSelectionV1,
  type ManagedPreparedRequestV1,
  type ManagedProviderContextV1,
  type ManagedProviderInputV1,
} from "./llm"
import { deriveSubagentSessionPermission } from "../agent/subagent-permissions"
import { blake3 } from "@noble/hashes/blake3.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import { SessionRunState } from "./run-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Database } from "@opencode-ai/core/database/database"
import { SessionSupervisor, SessionSupervisorError } from "@opencode-ai/core/session/supervisor"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ContextSelectionV1 } from "@opencode-ai/schema/context-selection-v1"
import { eq } from "drizzle-orm"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionReminders } from "./reminders"
import { SessionTools } from "./tools"
import { AgentProfileService } from "@opencode-ai/core/config"
import { builtinHarnessSystemPromptV1 } from "@opencode-ai/core/harness-profile"
import { requireToolExecution } from "./tool-batch"
import type { DirectAttemptAuthority } from "./tool-batch"
import type { DirectTurnAuthority } from "./managed-control"
import { consumptionAckDigest, consumingScopeDigest, digestText, type DirectInboxConsumptionProofV1 } from "./direct-subagent-inbox"

import { LLMEvent } from "@opencode-ai/llm"

// @ts-ignore
globalThis.AI_SDK_LOG_WARNINGS = false

const decodeMessageInfo = Schema.decodeUnknownExit(SessionV1.Info)
const decodeMessagePart = Schema.decodeUnknownExit(SessionV1.Part)
const MAX_MCP_RESOURCE_BLOB_BYTES = 10 * 1024 * 1024
const SUPPORTED_MCP_RESOURCE_ATTACHMENT_MIMES = new Set([
  "application/pdf",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
])

const STRUCTURED_OUTPUT_DESCRIPTION = `Use this tool to return your final response in the requested structured format.

IMPORTANT:
- You MUST call this tool exactly once at the end of your response
- The input must be valid JSON matching the required schema
- Complete all necessary research and tool calls BEFORE calling this tool
- This tool provides your final answer - no further actions are taken after calling it`

const STRUCTURED_OUTPUT_SYSTEM_PROMPT = `IMPORTANT: The user has requested structured output. You MUST use the StructuredOutput tool to provide your final response. Do NOT respond with plain text - you MUST call the StructuredOutput tool with your answer formatted according to the schema.`

function sessionAgentProfilePin(metadata: Record<string, unknown> | undefined) {
  const raw = metadata?.horizonAgentProfileV2
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined
  const value = raw as Record<string, unknown>
  if (
    Object.keys(value).length !== 5 ||
    ["harness", "permissionsDigest", "profileDigest", "profileID", "profileRevision"].some((key) => !Object.hasOwn(value, key)) ||
    typeof value.profileID !== "string" ||
    typeof value.profileRevision !== "string" ||
    !/^[1-9][0-9]{0,19}$/.test(value.profileRevision) ||
    typeof value.profileDigest !== "string" ||
    !/^blake3:[0-9a-f]{64}$/.test(value.profileDigest) ||
    typeof value.permissionsDigest !== "string" ||
    !/^(sha256|blake3):[0-9a-f]{64}$/.test(value.permissionsDigest) ||
    typeof value.harness !== "string" ||
    !/^[A-Za-z0-9._-]{1,256}$/.test(value.harness)
  ) {
    throw new SessionSupervisorError({ stage: "agent-profile", reason: "child Session has an invalid immutable AgentProfileV2 pin" })
  }
  if (BigInt(value.profileRevision) > 18_446_744_073_709_551_615n) {
    throw new SessionSupervisorError({ stage: "agent-profile", reason: "child Session AgentProfileV2 revision exceeds u64" })
  }
  return { profileID: value.profileID, revision: value.profileRevision, harness: value.harness }
}

function managedPreflightProfilePin(metadata: Record<string, unknown> | undefined) {
  const raw = metadata?.horizonManagedPreflightV1
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined
  const value = raw as Record<string, unknown>
  if (value.schemaVersion !== 1 || typeof value.profileID !== "string" ||
    typeof value.profileRevision !== "string" || !/^[1-9][0-9]{0,19}$/.test(value.profileRevision) ||
    typeof value.profileDigest !== "string" || !/^blake3:[0-9a-f]{64}$/.test(value.profileDigest) ||
    typeof value.harness !== "string" || !/^[A-Za-z0-9._-]{1,256}$/.test(value.harness)) return undefined
  if (BigInt(value.profileRevision) > 18_446_744_073_709_551_615n) return undefined
  return { profileID: value.profileID, revision: value.profileRevision, profileDigest: value.profileDigest, harness: value.harness }
}

const AGENT_SPAWN_UNAVAILABLE_MESSAGE =
  "Agent delegation is unavailable until agents.spawn is mediated by Rust Guard and ExecutionHost."

export function shouldApplyPendingFeatures(
  directAttempt?: DirectAttemptAuthority,
  managedAttempt?: ManagedAttemptAuthority,
) {
  return directAttempt === undefined && managedAttempt === undefined
}

function mcpResourceBase64Size(value: string) {
  const trimmed = value.replace(/\s/g, "")
  const padding = trimmed.endsWith("==") ? 2 : trimmed.endsWith("=") ? 1 : 0
  return Math.max(0, Math.floor((trimmed.length * 3) / 4) - padding)
}

function formatMcpResourceBytes(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${Math.ceil(value / 1024)} KB`
  return `${Math.ceil(value / (1024 * 1024))} MB`
}

function isOrphanedInterruptedTool(part: SessionV1.ToolPart) {
  // cleanup() marks abandoned tool_use blocks this way after retries/aborts.
  // They are not pending work and must not trigger an assistant-prefill request.
  return part.state.status === "error" && part.state.metadata?.interrupted === true
}

export interface Interface {
  readonly cancel: (sessionID: SessionID) => Effect.Effect<void>
  readonly prompt: (input: PromptInput) => Effect.Effect<
    SessionV1.WithParts,
    Image.Error | Session.BusyError | SessionSupervisorError
  >
  /**
   * Internal managed-run entry. The authority must be minted by HostKernel
   * admission; request handlers never accept it from client payloads.
   */
  readonly promptManaged: (
    input: PromptInput,
    authority: ManagedAttemptAuthority,
    followUpRunner?: ManagedFollowUpRunnerV1,
  ) => Effect.Effect<SessionV1.WithParts, Image.Error | Session.BusyError | SessionSupervisorError>
  /** Internal Rust-selected child adapter; task selectors never come from model arguments. */
  readonly runManagedTask: (
    input: Omit<ManagedTaskPromptInput, "promptOps">,
  ) => ReturnType<typeof runManagedTaskPrompt>
  /** Compile the exact managed child provider request without dispatching it. */
  readonly prepareManagedTaskRequest: (input: {
    readonly selection: ManagedReadyTaskSelectionV1
    readonly rootSessionID: string
    readonly childSessionID: string
    readonly preAdmissionTarget: ManagedWorktreeTargetV1
    readonly requestID: string
    readonly requestSequence: "1"
    readonly trustedPrincipal: TrustedPrincipal
  }) => Effect.Effect<ManagedPreparedRequestV1, ManagedControl.ManagedControlError | SessionSupervisorError>
  /** Compile the next managed follow-up against the live transcript without persisting it or dispatching. */
  readonly prepareManagedFollowUp: (input: {
    readonly prompt: PromptInput
    readonly authority: ManagedAttemptAuthority
    readonly context: ManagedProviderContextV1
    readonly requestID: string
  }) => Effect.Effect<ManagedPreparedRequestV1, ManagedControl.ManagedControlError | SessionSupervisorError>
  /** Compile the real SessionPrompt body without starting provider transport. */
  readonly prepareManagedPrompt: (input: {
    readonly prompt: PromptInput
    readonly remainingTokens: string
    readonly directory: string
    readonly workspaceID: string
  }) => Effect.Effect<ManagedProviderInputV1, Session.BusyError | SessionSupervisorError>
  /** Internal safe-boundary wake for an already committed direct child follow-up. */
  readonly followUpDirectChild: (input: {
    readonly parentSessionID: string
    readonly childSessionID: string
    readonly messageID: string
    readonly freshTurnAuthorization?: ManagedControl.FreshTurnAuthorizationV1
  }) => Effect.Effect<void, Session.BusyError | SessionSupervisorError | ManagedControl.ManagedControlError>
  readonly loop: (input: LoopInput) => Effect.Effect<SessionV1.WithParts, Session.BusyError | SessionSupervisorError>
  readonly shell: (input: ShellInput) => Effect.Effect<
    SessionV1.WithParts,
    Image.Error | Session.BusyError | Pty.InvalidInputError | Pty.UnavailableError |
      Pty.ShellProfileUnavailableError | SessionSupervisorError,
    TrustedPrincipalContext
  >
  readonly command: (
    input: CommandInput,
  ) => Effect.Effect<
    SessionV1.WithParts,
    Image.Error | Session.BusyError | Pty.InvalidInputError | Pty.UnavailableError |
      Pty.ShellProfileUnavailableError | SessionSupervisorError,
    TrustedPrincipalContext
  >
  readonly resolvePromptParts: (template: string) => Effect.Effect<PromptInput["parts"], SessionSupervisorError>
}

/**
 * Internal serialized managed follow-up seam. The adapter must reconcile the
 * exact committed inbox row, claim its one-use HostKernel wake, persist that
 * claim, compile/advance the exact next ContextSelection and provider request,
 * and return only after the next prompt has crossed its safe boundary. Queue
 * rows are never eligible. An absent adapter leaves follow-up unavailable.
 */
export type ManagedFollowUpRunnerV1 = (input: {
  readonly sessionID: string
  readonly authority: ManagedAttemptAuthority
  readonly completion: ManagedProviderTurnCompletionV1
  readonly context: ManagedProviderContextV1
}) => Effect.Effect<
  | {
      readonly prompt: PromptInput
      readonly context: ManagedProviderContextV1
      /** Called after the exact follow-up user message is durably appended, before provider dispatch. */
      readonly onPromptCommitted: (input: { readonly promptMessageID: string }) => Effect.Effect<void, ManagedControl.ManagedControlError | SessionSupervisorError>
    }
  | undefined,
  ManagedControl.ManagedControlError | SessionSupervisorError
>

/** Reconcile the exact persisted managed inbox/request boundary before provider dispatch. */
export type ManagedPreDispatchRecoveryV1 = (input: {
  readonly sessionID: string
  readonly promptMessageID: string
  readonly promptText: string
  readonly authority: ManagedAttemptAuthority
  readonly context: ManagedProviderContextV1
}) => Effect.Effect<void, ManagedControl.ManagedControlError | SessionSupervisorError>

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionPrompt") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const status = yield* SessionStatus.Service
    const sessions = yield* Session.Service
    const agents = yield* Agent.Service
    const provider = yield* Provider.Service
    const processor = yield* SessionProcessor.Service
    const compaction = yield* SessionCompaction.Service
    const plugin = yield* Plugin.Service
    const commands = yield* Command.Service
    const config = yield* Config.Service
    const permission = yield* Permission.Service
    const fsys = yield* FSUtil.Service
    const mcp = yield* MCP.Service
    const lsp = yield* LSP.Service
    const registry = yield* ToolRegistry.Service
    const webSearchRuntime = yield* WebSearchRuntime.Service
    const truncate = yield* Truncate.Service
    const image = yield* Image.Service
    const scope = yield* Scope.Scope
    const instruction = yield* Instruction.Service
    const state = yield* SessionRunState.Service
    const revert = yield* SessionRevert.Service
    const summary = yield* SessionSummary.Service
    const sys = yield* SystemPrompt.Service
    const llm = yield* LLM.Service
    const events = yield* EventV2Bridge.Service
    const flags = yield* RuntimeFlags.Service
    const database = yield* Database.Service
    const supervisor = yield* SessionSupervisor.Service
    const locations = yield* LocationServiceMap.Service
    const { db } = database
    const ops: () => Effect.Effect<TaskPromptOps> = Effect.fn("SessionPrompt.ops")(function* () {
      return {
        cancel: (sessionID: SessionID): Effect.Effect<void> => cancel(sessionID),
        resolvePromptParts: (template: string): Effect.Effect<PromptInput["parts"], SessionSupervisorError> =>
          resolvePromptParts(template),
        prompt: (
          input: PromptInput,
          directAttempt?: DirectAttemptAuthority,
          managedAttempt?: ManagedAttemptAuthority,
          directTurn?: DirectTurnAuthority,
          managedContext?: ManagedProviderContextV1,
          managedFollowUpRunner?: ManagedFollowUpRunnerV1,
          managedPreDispatchRecovery?: ManagedPreDispatchRecoveryV1,
        ): Effect.Effect<SessionV1.WithParts, Image.Error | Session.BusyError | SessionSupervisorError> =>
          promptWithAttempt(input, directAttempt, managedAttempt, directTurn, managedContext, managedFollowUpRunner, managedPreDispatchRecovery),
      } satisfies TaskPromptOps
    })

    const cancel = Effect.fn("SessionPrompt.cancel")(function* (sessionID: SessionID) {
      yield* Effect.logInfo("cancel", { "session.id": sessionID })
      yield* state.cancel(sessionID)
    })

    const resolvePromptParts = Effect.fn("SessionPrompt.resolvePromptParts")(function* (template: string) {
      const ctx = yield* InstanceState.context
      const parts: Types.DeepMutable<PromptInput["parts"]> = [{ type: "text", text: template }]
      const files = ConfigMarkdown.files(template)
      const seen = new Set<string>()
      yield* Effect.forEach(
        files,
        Effect.fnUntraced(function* (match) {
          const name = match[1]
          if (!name) return
          if (seen.has(name)) return
          seen.add(name)

          const filepath = name.startsWith("~/")
            ? path.join(os.homedir(), name.slice(2))
            // Non-git projects (and installs where the guarded Git read path is
            // unavailable) pin `worktree` to "/"; resolving an @file there would
            // address the filesystem root. The instance directory is the
            // canonical project root in that case.
            : path.resolve(ctx.worktree === "/" ? ctx.directory : ctx.worktree, name)

          const info = yield* fsys.stat(filepath).pipe(Effect.option)
          if (Option.isNone(info)) {
            const found = yield* agents.get(name)
            if (found) parts.push({ type: "agent", name: found.name })
            return
          }
          const stat = info.value
          parts.push({
            type: "file",
            url: pathToFileURL(filepath).href,
            filename: name,
            mime: stat.type === "Directory" ? "application/x-directory" : "text/plain",
          })
        }),
        { concurrency: "unbounded", discard: true },
      )
      return parts
    })

    const title = Effect.fn("SessionPrompt.ensureTitle")(function* (input: {
      session: Session.Info
      history: SessionV1.WithParts[]
      providerID: ProviderV2.ID
      modelID: ModelV2.ID
    }) {
      if (input.session.parentID) return
      if (!Session.isDefaultTitle(input.session.title)) return

      const real = (m: SessionV1.WithParts) =>
        m.info.role === "user" && !m.parts.every((p) => "synthetic" in p && p.synthetic)
      const idx = input.history.findIndex(real)
      if (idx === -1) return
      if (input.history.filter(real).length !== 1) return

      const context = input.history.slice(0, idx + 1)
      const firstUser = context[idx]
      if (!firstUser || firstUser.info.role !== "user") return
      const firstInfo = firstUser.info

      const subtasks = firstUser.parts.filter((p): p is SessionV1.SubtaskPart => p.type === "subtask")
      const onlySubtasks = subtasks.length > 0 && firstUser.parts.every((p) => p.type === "subtask")

      const ag = yield* agents.get("title")
      if (!ag) return
      // Session title generation is auxiliary work on the same Session route.
      // Do not silently select a different small model when the title agent has
      // no explicit model: use the exact provider/model already pinned to the
      // Session. An explicit title-agent model remains an intentional override.
      const mdl = ag.model
        ? yield* provider.getModel(ag.model.providerID, ag.model.modelID)
        : yield* provider.getModel(input.providerID, input.modelID)
      const msgs = onlySubtasks
        ? [{ role: "user" as const, content: subtasks.map((p) => p.prompt).join("\n") }]
        : yield* MessageV2.toModelMessagesEffect(context, mdl)
      const text = yield* llm
        .stream({
          agent: ag,
          user: firstInfo,
          system: [],
          small: true,
          tools: {},
          model: mdl,
          sessionID: input.session.id,
          retries: 2,
          messages: [{ role: "user", content: "Generate a title for this conversation:\n" }, ...msgs],
        })
        .pipe(
          Stream.filter(LLMEvent.is.textDelta),
          Stream.map((e) => e.text),
          Stream.mkString,
          Effect.orDie,
        )
      const cleaned = text
        .replace(/<think>[\s\S]*?<\/think>\s*/g, "")
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.length > 0)
      if (!cleaned) return
      const t = cleaned.length > 100 ? cleaned.substring(0, 97) + "..." : cleaned
      yield* sessions
        .setTitle({ sessionID: input.session.id, title: t })
        .pipe(Effect.catchCause((cause) => Effect.logError("failed to generate title", { error: Cause.squash(cause) })))
    })

    const handleSubtask = Effect.fn("SessionPrompt.handleSubtask")(function* (input: {
      task: SessionV1.SubtaskPart
      model: Provider.Model
      lastUser: SessionV1.User
      sessionID: SessionID
    }) {
      const { task, model, lastUser, sessionID } = input
      const ctx = yield* InstanceState.context
      const now = Date.now()
      const assistantID = MessageID.ascending()
      const toolInput = {
        prompt: task.prompt,
        description: task.description,
        subagent_type: task.agent,
        command: task.command,
      }

      yield* sessions.updateMessage({
        id: assistantID,
        role: "assistant",
        parentID: lastUser.id,
        sessionID,
        mode: task.agent,
        agent: task.agent,
        variant: lastUser.model.variant,
        path: { cwd: ctx.directory, root: ctx.worktree },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: model.id,
        providerID: model.providerID,
        finish: "tool-calls",
        time: { created: now, completed: now },
      } satisfies SessionV1.Assistant)
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: assistantID,
        sessionID,
        type: "tool",
        callID: ulid(),
        tool: TaskTool.id,
        state: {
          status: "error",
          input: toolInput,
          error: AGENT_SPAWN_UNAVAILABLE_MESSAGE,
          time: { start: now, end: now },
        },
      } satisfies SessionV1.ToolPart)
    })

    const getModel = Effect.fn("SessionPrompt.getModel")(function* (
      providerID: ProviderV2.ID,
      modelID: ModelV2.ID,
      sessionID: SessionID,
    ) {
      const exit = yield* provider.getModel(providerID, modelID).pipe(Effect.exit)
      if (Exit.isSuccess(exit)) return exit.value
      const err = Cause.squash(exit.cause)
      if (Provider.ModelNotFoundError.isInstance(err)) {
        const hint = err.suggestions?.length ? ` Did you mean: ${err.suggestions.join(", ")}?` : ""
        yield* events.publish(Session.Event.Error, {
          sessionID,
          error: new NamedError.Unknown({
            message: `Model not found: ${err.providerID}/${err.modelID}.${hint}`,
          }).toObject(),
        })
      }
      return yield* Effect.die(err)
    })

    const currentModel = Effect.fnUntraced(function* (sessionID: SessionID) {
      const current = yield* db
        .select({ model: SessionTable.model })
        .from(SessionTable)
        .where(eq(SessionTable.id, sessionID))
        .get()
        .pipe(Effect.orDie)
      if (current?.model) {
        return {
          providerID: ProviderV2.ID.make(current.model.providerID),
          modelID: ModelV2.ID.make(current.model.id),
          ...(current.model.variant && current.model.variant !== "default" ? { variant: current.model.variant } : {}),
        }
      }
      const match = yield* sessions
        .findMessage(sessionID, (m) => m.info.role === "user" && !!m.info.model)
        .pipe(Effect.orDie)
      if (Option.isSome(match) && match.value.info.role === "user") return match.value.info.model
      return yield* provider.defaultModel().pipe(Effect.orDie)
    })

    const createUserMessage = Effect.fn("SessionPrompt.createUserMessage")(function* (input: PromptInput) {
      const agentName = input.agent
      const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
      const preflightProfile = managedPreflightProfilePin(session.metadata)
      const ag = agentName
        ? preflightProfile
          ? yield* agents.getProfile(preflightProfile.profileID, preflightProfile.revision)
          : yield* agents.get(agentName)
        : yield* agents.defaultInfo()
      if (!ag) {
        const available = (yield* agents.list().pipe(
          Effect.catchIf(isAgentProfileDirectoryError, agentProfileDirectoryFailure),
        )).filter((a) => !a.hidden).map((a) => a.name)
        const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
        const error = new NamedError.Unknown({ message: `Agent not found: "${agentName}".${hint}` })
        yield* events.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
        throw error
      }

      const model = input.model ?? ag.model ?? (yield* currentModel(input.sessionID))
      const same = ag.model && model.providerID === ag.model.providerID && model.modelID === ag.model.modelID
      const full =
        !input.variant && ag.variant && same
          ? yield* provider
              .getModel(model.providerID, model.modelID)
              .pipe(Effect.catchIf(Provider.ModelNotFoundError.isInstance, () => Effect.succeed(undefined)))
          : undefined
      const variant = input.variant ?? (ag.variant && full?.variants?.[ag.variant] ? ag.variant : undefined)

      const info: SessionV1.User = {
        id: input.messageID ?? MessageID.ascending(),
        role: "user",
        sessionID: input.sessionID,
        time: { created: Date.now() },
        tools: input.tools,
        agent: ag.name,
        model: {
          providerID: model.providerID,
          modelID: model.modelID,
          variant,
        },
        system: input.system,
        format: input.format,
      }

      const current = session
      if (
        current.agent !== info.agent ||
        current.model?.providerID !== info.model.providerID ||
        current.model?.id !== info.model.modelID ||
        (current.model?.variant === "default" ? undefined : current.model?.variant) !== info.model.variant
      ) {
        yield* sessions.setAgentModel({
          sessionID: input.sessionID,
          agent: info.agent,
          model: {
            id: info.model.modelID,
            providerID: info.model.providerID,
            variant: info.model.variant ?? "default",
          },
          time: info.time.created,
        })
      }

      yield* Effect.addFinalizer(() => instruction.clear(info.id))

      type Draft<T> = T extends SessionV1.Part ? Omit<T, "id"> & { id?: string } : never
      const assign = (part: Draft<SessionV1.Part>): SessionV1.Part => ({
        ...part,
        id: part.id ? PartID.make(part.id) : PartID.ascending(),
      })

      const resolvePart: (part: PromptInput["parts"][number]) => Effect.Effect<Draft<SessionV1.Part>[]> = Effect.fn(
        "SessionPrompt.resolveUserPart",
      )(function* (part) {
        if (part.type === "file") {
          if (part.source?.type === "resource") {
            const { clientName, uri } = part.source
            yield* Effect.logInfo("mcp resource", { clientName, uri, mime: part.mime })
            const pieces: Draft<SessionV1.Part>[] = [
              {
                messageID: info.id,
                sessionID: input.sessionID,
                type: "text",
                synthetic: true,
                text: `Reading MCP resource: ${part.filename} (${uri})`,
              },
            ]
            const exit = yield* mcp.readResource(clientName, uri).pipe(Effect.exit)
            if (Exit.isSuccess(exit)) {
              const content = exit.value
              if (!content) throw new Error(`Resource not found: ${clientName}/${uri}`)
              const items = Array.isArray(content.contents) ? content.contents : [content.contents]
              for (const c of items) {
                if (!c || typeof c !== "object") continue
                if ("text" in c && typeof c.text === "string" && c.text) {
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: c.text,
                  })
                } else if ("blob" in c && typeof c.blob === "string" && c.blob) {
                  const mime = "mimeType" in c && typeof c.mimeType === "string" ? c.mimeType : part.mime
                  const filename = "uri" in c && typeof c.uri === "string" ? c.uri : part.filename
                  const size = mcpResourceBase64Size(c.blob)
                  if (!SUPPORTED_MCP_RESOURCE_ATTACHMENT_MIMES.has(mime)) {
                    pieces.push({
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: `[Binary MCP resource omitted: ${filename ?? uri} (${mime}, ${formatMcpResourceBytes(size)}) is not a supported attachment type]`,
                    })
                    continue
                  }
                  if (size > MAX_MCP_RESOURCE_BLOB_BYTES) {
                    pieces.push({
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: `[Binary MCP resource omitted: ${filename ?? uri} (${mime}, ${formatMcpResourceBytes(size)}) exceeds ${formatMcpResourceBytes(MAX_MCP_RESOURCE_BLOB_BYTES)}]`,
                    })
                    continue
                  }
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `[Binary MCP resource attached: ${filename ?? uri} (${mime})]`,
                  })
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "file",
                    mime,
                    filename,
                    url: `data:${mime};base64,${c.blob}`,
                  })
                }
              }
            } else {
              const error = Cause.squash(exit.cause)
              yield* Effect.logError("failed to read MCP resource", { error, clientName, uri })
              const message = error instanceof Error ? error.message : String(error)
              pieces.push({
                messageID: info.id,
                sessionID: input.sessionID,
                type: "text",
                synthetic: true,
                text: `Failed to read MCP resource ${part.filename}: ${message}`,
              })
            }
            return pieces
          }
          const url = new URL(part.url)
          switch (url.protocol) {
            case "data:":
              if (part.mime === "text/plain") {
                return [
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: ${JSON.stringify({ filePath: part.filename })}`,
                  },
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: decodeDataUrl(part.url),
                  },
                  { ...part, messageID: info.id, sessionID: input.sessionID },
                ]
              }
              break
            case "file:": {
              yield* Effect.logInfo("file", { mime: part.mime })
              const filepath = fileURLToPath(part.url)
              const mime = (yield* fsys.isDir(filepath)) ? "application/x-directory" : part.mime

              const { read } = yield* registry.named()
              const execRead = (args: Parameters<typeof read.execute>[0], extra?: Tool.Context["extra"]) => {
                const controller = new AbortController()
                return read
                  .execute(args, {
                    sessionID: input.sessionID,
                    abort: controller.signal,
                    agent: input.agent!,
                    messageID: info.id,
                    extra: { bypassCwdCheck: true, ...extra },
                    messages: [],
                    metadata: () => Effect.void,
                    ask: () => Effect.void,
                  })
                  .pipe(Effect.onInterrupt(() => Effect.sync(() => controller.abort())))
              }

              if (mime === "text/plain") {
                let offset: number | undefined
                let limit: number | undefined
                const range = { start: url.searchParams.get("start"), end: url.searchParams.get("end") }
                if (range.start != null) {
                  const filePathURI = part.url.split("?")[0]
                  let start = parseInt(range.start)
                  let end = range.end ? parseInt(range.end) : undefined
                  if (start === end) {
                    const symbols = yield* lsp.documentSymbol(filePathURI).pipe(Effect.catch(() => Effect.succeed([])))
                    for (const symbol of symbols) {
                      let r: LSP.Range | undefined
                      if ("range" in symbol) r = symbol.range
                      else if ("location" in symbol) r = symbol.location.range
                      if (r?.start?.line && r?.start?.line === start) {
                        start = r.start.line
                        end = r?.end?.line ?? start
                        break
                      }
                    }
                  }
                  offset = Math.max(start, 1)
                  if (end) limit = end - (offset - 1)
                }
                const args = { filePath: filepath, offset, limit }
                const pieces: Draft<SessionV1.Part>[] = [
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: ${JSON.stringify(args)}`,
                  },
                ]
                const exit = yield* provider.getModel(info.model.providerID, info.model.modelID).pipe(
                  Effect.flatMap((mdl) => execRead(args, { model: mdl })),
                  Effect.exit,
                )
                if (Exit.isSuccess(exit)) {
                  const result = exit.value
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: result.output,
                  })
                  if (result.attachments?.length) {
                    pieces.push(
                      ...result.attachments.map((a) => ({
                        ...a,
                        synthetic: true,
                        filename: a.filename ?? part.filename,
                        messageID: info.id,
                        sessionID: input.sessionID,
                      })),
                    )
                  } else {
                    pieces.push({ ...part, mime, messageID: info.id, sessionID: input.sessionID })
                  }
                } else {
                  const error = Cause.squash(exit.cause)
                  yield* Effect.logError("failed to read file", { error, filepath })
                  const message = error instanceof Error ? error.message : String(error)
                  yield* events.publish(Session.Event.Error, {
                    sessionID: input.sessionID,
                    error: new NamedError.Unknown({ message }).toObject(),
                  })
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Read tool failed to read ${filepath} with the following error: ${message}`,
                  })
                }
                return pieces
              }

              if (mime === "application/x-directory") {
                const args = { filePath: filepath }
                const exit = yield* execRead(args).pipe(Effect.exit)
                if (Exit.isFailure(exit)) {
                  const error = Cause.squash(exit.cause)
                  yield* Effect.logError("failed to read directory", { error, filepath })
                  const message = error instanceof Error ? error.message : String(error)
                  yield* events.publish(Session.Event.Error, {
                    sessionID: input.sessionID,
                    error: new NamedError.Unknown({ message }).toObject(),
                  })
                  return [
                    {
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: `Read tool failed to read ${filepath} with the following error: ${message}`,
                    },
                  ]
                }
                return [
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: ${JSON.stringify(args)}`,
                  },
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: exit.value.output,
                  },
                  { ...part, mime, messageID: info.id, sessionID: input.sessionID },
                ]
              }

              return [
                {
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "text",
                  synthetic: true,
                  text: `Called the Read tool with the following input: {"filePath":"${filepath}"}`,
                },
                {
                  id: part.id,
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "file",
                  url:
                    `data:${mime};base64,` +
                    Buffer.from(yield* fsys.readFile(filepath).pipe(Effect.catch(Effect.die))).toString("base64"),
                  mime,
                  filename: part.filename!,
                  source: part.source,
                },
              ]
            }
          }
        }

        if (part.type === "agent") {
          const perm = Permission.evaluate("task", part.name, ag.permission)
          const hint = perm.action === "deny" ? " . Invoked by user; guaranteed to exist." : ""
          return [
            { ...part, messageID: info.id, sessionID: input.sessionID },
            {
              messageID: info.id,
              sessionID: input.sessionID,
              type: "text",
              synthetic: true,
              text:
                " Use the above message and context to generate a prompt and call the task tool with subagent: " +
                part.name +
                hint,
            },
          ]
        }

        return [{ ...part, messageID: info.id, sessionID: input.sessionID }]
      })

      const resolvedParts = yield* Effect.forEach(input.parts, resolvePart, { concurrency: "unbounded" }).pipe(
        Effect.map((x) => x.flat().map(assign)),
      )

      yield* plugin.trigger(
        "chat.message",
        {
          sessionID: input.sessionID,
          agent: input.agent,
          model: input.model,
          messageID: input.messageID,
          variant: input.variant,
        },
        { message: info, parts: resolvedParts },
      )

      const parts = yield* Effect.forEach(resolvedParts, (part) =>
        part.type === "file" && part.mime.startsWith("image/")
          ? image.normalize(part).pipe(
              Effect.catchIf(
                (error) => error instanceof Image.ResizerUnavailableError,
                () => Effect.succeed(part),
              ),
            )
          : Effect.succeed(part),
      )

      const parsed = decodeMessageInfo(info, { errors: "all", propertyOrder: "original" })
      if (Exit.isFailure(parsed)) {
        yield* Effect.logError("invalid user message before save", {
          sessionID: input.sessionID,
          messageID: info.id,
          agent: info.agent,
          model: info.model,
          cause: Cause.pretty(parsed.cause),
        })
      }
      for (const [index, part] of parts.entries()) {
        const p = decodeMessagePart(part, { errors: "all", propertyOrder: "original" })
        if (Exit.isSuccess(p)) continue
        yield* Effect.logError("invalid user part before save", {
          sessionID: input.sessionID,
          messageID: info.id,
          partID: part.id,
          partType: part.type,
          index,
          cause: Cause.pretty(p.cause),
          part,
        })
      }

      yield* sessions.updateMessage(info)
      for (const part of parts) yield* sessions.updatePart(part)

      return { info, parts }
    }, Effect.scoped)

    const promptWork = Effect.fn("SessionPrompt.prompt")(function* (
      input: PromptInput,
      directAttempt?: DirectAttemptAuthority,
      managedAttempt?: ManagedAttemptAuthority,
      directTurn?: DirectTurnAuthority,
      managedContext?: ManagedProviderContextV1,
      managedFollowUpRunner?: ManagedFollowUpRunnerV1,
      managedPreDispatchRecovery?: ManagedPreDispatchRecoveryV1,
    ) {
      const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
      // Apply settings queued at the next-turn boundary only for a new root
      // prompt. Attempt-bound child prompts execute inside the parent turn and
      // must retain its pinned effective configuration.
      if (shouldApplyPendingFeatures(directAttempt, managedAttempt)) yield* config.applyPendingFeatures()
      yield* revert.cleanup(session)
      const message = yield* createUserMessage(input)
      yield* sessions.touch(input.sessionID)

      const permissions: PermissionV1.Rule[] = []
      for (const [t, enabled] of Object.entries(input.tools ?? {})) {
        permissions.push({ permission: t, action: enabled ? "allow" : "deny", pattern: "*" })
      }
      if (permissions.length > 0) {
        session.permission = permissions
        yield* sessions.setPermission({ sessionID: session.id, permission: permissions })
      }

      if (input.noReply === true) return message
      return yield* loopWithAttempt({ sessionID: input.sessionID }, directAttempt, managedAttempt, directTurn, managedContext, managedFollowUpRunner, managedPreDispatchRecovery)
    })
    const promptWithAttempt = (
      input: PromptInput,
      directAttempt?: DirectAttemptAuthority,
      managedAttempt?: ManagedAttemptAuthority,
      directTurn?: DirectTurnAuthority,
      managedContext?: ManagedProviderContextV1,
      managedFollowUpRunner?: ManagedFollowUpRunnerV1,
      managedPreDispatchRecovery?: ManagedPreDispatchRecoveryV1,
    ): Effect.Effect<SessionV1.WithParts, Image.Error | Session.BusyError | SessionSupervisorError> =>
      state.withExecutionOwner(input.sessionID, promptWork(input, directAttempt, managedAttempt, directTurn, managedContext, managedFollowUpRunner, managedPreDispatchRecovery))
    const prompt: Interface["prompt"] = (input) => promptWithAttempt(input)
    const promptManaged: Interface["promptManaged"] = (input, authority, followUpRunner) => {
      const scope = authority.currentScope()
      if (scope.sessionID !== input.sessionID) {
        return Effect.fail(new SessionSupervisorError({
          stage: "managed-attempt",
          reason: "managed Attempt scope is bound to a different Session",
        }))
      }
      return state.withExecutionOwner(input.sessionID, promptWork(input, undefined, authority, undefined, undefined, followUpRunner))
    }
    const runManagedTask: Interface["runManagedTask"] = (input) =>
      Effect.gen(function* () {
        const promptOps = yield* ops()
        return yield* runManagedTaskPrompt({ ...input, promptOps }).pipe(
          Effect.provideService(SessionSupervisor.Service, supervisor),
        )
      })

    /**
     * Collapse prompt/preflight build failures into the declared managed error
     * channels. These failures happen before any dispatch, so they fail closed
     * with the original message preserved in `reason`.
     */
    const managedPreflightFailure = (operation: string, error: unknown) => {
      if (error instanceof SessionSupervisorError) return error
      if (error instanceof ManagedControl.ManagedControlError) return error
      const reason = error instanceof Error ? error.message : String(error)
      return new ManagedControl.ManagedControlError({ operation, code: "managed_unavailable", reason })
    }

    /** Same collapse for the channel that keeps Session.BusyError visible. */
    const promptBuildFailure = (error: unknown) => {
      if (error instanceof Session.BusyError) return error
      if (error instanceof SessionSupervisorError) return error
      const reason = error instanceof Error ? error.message : String(error)
      return new SessionSupervisorError({ stage: "managed_context", reason: `prompt build failed before dispatch: ${reason}` })
    }

    const prepareManagedTaskRequest: Interface["prepareManagedTaskRequest"] = (input) =>
      Effect.gen(function* () {
        const task = input.selection.task
        if (input.selection.status !== "READY_TASK" || !task ||
          input.trustedPrincipal.kind !== "server_auth" ||
          input.rootSessionID !== input.selection.sessionID ||
          input.childSessionID !== ManagedControl.managedTaskSessionID(task.candidateAttemptID) ||
          input.requestSequence !== "1" ||
          input.requestID !== `req_managed_${task.candidateAttemptID}_1` ||
          input.preAdmissionTarget.workspaceRef !== input.selection.workspaceRef) {
          return yield* new ManagedControl.ManagedControlError({
            operation: "managed_context.prepare",
            code: "managed_conflict",
            reason: "managed preflight identity or authenticated P8 target differs from the canonical READY_TASK selection",
          })
        }
        if (input.trustedPrincipal.subject.length < 1 ||
          input.preAdmissionTarget.worktreeID.length < 1 ||
          !/^[1-9][0-9]{0,19}$/.test(task.taskRevision) ||
          !/^blake3:[0-9a-f]{64}$/.test(task.contextDigest) ||
          !/^blake3:[0-9a-f]{64}$/.test(input.selection.specDigest) ||
          !/^blake3:[0-9a-f]{64}$/.test(task.profile.definitionDigest) ||
          !/^[1-9][0-9]{0,15}$/.test(task.profile.revision)) {
          return yield* new ManagedControl.ManagedControlError({
            operation: "managed_context.prepare",
            code: "managed_protocol",
            reason: "managed Task, accepted Spec, profile, or trusted principal pins are malformed",
          })
        }
        const root = yield* sessions.get(SessionID.make(input.rootSessionID))
        const rootBinding = root.metadata?.horizonManagedRoot
        if (root.parentID || root.id !== input.selection.sessionID || root.workspaceID !== input.selection.workspaceRef ||
          typeof rootBinding !== "object" || rootBinding === null || Array.isArray(rootBinding) ||
          rootBinding.goalID !== input.selection.goalID || rootBinding.runID !== input.selection.runID ||
          rootBinding.specID !== input.selection.specID || rootBinding.specDigest !== input.selection.specDigest ||
          rootBinding.workspaceID !== input.selection.workspaceRef) {
          return yield* new ManagedControl.ManagedControlError({
            operation: "managed_context.prepare",
            code: "managed_conflict",
            reason: "managed preflight root Session is not durably bound to the selected Goal, Run, Spec, and workspace",
          })
        }
        const target = input.preAdmissionTarget
        if (target.locationID !== input.selection.locationID || target.workspaceRef !== input.selection.workspaceRef ||
          target.workspaceID.length < 1 || target.canonicalRoot.length < 1 ||
          !/^blake3:[0-9a-f]{64}$/.test(target.workspaceRevision) ||
          !/^(0|[1-9][0-9]{0,19})$/.test(target.worktreePoolRevision) || BigInt(target.worktreePoolRevision) === 0n ||
          !target.worktreeBaseRevision) {
          return yield* new ManagedControl.ManagedControlError({
            operation: "managed_context.prepare",
            code: "managed_conflict",
            reason: "authenticated P8 target does not match the managed selection workspace and Location",
          })
        }
        const targetWorkspaceID = WorkspaceV2.ID.make(target.workspaceID)
        const targetDirectory = AbsolutePath.make(target.canonicalRoot)
        const targetLocation = Location.Ref.make({ directory: targetDirectory, workspaceID: targetWorkspaceID })
        const registeredLocationID = yield* supervisor.registerHostLocation(targetLocation).pipe(
          Effect.provideService(TrustedPrincipalContext, { principal: input.trustedPrincipal }),
          Effect.mapError((error) => new ManagedControl.ManagedControlError({
            operation: "managed_context.prepare",
            code: "managed_unavailable",
            reason: `P8 target Location could not be registered: ${error.message}`,
          })),
        )
        if (registeredLocationID !== target.locationID) {
          return yield* new ManagedControl.ManagedControlError({
            operation: "managed_context.prepare",
            code: "managed_conflict",
            reason: "Core resolved a different Location than the authenticated P8 worktree target",
          })
        }
        const profileRevision = task.profile.revision
        const profile = yield* agents.getProfile(task.profile.profileID, profileRevision)
        const profileProjection = profile.options.horizonAgentProfile
        if (typeof profileProjection !== "object" || profileProjection === null ||
          !("profileId" in profileProjection) || profileProjection.profileId !== task.profile.profileID ||
          !("revision" in profileProjection) || String(profileProjection.revision) !== task.profile.revision ||
          !("harness" in profileProjection) || typeof profileProjection.harness !== "string" ||
          profile.model === undefined) {
          return yield* new ManagedControl.ManagedControlError({
            operation: "managed_context.prepare",
            code: "agent_profile_stale",
            reason: "Core Config did not resolve the exact enabled Task-pinned AgentProfileV2 revision and model",
          })
        }
        const profileLimits = "limits" in profileProjection && typeof profileProjection.limits === "object" && profileProjection.limits !== null
          ? profileProjection.limits as Record<string, unknown>
          : undefined
        const maxMessageBytes = profileLimits?.maxMessageBytes
        const maxPendingMessages = profileLimits?.maxPendingMessages
        if (!Number.isSafeInteger(maxMessageBytes) || (maxMessageBytes as number) < 1 ||
          !Number.isSafeInteger(maxPendingMessages) || (maxPendingMessages as number) < 1) {
          return yield* new ManagedControl.ManagedControlError({
            operation: "managed_context.prepare",
            code: "agent_profile_stale",
            reason: "Task-pinned AgentProfileV2 has no bounded pending-message and message-byte limits",
          })
        }
        if (BigInt(task.effectiveMaxTokens) < 1n || BigInt(task.remainingTokens) < 1n ||
          BigInt(task.remainingTokens) > BigInt(task.effectiveMaxTokens)) {
          return yield* new ManagedControl.ManagedControlError({
            operation: "managed_context.prepare",
            code: "managed_conflict",
            reason: "Rust-selected managed token remainder is malformed or exhausted",
          })
        }
        const model = yield* provider.getModel(profile.model.providerID, profile.model.modelID)
        if (!model) {
          return yield* new ManagedControl.ManagedControlError({
            operation: "managed_context.prepare",
            code: "agent_profile_unavailable",
            reason: "Task-pinned AgentProfileV2 provider/model is unavailable",
          })
        }
        const parentAgent = yield* agents.get(root.agent ?? "build")
        const childPermission = deriveSubagentSessionPermission({
          parentAgentPermission: parentAgent.permission,
          parentSessionPermission: root.permission ?? [],
          subagent: profile,
        })
        const managedToolDenies = ["task", "todowrite"].map((permission) => ({
          permission,
          pattern: "*",
          action: "deny" as const,
        }))
        const childPermissions = [
          ...childPermission,
          ...managedToolDenies.filter((deny) => !childPermission.some((rule) =>
            rule.permission === deny.permission && rule.pattern === deny.pattern && rule.action === "deny")),
        ]
        const promptText = [
          `Task: ${task.title}`,
          task.purpose,
          `Goal: ${input.selection.goalObjective}`,
          input.selection.specConstraints.length > 0
            ? `Accepted constraints:\n${input.selection.specConstraints.map((item) => `- ${item}`).join("\n")}`
            : undefined,
          `Acceptance criteria:\n${task.criteria.map((item) => `- ${item.criterionID}: ${item.description}`).join("\n")}`,
          task.dependencies.length > 0 ? `Scheduler-satisfied dependency Task IDs: ${task.dependencies.join(", ")}` : undefined,
        ].filter((part): part is string => typeof part === "string").join("\n\n")
        if (Buffer.byteLength(promptText, "utf8") > (maxMessageBytes as number) || (maxPendingMessages as number) < 1) {
          return yield* new ManagedControl.ManagedControlError({
            operation: "managed_context.prepare",
            code: "agent_profile_limit",
            reason: "managed Task prompt exceeds its exact AgentProfileV2 message limits",
          })
        }
        const promptMessageID = MessageID.make(`msg_managed_${createHash("sha256").update(`${input.requestID}\0${input.childSessionID}`).digest("hex").slice(0, 32)}`)
        const promptDigest = `sha256:${createHash("sha256").update(promptText, "utf8").digest("hex")}`
        const stage = {
          schemaVersion: 1,
          candidateAttemptID: task.candidateAttemptID,
          taskID: task.taskID,
          taskRevision: task.taskRevision,
          taskContextDigest: task.contextDigest,
          specID: input.selection.specID,
          specDigest: input.selection.specDigest,
          profileID: task.profile.profileID,
          profileRevision: task.profile.revision,
          profileDigest: task.profile.definitionDigest,
          harness: profileProjection.harness,
          worktreeTarget: target,
          requestID: input.requestID,
          requestSequence: input.requestSequence,
          promptMessageID,
          promptDigest,
        }
        const childID = SessionID.make(input.childSessionID)
        const existing = yield* sessions.get(childID).pipe(
          Effect.map(Option.some),
          Effect.catchTag("NotFoundError", () => Effect.succeed(Option.none())),
        )
        let child: Session.Info
        let persistedContextSelection: ContextSelectionV1 | undefined
        if (Option.isSome(existing)) {
          child = existing.value
          const savedStage = child.metadata?.horizonManagedPreflightV1
          const savedStageRecord = typeof savedStage === "object" && savedStage !== null && !Array.isArray(savedStage)
            ? savedStage as Record<string, unknown>
            : undefined
          const savedContextSelection = savedStageRecord?.contextSelection
          const savedStageBase = savedStageRecord
            ? Object.fromEntries(Object.entries(savedStageRecord).filter(([key]) => key !== "contextSelection"))
            : undefined
          const savedKeys = savedStageRecord ? Object.keys(savedStageRecord).toSorted().join("\0") : ""
          const expectedKeys = [Object.keys(stage), [...Object.keys(stage), "contextSelection"]]
            .map((keys) => keys.toSorted().join("\0"))
          if (child.parentID !== root.id || child.workspaceID !== target.workspaceID ||
            child.agent !== profile.name || child.model?.providerID !== model.providerID || child.model?.id !== model.id ||
            !expectedKeys.includes(savedKeys) || JSON.stringify(savedStageBase) !== JSON.stringify(stage)) {
            return yield* new ManagedControl.ManagedControlError({
              operation: "managed_context.prepare",
              code: "managed_conflict",
              reason: "candidate child Session already exists with conflicting preflight identity or prepared prompt",
            })
          }
          if (savedContextSelection !== undefined) {
            persistedContextSelection = yield* Effect.try({
              try: () => Schema.decodeUnknownSync(ContextSelectionV1, { onExcessProperty: "error" })(savedContextSelection),
              catch: () => new ManagedControl.ManagedControlError({
                operation: "managed_context.prepare",
                code: "managed_conflict",
                reason: "persisted candidate ContextSelection is malformed",
              }),
            })
          }
        } else {
          child = yield* sessions.create({
            id: childID,
            parentID: root.id,
            title: task.title,
            agent: profile.name,
            model: { providerID: model.providerID, id: model.id },
            permission: childPermissions,
            workspaceID: targetWorkspaceID,
            metadata: { horizonManagedPreflightV1: stage },
          }).pipe(Effect.provideService(TrustedPrincipalContext, { principal: input.trustedPrincipal }))
        }
        const providerInput = yield* prepareManagedPrompt({
          prompt: {
            messageID: promptMessageID,
            sessionID: childID,
            model: { providerID: model.providerID, modelID: model.id },
            agent: profile.name,
            parts: [{ type: "text", text: promptText }],
          },
          remainingTokens: task.remainingTokens,
          directory: target.canonicalRoot,
          workspaceID: target.workspaceID,
        }).pipe(
          Effect.provideService(InstanceRef, { ...(yield* InstanceState.context), directory: targetDirectory }),
          Effect.provideService(WorkspaceRef, targetWorkspaceID),
        )
        const cursor = yield* supervisor.sessionProjectionCursor(childID)
        if (cursor.ownerKind !== "session" || cursor.ownerId !== childID ||
          !/^[1-9][0-9]{0,19}$/.test(cursor.seq) ||
          !/^blake3:[0-9a-f]{64}$/.test(cursor.eventDigest)) {
          return yield* new ManagedControl.ManagedControlError({
            operation: "managed_context.prepare",
            code: "managed_unavailable",
            reason: "SessionSupervisor did not return an exact child Session source cursor for context selection",
          })
        }
        const sourceRevision = persistedContextSelection
          ? persistedContextSelection.sourceRevision
          : cursor.seq
        if (persistedContextSelection && BigInt(cursor.seq) !== BigInt(sourceRevision) + 1n) {
          return yield* new ManagedControl.ManagedControlError({
            operation: "managed_context.prepare",
            code: "managed_conflict",
            reason: "child Session source advanced beyond the single known preflight-metadata event; exact context replay is unavailable",
          })
        }
        const contextSelection = compileManagedContextSelection({
          sessionID: childID,
          requestID: input.requestID,
          requestSequence: input.requestSequence,
          sourceRevision,
          attemptID: task.candidateAttemptID,
          taskID: task.taskID,
          taskRevision: task.taskRevision,
          taskContextDigest: task.contextDigest,
          specID: input.selection.specID,
          specDigest: input.selection.specDigest,
          profileID: task.profile.profileID,
          profileRevision: task.profile.revision,
          profileDigest: task.profile.definitionDigest,
          // No toolset provenance exists before the child's first resolved run;
          // this frozen selection pins an empty source set by construction.
          toolSources: [],
          providerInput,
        })
        if (persistedContextSelection && !sameManagedContextSelectionV1(persistedContextSelection, contextSelection)) {
          return yield* new ManagedControl.ManagedControlError({
            operation: "managed_context.prepare",
            code: "managed_conflict",
            reason: "recompiled sequence-1 ContextSelection differs from the exact persisted pre-admission selection",
          })
        }
        const profileRecords = yield* Effect.serviceOption(AgentProfileService)
        const taskProfile = Option.isSome(profileRecords)
          ? yield* profileRecords.value.agentProfiles().pipe(
              Effect.map((records) =>
                records.find((record) =>
                  record.profileId === task.profile.profileID && String(record.revision) === task.profile.revision),
              ),
              Effect.catch(() => Effect.succeed(undefined)),
            )
          : undefined
        if (!taskProfile) {
          return yield* new ManagedControl.ManagedControlError({
            operation: "managed_context.prepare",
            code: "managed_unavailable",
            reason: "the task-pinned AgentProfileV2 harness projection is unavailable",
          })
        }
        const exactContextSelection = persistedContextSelection ?? contextSelection
        if (!persistedContextSelection) {
          const completedStage = { ...stage, contextSelection: exactContextSelection }
          yield* sessions.setMetadata({ sessionID: child.id, metadata: { ...(child.metadata ?? {}), horizonManagedPreflightV1: completedStage } })
        }
        return {
          contextSelection: exactContextSelection,
          providerInput,
          toolSources: [],
          context: {
            attemptID: task.candidateAttemptID,
            taskID: task.taskID,
            taskRevision: task.taskRevision,
            taskContextDigest: task.contextDigest,
            specID: input.selection.specID,
            specDigest: input.selection.specDigest,
            profileID: task.profile.profileID,
            profileRevision: task.profile.revision,
            profileDigest: task.profile.definitionDigest,
            selectionSessionID: childID,
            sourceRevision: exactContextSelection.sourceRevision,
            requestID: input.requestID,
            requestSequence: input.requestSequence,
            harnessID: taskProfile.harness,
          },
        } satisfies ManagedPreparedRequestV1
      }).pipe(Effect.mapError((error) => managedPreflightFailure("managed_task_prepare", error)))

    const prepareManagedPrompt: Interface["prepareManagedPrompt"] = (input) =>
      state.withExecutionOwner(input.prompt.sessionID, Effect.gen(function* () {
        if (!/^(0|[1-9][0-9]{0,19})$/.test(input.remainingTokens) || BigInt(input.remainingTokens) < 1n) {
          return yield* new SessionSupervisorError({ stage: "managed_context", reason: "managed prompt preflight token remainder is malformed or exhausted" })
        }
        const sessionID = input.prompt.sessionID
        const current = yield* sessions.get(sessionID).pipe(Effect.orDie)
        const messages = yield* MessageV2.filterCompactedEffect(sessionID).pipe(Effect.provideService(Database.Service, database))
        let staged: SessionV1.WithParts | undefined
        if (messages.length === 0) {
          staged = yield* createUserMessage(input.prompt)
          yield* sessions.touch(sessionID)
        } else {
          const expectedID = input.prompt.messageID
          const users = messages.filter((message) => message.info.role === "user")
          if (messages.length !== 1 || users.length !== 1 || !expectedID || users[0]!.info.id !== expectedID) {
            return yield* new SessionSupervisorError({ stage: "managed_context", reason: "managed preflight child Session already contains non-identical request history" })
          }
          staged = users[0]
        }
        const preflight: ManagedPromptPreflight = { remainingTokens: input.remainingTokens, user: staged }
        const run = runLoop(sessionID, undefined, undefined, undefined, undefined, preflight)
        const rootInstance = yield* InstanceState.context
        const targetInstance = { ...rootInstance, directory: AbsolutePath.make(input.directory) }
        yield* run.pipe(
          Effect.provideService(InstanceRef, targetInstance),
          Effect.provideService(WorkspaceRef, WorkspaceV2.ID.make(input.workspaceID)),
          Effect.ensuring(status.set(sessionID, { type: "idle" })),
        )
        if (!preflight.providerInput) {
          return yield* new SessionSupervisorError({ stage: "managed_context", reason: "SessionPrompt failed to compile a no-dispatch managed request" })
        }
        return preflight.providerInput
      })).pipe(Effect.mapError((error) => promptBuildFailure(error)))

    const prepareManagedFollowUp: Interface["prepareManagedFollowUp"] = (input) =>
      Effect.gen(function* () {
        const promptInput = yield* Effect.try({
          try: () => Schema.decodeUnknownSync(PromptInput, { onExcessProperty: "error" })(input.prompt),
          catch: () => new SessionSupervisorError({ stage: "managed_follow_up", reason: "follow-up prompt is malformed" }),
        })
        const scope = input.authority.currentScope()
        const context = input.context
        const nextSequence = (BigInt(scope.requestSequence) + 1n).toString()
        if (promptInput.sessionID !== scope.sessionID || promptInput.messageID === undefined ||
          promptInput.agent !== undefined || promptInput.model !== undefined || promptInput.variant !== undefined ||
          promptInput.tools !== undefined || promptInput.system !== undefined || promptInput.format !== undefined ||
          promptInput.noReply === true || promptInput.parts.length !== 1 || promptInput.parts[0]?.type !== "text" ||
          promptInput.parts[0].text.length === 0 || Buffer.byteLength(promptInput.parts[0].text, "utf8") > 16 * 1024 ||
          context.attemptID !== scope.attemptID || context.taskID !== scope.taskID ||
          context.selectionSessionID !== scope.sessionID || context.requestSequence !== scope.requestSequence ||
          context.requestID !== scope.requestID || context.contextSelectionDigest !== scope.contextSelectionDigest ||
          input.requestID !== `req_managed_${scope.attemptID}_${nextSequence}` ||
          !/^blake3:[0-9a-f]{64}$/.test(context.contextSelectionDigest) ||
          !/^[1-9][0-9]{0,19}$/.test(scope.requestSequence) || BigInt(scope.requestSequence) >= 1024n ||
          !/^[1-9][0-9]{0,19}$/.test(input.authority.remainingTokens()) ||
          context.profileID.length === 0 || context.taskRevision.length === 0 || context.specID.length === 0) {
          return yield* new ManagedControl.ManagedControlError({
            operation: "managed_context.prepare_follow_up",
            code: "managed_conflict",
            reason: "follow-up prompt does not name the exact live managed Attempt and successor request",
          })
        }
        const sessionID = SessionID.make(scope.sessionID)
        const session = yield* sessions.get(sessionID)
        if (!session.parentID || session.workspaceID !== scope.worktreeTarget.workspaceID ||
          session.directory !== scope.worktreeTarget.canonicalRoot || session.agent === undefined || !session.model ||
          !managedPreflightProfilePin(session.metadata)) {
          return yield* new ManagedControl.ManagedControlError({
            operation: "managed_context.prepare_follow_up",
            code: "managed_conflict",
            reason: "follow-up target Session is not the exact managed child workspace and profile",
          })
        }
        const model = yield* provider.getModel(session.model.providerID, session.model.id)
        if (!model) return yield* new ManagedControl.ManagedControlError({
          operation: "managed_context.prepare_follow_up",
          code: "agent_profile_unavailable",
          reason: "managed follow-up model is unavailable",
        })
        const user: SessionV1.WithParts = {
          info: {
            id: promptInput.messageID,
            sessionID,
            role: "user",
            time: { created: Date.now() },
            agent: session.agent,
            model: {
              providerID: ProviderV2.ID.make(model.providerID),
              modelID: ModelV2.ID.make(model.id),
              ...(session.model.variant && session.model.variant !== "default" ? { variant: session.model.variant } : {}),
            },
          },
          parts: [{
            id: PartID.make(`prt_${createHash("sha256").update(`${promptInput.messageID}\0follow-up`).digest("hex").slice(0, 32)}`),
            sessionID,
            messageID: promptInput.messageID,
            type: "text",
            text: promptInput.parts[0].text,
          }],
        }
        const cursor = yield* supervisor.sessionProjectionCursor(sessionID)
        if (cursor.ownerKind !== "session" || cursor.ownerId !== sessionID ||
          !/^(0|[1-9][0-9]{0,19})$/.test(cursor.seq) || !/^blake3:[0-9a-f]{64}$/.test(cursor.eventDigest)) {
          return yield* new ManagedControl.ManagedControlError({
            operation: "managed_context.prepare_follow_up",
            code: "managed_unavailable",
            reason: "child Session projection cursor is unavailable or malformed",
          })
        }
        const preflight: ManagedPromptPreflight = { remainingTokens: input.authority.remainingTokens(), user, appendUser: user }
        yield* runLoop(sessionID, undefined, input.authority, undefined, undefined, preflight).pipe(
          Effect.provideService(InstanceRef, { ...(yield* InstanceState.context), directory: AbsolutePath.make(scope.worktreeTarget.canonicalRoot) }),
          Effect.provideService(WorkspaceRef, WorkspaceV2.ID.make(scope.worktreeTarget.workspaceID)),
          Effect.ensuring(status.set(sessionID, { type: "idle" })),
        )
        if (!preflight.providerInput) return yield* new ManagedControl.ManagedControlError({
          operation: "managed_context.prepare_follow_up",
          code: "managed_unavailable",
          reason: "Core prompt pipeline did not produce a no-dispatch provider input",
        })
        const sequence = nextSequence
        const requestID = input.requestID
        const contextSelection = compileManagedContextSelection({
          sessionID: scope.sessionID,
          requestID,
          requestSequence: sequence,
          sourceRevision: cursor.seq,
          attemptID: context.attemptID,
          taskID: context.taskID,
          taskRevision: context.taskRevision,
          taskContextDigest: context.taskContextDigest,
          specID: context.specID,
          specDigest: context.specDigest,
          profileID: context.profileID,
          profileRevision: context.profileRevision,
          profileDigest: context.profileDigest,
          toolSources: preflight.toolSources ?? [],
          providerInput: preflight.providerInput,
        })
        return {
          contextSelection,
          providerInput: preflight.providerInput,
          toolSources: preflight.toolSources ?? [],
          context: {
            attemptID: context.attemptID,
            taskID: context.taskID,
            taskRevision: context.taskRevision,
            taskContextDigest: context.taskContextDigest,
            specID: context.specID,
            specDigest: context.specDigest,
            profileID: context.profileID,
            profileRevision: context.profileRevision,
            profileDigest: context.profileDigest,
            selectionSessionID: scope.sessionID,
            sourceRevision: cursor.seq,
            requestID,
            requestSequence: sequence,
            harnessID: context.harnessID,
          },
        } satisfies ManagedPreparedRequestV1
      }).pipe(Effect.mapError((error) => managedPreflightFailure("managed_follow_up", error)))

    const followUpDirectChild: Interface["followUpDirectChild"] = (input) =>
      state.withExecutionOwner(SessionID.make(input.childSessionID), Effect.gen(function* () {
        const parent = yield* sessions.get(SessionID.make(input.parentSessionID))
        const child = yield* sessions.get(SessionID.make(input.childSessionID))
        const delivery = child.metadata?.horizonSubagentDelivery
        const profile = child.metadata?.horizonAgentProfileV2
        const attemptID = child.metadata?.horizonDirectAttemptID
        if (child.parentID !== parent.id || child.directory !== parent.directory || child.workspaceID !== parent.workspaceID ||
          typeof delivery !== "object" || delivery === null || Array.isArray(delivery) ||
          (delivery as Record<string, unknown>).lane !== "direct_session" ||
          typeof profile !== "object" || profile === null || Array.isArray(profile) ||
          typeof attemptID !== "string" || !/^att_[a-z0-9]{16,64}$/.test(attemptID)) {
          return yield* new ManagedControl.ManagedControlError({ operation: "direct_follow_up", code: "managed_forbidden", reason: "follow-up target is not an authenticated direct child Session" })
        }
        const pin = profile as Record<string, unknown>
        if (typeof pin.profileID !== "string" || typeof pin.profileRevision !== "string" ||
          typeof pin.profileDigest !== "string" || typeof pin.permissionsDigest !== "string" ||
          typeof pin.harness !== "string") {
          return yield* new ManagedControl.ManagedControlError({ operation: "direct_follow_up", code: "agent_profile_stale", reason: "child AgentProfileV2 pin is malformed" })
        }
        const attempt = yield* ManagedControl.snapshotDirectAttempt(attemptID)
        const directAttempt = attempt.directAttempt
        if (attempt.phase !== "EXECUTING" || !directAttempt || directAttempt.parentSessionID !== parent.id ||
          directAttempt.childSessionID !== child.id || directAttempt.profileID !== pin.profileID ||
          directAttempt.profileRevision !== pin.profileRevision || directAttempt.profileDigest !== pin.profileDigest ||
          directAttempt.permissionsDigest !== pin.permissionsDigest || child.metadata?.horizonDirectAttemptScope !== undefined &&
            !ManagedControl.sameDirectAttemptScope(directAttempt, child.metadata.horizonDirectAttemptScope as ManagedControl.DirectAttemptScopeV1)) {
          return yield* new ManagedControl.ManagedControlError({ operation: "direct_follow_up", code: "managed_conflict", reason: "HostKernel live Attempt differs from the child profile or persisted scope" })
        }
        const row = yield* sessions.directInboxGet(input.messageID)
        if (row?.state === "consumed" && row.host_consumed_ack_digest === null) {
          const live = yield* ManagedControl.snapshotDirectAttempt(attemptID)
          const scope = live.directAttempt
          if (!scope || live.phase !== "EXECUTING" || row.delivery_attempt_id !== attemptID ||
            row.delivery_owner_epoch !== scope.ownerEpoch || row.child_owner_epoch !== scope.ownerEpoch ||
            row.delivery_scope_digest === null || row.delivery_prompt_message_id === null ||
            row.consumption_ack_digest === null || row.inbox_receipt_digest === null ||
            row.profile_id !== scope.profileID || row.profile_revision !== scope.profileRevision ||
            row.profile_digest !== scope.profileDigest || row.permission_scope_digest !== scope.permissionsDigest ||
            row.delivery_workspace_id !== scope.workspaceID) {
            return yield* new ManagedControl.ManagedControlError({ operation: "direct_follow_up_reconcile", code: "managed_unknown", reason: "consumed inbox row cannot be reconciled against the current authenticated child Attempt" })
          }
          const proof: DirectInboxConsumptionProofV1 = {
            messageID: row.message_id, parentSessionID: row.parent_session_id, childSessionID: row.child_session_id,
            mailboxSequence: row.mailbox_sequence, inboxReceiptDigest: row.inbox_receipt_digest,
            promptMessageID: row.delivery_prompt_message_id, consumingAttemptID: attemptID,
            consumingOwnerEpoch: row.delivery_owner_epoch, consumingScopeDigest: row.delivery_scope_digest,
            consumedPayloadDigest: row.payload_digest,
          }
          if (consumptionAckDigest(proof) !== row.consumption_ack_digest) {
            return yield* new ManagedControl.ManagedControlError({ operation: "direct_follow_up_reconcile", code: "managed_conflict", reason: "stored consumption proof digest is inconsistent" })
          }
          const pins: ManagedControl.DirectMessagePinsV1 = {
            parentSessionID: row.parent_session_id, childSessionID: row.child_session_id,
            childOwnerEpoch: row.child_owner_epoch, profileID: row.profile_id, profileRevision: row.profile_revision,
            profileDigest: row.profile_digest, permissionScopeDigest: row.permission_scope_digest,
            directAttemptID: row.child_attempt_id, messageID: row.message_id, deliveryMode: "follow_up",
            payloadDigest: row.payload_digest, payloadBytes: row.payload_bytes,
            mailboxSequence: row.mailbox_sequence, mailboxCapacity: row.mailbox_capacity,
          }
          const response = yield* supervisor.requestHostKernel("direct.message.v1", "acknowledge_consumed", {
            authorityPins: pins, inboxReceiptDigest: row.inbox_receipt_digest,
            consumption: {
              promptMessageID: row.delivery_prompt_message_id, consumingAttemptID: attemptID,
              consumingOwnerEpoch: row.delivery_owner_epoch, consumingScopeDigest: row.delivery_scope_digest,
              consumedPayloadDigest: row.payload_digest,
            },
            consumptionAckDigest: row.consumption_ack_digest,
            currentConsumer: {
              attemptID: scope.attemptID, parentSessionID: scope.parentSessionID, childSessionID: scope.childSessionID,
              ownerEpoch: BigInt(scope.ownerEpoch), expectedRevision: BigInt(scope.expectedRevision),
              profileID: scope.profileID, profileRevision: scope.profileRevision, profileDigest: scope.profileDigest,
              locationID: scope.locationID, workspaceID: scope.workspaceID, workspaceRevision: scope.workspaceRevision,
              capabilityDigest: scope.capabilityDigest, permissionsDigest: scope.permissionsDigest,
              budgetDigest: scope.budgetDigest, scopeDigest: scope.scopeDigest,
            },
          }, { deliveryID: `direct_message_consume_${row.consumption_ack_digest.slice("sha256:".length)}` })
          const ack = response as Record<string, unknown>
          if (ack.status !== "CONSUMED" || ack.messageID !== row.message_id || typeof ack.consumptionReceiptDigest !== "string") {
            return yield* new ManagedControl.ManagedControlError({ operation: "direct_follow_up_reconcile", code: "managed_unknown", reason: "HostKernel consumption acknowledgement remains unresolved" })
          }
          yield* sessions.directInboxMarkHostConsumed({ messageID: row.message_id, consumptionAckDigest: row.consumption_ack_digest, hostConsumedAckDigest: ack.consumptionReceiptDigest })
          return undefined
        }
        if (row?.state === "consumed" && row.host_consumed_ack_digest !== null) return undefined
        yield* ManagedControl.requireDirectTurnLifecycle()
        if (!row || row.state !== "committed" || row.delivery_mode !== "follow_up" || row.child_session_id !== child.id ||
          row.parent_session_id !== parent.id || row.child_attempt_id !== attemptID || row.child_owner_epoch !== directAttempt.ownerEpoch ||
          row.profile_id !== pin.profileID || row.profile_revision !== pin.profileRevision || row.profile_digest !== pin.profileDigest ||
          row.permission_scope_digest !== pin.permissionsDigest || !row.payload || Buffer.byteLength(row.payload, "utf8") !== row.payload_bytes ||
          digestText(row.payload) !== row.payload_digest) {
          return yield* new ManagedControl.ManagedControlError({ operation: "direct_follow_up", code: "managed_conflict", reason: "only the exact committed follow-up for the live child Attempt can be woken" })
        }
        const turnCompletion = child.metadata?.horizonDirectTurnCompletion
        const completedScope = ManagedControl.decodeDirectTurnScopeCandidate(child.metadata?.horizonDirectTurnScope)
        if (typeof turnCompletion !== "object" || turnCompletion === null || Array.isArray(turnCompletion) ||
          (turnCompletion as Record<string, unknown>).state !== "completed" ||
          !ManagedControl.sameDirectAttemptScope(completedScope.directAttempt, directAttempt)) {
          return yield* new ManagedControl.ManagedControlError({ operation: "direct_follow_up", code: "managed_conflict", reason: "follow-up is not bound to the latest completed child turn" })
        }
        const pins: ManagedControl.DirectMessagePinsV1 = {
          parentSessionID: parent.id, childSessionID: child.id, childOwnerEpoch: row.child_owner_epoch,
          profileID: row.profile_id, profileRevision: row.profile_revision, profileDigest: row.profile_digest,
          permissionScopeDigest: row.permission_scope_digest, directAttemptID: row.child_attempt_id,
          messageID: row.message_id, deliveryMode: "follow_up", payloadDigest: row.payload_digest,
          payloadBytes: row.payload_bytes, mailboxSequence: row.mailbox_sequence, mailboxCapacity: row.mailbox_capacity,
        }
        if (!input.freshTurnAuthorization) {
          return yield* new ManagedControl.ManagedControlError({ operation: "direct_follow_up", code: "managed_unavailable", reason: "new child turns require a HostKernel fresh-turn authorization" })
        }
        const freshTurnAuthorization = input.freshTurnAuthorization
        const authorizedPins = freshTurnAuthorization.authorityPins
        const pinKeys = Object.keys(pins).toSorted()
        if (Object.keys(authorizedPins).toSorted().join("\0") !== pinKeys.join("\0") ||
          pinKeys.some((key) => authorizedPins[key as keyof typeof authorizedPins] !== pins[key as keyof typeof pins]) ||
          freshTurnAuthorization.completedTurnScope.runnerCycleID !== completedScope.runnerCycleID ||
          freshTurnAuthorization.completedTurnScope.turnSequence !== completedScope.turnSequence ||
          freshTurnAuthorization.completedTurnScope.cycleDigest !== completedScope.cycleDigest) {
          return yield* new ManagedControl.ManagedControlError({ operation: "direct_follow_up", code: "managed_conflict", reason: "fresh-turn authorization does not match the committed mailbox row and completed turn" })
        }
        const hostReceipt = yield* ManagedControl.inspectDirectMessage({ pins })
        if (hostReceipt.status !== "FOLLOW_UP_SCHEDULED" || hostReceipt.receiptDigest !== row.host_receipt_digest) {
          return yield* new ManagedControl.ManagedControlError({ operation: "direct_follow_up", code: "managed_unknown", reason: "HostKernel has not confirmed the exact committed follow-up receipt" })
        }
        const claimed = yield* sessions.directInboxClaim({
          childSessionID: child.id, attemptID, ownerEpoch: directAttempt.ownerEpoch,
          profileID: pin.profileID, profileRevision: pin.profileRevision, profileDigest: pin.profileDigest,
          permissionScopeDigest: pin.permissionsDigest, deliveryMode: "follow_up", triggerMessageID: row.message_id,
        })
        if (claimed.length !== 1 || claimed[0].message_id !== row.message_id) {
          return yield* new ManagedControl.ManagedControlError({ operation: "direct_follow_up", code: "managed_conflict", reason: "safe-boundary claim did not own exactly the committed follow-up" })
        }
        const begun = yield* ManagedControl.beginDirectTurn({ directAttempt, freshTurnAuthorization })
        if (!ManagedControl.sameDirectAttemptScope(begun.directAttempt, directAttempt)) {
          yield* sessions.directInboxTransition({ messageID: row.message_id, expected: ["delivering"], state: "unknown" }).pipe(Effect.ignore)
          return yield* new ManagedControl.ManagedControlError({ operation: "turn_begin", code: "managed_conflict", reason: "HostKernel began a turn for a changed DirectAttempt" })
        }
        const bridge = yield* EffectBridge.make()
        const persistTurn = async (scope: ManagedControl.DirectTurnScopeV1) => {
          const current = await bridge.promise(sessions.get(child.id))
          if (current.metadata?.horizonDirectAttemptID !== attemptID ||
            JSON.stringify(current.metadata?.horizonSubagentDelivery) !== JSON.stringify(delivery)) throw new Error("child authority changed while persisting turn scope")
          await bridge.promise(sessions.setMetadata({ sessionID: child.id, metadata: {
            ...(current.metadata ?? {}), horizonDirectTurnScope: scope, horizonDirectAttemptScope: scope.directAttempt,
          } }))
        }
        const directTurn = ManagedControl.createDirectTurnAuthority(begun, persistTurn)
        let currentDirectAttempt = directAttempt
        const directAttemptAuthority: DirectAttemptAuthority = {
          currentScope: () => currentDirectAttempt,
          acceptRefreshedScope: ({ previous, refreshed, transition }) => {
            if (!ManagedControl.sameDirectAttemptScope(currentDirectAttempt, previous) ||
              !(ManagedControl.sameDirectAttemptScope(previous, refreshed) ||
                (transition === "batch_bind" ? ManagedControl.isNextDirectAttemptScope(previous, refreshed) : ManagedControl.isReceiptAdvancedDirectAttemptScope(previous, refreshed)))) {
              throw new Error("HostKernel returned a stale or mismatched DirectAttempt scope")
            }
            currentDirectAttempt = refreshed
          },
        }
        const childAgent = yield* agents.getProfile(pin.profileID, pin.profileRevision)
        const profileValue = childAgent.options.horizonAgentProfile
        const profileProjection = typeof profileValue === "object" && profileValue !== null && !Array.isArray(profileValue)
          ? profileValue as Record<string, unknown>
          : undefined
        if (!profileProjection ||
          profileProjection.profileId !== pin.profileID || String(profileProjection.revision) !== pin.profileRevision ||
          profileProjection.harness !== pin.harness) {
          yield* sessions.directInboxTransition({ messageID: row.message_id, expected: ["delivering"], state: "unknown" }).pipe(Effect.ignore)
          return yield* new ManagedControl.ManagedControlError({ operation: "direct_follow_up", code: "agent_profile_stale", reason: "resolved runtime profile differs from the immutable child Session pin" })
        }
        const selectedModel = childAgent.model
        if (!selectedModel || !childAgent.permission.length) {
          yield* sessions.directInboxTransition({ messageID: row.message_id, expected: ["delivering"], state: "unknown" }).pipe(Effect.ignore)
          return yield* new ManagedControl.ManagedControlError({ operation: "direct_follow_up", code: "agent_profile_unavailable", reason: "pinned AgentProfileV2 has no executable model or permission projection" })
        }
        const model = yield* provider.getModel(selectedModel.providerID, selectedModel.modelID)
        if (!model) return yield* new ManagedControl.ManagedControlError({ operation: "direct_follow_up", code: "agent_profile_unavailable", reason: "pinned AgentProfileV2 model is unavailable" })
        const promptMessageID = MessageID.ascending()
        const run = promptWork({
          messageID: promptMessageID,
          sessionID: child.id,
          model: { providerID: model.providerID, modelID: model.id },
          agent: childAgent.name,
          parts: [{ type: "text", text: row.payload }],
        }, directAttemptAuthority, undefined, directTurn)
        const limits = typeof profileProjection.limits === "object" && profileProjection.limits !== null
          ? profileProjection.limits as Record<string, unknown>
          : undefined
        const wallTimeMs = limits?.wallTimeMs
        if (wallTimeMs !== undefined && (typeof wallTimeMs !== "string" || !/^[1-9][0-9]{0,19}$/.test(wallTimeMs) ||
          BigInt(wallTimeMs) > BigInt(Number.MAX_SAFE_INTEGER))) {
          return yield* new ManagedControl.ManagedControlError({
            operation: "direct_follow_up",
            code: "agent_profile_limit",
            reason: "AgentProfileV2 wall-time limit is invalid or exceeds the supported timer range",
          })
        }
        const result = typeof wallTimeMs === "string"
          ? yield* run.pipe(
              Effect.timeoutOrElse({
                duration: Number(BigInt(wallTimeMs)),
                orElse: () =>
                  Effect.fail(
                    new ManagedControl.ManagedControlError({
                      operation: "direct_follow_up",
                      code: "agent_profile_limit",
                      reason: "AgentProfileV2 wall-time limit was reached; turn outcome requires reconciliation",
                    }),
                  ),
              }),
            )
          : yield* run
        const output = result.parts.findLast((part) => part.type === "text")
        const resultDigest = ManagedControl.resultDigest({
          childSessionID: child.id, agent: childAgent.name, state: "completed",
          outputDigest: ManagedControl.outputDigest(output?.type === "text" ? output.text : ""),
          outputBytes: Buffer.byteLength(output?.type === "text" ? output.text : "", "utf8"),
        })
        const completionScope = directTurn.currentScope()
        const completionIntent = {
          runnerCycleID: completionScope.runnerCycleID, turnSequence: completionScope.turnSequence,
          cycleDigest: completionScope.cycleDigest, resultDigest, state: "pending" as const,
        }
        const beforeComplete = yield* sessions.get(child.id)
        yield* sessions.setMetadata({ sessionID: child.id, metadata: { ...(beforeComplete.metadata ?? {}),
          horizonDirectTurnScope: completionScope, horizonDirectAttemptScope: completionScope.directAttempt,
          horizonDirectTurnCompletion: completionIntent,
        } })
        const completed = yield* ManagedControl.completeDirectTurn({ directTurnScope: completionScope, resultDigest })
        const afterComplete = yield* sessions.get(child.id)
        yield* sessions.setMetadata({ sessionID: child.id, metadata: { ...(afterComplete.metadata ?? {}),
          horizonDirectTurnScope: completionScope, horizonDirectAttemptScope: completionScope.directAttempt,
          horizonDirectTurnCompletion: { ...completionIntent, state: "completed", nextTurnSequence: completed.nextTurnSequence, receiptDigest: completed.receiptDigest },
        } })
        const proof: DirectInboxConsumptionProofV1 = {
          messageID: row.message_id, parentSessionID: row.parent_session_id, childSessionID: row.child_session_id,
          mailboxSequence: row.mailbox_sequence, inboxReceiptDigest: row.inbox_receipt_digest,
          promptMessageID, consumingAttemptID: attemptID, consumingOwnerEpoch: directAttempt.ownerEpoch,
          consumingScopeDigest: consumingScopeDigest(currentDirectAttempt), consumedPayloadDigest: row.payload_digest,
        }
        const ackDigest = consumptionAckDigest(proof)
        const consumed = yield* sessions.directInboxConsume({ rows: [{ messageID: row.message_id, consumptionAckDigest: ackDigest }],
          promptMessageID, consumingAttemptID: attemptID, consumingOwnerEpoch: directAttempt.ownerEpoch,
          consumingScopeDigest: proof.consumingScopeDigest, consumingWorkspaceID: currentDirectAttempt.workspaceID,
        })
        const consumedRow = consumed[0]
        if (!consumedRow) return yield* new ManagedControl.ManagedControlError({ operation: "direct_follow_up", code: "managed_unknown", reason: "child completed but Core consumption receipt is unresolved" })
        const consumeAck = yield* supervisor.requestHostKernel("direct.message.v1", "acknowledge_consumed", {
          authorityPins: pins,
          inboxReceiptDigest: row.inbox_receipt_digest,
          consumption: {
            promptMessageID, consumingAttemptID: attemptID, consumingOwnerEpoch: directAttempt.ownerEpoch,
            consumingScopeDigest: proof.consumingScopeDigest, consumedPayloadDigest: row.payload_digest,
          },
          consumptionAckDigest: ackDigest,
          currentConsumer: {
            attemptID: currentDirectAttempt.attemptID, parentSessionID: currentDirectAttempt.parentSessionID,
            childSessionID: currentDirectAttempt.childSessionID, ownerEpoch: BigInt(currentDirectAttempt.ownerEpoch),
            expectedRevision: BigInt(currentDirectAttempt.expectedRevision), profileID: currentDirectAttempt.profileID,
            profileRevision: currentDirectAttempt.profileRevision, profileDigest: currentDirectAttempt.profileDigest,
            locationID: currentDirectAttempt.locationID, workspaceID: currentDirectAttempt.workspaceID,
            workspaceRevision: currentDirectAttempt.workspaceRevision, capabilityDigest: currentDirectAttempt.capabilityDigest,
            permissionsDigest: currentDirectAttempt.permissionsDigest, budgetDigest: currentDirectAttempt.budgetDigest, scopeDigest: currentDirectAttempt.scopeDigest,
          },
        }, { deliveryID: `direct_message_consume_${ackDigest.slice("sha256:".length)}` })
        const ack = consumeAck as Record<string, unknown>
        if (ack.status !== "CONSUMED" || ack.messageID !== row.message_id || typeof ack.consumptionReceiptDigest !== "string") {
          return yield* new ManagedControl.ManagedControlError({ operation: "direct_follow_up", code: "managed_unknown", reason: "HostKernel consume acknowledgement is unresolved" })
        }
        yield* sessions.directInboxMarkHostConsumed({ messageID: row.message_id, consumptionAckDigest: ackDigest, hostConsumedAckDigest: ack.consumptionReceiptDigest })
        return undefined
      })).pipe(
        Effect.mapError((error) => managedPreflightFailure("direct_follow_up", error)),
        // ManagedControl.call reads SessionSupervisorService from context; the
        // interface keeps this requirement-free, so bind the captured instance.
        Effect.provideService(SessionSupervisor.Service, supervisor),
      )

    const lastAssistant = Effect.fnUntraced(function* (sessionID: SessionID) {
      const match = yield* sessions.findMessage(sessionID, (m) => m.info.role !== "user").pipe(Effect.orDie)
      if (Option.isSome(match)) return match.value
      const msgs = yield* sessions.messages({ sessionID, limit: 1 }).pipe(Effect.orDie)
      if (msgs.length > 0) return msgs[0]
      throw new Error("Impossible")
    })

    type ManagedPromptPreflight = {
      readonly remainingTokens: string
      user?: SessionV1.WithParts
      /** A next-turn user entry visible only to this no-dispatch compiler. */
      appendUser?: SessionV1.WithParts
      providerInput?: ManagedProviderInputV1
      toolSources?: readonly import("@/tool/discovery").ToolsetSourceRefV1[]
    }

    const runLoopImpl = Effect.fn("SessionPrompt.run")(
      function* (
        sessionID: SessionID,
        directAttempt?: DirectAttemptAuthority,
        managedAttempt?: ManagedAttemptAuthority,
        directTurn?: DirectTurnAuthority,
        managedContext?: ManagedProviderContextV1,
        preflight?: ManagedPromptPreflight,
      managedFollowUpRunner?: ManagedFollowUpRunnerV1,
      managedPreDispatchRecovery?: ManagedPreDispatchRecoveryV1,
      ) {
        const ctx = yield* InstanceState.context
        let structured: unknown
        let step = 0
        const session = yield* sessions.get(sessionID).pipe(Effect.orDie)

        while (true) {
          yield* status.set(sessionID, { type: "busy" })
          yield* Effect.logInfo("loop", { "session.id": sessionID, step })

          let msgs = yield* MessageV2.filterCompactedEffect(sessionID).pipe(
            Effect.provideService(Database.Service, database),
          )
          if (preflight?.appendUser) msgs = [...msgs, preflight.appendUser]

          const { user: lastUser, assistant: lastAssistant, finished: lastFinished, tasks } = MessageV2.latest(msgs)

          if (!lastUser) throw new Error("No user message found in stream. This should never happen.")
          // The latest projection returns the user Info; the persisted WithParts
          // entry is re-found by identity so preflight/recovery carry the exact
          // durable message the loop observed.
          const lastUserMessage = msgs.findLast((message) => message.info === lastUser)

          const lastAssistantMsg = msgs.findLast(
            (msg) => msg.info.role === "assistant" && msg.info.id === lastAssistant?.id,
          )
          // Some providers return "stop" even when the assistant message contains
          // tool calls. Keep the loop running so tool results can be sent back to
          // the model, but ignore cleanup-marked interrupted orphans.
          const hasToolCalls =
            lastAssistantMsg?.parts.some(
              (part) => part.type === "tool" &&
                (part.state.status === "pending" || part.state.status === "running") &&
                !isOrphanedInterruptedTool(part),
            ) ?? false

          if (
            lastAssistant?.finish &&
            !["tool-calls", "unknown"].includes(lastAssistant.finish) &&
            !hasToolCalls &&
            lastAssistant.parentID === lastUser.id
          ) {
            // Final managed completion is a separate durable HostKernel fact
            // from settling any one provider request. This point is reached
            // only after the complete assistant entry was reloaded from the
            // Session store and the loop has ruled out further tool work.
            // The managed-control authority supplies the exact latest settled
            // request/response/usage pins; this layer passes no caller hashes.
            let completedTurn: ManagedProviderTurnCompletionV1 | undefined
            if (managedAttempt) {
              completedTurn = yield* ManagedControl.completeManagedProviderTurn({
                authority: managedAttempt,
                assistantEntryID: lastAssistant.id,
              }).pipe(
                Effect.catchTag("ManagedControlError", (error) =>
                  Effect.fail(new SessionSupervisorError({
                    stage: "managed_completion",
                    reason: error.reason,
                    hostCode: error.code,
                  })),
                ),
              )
            }
            if (managedAttempt && completedTurn && managedFollowUpRunner && managedContext) {
              const continuation = yield* managedFollowUpRunner({
                sessionID,
                authority: managedAttempt,
                completion: completedTurn,
                context: managedContext,
              }).pipe(
                Effect.catchTag("ManagedControlError", (error) =>
                  Effect.fail(new SessionSupervisorError({
                    stage: "managed_follow_up",
                    reason: error.reason,
                    hostCode: error.code,
                  })),
                ),
              )
              if (continuation) {
                const nextScope = managedAttempt.currentScope()
                const nextContext = continuation.context
                const selection = nextContext.initialSelection
                const nextPrompt = yield* Effect.try({
                  try: () => Schema.decodeUnknownSync(PromptInput, { onExcessProperty: "error" })(continuation.prompt),
                  catch: () => new SessionSupervisorError({
                    stage: "managed_follow_up",
                    reason: "next managed prompt is malformed",
                  }),
                })
                const nextModel = nextPrompt.model
                const nextParts = nextPrompt.parts
                let decodedSelection: ContextSelectionV1 | undefined
                if (selection) {
                  decodedSelection = yield* Effect.try({
                    try: () => Schema.decodeUnknownSync(ContextSelectionV1, { onExcessProperty: "error" })(selection),
                    catch: () => new SessionSupervisorError({
                      stage: "managed_follow_up",
                      reason: "next managed ContextSelection is malformed",
                    }),
                  })
                }
                const currentSession = yield* sessions.get(sessionID).pipe(Effect.orDie)
                if (nextPrompt.sessionID !== sessionID || nextContext.selectionSessionID !== sessionID ||
                  nextContext.attemptID !== nextScope.attemptID || nextContext.taskID !== nextScope.taskID ||
                  nextContext.requestID !== nextScope.requestID || nextContext.requestSequence !== nextScope.requestSequence ||
                  nextContext.contextSelectionDigest !== nextScope.contextSelectionDigest ||
                  !nextContext.initialProviderInput || !nextModel || nextPrompt.agent !== currentSession.agent ||
                  nextModel.providerID !== currentSession.model?.providerID ||
                  nextModel.modelID !== currentSession.model?.id ||
                  !nextPrompt.messageID || !/^msg[A-Za-z0-9._-]{1,256}$/.test(nextPrompt.messageID) ||
                  nextPrompt.tools !== undefined || nextPrompt.system !== undefined || nextPrompt.format !== undefined ||
                  nextPrompt.noReply === true || nextParts.length !== 1 || nextParts[0]?.type !== "text" ||
                  Buffer.byteLength(nextParts[0].text, "utf8") < 1 || Buffer.byteLength(nextParts[0].text, "utf8") > 1024 * 1024 ||
                  !decodedSelection || decodedSelection.sessionID !== sessionID || decodedSelection.attemptID !== nextScope.attemptID ||
                  decodedSelection.requestID !== nextScope.requestID || decodedSelection.requestSequence !== nextScope.requestSequence ||
                  decodedSelection.mode !== "fresh") {
                  return yield* new SessionSupervisorError({
                    stage: "managed_follow_up",
                    reason: "next managed prompt is not bound to the live HostKernel request and ContextSelection pins",
                  })
                }
                // The follow-up projection above admits only one text part, so
                // image normalization is unreachable here. Keep the loop's
                // public supervisor-only error contract even if that invariant
                // is ever violated: fail closed instead of widening it.
                yield* createUserMessage(nextPrompt).pipe(
                  Effect.mapError((error) =>
                    error instanceof SessionSupervisorError
                      ? error
                      : new SessionSupervisorError({
                          stage: "managed_follow_up",
                          reason: `follow-up user message projection failed before dispatch: ${
                            error instanceof Error ? error.message : String(error)
                          }`,
                        }),
                  ),
                )
                yield* continuation.onPromptCommitted({ promptMessageID: nextPrompt.messageID! }).pipe(
                  Effect.catchTag("ManagedControlError", (error) =>
                    Effect.fail(new SessionSupervisorError({
                      stage: "managed_follow_up",
                      reason: error.reason,
                      hostCode: error.code,
                    })),
                  ),
                )
                managedContext = nextContext
                continue
              }
            }
            const orphan = lastAssistantMsg?.parts.find(
              (part): part is SessionV1.ToolPart => part.type === "tool" && isOrphanedInterruptedTool(part),
            )
            if (orphan) {
              yield* Effect.logWarning("loop exit with orphaned interrupted tool", {
                "session.id": sessionID,
                messageID: lastAssistant.id,
                tool: orphan.tool,
                callID: orphan.callID,
              })
            }
            yield* Effect.logInfo("exiting loop", { "session.id": sessionID })
            break
          }

          step++
          if (step === 1 && !preflight)
            yield* title({
              session,
              modelID: lastUser.model.modelID,
              providerID: lastUser.model.providerID,
              history: msgs,
            }).pipe(Effect.ignore, Effect.forkIn(scope))

          const model = yield* getModel(lastUser.model.providerID, lastUser.model.modelID, sessionID)
          const task = tasks.pop()

          if (task?.type === "subtask") {
            yield* handleSubtask({ task, model, lastUser, sessionID })
            continue
          }

          if (task?.type === "compaction") {
            const result = yield* compaction.process({
              messages: msgs,
              parentID: lastUser.id,
              sessionID,
              auto: task.auto,
              overflow: task.overflow,
            })
            if (result === "stop") break
            continue
          }

          if (
            !preflight &&
            lastFinished &&
            lastFinished.summary !== true &&
            (yield* compaction.isOverflow({ tokens: lastFinished.tokens, model }))
          ) {
            yield* compaction.create({ sessionID, agent: lastUser.agent, model: lastUser.model, auto: true })
            continue
          }

          const profilePin = sessionAgentProfilePin(session.metadata)
          const preflightProfile = preflight ? managedPreflightProfilePin(session.metadata) : undefined
          const agent = yield* (profilePin
            ? agents.getProfile(profilePin.profileID, profilePin.revision)
            : preflightProfile
              ? agents.getProfile(preflightProfile.profileID, preflightProfile.revision)
              : agents.get(lastUser.agent))
          if (profilePin || preflightProfile) {
            const projection = agent?.options.horizonAgentProfile
            const expectedHarness = profilePin?.harness ?? preflightProfile?.harness
            if (
              typeof projection !== "object" ||
              projection === null ||
              !("harness" in projection) ||
              projection.harness !== expectedHarness
            ) {
              return yield* new SessionSupervisorError({
                stage: "agent-profile",
                reason: "resumed child Session harness does not match its immutable AgentProfileV2 pin",
              })
            }
          }
          if (!agent) {
            const available = (yield* agents.list().pipe(
          Effect.catchIf(isAgentProfileDirectoryError, agentProfileDirectoryFailure),
        )).filter((a) => !a.hidden).map((a) => a.name)
            const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
            const error = new NamedError.Unknown({ message: `Agent not found: "${lastUser.agent}".${hint}` })
            yield* events.publish(Session.Event.Error, { sessionID, error: error.toObject() })
            throw error
          }
          const maxSteps = agent.steps ?? Infinity
          const isLastStep = step >= maxSteps
          msgs = yield* SessionReminders.apply({ messages: msgs, agent, session }).pipe(
            Effect.provideService(RuntimeFlags.Service, flags),
            Effect.provideService(FSUtil.Service, fsys),
            Effect.provideService(Session.Service, sessions),
          )

          const msg: SessionV1.Assistant = {
            id: MessageID.ascending(),
            parentID: lastUser.id,
            role: "assistant",
            mode: agent.name,
            agent: agent.name,
            variant: lastUser.model.variant,
            path: { cwd: ctx.directory, root: ctx.worktree },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: model.id,
            providerID: model.providerID,
            time: { created: Date.now() },
            sessionID,
          }
          const finalizeInterruptedAssistant = Effect.gen(function* () {
            if (msg.time.completed) return
            msg.error ??= MessageV2.fromError(new DOMException("Aborted", "AbortError"), {
              providerID: msg.providerID,
              aborted: true,
            })
            msg.time.completed = Date.now()
            yield* sessions.updateMessage(msg)
          })

          const handle = yield* processor
            .create({
              assistantMessage: msg,
              sessionID,
              model,
            })
            .pipe(Effect.onInterrupt(() => finalizeInterruptedAssistant))

          const outcome: "break" | "continue" = yield* Effect.gen(function* () {
            const lastUserMsg = msgs.findLast((m) => m.info.role === "user")
            const bypassAgentCheck = lastUserMsg?.parts.some((p) => p.type === "agent") ?? false
            const promptOps = yield* ops()

            const resolvedTools = yield* SessionTools.resolve({
              agent,
              session,
              model,
              processor: handle,
              bypassAgentCheck,
              messages: msgs,
              promptOps,
              directAttempt,
              managedAttempt,
            }).pipe(
              Effect.provideService(Permission.Service, permission),
              Effect.provideService(ToolRegistry.Service, registry),
              Effect.provideService(FSUtil.Service, fsys),
              Effect.provideService(RuntimeFlags.Service, flags),
              Effect.provideService(WebSearchRuntime.Service, webSearchRuntime),
            )
            const tools = resolvedTools.tools
            const toolDefinitions = resolvedTools.definitions
            if (preflight) preflight.toolSources = resolvedTools.toolDiscovery.sourceRefs

            if (lastUser.format?.type === "json_schema") {
              tools["StructuredOutput"] = createStructuredOutputTool({
                schema: lastUser.format.schema,
                onSuccess(output) {
                  structured = output
                },
              })
              toolDefinitions["StructuredOutput"] = {
                capability: { id: "tool.structured-output", effectClass: "control" },
                schema: lastUser.format.schema,
                internal: true,
                validate: async (value) => value,
              }
            }
            if (step === 1 && !preflight)
              yield* summary.summarize({ sessionID, messageID: lastUser.id }).pipe(Effect.ignore, Effect.forkIn(scope))

            // Managed request context is pinned by Core before provider dispatch.
            // Do not let a post-pin extension hook silently rewrite that transcript.
            if (managedAttempt === undefined && !preflight) {
              yield* plugin.trigger("experimental.chat.messages.transform", {}, { messages: msgs })
            }

            const [skills, env, instructions, mcpInstructions, modelMsgs] = yield* Effect.all([
              sys.skills(agent),
              sys.environment(model),
              instruction.system().pipe(Effect.orDie),
              sys.mcp(agent, session.permission),
              MessageV2.toModelMessagesEffect(msgs, model),
            ])
            const configuredHarness = agent.options.horizonHarness
            const harnessID = typeof configuredHarness === "string" ? configuredHarness : "native-rich"
            const harnessPrompt = builtinHarnessSystemPromptV1(harnessID)
            if (harnessPrompt === undefined) {
              throw new SessionSupervisorError({ stage: "agent-profile", reason: "selected HarnessProfileV1 system prompt is unavailable" })
            }
            const system = [
              harnessPrompt,
              ...env,
              ...instructions,
              ...(mcpInstructions ? [mcpInstructions] : []),
              ...(skills ? [skills] : []),
            ]
            const format = lastUser.format ?? { type: "text" as const }
            if (format.type === "json_schema") system.push(STRUCTURED_OUTPUT_SYSTEM_PROMPT)
            const streamInput: LLM.StreamInput = {
              user: lastUser,
              agent,
              permission: session.permission,
              sessionID,
              parentSessionID: session.parentID,
              directAttempt,
              managedAttempt,
              directTurn,
              system,
              messages: [
                ...modelMsgs,
                ...(isLastStep ? [{ role: "assistant" as const, content: MAX_STEPS_PROMPT }] : []),
              ],
              tools,
              toolDefinitions,
              toolDiscovery: resolvedTools.toolDiscovery,
              model,
              toolChoice: format.type === "json_schema" ? "required" : undefined,
              ...(preflight ? { managedRemainingTokens: preflight.remainingTokens } : {}),
            }
            if (preflight) {
              if (!lastUserMessage) {
                return yield* new SessionSupervisorError({
                  stage: "managed_context",
                  reason: "prompt stream is missing its persisted user message",
                })
              }
              preflight.user = lastUserMessage
              // Provider preflight has an open error channel because it runs the
              // shared LLMRequestPrep pipeline. The prompt loop's public contract
              // is SessionSupervisorError-only, so an unsupported/preparation
              // failure must fail closed through the supervisor channel instead
              // of widening the loop requirement or dispatching anything.
              preflight.providerInput = yield* handle.prepareManagedRequest(streamInput).pipe(
                Effect.mapError((error) =>
                  error instanceof SessionSupervisorError
                    ? error
                    : new SessionSupervisorError({
                        stage: "managed_context",
                        reason: `managed provider preflight failed before dispatch: ${
                          error instanceof Error ? error.message : String(error)
                        }`,
                      }),
                ),
              )
              return "break" as const
            }
            if (managedAttempt && lastUser.role === "user") {
              if (!managedContext || !managedPreDispatchRecovery) {
                return yield* new SessionSupervisorError({
                  stage: "managed_pre_dispatch_recovery",
                  reason: "managed provider dispatch requires the authenticated ContextSelection and durable inbox recovery callback",
                })
              }
              const liveScope = managedAttempt.currentScope()
              if (managedContext.selectionSessionID !== sessionID ||
                managedContext.attemptID !== liveScope.attemptID ||
                managedContext.taskID !== liveScope.taskID ||
                managedContext.requestID !== liveScope.requestID ||
                managedContext.requestSequence !== liveScope.requestSequence ||
                managedContext.contextSelectionDigest !== liveScope.contextSelectionDigest) {
                return yield* new SessionSupervisorError({
                  stage: "managed_pre_dispatch_recovery",
                  reason: "managed provider dispatch ContextSelection differs from the live HostKernel Attempt scope",
                  hostCode: "managed_conflict",
                })
              }
              if (!lastUserMessage) {
                return yield* new SessionSupervisorError({
                  stage: "managed_pre_dispatch_recovery",
                  reason: "prompt stream is missing its persisted user message",
                })
              }
              const textParts = lastUserMessage.parts.filter((part): part is SessionV1.TextPart => part.type === "text")
              if (textParts.length !== 1 || lastUserMessage.parts.length !== 1) {
                return yield* new SessionSupervisorError({ stage: "managed_pre_dispatch_recovery", reason: "managed request lacks one exact persisted user text message" })
              }
              yield* managedPreDispatchRecovery({
                sessionID, promptMessageID: lastUser.id, promptText: textParts[0]!.text,
                authority: managedAttempt, context: managedContext,
              }).pipe(Effect.catchTag("ManagedControlError", (error) => Effect.fail(new SessionSupervisorError({
                stage: "managed_pre_dispatch_recovery", reason: error.reason, hostCode: error.code,
              }))))
            }
            // Persist the assistant placeholder only for an actual dispatch.
            yield* sessions.updateMessage(msg)
            const result = yield* handle.process(streamInput)

            if (structured !== undefined) {
              handle.message.structured = structured
              handle.message.finish = handle.message.finish ?? "stop"
              yield* sessions.updateMessage(handle.message)
              return "break" as const
            }

            const finished = handle.message.finish && !["tool-calls", "unknown"].includes(handle.message.finish)
            if (finished && !handle.message.error) {
              // Surface any content-filter finish (e.g. Anthropic stop_reason:
              // refusal) as an error. These turns may have produced no visible
              // output at all — previously the session went idle silently — or
              // partial text that was cut off by the provider's filter.
              if (handle.message.finish === "content-filter") {
                handle.message.error = new SessionV1.ContentFilterError({
                  message: "The response was blocked by the provider's content filter",
                }).toObject()
                yield* sessions.updateMessage(handle.message)
                yield* events.publish(Session.Event.Error, { sessionID, error: handle.message.error })
                return "break" as const
              }
              if (format.type === "json_schema") {
                handle.message.error = new SessionV1.StructuredOutputError({
                  message: "Model did not produce structured output",
                  retries: 0,
                }).toObject()
                yield* sessions.updateMessage(handle.message)
                return "break" as const
              }
            }

            if (result === "stop") return "break" as const
            if (result === "compact") {
              yield* compaction.create({
                sessionID,
                agent: lastUser.agent,
                model: lastUser.model,
                auto: true,
                overflow: !handle.message.finish,
              })
            }
            return "continue" as const
          }).pipe(
            Effect.ensuring(instruction.clear(handle.message.id)),
            Effect.onInterrupt(() => finalizeInterruptedAssistant),
          )
          if (outcome === "break") break
          continue
        }

        if (preflight?.providerInput && preflight.user) return preflight.user
        yield* compaction.prune({ sessionID }).pipe(Effect.ignore, Effect.forkIn(scope))
        return yield* lastAssistant(sessionID)
      },
    )

    const runLoop: (
      sessionID: SessionID,
      directAttempt?: DirectAttemptAuthority,
      managedAttempt?: ManagedAttemptAuthority,
      directTurn?: DirectTurnAuthority,
      managedContext?: ManagedProviderContextV1,
      preflight?: ManagedPromptPreflight,
      managedFollowUpRunner?: ManagedFollowUpRunnerV1,
      managedPreDispatchRecovery?: ManagedPreDispatchRecoveryV1,
    ) => Effect.Effect<
      SessionV1.WithParts,
      SessionSupervisorError
    > = (
      sessionID,
      directAttempt,
      managedAttempt,
      directTurn,
      managedContext,
      preflight,
      managedFollowUpRunner,
      managedPreDispatchRecovery,
    ) =>
      runLoopImpl(
        sessionID,
        directAttempt,
        managedAttempt,
        directTurn,
        managedContext,
        preflight,
        managedFollowUpRunner,
        managedPreDispatchRecovery,
      ).pipe(
        // ManagedControl.call reads SessionSupervisorService from context; the
        // declared signature keeps this loop requirement-free, so bind the
        // captured instance exactly like runManagedTask does.
        Effect.provideService(SessionSupervisor.Service, supervisor),
      )

    const loopWithAttempt: (
      input: LoopInput,
      directAttempt?: DirectAttemptAuthority,
      managedAttempt?: ManagedAttemptAuthority,
      directTurn?: DirectTurnAuthority,
      managedContext?: ManagedProviderContextV1,
      managedFollowUpRunner?: ManagedFollowUpRunnerV1,
      managedPreDispatchRecovery?: ManagedPreDispatchRecoveryV1,
    ) => Effect.Effect<SessionV1.WithParts, Session.BusyError | SessionSupervisorError> = Effect.fn(
      "SessionPrompt.loop",
    )(function* (
      input: LoopInput,
      directAttempt?: DirectAttemptAuthority,
      managedAttempt?: ManagedAttemptAuthority,
      directTurn?: DirectTurnAuthority,
      managedContext?: ManagedProviderContextV1,
      managedFollowUpRunner?: ManagedFollowUpRunnerV1,
      managedPreDispatchRecovery?: ManagedPreDispatchRecoveryV1,
    ) {
      const observedRun = Effect.scoped(
        Effect.gen(function* () {
          const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
          const turnComplete = yield* Ref.make(false)
          const supervisorReady = yield* Deferred.make<void, SessionSupervisorError>()
          const watcher = yield* supervisor
            .watchSession(input.sessionID, database.path, session.directory, turnComplete, supervisorReady)
            .pipe(Effect.forkScoped({ startImmediately: true }))
          yield* Deferred.await(supervisorReady)
          let promptRun = runLoop(input.sessionID, directAttempt, managedAttempt, directTurn, managedContext, undefined, managedFollowUpRunner, managedPreDispatchRecovery)
          if (directAttempt !== undefined && managedAttempt !== undefined) {
            promptRun = Effect.fail(new SessionSupervisorError({
              stage: "lsp-scope",
              reason: "prompt cannot carry both managed and direct editor Attempt authority",
            }))
          }
          // Direct root Sessions use an authenticated, read-only HostKernel
          // workspace snapshot. Child and managed Sessions keep their existing
          // Attempt authority; no synthetic Attempt is created for a root.
          const rootDirectSession = directAttempt === undefined && managedAttempt === undefined &&
            directTurn === undefined && managedContext === undefined
          if ((directAttempt === undefined) !== (managedAttempt === undefined) || rootDirectSession) {
            const instance = yield* InstanceState.context
            const sessionWorkspaceID = yield* InstanceState.workspaceID
            const managedScope = managedAttempt?.currentScope()
            const directScope = directAttempt?.currentScope()
            const trustedAttempt = managedScope ?? directScope
            if (trustedAttempt || rootDirectSession) {
              const workspaceID = managedScope?.worktreeTarget.workspaceID ?? directScope?.workspaceID ??
                (rootDirectSession ? sessionWorkspaceID : undefined)
              const directory = managedScope?.worktreeTarget.canonicalRoot ?? instance.directory
              if (!workspaceID) {
                if (trustedAttempt) {
                  // An Attempt-scoped turn must carry its own trusted workspace;
                  // never synthesize one from ambient instance state.
                  promptRun = Effect.fail(new SessionSupervisorError({
                    stage: "lsp-scope",
                    reason: "authenticated editor Session has no trusted workspace ID",
                  }))
                }
                // A root direct Session with no trusted workspace ID cannot
                // build a workspace-bound execution scope. RepoIntel/LSP context
                // is optional, so withhold it (no execution scope, no LSP
                // clients) instead of failing the ordinary direct model turn.
              } else {
                const locationRef = Location.Ref.make({
                  directory: AbsolutePath.make(directory),
                  workspaceID: WorkspaceV2.ID.make(workspaceID),
                })
                const bridge = yield* EffectBridge.make()
                const principal = yield* Effect.serviceOption(TrustedPrincipalContext)
                const rootWorkspaceSnapshot = rootDirectSession && Option.isSome(principal)
                  ? yield* supervisor.directSessionWorkspaceSnapshot({ sessionID: input.sessionID, locationRef }).pipe(
                      Effect.provideService(TrustedPrincipalContext, principal.value),
                      Effect.catch(() => Effect.succeed(undefined)),
                    )
                  : undefined
                if (rootDirectSession && !rootWorkspaceSnapshot) {
                  // RepoIntel/LSP context is optional. HostKernel projection
                  // failure must not prevent an ordinary direct model turn.
                } else {
                const trustedPins = trustedAttempt ?? (rootWorkspaceSnapshot && {
                  attemptID: input.sessionID,
                  ownerEpoch: rootWorkspaceSnapshot.ownerEpoch,
                  locationID: rootWorkspaceSnapshot.locationID,
                  workspaceRevision: rootWorkspaceSnapshot.workspaceRevision,
                })
                const rootOwnerScopeDigest = rootWorkspaceSnapshot
                  ? createHash("sha256").update(JSON.stringify([
                      "direct-root-session-lsp-v1",
                      input.sessionID,
                      rootWorkspaceSnapshot.ownerEpoch,
                      rootWorkspaceSnapshot.locationID,
                      rootWorkspaceSnapshot.workspaceRootDigest,
                      rootWorkspaceSnapshot.workspaceRevision,
                    ])).digest("hex")
                  : undefined
                const clientJobs = new Map<string, Promise<import("@/lsp/client").Info | undefined>>()
                let disposed = false
                const dispose = async () => {
                  if (disposed) return
                  disposed = true
                  const clients = await Promise.all([...clientJobs.values()])
                  await Promise.all(clients.flatMap((client) => client ? [client.shutdown()] : []))
                }
                const getExistingClients = async () =>
                  (await Promise.all([...clientJobs.values()])).filter((client): client is import("@/lsp/client").Info => Boolean(client))
                const getClients = async (file?: string) => {
                  const live = managedAttempt?.currentScope() ?? directAttempt?.currentScope()
                  const unchanged = managedScope
                    ? live && ManagedControl.sameManagedAttemptScope(live as ManagedControl.ManagedAttemptScopeV1, managedScope)
                    : directScope
                      ? live && ManagedControl.sameDirectAttemptScope(live as ManagedControl.DirectAttemptScopeV1, directScope)
                      : rootWorkspaceSnapshot && await bridge.promise(supervisor.directSessionWorkspaceSnapshot({
                          sessionID: input.sessionID,
                          locationRef,
                        })).then((current) =>
                          current.ownerEpoch === rootWorkspaceSnapshot.ownerEpoch &&
                          current.locationID === rootWorkspaceSnapshot.locationID &&
                          current.workspaceRevision === rootWorkspaceSnapshot.workspaceRevision &&
                          current.workspaceRootDigest === rootWorkspaceSnapshot.workspaceRootDigest,
                        ).catch(() => false)
                  if (disposed || !unchanged || !config.getGlobalLaunchProfiles) {
                    await dispose()
                    return []
                  }
                  const getLaunchProfiles = config.getGlobalLaunchProfiles
                  if (file) {
                    const fileRelative = path.relative(directory, path.resolve(file))
                    if (fileRelative === ".." || fileRelative.startsWith(`..${path.sep}`) || path.isAbsolute(fileRelative)) return []
                  }
                  const globalConfig = await bridge.promise(getLaunchProfiles())
                  const configured = globalConfig.lsp && typeof globalConfig.lsp === "object"
                    ? Object.entries(globalConfig.lsp)
                    : []
                  const selected = LSPServer.builtins.filter((server) =>
                    (!file || server.extensions.some((extension) => file.endsWith(extension))) &&
                    configured.some(([serverID, configEntry]) =>
                      serverID === server.id && projectGlobalLspConfigProfileV1({ serverID, configEntry }) !== undefined,
                    ),
                  )
                  const result: import("@/lsp/client").Info[] = []
                  for (const server of selected) {
                    // Keep LSP project scope at the authenticated workspace root.
                    // Upstream marker-based root discovery reads arbitrary project
                    // files through Core's ambient filesystem; it is not an
                    // authorization source and can escape the HostKernel snapshot.
                    const root = directory
                    const profile = configured.find(([serverID]) => serverID === server.id)?.[1]
                    const launchProfile = projectGlobalLspConfigProfileV1({ serverID: server.id, configEntry: profile })
                    const ownerScopeDigest = managedScope?.delegationBindingDigest ?? directScope?.scopeDigest ?? rootOwnerScopeDigest
                    if (!ownerScopeDigest || !launchProfile) continue
                    // Cache identity includes the complete trusted projection. HostKernel's
                    // minted HostProcessRef remains authoritative for the resolved profile
                    // digest; this local digest prevents config projections with a reused
                    // profile ID/revision from sharing a prompt-local client entry.
                    const launchProfileDefinitionDigest = createHash("sha256")
                      .update(JSON.stringify(launchProfile))
                      .digest("hex")
                    const initialization = profile && typeof profile === "object" && "initialization" in profile
                      ? profile.initialization
                      : undefined
                    const key = JSON.stringify([
                      server.id,
                      path.resolve(root),
                      input.sessionID,
                      trustedPins?.attemptID,
                      trustedPins?.ownerEpoch,
                      trustedPins?.locationID,
                      trustedPins?.workspaceRevision,
                      ownerScopeDigest,
                      launchProfile.profileId,
                      launchProfile.revision,
                      launchProfileDefinitionDigest,
                      JSON.stringify(initialization ?? null),
                    ])
                    let pending = clientJobs.get(key)
                    if (!pending) {
                      pending = (async () => {
                        const approvalConfig = await bridge.promise(getLaunchProfiles())
                        const configuredEntry = configured.find(([serverID]) => serverID === server.id)?.[1]
                        const initialization = configuredEntry && typeof configuredEntry === "object" &&
                          "initialization" in configuredEntry ? configuredEntry.initialization : undefined
                        const composed = await createSupervisedLspClientV1({
                          config: approvalConfig,
                          serverID: server.id,
                          sessionID: input.sessionID,
                          locationID: trustedPins!.locationID,
                          locationRef,
                          workspaceRevision: trustedPins!.workspaceRevision,
                          ...(managedScope === undefined ? { workspaceID } : {}),
                          ...(managedScope === undefined ? {} : { managedAttempt: managedScope }),
                          ...(directScope === undefined ? {} : { directAttempt: directScope }),
                          root: path.resolve(root),
                          directory,
                          instance: { ...instance, directory, worktree: directory },
                          initialization,
                          supervisor,
                          runTrustedEffect: (effect) => bridge.promise(effect),
                          requestHostKernel: (serviceID, operation, body) =>
                            bridge.promise(supervisor.requestHostKernel(serviceID, operation, body)),
                        })
                        return composed.client
                      })()
                      clientJobs.set(key, pending)
                    }
                    const client = await pending
                    if (client) result.push(client)
                  }
                  return result
                }
                promptRun = lsp.withExecutionScope({
                  sessionID: input.sessionID,
                  locationID: trustedPins!.locationID,
                  locationRef,
                  workspaceID,
                  workspaceRevision: trustedPins!.workspaceRevision,
                  getClients,
                  getExistingClients,
                  dispose,
                  ...(managedScope === undefined ? {} : { managedAttempt: managedScope }),
                  ...(directScope === undefined ? {} : { directAttempt: directScope }),
                }, promptRun)
                }
              }
            }
          }
          const result = yield* promptRun.pipe(
            Effect.onExit(() => Ref.set(turnComplete, true)),
          )
          yield* Fiber.join(watcher)
          return result
        }),
      )
      return yield* state.ensureRunning(input.sessionID, lastAssistant(input.sessionID), observedRun)
    })
    const loop: Interface["loop"] = (input) => loopWithAttempt(input)

    // Pty is a location-scoped service: resolve it per call through the
    // LocationServiceMap instead of binding it in this global graph.
    const runTerminal = (
      locationRef: typeof Location.Ref.Type,
      input: Pty.TerminalRunInput & { readonly sessionID?: string },
    ) =>
      Effect.gen(function* () {
        const terminal = yield* Pty.Service
        return yield* terminal.runUser({ ...input, locationRef })
      }).pipe(Effect.provide(locations.get(locationRef)))

    const shell: Interface["shell"] = Effect.fn("SessionPrompt.shell")(function* (input) {
      const instance = yield* InstanceState.context
      const workspaceID = yield* InstanceState.workspaceID
      const message = yield* createUserMessage({
        sessionID: input.sessionID,
        messageID: input.messageID,
        agent: input.agent,
        model: input.model,
        parts: [{ type: "text", text: `! ${input.command}` }],
      })
      const result = yield* runTerminal(Location.Ref.make({ directory: AbsolutePath.make(instance.directory), workspaceID }), {
        sessionID: input.sessionID,
        command: input.command,
        cwd: instance.directory,
        timeoutMs: flags.bashDefaultTimeoutMs ?? 120_000,
      })
      const part: SessionV1.Part = {
        id: PartID.ascending(),
        messageID: message.info.id,
        sessionID: input.sessionID,
        type: "text",
        synthetic: true,
        text: `[terminal ${result.status}${result.exitCode === undefined ? "" : `, exit code ${result.exitCode}`}]\n${result.preview}`,
      }
      yield* sessions.updatePart(part)
      return { info: message.info, parts: [...message.parts, part] }
    })

    const commandWork = Effect.fn("SessionPrompt.command")(function* (input: CommandInput) {
      yield* Effect.logInfo("command", {
        "session.id": input.sessionID,
        command: input.command,
        agent: input.agent,
      })
      const cmd = yield* commands.get(input.command)
      if (!cmd) {
        const available = (yield* commands.list()).map((c) => c.name)
        const hint = available.length ? ` Available commands: ${available.join(", ")}` : ""
        const error = new NamedError.Unknown({ message: `Command not found: "${input.command}".${hint}` })
        yield* events.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
        throw error
      }
      const agentName = cmd.agent ?? input.agent

      const raw = input.arguments.match(argsRegex) ?? []
      const args = raw.map((arg) => arg.replace(quoteTrimRegex, ""))
      const templateCommand = yield* Effect.promise(async () => cmd.template)

      const placeholders = templateCommand.match(placeholderRegex) ?? []
      let last = 0
      for (const item of placeholders) {
        const value = Number(item.slice(1))
        if (value > last) last = value
      }

      const withArgs = templateCommand.replaceAll(placeholderRegex, (_, index) => {
        const position = Number(index)
        const argIndex = position - 1
        if (argIndex >= args.length) return ""
        if (position === last) return args.slice(argIndex).join(" ")
        return args[argIndex]
      })
      const usesArgumentsPlaceholder = templateCommand.includes("$ARGUMENTS")
      let template = withArgs.replaceAll("$ARGUMENTS", input.arguments)

      if (placeholders.length === 0 && !usesArgumentsPlaceholder && input.arguments.trim()) {
        template = template + "\n\n" + input.arguments
      }

      const shellBlocks = ConfigMarkdown.shell(template)
      if (shellBlocks.length > 0) {
        if (shellBlocks.length > 1) {
          return yield* new SessionSupervisorError({
            stage: "host-kernel",
            reason: "multiple shell interpolations require atomic Guard admission",
          })
        }
        const instance = yield* InstanceState.context
        const workspaceID = yield* InstanceState.workspaceID
        let rendered = ""
        let offset = 0
        for (const block of shellBlocks) {
          rendered += template.slice(offset, block.index)
          const result = yield* runTerminal(Location.Ref.make({ directory: AbsolutePath.make(instance.directory), workspaceID }), {
            sessionID: input.sessionID,
            command: block[1],
            cwd: instance.directory,
            timeoutMs: flags.bashDefaultTimeoutMs ?? 120_000,
          })
          rendered += `[terminal ${result.status}${result.exitCode === undefined ? "" : `, exit code ${result.exitCode}`}]\n${result.preview}`
          offset = block.index + block[0].length
        }
        template = rendered + template.slice(offset)
      }
      template = template.trim()

      const taskModel = yield* Effect.gen(function* () {
        if (cmd.model) return Provider.parseModel(cmd.model)
        if (cmd.agent) {
          const cmdAgent = yield* agents.get(cmd.agent)
          if (cmdAgent?.model) return cmdAgent.model
        }
        if (input.model) return Provider.parseModel(input.model)
        return yield* currentModel(input.sessionID)
      })

      yield* getModel(taskModel.providerID, taskModel.modelID, input.sessionID)

      const agent = agentName ? yield* agents.get(agentName) : yield* agents.defaultInfo()
      if (!agent) {
        const available = (yield* agents.list().pipe(
          Effect.catchIf(isAgentProfileDirectoryError, agentProfileDirectoryFailure),
        )).filter((a) => !a.hidden).map((a) => a.name)
        const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
        const error = new NamedError.Unknown({ message: `Agent not found: "${agentName}".${hint}` })
        yield* events.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
        throw error
      }

      const templateParts = yield* resolvePromptParts(template)
      const inputFiles = new Set(
        input.parts?.filter((part) => new URL(part.url).protocol === "file:").map((part) => fileURLToPath(part.url)),
      )
      const uniqueTemplateParts = templateParts.filter(
        (part) => part.type !== "file" || !inputFiles.has(fileURLToPath(part.url)),
      )
      const isSubtask = (agent.mode === "subagent" && cmd.subtask !== false) || cmd.subtask === true
      const parts = isSubtask
        ? [
            {
              type: "subtask" as const,
              agent: agent.name,
              description: cmd.description ?? "",
              command: input.command,
              model: { providerID: taskModel.providerID, modelID: taskModel.modelID },
              prompt: templateParts.find((y) => y.type === "text")?.text ?? "",
            },
          ]
        : [...uniqueTemplateParts, ...(input.parts ?? [])]

      const userAgent = isSubtask ? (input.agent ?? (yield* agents.defaultInfo()).name) : agent.name
      const userModel = isSubtask
        ? input.model
          ? Provider.parseModel(input.model)
          : yield* currentModel(input.sessionID)
        : taskModel

      yield* plugin.trigger(
        "command.execute.before",
        { command: input.command, sessionID: input.sessionID, arguments: input.arguments },
        { parts },
      )

      const result = yield* prompt({
        sessionID: input.sessionID,
        messageID: input.messageID,
        model: userModel,
        agent: userAgent,
        parts,
        variant: input.variant,
      })
      yield* events.publish(Command.Event.Executed, {
        name: input.command,
        sessionID: input.sessionID,
        arguments: input.arguments,
        messageID: result.info.id,
      })
      return result
    })
    const command: Interface["command"] = (input) => state.withExecutionOwner(input.sessionID, commandWork(input))

    return Service.of({
      cancel,
      prompt,
      promptManaged,
      runManagedTask,
      prepareManagedTaskRequest,
      prepareManagedPrompt,
      followUpDirectChild,
      prepareManagedFollowUp,
      loop,
      shell,
      command,
      resolvePromptParts,
    })
  }),
)

const ModelRef = Schema.Struct({
  providerID: ProviderV2.ID,
  modelID: ModelV2.ID,
})

export const PromptInput = Schema.Struct({
  sessionID: SessionID,
  messageID: Schema.optional(MessageID),
  model: Schema.optional(ModelRef),
  agent: Schema.optional(Schema.String),
  noReply: Schema.optional(Schema.Boolean),
  tools: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)).annotate({
    description:
      "@deprecated tools and permissions have been merged, you can set permissions on the session itself now",
  }),
  format: Schema.optional(SessionV1.Format),
  system: Schema.optional(Schema.String),
  variant: Schema.optional(Schema.String),
  parts: Schema.Array(
    Schema.Union([
      SessionV1.TextPartInput,
      SessionV1.FilePartInput,
      SessionV1.AgentPartInput,
      SessionV1.SubtaskPartInput,
    ]).annotate({ discriminator: "type" }),
  ),
})
export type PromptInput = Schema.Schema.Type<typeof PromptInput>

export class LoopInput extends Schema.Class<LoopInput>("SessionPrompt.LoopInput")({
  sessionID: SessionID,
}) {}

export const ShellInput = Schema.Struct({
  sessionID: SessionID,
  messageID: Schema.optional(MessageID),
  agent: Schema.String,
  model: Schema.optional(ModelRef),
  command: Schema.String,
})
export type ShellInput = Schema.Schema.Type<typeof ShellInput>

export const CommandInput = Schema.Struct({
  messageID: Schema.optional(MessageID),
  sessionID: SessionID,
  agent: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  arguments: Schema.String,
  command: Schema.String,
  variant: Schema.optional(Schema.String),
  // Inlined (no identifier annotation) to keep the original SDK output — the
  // PromptInput call site below references FilePartInput by ref via the
  // Schema export in message-v2.ts.
  parts: Schema.optional(
    Schema.Array(
      Schema.Union([
        Schema.Struct({
          id: Schema.optional(PartID),
          type: Schema.Literal("file"),
          mime: Schema.String,
          filename: Schema.optional(Schema.String),
          url: Schema.String,
          source: Schema.optional(SessionV1.FilePartSource),
        }),
      ]).annotate({ discriminator: "type" }),
    ),
  ),
})
export type CommandInput = Schema.Schema.Type<typeof CommandInput>

/** @internal Exported for testing */
export function createStructuredOutputTool(input: {
  schema: Record<string, any>
  onSuccess: (output: unknown) => void
}): AITool {
  // Remove $schema property if present (not needed for tool input)
  const { $schema: _, ...toolSchema } = input.schema

  return tool({
    description: STRUCTURED_OUTPUT_DESCRIPTION,
    inputSchema: jsonSchema(toolSchema as JSONSchema7),
    async execute(args, options) {
      requireToolExecution({
        context: options.experimental_context,
        callID: options.toolCallId,
        capability: { id: "tool.structured-output", effectClass: "control" },
        internal: true,
      })
      input.onSuccess(args)
      return {
        output: "Structured output captured successfully.",
        title: "Structured Output",
        metadata: { valid: true },
      }
    },
    toModelOutput({ output }) {
      return {
        type: "text",
        value: output.output,
      }
    },
  })
}
// Match [Image N] as single token, quoted strings, or non-space sequences
const argsRegex = /(?:\[Image\s+\d+\]|"[^"]*"|'[^']*'|[^\s"']+)/gi
const placeholderRegex = /\$(\d+)/g
const quoteTrimRegex = /^["']|["']$/g

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [
    SessionStatus.node,
    Session.node,
    Agent.node,
    Provider.node,
    SessionProcessor.node,
    SessionCompaction.node,
    Plugin.node,
    Command.node,
    Config.node,
    Permission.node,
    FSUtil.node,
    MCP.node,
    LSP.node,
    ToolRegistry.node,
    // SessionTools.resolve reads WebSearchRuntime in this layer's context; the
    // sibling ToolRegistry dependency does not share its provided services.
    WebSearchRuntime.node,
    Truncate.node,
    Image.node,
    Instruction.node,
    SessionRunState.node,
    SessionRevert.node,
    SessionSummary.node,
    SystemPrompt.node,
    LLM.node,
    EventV2Bridge.node,
    RuntimeFlags.node,
    Database.node,
    SessionSupervisor.node,
    locationServiceMapNode,
  ],
})

export * as SessionPrompt from "./prompt"
