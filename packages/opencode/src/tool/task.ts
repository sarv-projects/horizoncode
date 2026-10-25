import * as Tool from "./tool"
import DESCRIPTION from "./task.txt"
import { ToolJsonSchema } from "./json-schema"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { BackgroundJob } from "@/background/job"
import { Session } from "@/session/session"
import type { DirectSubagentInboxRowV1 } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { SessionID, MessageID } from "../session/schema"
import { MessageV2 } from "../session/message-v2"
import { Agent } from "../agent/agent"
import { Provider } from "@/provider/provider"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { deriveSubagentSessionPermission } from "../agent/subagent-permissions"
import type { SessionPrompt } from "../session/prompt"
import { Config } from "@/config/config"
import { Cause, Effect, Exit, Option, Schema, Scope } from "effect"
import { createHash } from "node:crypto"
import { EffectBridge } from "@/effect/bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Database } from "@opencode-ai/core/database/database"
import { SessionSupervisorError, Service as SessionSupervisorService, SessionSupervisor } from "@opencode-ai/core/session/supervisor"
import { InstanceState } from "@/effect/instance-state"
import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap } from "@opencode-ai/core/location-services"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import * as SubagentDeliveryV1 from "@opencode-ai/schema/subagent-delivery-v1"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { TrustedPrincipalContext } from "@opencode-ai/core/trusted-principal"
import { AgentProfileService } from "@opencode-ai/core/config"
import * as AgentProfileV2 from "@opencode-ai/schema/agent-profile-v2"
import { ManagedControl, ManagedControlError } from "@/session/managed-control"
import type {
  ManagedAttemptAdmission,
  ManagedDispatchConsumeReceiptV1,
  ManagedDispatchHandoffV1,
  ManagedReadyTaskSelectionV1,
} from "@/session/managed-control"
import {
  isNextDirectAttemptScope,
  isReceiptAdvancedDirectAttemptScope,
  sameDirectAttemptScope,
} from "@/session/managed-control"
import {
  consumptionAckDigest,
  consumingScopeDigest,
  digestText,
  inboxReceiptDigest,
  type DirectInboxConsumptionProofV1,
} from "@/session/direct-subagent-inbox"
import type { ManagedAttemptAuthority } from "@/session/managed-control"
import type { ManagedPreparedRequestV1, ManagedProviderContextV1 } from "@/session/llm"
import type { DirectAttemptAuthority } from "@/session/tool-batch"
import type { DirectTurnAuthority, DirectTurnScopeV1 } from "@/session/managed-control"
import type { Image } from "@/image/image"

export interface TaskPromptOps {
  cancel(sessionID: SessionID): Effect.Effect<void>
  resolvePromptParts(template: string): Effect.Effect<SessionPrompt.PromptInput["parts"], SessionSupervisorError>
  prompt(
    input: SessionPrompt.PromptInput,
    directAttempt?: DirectAttemptAuthority,
    managedAttempt?: ManagedAttemptAuthority,
    directTurn?: DirectTurnAuthority,
    managedContext?: ManagedProviderContextV1,
    managedFollowUpRunner?: SessionPrompt.ManagedFollowUpRunnerV1,
    managedPreDispatchRecovery?: SessionPrompt.ManagedPreDispatchRecoveryV1,
  ): Effect.Effect<SessionV1.WithParts, Image.Error | Session.BusyError | SessionSupervisorError>
}

const id = "task"
const BACKGROUND_DESCRIPTION = [
  "Background mode: background=true launches the subagent asynchronously and returns immediately.",
  "Foreground is the default; use it when you need the result before continuing.",
  "Use background only for independent work that can run while you continue elsewhere.",
  "You will be notified automatically when it finishes.",
].join(" ")
const BACKGROUND_STARTED = [
  "The task is working in the background. You will be notified automatically when it finishes.",
  "DO NOT sleep, poll for progress, ask the task for status, or duplicate this task's work — avoid working with the same files or topics it is using.",
  "Work on non-overlapping tasks, or briefly tell the user what you launched and end your response.",
].join("\n")
const BACKGROUND_UPDATED = [
  "Additional context sent to the running background task.",
  "The task is still working in the background. You will be notified automatically when it finishes.",
  "DO NOT sleep, poll for progress, ask the task for status, or duplicate this task's work — avoid working with the same files or topics it is using.",
  "Work on non-overlapping tasks, or briefly tell the user what you sent and end your response.",
].join("\n")

const BaseParameterFields = {
  description: Schema.String.annotate({ description: "A short (3-5 words) description of the task" }),
  prompt: Schema.String.annotate({ description: "The task for the agent to perform" }),
  subagent_type: Schema.String.annotate({ description: "An explicit Core Config agent_profile_selectors selector bound to one immutable AgentProfileV2 ID and revision" }),
  task_id: Schema.optional(Schema.String).annotate({
    description:
      "This should only be set if you mean to resume a previous task (you can pass a prior task_id and the task will continue the same subagent session as before instead of creating a fresh one)",
  }),
  command: Schema.optional(Schema.String).annotate({ description: "The command that triggered this task" }),
}

const BaseParameters = Schema.Struct(BaseParameterFields)

export const Parameters = Schema.Struct({
  ...BaseParameterFields,
  background: Schema.optional(Schema.Boolean).annotate({
    description:
      "Run the agent in the background. You will be notified when it completes. DO NOT sleep, poll, or proactively check on its progress",
  }),
})

const UNAVAILABLE = [
  "Task/subagent execution is unavailable: an authenticated Rust direct Attempt",
  "could not be admitted, so no child session was created or prompted.",
].join(" ")
const PROFILE_PIN_KEY = "horizonAgentProfileV2"
const DIRECT_ATTEMPT_PIN_KEY = "horizonDirectAttemptID"
const DIRECT_SCOPE_PIN_KEY = "horizonDirectAttemptScopeDigest"
const MAX_DIRECT_CHILD_SESSIONS_PER_PARENT = 64
type DirectInboxTransitionWithDelivery = Parameters<Session.Interface["directInboxTransition"]>[0] & {
  readonly deliveryAttemptID?: string | null
  readonly deliveryOwnerEpoch?: string | null
}

type DirectProfilePin = {
  readonly profileID: string
  readonly profileRevision: string
  readonly profileDigest: string
  readonly permissionsDigest: string
  readonly harness: string
}

function directProfilePin(metadata: Record<string, unknown> | undefined): DirectProfilePin | undefined {
  const raw = metadata?.[PROFILE_PIN_KEY]
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined
  const value = raw as Record<string, unknown>
  const revision = value.profileRevision
  const maxRevision = "18446744073709551615"
  if (
    Object.keys(value).length !== 5 ||
    ["harness", "permissionsDigest", "profileDigest", "profileID", "profileRevision"].some((key) => !Object.hasOwn(value, key)) ||
    typeof value.profileID !== "string" ||
    typeof revision !== "string" ||
    !/^[1-9][0-9]{0,19}$/.test(revision) ||
    revision.length > maxRevision.length ||
    (revision.length === maxRevision.length && revision > maxRevision) ||
    typeof value.profileDigest !== "string" ||
    !/^blake3:[0-9a-f]{64}$/.test(value.profileDigest) ||
    typeof value.permissionsDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(value.permissionsDigest) ||
    typeof value.harness !== "string" ||
    !/^[A-Za-z0-9._-]{1,256}$/.test(value.harness)
  ) return undefined
  return {
    profileID: value.profileID,
    profileRevision: revision,
    profileDigest: value.profileDigest,
    permissionsDigest: value.permissionsDigest,
    harness: value.harness,
  }
}

function sameDirectDelivery(raw: unknown, expected: SubagentDeliveryV1.SubagentDeliveryV1): boolean {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false
  return JSON.stringify({ ...raw, ackState: expected.ackState }) === JSON.stringify(expected)
}

function trustedDigest(value: unknown) {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`
}

function renderOutput(input: {
  sessionID: SessionID
  state: "running" | "completed" | "error"
  summary?: string
  text: string
  attemptID?: string
  receiptDigest?: string
}) {
  const tag = input.state === "error" ? "task_error" : "task_result"
  const attributes = [
    input.attemptID ? ` attempt="${input.attemptID}"` : "",
    input.receiptDigest ? ` receipt="${input.receiptDigest}"` : "",
  ].join("")
  return [
    `<task id="${input.sessionID}" state="${input.state}"${attributes}>`,
    ...(input.summary ? [`<summary>${input.summary}</summary>`] : []),
    `<${tag}>`,
    input.text,
    `</${tag}>`,
    "</task>",
  ].join("\n")
}

export const TaskTool = Tool.define(
  id,
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const provider = yield* Provider.Service
    const locations = yield* LocationServiceMap.Service
    const background = yield* BackgroundJob.Service
    const config = yield* Config.Service
    const sessions = yield* Session.Service
    const sessionStatus = yield* SessionStatus.Service
    const scope = yield* Scope.Scope
    const flags = yield* RuntimeFlags.Service
    const database = yield* Database.Service
    // The authenticated host-kernel channel is captured once so the deferred
    // background job can carry the same supervisor into its own scope, and so the
    // tool's execute effect has no unresolved service requirement.
    const supervisor = yield* SessionSupervisor.Service

    const run = Effect.fn("TaskTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      const trustedPrincipal = ctx.trustedPrincipal
      if (trustedPrincipal?.kind !== "server_auth" || !trustedPrincipal.subject) {
        return yield* Effect.fail(
          new ManagedControlError({
            operation: "admit_direct_attempt",
            code: "authorization",
            reason: "direct child dispatch requires an authenticated principal",
          }),
        )
      }
      // A managed Task already has a Goal/Run/Task/Attempt authority. It must
      // never downgrade to the Goal-less direct Attempt lane by invoking this
      // legacy subagent tool. The managed claim/consume handoff is the only
      // permitted path and remains unavailable until its P1/P8 token arrives.
      if (ctx.extra?.managedAttempt !== undefined) {
        return yield* Effect.fail(new ManagedControlError({
          operation: "claim_dispatch",
          code: "capability_unavailable",
          reason: "managed child dispatch requires the authenticated P1/P8 claim and consume handoff; direct Attempt fallback is forbidden",
        }))
      }
      // Every dispatched child is fenced by an authenticated, durable Rust direct
      // Attempt before any child session is created or prompted. Direct coding does
      // not require a Goal, so the Attempt binds the parent/child session, the agent
      // and a Core-computed digest of the intersected dispatch scope (derived
      // permissions, provider/model, workspace and budget). When the authenticated
      // host kernel is unavailable this fails closed with zero child effect.
      const cfg = yield* config.get()
      const runInBackground = params.background === true
      if (runInBackground && !flags.experimentalBackgroundSubagents) {
        return yield* Effect.fail(
          new Error("Background subagents require OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true"),
        )
      }

      const parent = yield* sessions.get(ctx.sessionID)
      let current = parent
      let depth = 0
      while (current.parentID) {
        depth++
        current = yield* sessions.get(current.parentID)
      }
      if (depth >= (cfg.subagent_depth ?? 1)) {
        return yield* Effect.fail(
          new Error(
            `Subagent depth limit reached (${cfg.subagent_depth ?? 1}). Increase "subagent_depth" to allow nested subagents.`,
          ),
        )
      }

      const session = params.task_id
        ? yield* sessions
            .get(SessionID.make(params.task_id))
            .pipe(
              Effect.catchTag("NotFoundError", () =>
                Effect.fail(new Error("task_id does not identify a child session for this parent and agent")),
              ),
            )
        : undefined
      if (session && session.parentID !== ctx.sessionID) {
        return yield* Effect.fail(new Error("task_id does not identify a child session for this parent and agent"))
      }
      const instance = yield* InstanceState.context
      const profileLocationRef = Location.Ref.make({ directory: AbsolutePath.make(instance.directory) })
      const { definitions, selectedProfile } = yield* Effect.gen(function* () {
        const profiles = yield* AgentProfileService
        const definitions = yield* profiles.agentProfiles()
        const selectedProfile = yield* profiles.agentProfileSelector(params.subagent_type)
        return { definitions, selectedProfile }
      }).pipe(
        Effect.provide(locations.get(profileLocationRef)),
        Effect.mapError((error) => new ManagedControlError({
          operation: "admit_direct_attempt",
          code: "agent_profile_unavailable",
          reason: error.message,
        })),
      )
      let profileDefinition: AgentProfileV2.AgentProfileDefinitionV2 | undefined
      const savedProfilePin = directProfilePin(session?.metadata)
      if (session) {
        if (!savedProfilePin) {
          return yield* new ManagedControlError({
            operation: "admit_direct_attempt",
            code: "agent_profile_stale",
            reason: "resuming a child without its immutable AgentProfileV2 pin is unavailable",
          })
        }
        profileDefinition = definitions.find(
          (candidate) => candidate.profileId === savedProfilePin.profileID && String(candidate.revision) === savedProfilePin.profileRevision,
        )
        if (
          selectedProfile.profileId !== savedProfilePin.profileID ||
          String(selectedProfile.revision) !== savedProfilePin.profileRevision ||
          selectedProfile.harness !== savedProfilePin.harness
        ) {
          return yield* new ManagedControlError({
            operation: "admit_direct_attempt",
            code: "agent_profile_stale",
            reason: "resume selector no longer resolves to the immutable AgentProfileV2 revision pinned to this child Session",
          })
        }
      } else {
        profileDefinition = selectedProfile
      }
      if (!profileDefinition || !profileDefinition.enabled || !profileDefinition.roles.includes("subagent")) {
        return yield* new ManagedControlError({
          operation: "admit_direct_attempt",
          code: session ? "agent_profile_stale" : "agent_profile_unavailable",
          reason: session
            ? "the exact AgentProfileV2 revision pinned to this child Session is unavailable"
            : `subagent selector ${params.subagent_type} does not resolve to an enabled user-owned AgentProfileV2 subagent profile`,
        })
      }
      if (savedProfilePin && profileDefinition.harness !== savedProfilePin.harness) {
        return yield* new ManagedControlError({
          operation: "admit_direct_attempt",
          code: "agent_profile_stale",
          reason: "the exact pinned AgentProfileV2 harness is unavailable",
        })
      }
      if (depth >= Math.min(cfg.subagent_depth ?? 1, profileDefinition.limits.maxDepth)) {
        return yield* new ManagedControlError({
          operation: "admit_direct_attempt",
          code: "agent_profile_limit",
          reason: `AgentProfileV2 ${profileDefinition.profileId}@${profileDefinition.revision} child-depth limit is reached`,
        })
      }
      // Read the exact parent lineage; Session.list is intentionally paged and
      // could omit older direct children, weakening the local early-denial cap.
      const projectSessions = yield* sessions.children(parent.id)
      // This database snapshot provides prompt feedback, but it is not the
      // concurrency authority: HostKernel must atomically enforce the same
      // parent-wide ceiling against its DirectAttempt OwnerLog.
      const existingDirectChildren = projectSessions.filter((candidate) => {
        if (candidate.parentID !== parent.id || candidate.workspaceID !== parent.workspaceID || candidate.id === session?.id) return false
        const metadata = candidate.metadata
        if (typeof metadata?.[DIRECT_ATTEMPT_PIN_KEY] === "string") return true
        try {
          return Schema.decodeUnknownSync(SubagentDeliveryV1.SubagentDeliveryV1, { onExcessProperty: "error" })(
            metadata?.horizonSubagentDelivery,
          ).lane === "direct_session"
        } catch {
          return false
        }
      })
      if (existingDirectChildren.length >= MAX_DIRECT_CHILD_SESSIONS_PER_PARENT) {
        return yield* new ManagedControlError({
          operation: "admit_direct_attempt",
          code: "agent_profile_limit",
          reason: `parent Session direct-child limit of ${MAX_DIRECT_CHILD_SESSIONS_PER_PARENT} is reached`,
        })
      }
      const profileChildren = projectSessions.filter((candidate) => {
        const pin = directProfilePin(candidate.metadata)
        return candidate.parentID === parent.id && candidate.workspaceID === parent.workspaceID && pin?.profileID === profileDefinition.profileId
      })
      const existingProfileChildren = profileChildren.filter((candidate) => candidate.id !== session?.id)
      if (existingProfileChildren.length >= profileDefinition.limits.maxTotalChildren) {
        return yield* new ManagedControlError({
          operation: "admit_direct_attempt",
          code: "agent_profile_limit",
          reason: `AgentProfileV2 ${profileDefinition.profileId}@${profileDefinition.revision} total-child limit is reached`,
        })
      }
      const statusMap = yield* sessionStatus.list()
      const activeChildren = existingProfileChildren.filter((candidate) => statusMap.get(candidate.id)?.type !== "idle")
      const activeLimit = Math.min(profileDefinition.limits.maxActiveChildren, profileDefinition.maxParallelChildren)
      if (activeChildren.length >= activeLimit) {
        return yield* new ManagedControlError({
          operation: "admit_direct_attempt",
          code: "agent_profile_limit",
          reason: `AgentProfileV2 ${profileDefinition.profileId}@${profileDefinition.revision} active-child limit is reached`,
        })
      }
      const next = yield* agent.getProfile(profileDefinition.profileId, profileDefinition.revision)
      if (session && session.agent !== next.name) {
        return yield* new ManagedControlError({
          operation: "admit_direct_attempt",
          code: "agent_profile_stale",
          reason: "resumed child Session agent does not match its pinned AgentProfileV2 name",
        })
      }
      const parentAgent = yield* agent.get(ctx.agent)
      const childPermission = deriveSubagentSessionPermission({
        parentAgentPermission: parentAgent.permission,
        parentSessionPermission: parent.permission ?? [],
        subagent: next,
      })
      const childToolDenies = [
        ...(next.permission.some((rule) => rule.permission === "todowrite")
          ? []
          : [{ permission: "todowrite" as const, pattern: "*" as const, action: "deny" as const }]),
        ...(next.permission.some((rule) => rule.permission === id)
          ? []
          : [{ permission: id, pattern: "*" as const, action: "deny" as const }]),
        ...(cfg.experimental?.primary_tools?.map((permission) => ({
          permission,
          pattern: "*" as const,
          action: "deny" as const,
        })) ?? []),
      ]
      const childSessionPermission = [
        ...childPermission,
        ...childToolDenies.filter(
          (deny) =>
            !childPermission.some(
              (rule) =>
                rule.permission === deny.permission && rule.pattern === deny.pattern && rule.action === deny.action,
            ),
        ),
      ]
      const msg = yield* MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID }).pipe(
        Effect.provideService(Database.Service, database),
        Effect.orDie,
      )
      if (msg.info.role !== "assistant") return yield* Effect.fail(new Error("Not an assistant message"))
      const promptBytes = Buffer.byteLength(params.prompt, "utf8")
      if (profileDefinition.limits.maxPendingMessages < 1 || promptBytes > profileDefinition.limits.maxMessageBytes) {
        return yield* new ManagedControlError({
          operation: "admit_direct_attempt",
          code: "agent_profile_limit",
          reason: `AgentProfileV2 prompt exceeds its pending-message or message-byte limit`,
        })
      }
      const model = next.model
      if (!model) {
        return yield* new ManagedControlError({
          operation: "admit_direct_attempt",
          code: "agent_profile_unavailable",
          reason: "the selected AgentProfileV2 has no executable provider/model selection",
        })
      }
      yield* provider.getModel(model.providerID, model.modelID).pipe(
        Effect.mapError((error) => new ManagedControlError({
          operation: "admit_direct_attempt",
          code: "agent_profile_unavailable",
          reason: `AgentProfileV2 ${profileDefinition.profileId}@${profileDefinition.revision} selected an unavailable provider/model: ${error.message}`,
        })),
      )

      // Check the authenticated boundary before even registering the child scope.
      if (!(yield* ManagedControl.available())) {
        return yield* Effect.fail(
          new ManagedControlError({
            operation: "admit_direct_attempt",
            code: "managed_unavailable",
            reason: UNAVAILABLE,
          }),
        )
      }

      // The Attempt location is derived from the parent session's persisted
      // workspace (or the current trusted workspace context) and this runtime's
      // canonical project directory. No task argument can choose either value.
      const workspaceID = parent.workspaceID ?? (yield* InstanceState.workspaceID)
      if (!workspaceID) {
        return yield* Effect.fail(
          new ManagedControlError({
            operation: "admit_direct_attempt",
            code: "managed_conflict",
            reason: "direct child dispatch requires a trusted workspace binding",
          }),
        )
      }
      const locationRef = Location.Ref.make({
        directory: AbsolutePath.make(instance.directory),
        workspaceID,
      })
      const locationID = yield* supervisor.registerHostLocation(locationRef).pipe(
        Effect.provideService(TrustedPrincipalContext, { principal: trustedPrincipal }),
        Effect.mapError(
          (error) =>
            new ManagedControlError({
              operation: "admit_direct_attempt",
              code: "managed_unavailable",
              reason: `could not register the trusted parent workspace location: ${error.message}`,
            }),
        ),
      )
      const effectivePermissionRules = [...next.permission, ...childSessionPermission]
        .filter((rule, index, all) => all.findIndex((item) =>
          item.permission === rule.permission && item.pattern === rule.pattern && item.action === rule.action,
        ) === index)
        .map((rule) => `${rule.permission}:${rule.pattern}:${rule.action}`)
        .sort()
      const capabilityRules = effectivePermissionRules.filter((rule) => !rule.endsWith(":deny"))
      const budgetFacts = {
        maxAttempts: 1,
        maxSubagentDepth: cfg.subagent_depth ?? 1,
        profileID: profileDefinition.profileId,
        profileRevision: profileDefinition.revision,
        maxProfileDepth: profileDefinition.limits.maxDepth,
        maxActiveChildren: profileDefinition.limits.maxActiveChildren,
        maxTotalChildren: profileDefinition.limits.maxTotalChildren,
        maxParallelChildren: profileDefinition.maxParallelChildren,
        profileWallTimeMs: profileDefinition.limits.wallTimeMs,
        background: runInBackground,
        backgroundEnabled: flags.experimentalBackgroundSubagents,
      }
      const capabilityDigest = trustedDigest({ capabilities: capabilityRules })
      const permissionsDigest = trustedDigest({ rules: effectivePermissionRules })
      const budgetDigest = trustedDigest(budgetFacts)

      // ---- authenticated dispatch fence ----
      if (!ctx.extra?.bypassAgentCheck) {
        yield* ctx.ask({
          permission: id,
          patterns: [params.subagent_type],
          always: ["*"],
          metadata: {
            description: params.description,
            subagent_type: params.subagent_type,
          },
        })
      }
      const childID = session?.id ?? SessionID.descending()
      let sessionMetadata = session?.metadata
      const retainedAttemptID = session?.metadata?.[DIRECT_ATTEMPT_PIN_KEY]
      if (session && (typeof retainedAttemptID !== "string" || !/^att_[a-z0-9]{16,64}$/.test(retainedAttemptID))) {
        return yield* new ManagedControlError({ operation: "direct_attempt_snapshot", code: "managed_conflict", reason: "resumed child has no exact durable DirectAttempt identity" })
      }
      if (session && (yield* sessionStatus.get(session.id)).type !== "idle") {
        return yield* new ManagedControlError({ operation: "turn_begin", code: "managed_conflict", reason: "child already has a runner; send a queued message instead of starting another child turn" })
      }
      const attemptID = typeof retainedAttemptID === "string" ? retainedAttemptID : ManagedControl.newAttemptID()
      const scopeDigest = ManagedControl.scopeDigest({
        parentSessionID: ctx.sessionID,
        childSessionID: childID,
        agent: next.name,
        providerID: model.providerID,
        modelID: model.modelID,
        workspaceRoot: instance.worktree,
        permissionRules: effectivePermissionRules,
        deniedTools: childToolDenies.map((deny) => deny.permission),
        background: runInBackground,
        maxAttempts: 1,
        subagentDepth: cfg.subagent_depth ?? 1,
      })
      const admitted = yield* Effect.gen(function* () {
        if (session) {
          // Persisted metadata identifies the row only. The authenticated native
          // snapshot supplies every live permission/workspace/revision pin.
          const live = yield* ManagedControl.snapshotDirectAttempt(attemptID)
          const directAttempt = live.directAttempt
          if (live.phase !== "EXECUTING" || !directAttempt || live.parentSessionID !== ctx.sessionID ||
            live.childSessionID !== childID || live.agent !== next.name || directAttempt.locationID !== locationID ||
            directAttempt.workspaceID !== workspaceID || directAttempt.scopeDigest !== scopeDigest ||
            directAttempt.capabilityDigest !== capabilityDigest || directAttempt.permissionsDigest !== permissionsDigest ||
            directAttempt.budgetDigest !== budgetDigest) {
            return yield* new ManagedControlError({ operation: "direct_attempt_snapshot", code: "managed_conflict", reason: "resumed child does not match the authenticated live Attempt; no replacement Attempt was admitted" })
          }
          return { ...live, directAttempt, ownerEpoch: directAttempt.ownerEpoch,
            locationID: directAttempt.locationID, workspaceID: directAttempt.workspaceID,
            workspaceRevision: directAttempt.workspaceRevision }
        }
        return yield* ManagedControl.admitDirectAttempt({
        attemptID,
        parentSessionID: ctx.sessionID,
        childSessionID: childID,
        agent: next.name,
        profileSelection: {
          profileId: profileDefinition.profileId,
          revision: String(profileDefinition.revision),
        },
        profileDefinition,
        scopeDigest,
        locationID,
        workspaceID,
        capabilityDigest,
        permissionsDigest,
        budgetDigest,
      })
      })
      if (admitted.phase !== "EXECUTING") {
        return yield* Effect.fail(
          new ManagedControlError({
            operation: "admit_direct_attempt",
            code: "managed_conflict",
            reason: `attempt ${attemptID} was admitted as ${admitted.phase}; direct dispatch requires EXECUTING`,
          }),
        )
      }
      const profileRevision = String(profileDefinition.revision)
      if (
        admitted.directAttempt.profileID !== profileDefinition.profileId ||
        admitted.directAttempt.profileRevision !== profileRevision ||
        admitted.directAttempt.permissionsDigest !== permissionsDigest ||
        (savedProfilePin &&
          (admitted.directAttempt.profileDigest !== savedProfilePin.profileDigest ||
            admitted.directAttempt.permissionsDigest !== savedProfilePin.permissionsDigest))
      ) {
        if (!session) yield* ManagedControl.cancelDirectAttempt({
          attemptID,
          expectedRevision: admitted.revision,
        }).pipe(Effect.ignore)
        return yield* new ManagedControlError({
          operation: "admit_direct_attempt",
          code: "agent_profile_stale",
          reason: "HostKernel profile pin does not match the selected or resumed AgentProfileV2 revision and permission scope",
        })
      }
      const sessionProfilePin = {
        profileID: admitted.directAttempt.profileID,
        profileRevision: admitted.directAttempt.profileRevision,
        profileDigest: admitted.directAttempt.profileDigest,
        permissionsDigest: admitted.directAttempt.permissionsDigest,
        harness: profileDefinition.harness,
      }
      let attemptRevision = admitted.revision
      let attemptReceipt: string | null = null
      // Admission is the durable authority boundary. Any setup failure before
      // childRun takes ownership must close that Attempt with its cancellation
      // fence; otherwise it remains EXECUTING despite no child work being run.
      let cancellationRequested = false
      let initialPromptDispatched = false
      const cancelAttempt = Effect.fn("TaskTool.cancelAttempt")(function* () {
        // A refused follow-up must not cancel the already-live child Attempt.
        if (cancellationRequested || (session && !initialPromptDispatched)) return
        const cancelled = yield* ManagedControl.cancelDirectAttempt({
          attemptID,
          expectedRevision: attemptRevision,
        }).pipe(Effect.catchTag("ManagedControlError", () => Effect.succeed(undefined)))
        cancellationRequested = true
        if (cancelled) attemptRevision = cancelled.revision
      })
      const directAttemptBridge = yield* EffectBridge.make().pipe(
        Effect.catchCause((cause) => cancelAttempt().pipe(Effect.andThen(Effect.failCause(cause)))),
      )
      let directAttemptScope = admitted.directAttempt
      const directAttemptAuthority: DirectAttemptAuthority = {
        currentScope: () => directAttemptScope,
        acceptRefreshedScope: ({ previous, refreshed, transition }) => {
          if (!sameDirectAttemptScope(directAttemptScope, previous)) {
            throw new Error("Direct Attempt scope is stale before HostKernel refresh")
          }
          const valid = sameDirectAttemptScope(previous, refreshed) || (transition === "batch_bind"
            ? isNextDirectAttemptScope(previous, refreshed)
            : transition === "effect_receipt" && isReceiptAdvancedDirectAttemptScope(previous, refreshed))
          if (!valid) throw new Error("HostKernel returned a stale or mismatched Direct Attempt scope")
          directAttemptScope = refreshed
          attemptRevision = refreshed.expectedRevision
        },
      }
      const childMessageID = MessageID.ascending()
      let followUpAuthorization: ManagedControl.FreshTurnAuthorizationV1 | undefined
      let followUpRow: DirectSubagentInboxRowV1 | undefined
      if (session) {
        yield* ManagedControl.requireDirectTurnLifecycle()
        let completion = sessionMetadata?.horizonDirectTurnCompletion
        if (typeof completion === "object" && completion !== null && !Array.isArray(completion) &&
          (completion as Record<string, unknown>).state === "pending") {
          const pending = completion as Record<string, unknown>
          const pendingScope = yield* Effect.try({
            try: () => ManagedControl.decodeDirectTurnScopeCandidate(sessionMetadata?.horizonDirectTurnScope),
            catch: () => new ManagedControlError({ operation: "turn_complete", code: "managed_conflict", reason: "pending turn completion has no exact replay scope" }),
          })
          if (pending.runnerCycleID !== pendingScope.runnerCycleID || pending.turnSequence !== pendingScope.turnSequence ||
            pending.cycleDigest !== pendingScope.cycleDigest ||
            !sameDirectAttemptScope(pendingScope.directAttempt, directAttemptScope) ||
            typeof pending.resultDigest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(pending.resultDigest)) {
            return yield* new ManagedControlError({ operation: "turn_complete", code: "managed_conflict", reason: "pending completion pins differ from the authenticated live child Attempt" })
          }
          // Only replay the exact completion request. If HostKernel cannot prove
          // that same cycle/result receipt, this Attempt remains fenced UNKNOWN.
          const recovered = yield* ManagedControl.completeDirectTurn({
            directTurnScope: pendingScope,
            resultDigest: pending.resultDigest,
          })
          // This recovery branch only runs for an existing child Session. Do not
          // reference `nextSession` here: it is intentionally created below, after
          // follow-up admission, and is still in its temporal dead zone.
          const currentChild = yield* sessions.get(session.id)
          if (currentChild.metadata?.[DIRECT_ATTEMPT_PIN_KEY] !== attemptID ||
            !sameDirectDelivery(currentChild.metadata?.horizonSubagentDelivery, session.metadata?.horizonSubagentDelivery)) {
            return yield* new ManagedControlError({ operation: "turn_complete", code: "managed_conflict", reason: "child Session authority changed during completion reconciliation" })
          }
          sessionMetadata = {
            ...(currentChild.metadata ?? {}),
            horizonDirectTurnScope: pendingScope,
            horizonDirectAttemptScope: pendingScope.directAttempt,
            horizonDirectTurnCompletion: {
              ...pending,
              state: "completed",
              nextTurnSequence: recovered.nextTurnSequence,
              receiptDigest: recovered.receiptDigest,
            },
          }
          yield* sessions.setMetadata({ sessionID: currentChild.id, metadata: sessionMetadata })
          completion = sessionMetadata.horizonDirectTurnCompletion
        }
        const completed = typeof completion === "object" && completion !== null && !Array.isArray(completion)
          ? completion as Record<string, unknown> : undefined
        if (!completed || completed.state !== "completed" || !ctx.callID) {
          return yield* new ManagedControlError({ operation: "turn_begin", code: "managed_unavailable", reason: "follow-up requires a durable completed turn and an exact parent tool-call identity" })
        }
        const completedScope = yield* Effect.try({
          try: () => ManagedControl.decodeDirectTurnScopeCandidate(sessionMetadata?.horizonDirectTurnScope),
          catch: () => new ManagedControlError({ operation: "turn_begin", code: "managed_conflict", reason: "child has no valid completed-turn replay material" }),
        })
        if (completed.runnerCycleID !== completedScope.runnerCycleID || completed.turnSequence !== completedScope.turnSequence ||
          completed.cycleDigest !== completedScope.cycleDigest || !sameDirectAttemptScope(completedScope.directAttempt, directAttemptScope)) {
          return yield* new ManagedControlError({ operation: "turn_begin", code: "managed_conflict", reason: "completed-turn replay material differs from the authenticated live Attempt" })
        }
        // This native request remains false-gated until Guard/recovery acceptance.
        // Reserve a bounded durable message identity first; no provider is woken
        // until prepare, inbox commit and turn_begin all confirm the exact pins.
        const requestID = digestText(`${ctx.messageID}:${ctx.callID}`).slice("sha256:".length)
        const messageID = MessageID.ascending(`${ctx.sessionID}:${childID}:${requestID}`)
        const reservation = yield* sessions.directInboxCreateDraft({
          messageId: messageID, parentSessionId: ctx.sessionID, childSessionId: childID, requestId: requestID,
          payload: params.prompt, payloadDigest: digestText(params.prompt), payloadBytes: promptBytes,
          deliveryMode: "follow_up", childAttemptId: attemptID, childOwnerEpoch: directAttemptScope.ownerEpoch,
          profileId: directAttemptScope.profileID, profileRevision: directAttemptScope.profileRevision,
          profileDigest: directAttemptScope.profileDigest, permissionScopeDigest: permissionsDigest,
          mailboxCapacity: Math.min(32, profileDefinition.limits.maxPendingMessages),
          inboxReceiptDigest: digestText(`${messageID}:preparing`),
        })
        followUpRow = reservation.row
        if (!reservation.created && reservation.row.state !== "preparing" && reservation.row.state !== "admitted" &&
          reservation.row.state !== "appended" && reservation.row.state !== "committed") {
          return yield* new ManagedControlError({ operation: "turn_begin", code: "managed_conflict", reason: `follow-up delivery is ${reservation.row.state}; it requires receipt reconciliation and cannot be redispatched` })
        }
        const pins: ManagedControl.DirectMessagePinsV1 = {
          parentSessionID: ctx.sessionID, childSessionID: childID, childOwnerEpoch: directAttemptScope.ownerEpoch,
          profileID: directAttemptScope.profileID, profileRevision: directAttemptScope.profileRevision,
          profileDigest: directAttemptScope.profileDigest, permissionScopeDigest: permissionsDigest,
          directAttemptID: attemptID, messageID, deliveryMode: "follow_up", payloadDigest: digestText(params.prompt),
          payloadBytes: promptBytes, mailboxSequence: followUpRow.mailbox_sequence, mailboxCapacity: followUpRow.mailbox_capacity,
        }
        followUpAuthorization = yield* ManagedControl.issueFreshTurnAuthorization({ pins, completedTurnScope: completedScope })
        if (followUpRow.state === "preparing") {
          // Repeating the original, deterministic IDs after a lost prepare reply is
          // the documented recovery path. HostKernel returns its retained exact
          // challenge/lease; this never mints another authorization or turn.
          const prepared = yield* ManagedControl.prepareDirectMessage({ pins, content: params.prompt,
            mailboxCapacity: pins.mailboxCapacity, freshTurnAuthorization: followUpAuthorization })
          if (prepared.status !== "ADMITTED") {
            yield* sessions.directInboxTransition({ messageID, expected: ["preparing"], state: prepared.status === "DENIED" ? "denied" : "approval_required",
              ...(prepared.status === "NEEDS_APPROVAL" ? { challengeID: prepared.challengeID, effectID: prepared.effectID,
                approvalExpiresAtUnixMs: prepared.expiresAtUnixMs, approvalArgumentSummary: JSON.stringify(prepared.argumentSummary),
                approvalPolicySummary: prepared.policySummary } : {}) })
            return yield* new ManagedControlError({ operation: "direct.message.prepare", code: "managed_unavailable", reason: "follow-up was not admitted; no child turn was started" })
          }
          const receipt = inboxReceiptDigest({ ...pins, directAttemptID: attemptID, deliveryMode: "follow_up" })
          followUpRow = yield* sessions.directInboxTransition({ messageID, expected: ["preparing"], state: "admitted",
            capabilityLeaseDigest: prepared.capabilityLeaseDigest, pinsDigest: prepared.pinsDigest, inboxReceiptDigest: receipt })
        }
        const receipt = inboxReceiptDigest({ ...pins, directAttemptID: attemptID, deliveryMode: "follow_up" })
        if (followUpRow.state === "admitted") {
          if (!followUpRow.capability_lease_digest || !followUpRow.pins_digest || followUpRow.inbox_receipt_digest !== receipt) {
            return yield* new ManagedControlError({ operation: "direct.message.commit", code: "managed_conflict", reason: "admitted follow-up is missing exact retained lease or inbox receipt pins" })
          }
          followUpRow = yield* sessions.directInboxTransition({ messageID, expected: ["admitted"], state: "appended" })
        }
        let committed: ManagedControl.DirectMessageReceiptV1
        if (followUpRow.state === "committed") {
          // A prior commit reply may have been lost. Reconcile its retained
          // HostKernel receipt; a timeout never triggers a second child turn.
          committed = yield* ManagedControl.inspectDirectMessage({ pins })
        } else {
          if (!followUpRow.capability_lease_digest || !followUpRow.pins_digest || followUpRow.inbox_receipt_digest !== receipt) {
            return yield* new ManagedControlError({ operation: "direct.message.commit", code: "managed_conflict", reason: "appended follow-up is missing exact retained lease or inbox receipt pins" })
          }
          committed = yield* ManagedControl.commitDirectMessage({ pins, capabilityLeaseDigest: followUpRow.capability_lease_digest,
            inboxReceipt: { messageID, parentSessionID: ctx.sessionID, childSessionID: childID, deliveryMode: "follow_up",
              mailboxSequence: pins.mailboxSequence, receiptDigest: receipt } })
        }
        if (committed.status !== "FOLLOW_UP_SCHEDULED") {
          yield* sessions.directInboxTransition({ messageID, expected: ["preparing", "admitted", "appended", "committed"], state: "unknown" }).pipe(Effect.ignore)
          return yield* new ManagedControlError({ operation: "direct.message.commit", code: "managed_conflict", reason: "follow-up commit is unresolved; no provider wake occurred" })
        }
        if (followUpRow.state !== "committed") {
          followUpRow = yield* sessions.directInboxTransition({ messageID, expected: ["appended"], state: "committed", hostReceiptDigest: committed.receiptDigest })
        } else if (followUpRow.host_receipt_digest !== committed.receiptDigest) {
          return yield* new ManagedControlError({ operation: "direct.message.commit", code: "managed_conflict", reason: "retained follow-up receipt differs from HostKernel inspection" })
        }
      }
      const deliveryEnvelope = yield* Effect.try({
        try: () => {
          const now = Date.now()
          const configuredWallTimeMs = BigInt(profileDefinition.limits.wallTimeMs ?? "300000")
          if (configuredWallTimeMs > BigInt(Number.MAX_SAFE_INTEGER - now)) throw new Error("AgentProfile delivery expiry exceeds the supported timestamp range")
          const expiresAt = now + Number(configuredWallTimeMs)
          if (!Number.isSafeInteger(expiresAt)) throw new Error("AgentProfile delivery expiry exceeds the supported timestamp range")
          return directDeliveryEnvelope({
            scope: directAttemptScope,
            messageID: childMessageID,
            payload: params.prompt,
            sequence: directDeliverySequence(session, directAttemptScope),
            expiresAt,
          })
        },
        catch: (error) => new ManagedControlError({ operation: "subagent_delivery", code: "managed_protocol", reason: error instanceof Error ? error.message : "direct delivery could not be bound" }),
      }).pipe(Effect.catchCause((cause) => cancelAttempt().pipe(Effect.andThen(Effect.failCause(cause)))))

      const resultPayload = (state: "completed" | "failed", text: string) => ({
        childSessionID: childID,
        agent: next.name,
        state,
        outputDigest: ManagedControl.outputDigest(text),
        outputBytes: Buffer.byteLength(text, "utf8"),
      })
      const settleAttempt = (outcome: "succeeded" | "failed", payload: ReturnType<typeof resultPayload>) =>
        ManagedControl.settleDirectAttempt({
          attemptID,
          outcome,
          resultDigest: ManagedControl.resultDigest(payload),
          ...(outcome === "failed" ? { failureCode: "child_failed", retryable: false } : {}),
          expectedRevision: attemptRevision,
        }).pipe(
          Effect.tap((settlement) =>
            Effect.sync(() => {
              attemptRevision = settlement.revision
              if (settlement.receiptDigest) attemptReceipt = settlement.receiptDigest
            }),
          ),
        )

      const nextSession = yield* Effect.gen(function* () {
        if (session) return session
        return yield* sessions.create({
          id: childID,
          parentID: ctx.sessionID,
          title: params.description + ` (@${next.name} subagent)`,
          agent: next.name,
          permission: childSessionPermission,
          metadata: {
            [PROFILE_PIN_KEY]: sessionProfilePin,
            [DIRECT_ATTEMPT_PIN_KEY]: attemptID,
            [DIRECT_SCOPE_PIN_KEY]: scopeDigest,
            horizonSubagentDelivery: deliveryEnvelope,
          },
        })
      }).pipe(
        Effect.provideService(TrustedPrincipalContext, { principal: trustedPrincipal }),
        Effect.catchCause((cause) => cancelAttempt().pipe(Effect.andThen(Effect.failCause(cause)))),
      )
      if (session) {
        const existingPermission = session.permission ?? []
        const resumedRestrictions = childSessionPermission.filter(
          (rule) =>
            rule.action !== "allow" &&
            !existingPermission.some(
              (existing) =>
                existing.permission === rule.permission &&
                existing.pattern === rule.pattern &&
                existing.action === rule.action,
            ),
        )
        yield* sessions
          .setPermission({
            sessionID: session.id,
            permission: [...existingPermission, ...resumedRestrictions],
          })
          .pipe(Effect.catchCause((cause) => cancelAttempt().pipe(Effect.andThen(Effect.failCause(cause)))))
        yield* sessions
          .setMetadata({
            sessionID: session.id,
            metadata: {
              ...(session.metadata ?? {}),
              [PROFILE_PIN_KEY]: sessionProfilePin,
              [DIRECT_ATTEMPT_PIN_KEY]: attemptID,
              [DIRECT_SCOPE_PIN_KEY]: scopeDigest,
              horizonSubagentDelivery: deliveryEnvelope,
            },
          })
          .pipe(Effect.catchCause((cause) => cancelAttempt().pipe(Effect.andThen(Effect.failCause(cause)))))
      }
      const metadata = {
        parentSessionId: ctx.sessionID,
        sessionId: nextSession.id,
        agent: next.name,
        profileID: profileDefinition.profileId,
        profileRevision: String(profileDefinition.revision),
        model,
        attemptID,
        attemptScopeDigest: scopeDigest,
        background: runInBackground,
        jobId: undefined as string | undefined,
        attemptReceipt: undefined as string | undefined,
      }
      let directTurnAuthority: DirectTurnAuthority | undefined
      let directTurnCompletionUncertain = false

      // Session creation persists the lineage before the initial prompt starts.
      // Keep the envelope QUEUED until prompt dispatch begins, then distinguish
      // a proven pre-dispatch failure (EXPIRED) from an ambiguous dispatched
      // prompt (UNKNOWN). The transcript is retained in both cases.
      let inboxClaimed: DirectSubagentInboxRowV1[] = []
      const settleClaimedInbox = Effect.fn("TaskTool.settleClaimedInbox")(function* (state: "consumed" | "unknown" | "committed") {
        for (const row of inboxClaimed) {
          yield* sessions.directInboxTransition({
            messageID: row.message_id,
            expected: ["delivering"],
            state,
            deliveryAttemptID: row.delivery_attempt_id,
            deliveryOwnerEpoch: row.delivery_owner_epoch,
          } as DirectInboxTransitionWithDelivery)
        }
      })
      const acknowledgeInboxRow = Effect.fn("TaskTool.acknowledgeInboxRow")(function* (
        row: DirectSubagentInboxRowV1,
        currentConsumer: typeof directAttemptScope,
      ) {
        const promptMessageID = row.delivery_prompt_message_id
        const consumingAttemptID = row.delivery_attempt_id
        const consumingOwnerEpoch = row.delivery_owner_epoch
        const consumingDigest = row.delivery_scope_digest
        const storedAckDigest = row.consumption_ack_digest
        const inboxReceipt = row.inbox_receipt_digest
        if (typeof promptMessageID !== "string" || typeof consumingAttemptID !== "string" ||
          typeof consumingOwnerEpoch !== "string" || typeof consumingDigest !== "string" ||
          typeof storedAckDigest !== "string" || typeof inboxReceipt !== "string") return
        const proof: DirectInboxConsumptionProofV1 = {
          messageID: row.message_id,
          parentSessionID: row.parent_session_id,
          childSessionID: row.child_session_id,
          mailboxSequence: row.mailbox_sequence,
          inboxReceiptDigest: inboxReceipt,
          promptMessageID,
          consumingAttemptID,
          consumingOwnerEpoch,
          consumingScopeDigest: consumingDigest,
          consumedPayloadDigest: row.payload_digest,
        }
        if (consumptionAckDigest(proof) !== storedAckDigest || consumingOwnerEpoch !== currentConsumer.ownerEpoch ||
          row.profile_id !== currentConsumer.profileID || row.profile_revision !== currentConsumer.profileRevision ||
          row.profile_digest !== currentConsumer.profileDigest || row.permission_scope_digest !== currentConsumer.permissionsDigest ||
          row.child_session_id !== currentConsumer.childSessionID || row.delivery_workspace_id !== currentConsumer.workspaceID) return
        const authorityPins = {
          parentSessionID: row.parent_session_id,
          childSessionID: row.child_session_id,
          childOwnerEpoch: row.child_owner_epoch,
          profileID: row.profile_id,
          profileRevision: row.profile_revision,
          profileDigest: row.profile_digest,
          permissionScopeDigest: row.permission_scope_digest,
          directAttemptID: row.child_attempt_id,
          messageID: row.message_id,
          deliveryMode: row.delivery_mode === "follow_up" ? "follow_up" : "queue",
          payloadDigest: row.payload_digest,
          payloadBytes: row.payload_bytes,
          mailboxSequence: row.mailbox_sequence,
          mailboxCapacity: row.mailbox_capacity,
        }
        const consumption = {
          promptMessageID,
          consumingAttemptID,
          consumingOwnerEpoch,
          consumingScopeDigest: consumingDigest,
          consumedPayloadDigest: row.payload_digest,
        }
        const currentConsumerWire = {
          attemptID: currentConsumer.attemptID,
          parentSessionID: currentConsumer.parentSessionID,
          childSessionID: currentConsumer.childSessionID,
          ownerEpoch: BigInt(currentConsumer.ownerEpoch),
          expectedRevision: BigInt(currentConsumer.expectedRevision),
          profileID: currentConsumer.profileID,
          profileRevision: currentConsumer.profileRevision,
          profileDigest: currentConsumer.profileDigest,
          locationID: currentConsumer.locationID,
          workspaceID: currentConsumer.workspaceID,
          workspaceRevision: currentConsumer.workspaceRevision,
          capabilityDigest: currentConsumer.capabilityDigest,
          permissionsDigest: currentConsumer.permissionsDigest,
          budgetDigest: currentConsumer.budgetDigest,
          scopeDigest: currentConsumer.scopeDigest,
        }
        const response = yield* supervisor.requestHostKernel("direct.message.v1", "acknowledge_consumed", {
          authorityPins,
          inboxReceiptDigest: inboxReceipt,
          consumption,
          consumptionAckDigest: storedAckDigest,
          currentConsumer: currentConsumerWire,
        }, {
          deliveryID: `direct_message_consume_${createHash("sha256").update(JSON.stringify({
            messageID: row.message_id,
            consumptionAckDigest: storedAckDigest,
            currentAttemptID: currentConsumer.attemptID,
            expectedRevision: currentConsumer.expectedRevision,
            workspaceRevision: currentConsumer.workspaceRevision,
          })).digest("hex")}`,
        }).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
        if (!response || typeof response !== "object" || Array.isArray(response)) return
        const receipt = response as Record<string, unknown>
        if (Object.keys(receipt).toSorted().join("\0") !== ["status", "messageID", "mailboxSequence", "consumptionReceiptDigest"].toSorted().join("\0") ||
          receipt.status !== "CONSUMED" || receipt.messageID !== row.message_id || receipt.mailboxSequence !== row.mailbox_sequence ||
          typeof receipt.consumptionReceiptDigest !== "string" || !/^blake3:[0-9a-f]{64}$/.test(receipt.consumptionReceiptDigest)) return
        yield* sessions.directInboxMarkHostConsumed({
          messageID: row.message_id,
          consumptionAckDigest: storedAckDigest,
          hostConsumedAckDigest: receipt.consumptionReceiptDigest,
        }).pipe(Effect.catchCause(() => Effect.void))
      })
      const updateDeliveryAck = Effect.fn("TaskTool.updateDeliveryAck")(function* (
        ackState: SubagentDeliveryV1.SubagentDeliveryV1["ackState"],
      ) {
        const currentChild = yield* sessions.get(nextSession.id)
        if (!sameDirectDelivery(currentChild.metadata?.horizonSubagentDelivery, deliveryEnvelope)) return
        yield* sessions.setMetadata({
          sessionID: nextSession.id,
          metadata: {
            ...(currentChild.metadata ?? {}),
            horizonSubagentDelivery: { ...deliveryEnvelope, ackState },
          },
        })
      })

      yield* ctx.metadata({
        title: params.description,
        metadata,
      }).pipe(Effect.catchCause((cause) =>
        Effect.gen(function* () {
          if (!session) yield* updateDeliveryAck("expired").pipe(Effect.ignore)
          yield* cancelAttempt()
          return yield* Effect.failCause(cause)
        }),
      ))

      const ops = ctx.extra?.promptOps as TaskPromptOps
      if (!ops) {
        if (!session) yield* updateDeliveryAck("expired").pipe(Effect.ignore)
        yield* cancelAttempt()
        return yield* Effect.fail(new Error("TaskTool requires promptOps in ctx.extra"))
      }

      const runTask = Effect.fn("TaskTool.runTask")(function* () {
        let parts = yield* ops.resolvePromptParts(params.prompt)
        const currentChild = yield* sessions.get(nextSession.id)
        const delivery = Schema.decodeUnknownSync(SubagentDeliveryV1.SubagentDeliveryV1, { onExcessProperty: "error" })(
          currentChild.metadata?.horizonSubagentDelivery,
        )
        const currentProfile = directProfilePin(currentChild.metadata)
        const currentAttemptID = currentChild.metadata?.[DIRECT_ATTEMPT_PIN_KEY]
        if (delivery?.lane === "direct_session" && currentProfile && typeof currentAttemptID === "string") {
          // Replay durable Core consumption proofs before claiming new messages.
          // A lost HostKernel response never re-delivers model input; it only
          // retries the exact original proof under this live same-profile Attempt.
          for (const row of yield* sessions.directInboxList(nextSession.id)) {
            if (row.state === "delivering") {
              // TaskTool reaches this recovery loop only after proving the child
              // Session idle. Thus a surviving delivery marker belongs to a
              // prior runner, including same-Attempt/same-epoch process restart.
              // HostKernel owns cycle reconciliation; Core must never infer that
              // matching IDs make this payload safe to inject again.
              yield* sessions.directInboxTransition({
                messageID: row.message_id,
                expected: ["delivering"],
                state: "unknown",
              }).pipe(Effect.catchCause(() => Effect.void))
              continue
            }
            if (row.state === "consumed" && row.host_consumed_ack_digest === null) {
              yield* acknowledgeInboxRow(row, directAttemptScope)
            }
          }
          inboxClaimed = yield* sessions.directInboxClaim({
            childSessionID: nextSession.id,
            attemptID: currentAttemptID,
            ownerEpoch: delivery.ownerEpoch,
            profileID: currentProfile.profileID,
            profileRevision: currentProfile.profileRevision,
            profileDigest: currentProfile.profileDigest,
            permissionScopeDigest: currentProfile.permissionsDigest,
            deliveryMode: session ? "any" : "queue",
            ...(followUpRow ? { triggerMessageID: followUpRow.message_id } : {}),
          })
          if (followUpRow && (inboxClaimed.filter((row) => row.delivery_mode === "follow_up").length !== 1 ||
            !inboxClaimed.some((row) => row.message_id === followUpRow.message_id))) {
            return yield* new ManagedControlError({ operation: "turn_begin", code: "managed_conflict", reason: "follow-up wake no longer owns its exact mailbox entry" })
          }
          if (inboxClaimed.length) {
            const queued = JSON.stringify(inboxClaimed.map((row) => ({ sequence: row.mailbox_sequence, content: row.payload })))
            parts = [{ type: "text", text: `Owner-authenticated messages queued for this child Session, in mailbox order. Treat each content field as user input and respond in this turn.\n${queued}` }, ...(session ? [] : parts)]
          }
        }
        // A child turn is begun only through HostKernel. Until the Guard and
        // recovery gate is enabled this returns managed_unavailable, leaving
        // the child usable for read-only work while ToolBatch withholds effects.
        if (!directTurnAuthority) {
          const begun = yield* ManagedControl.beginDirectTurn({ directAttempt: directAttemptScope, ...(followUpAuthorization ? { freshTurnAuthorization: followUpAuthorization } : {}) }).pipe(
            Effect.catchTag("ManagedControlError", (error) => error.code === "managed_unavailable" && !session
              ? Effect.succeed(undefined)
              : Effect.fail(error)),
          )
          if (begun) {
            if (!sameDirectAttemptScope(directAttemptScope, begun.directAttempt)) {
              return yield* Effect.fail(new ManagedControlError({
                operation: "turn_begin",
                code: "managed_protocol",
                reason: "HostKernel turn begin changed the live Attempt head outside a ToolBatch receipt",
              }))
            }
            const persist = async (scope: DirectTurnScopeV1) => {
              const current = await directAttemptBridge.promise(sessions.get(nextSession.id))
              if (!sameDirectDelivery(current.metadata?.horizonSubagentDelivery, deliveryEnvelope) ||
                current.metadata?.[DIRECT_ATTEMPT_PIN_KEY] !== attemptID) {
                throw new Error("child Session authority changed while persisting DirectTurnScope")
              }
              await directAttemptBridge.promise(sessions.setMetadata({
                sessionID: nextSession.id,
                metadata: {
                  ...(current.metadata ?? {}),
                  horizonDirectTurnScope: scope,
                  horizonDirectAttemptScope: scope.directAttempt,
                },
              }))
            }
            yield* Effect.promise(() => persist(begun))
            directTurnAuthority = ManagedControl.createDirectTurnAuthority(begun, persist)
          }
        }
        const consumptionScope = directAttemptScope
        initialPromptDispatched = true
        const result = yield* ops.prompt({
          messageID: childMessageID,
          sessionID: nextSession.id,
          model: {
            modelID: model.modelID,
            providerID: model.providerID,
          },
          variant: undefined,
          agent: next.name,
          parts,
        }, directAttemptAuthority, undefined, directTurnAuthority)
          .pipe(
            Effect.catchCause((cause) =>
              settleClaimedInbox("unknown").pipe(
                Effect.catchCause(() => Effect.void),
                Effect.andThen(updateDeliveryAck("unknown")),
              ).pipe(
                Effect.catchCause(() => Effect.void),
                Effect.andThen(Effect.failCause(cause)),
              ),
            ),
          )
        // Acknowledgment is durable only after the child prompt returns.
        // Preserve all envelope pins and fail closed if another owner changed
        // this delivery while it was in flight.
        const completedChild = yield* sessions.get(nextSession.id)
        const currentDelivery = completedChild.metadata?.horizonSubagentDelivery
        if (JSON.stringify(currentDelivery) !== JSON.stringify(deliveryEnvelope)) {
          return yield* Effect.fail(new Error("SubagentDeliveryV1 changed while the child prompt was running"))
        }
        yield* sessions.setMetadata({
          sessionID: nextSession.id,
          metadata: {
            ...(completedChild.metadata ?? {}),
            horizonSubagentDelivery: { ...deliveryEnvelope, ackState: "acknowledged" },
          },
        }).pipe(
          Effect.catchCause((cause) =>
            updateDeliveryAck("unknown").pipe(
              Effect.catchCause(() => Effect.void),
              Effect.andThen(Effect.failCause(cause)),
            ),
          ),
        )
        if (inboxClaimed.length) {
          const scopeDigest = consumingScopeDigest(consumptionScope)
          const receipts = inboxClaimed.map((row) => {
            const proof: DirectInboxConsumptionProofV1 = {
              messageID: row.message_id,
              parentSessionID: row.parent_session_id,
              childSessionID: row.child_session_id,
              mailboxSequence: row.mailbox_sequence,
              inboxReceiptDigest: row.inbox_receipt_digest,
              promptMessageID: childMessageID,
              consumingAttemptID: attemptID,
              consumingOwnerEpoch: consumptionScope.ownerEpoch,
              consumingScopeDigest: scopeDigest,
              consumedPayloadDigest: row.payload_digest,
            }
            return { messageID: row.message_id, consumptionAckDigest: consumptionAckDigest(proof) }
          })
          const consumedRows = yield* sessions.directInboxConsume({
            rows: receipts,
            promptMessageID: childMessageID,
            consumingAttemptID: attemptID,
            consumingOwnerEpoch: consumptionScope.ownerEpoch,
            consumingScopeDigest: scopeDigest,
            consumingWorkspaceID: consumptionScope.workspaceID,
          })
          for (const row of consumedRows) {
            yield* acknowledgeInboxRow(row, directAttemptScope)
          }
          inboxClaimed = []
        }
        if (result.info.role === "assistant" && result.info.error) {
          const message =
            "message" in result.info.error.data && typeof result.info.error.data.message === "string"
              ? result.info.error.data.message
              : result.info.error.name
          return yield* Effect.fail(new Error(`Subagent failed (task_id: ${nextSession.id}): ${message}`))
        }
        const failed = result.parts.findLast((item) => item.type === "tool" && item.state.status === "error")
        if (failed?.type === "tool" && failed.state.status === "error") {
          return yield* Effect.fail(new Error(`Subagent failed (task_id: ${nextSession.id}): ${failed.state.error}`))
        }
        return result.parts.findLast((item) => item.type === "text")?.text ?? ""
      })

      // The authenticated Attempt is settled exactly once with the typed child
      // outcome. A successful result is only surfaced after the kernel recorded its
      // BLAKE3 receipt; if settlement fails, the tool fails closed (the child session
      // and its messages stay durable and can be resumed with task_id).
      const childRun = Effect.fn("TaskTool.childRun")(function* () {
        const wallTimeMs = profileDefinition.limits.wallTimeMs
        const timeoutMs = wallTimeMs === undefined ? undefined : Number(BigInt(wallTimeMs))
        if (timeoutMs !== undefined && !Number.isSafeInteger(timeoutMs)) {
          return yield* Effect.fail(new Error("AgentProfileV2 wall-time limit exceeds the supported timer range"))
        }
        const exit = wallTimeMs === undefined
          ? yield* runTask().pipe(Effect.exit)
          : yield* Effect.gen(function* () {
              const timed = yield* runTask().pipe(Effect.timeoutOption(timeoutMs!))
              if (Option.isNone(timed)) {
                return yield* Effect.fail(new Error(`AgentProfileV2 wall-time limit exceeded (${wallTimeMs} ms)`)).pipe(Effect.exit)
              }
              return yield* Effect.succeed(timed.value).pipe(Effect.exit)
            })
        if (Exit.isSuccess(exit)) {
          const text = exit.value
          if (directTurnAuthority) {
            // Persist the exact completion request before crossing the HostKernel
            // boundary. If the reply is lost, recovery can replay this same cycle
            // and digest; it must not start a new turn or settle the Attempt.
            const turn = directTurnAuthority.currentScope()
            const completedPayload = resultPayload("completed", text)
            const turnResultDigest = ManagedControl.resultDigest(completedPayload)
            const intent = {
              runnerCycleID: turn.runnerCycleID,
              turnSequence: turn.turnSequence,
              cycleDigest: turn.cycleDigest,
              resultDigest: turnResultDigest,
              state: "pending" as const,
            }
            const persistCompletion = async (state: typeof intent.state | "completed", receipt?: { nextTurnSequence: string; receiptDigest: string }) => {
              const current = await directAttemptBridge.promise(sessions.get(nextSession.id))
              if (current.metadata?.[DIRECT_ATTEMPT_PIN_KEY] !== attemptID ||
                !sameDirectDelivery(current.metadata?.horizonSubagentDelivery, deliveryEnvelope)) {
                throw new Error("child Session authority changed while persisting turn completion")
              }
              await directAttemptBridge.promise(sessions.setMetadata({
                sessionID: nextSession.id,
                metadata: {
                  ...(current.metadata ?? {}),
                  horizonDirectTurnScope: turn,
                  horizonDirectAttemptScope: turn.directAttempt,
                  horizonDirectTurnCompletion: {
                    ...intent,
                    state,
                    ...(receipt ? { nextTurnSequence: receipt.nextTurnSequence, receiptDigest: receipt.receiptDigest } : {}),
                  },
                },
              }))
            }
            directTurnCompletionUncertain = true
            yield* Effect.promise(() => persistCompletion("pending"))
            const completed = yield* ManagedControl.completeDirectTurn({
              directTurnScope: turn,
              resultDigest: turnResultDigest,
            })
            yield* Effect.promise(() => persistCompletion("completed", completed))
            directTurnCompletionUncertain = false
          }
          // A completed turn remains attached to its live Attempt so a distinct,
          // authenticated follow-up can consume exactly the next turn sequence.
          if (directTurnAuthority) return text
          yield* settleAttempt("succeeded", resultPayload("completed", text)).pipe(
            Effect.catchTag("ManagedControlError", (error) =>
              Effect.fail(
                new ManagedControlError({
                  operation: "task",
                  code: error.code,
                  reason: `child session ${nextSession.id} result could not be settled as attempt ${attemptID}: ${error.reason}`,
                }),
              ),
            ),
          )
          return text
        }
        if (directTurnCompletionUncertain) {
          // A completion request may have reached HostKernel. Keep the live
          // Attempt fenced for exact receipt reconciliation instead of converting
          // an ambiguous cycle into FAILED or retryable work.
          yield* settleClaimedInbox("unknown").pipe(Effect.ignore)
          yield* updateDeliveryAck("unknown").pipe(Effect.ignore)
          return yield* Effect.failCause(exit.cause)
        }
        if (Cause.hasInterrupts(exit.cause) || ctx.abort.aborted) {
          yield* settleClaimedInbox(initialPromptDispatched ? "unknown" : "committed")
          yield* updateDeliveryAck(initialPromptDispatched ? "unknown" : "expired").pipe(Effect.ignore)
          yield* cancelAttempt()
          return yield* Effect.failCause(exit.cause)
        }
        if (!initialPromptDispatched) {
          yield* settleClaimedInbox("committed")
          yield* updateDeliveryAck("expired").pipe(Effect.ignore)
        } else {
          yield* settleClaimedInbox("unknown")
        }
        const squashed = Cause.squash(exit.cause)
        const reason = squashed instanceof Error ? squashed.message : String(squashed)
        // A known child failure is recorded with its typed digest. Settlement failure
        // here is not laundered into success: the durable Attempt stays fenced and
        // recovery records UNKNOWN for it.
        yield* settleAttempt("failed", resultPayload("failed", reason)).pipe(Effect.catch(() => Effect.void))
        return yield* Effect.failCause(exit.cause)
      })

      const inject = Effect.fn("TaskTool.injectBackgroundResult")(function* (
        state: "completed" | "error",
        text: string,
      ) {
        const currentParent = yield* sessions.get(ctx.sessionID)
        yield* ops
          .prompt({
            sessionID: ctx.sessionID,
            agent: currentParent.agent ?? ctx.agent,
            variant: currentParent.model?.variant,
            parts: [
              {
                type: "text",
                synthetic: true,
                text: renderOutput({
                  sessionID: nextSession.id,
                  state,
                  summary:
                    state === "completed"
                      ? `Background task completed: ${params.description}`
                      : `Background task failed: ${params.description}`,
                  text,
                  attemptID,
                  ...(attemptReceipt ? { receiptDigest: attemptReceipt } : {}),
                }),
              },
            ],
          })
          .pipe(Effect.ignore, Effect.forkIn(scope, { startImmediately: true }))
      })

      const notify = Effect.fn("TaskTool.notifyBackgroundResult")(function* (jobID: string) {
        yield* background.wait({ id: jobID }).pipe(
          Effect.flatMap((result) => {
            if (result.info?.status === "completed") return inject("completed", result.info.output ?? "")
            if (result.info?.status === "error") return inject("error", result.info.error ?? "")
            return Effect.void
          }),
          Effect.forkIn(scope, { startImmediately: true }),
        )
      })

      const supervised = <A, E>(effect: Effect.Effect<A, E, SessionSupervisorService>) =>
        effect.pipe(Effect.provideService(SessionSupervisor.Service, supervisor),
          Effect.provideService(TrustedPrincipalContext, { principal: trustedPrincipal }))

      const extended = yield* background
        .extend({ id: nextSession.id, run: supervised(childRun()) })
        .pipe(Effect.catchCause((cause) =>
          Effect.gen(function* () {
            // A failed background extension may have crossed the executor
            // boundary; preserve UNKNOWN rather than treating it as unsent.
            yield* updateDeliveryAck("unknown").pipe(Effect.ignore)
            yield* cancelAttempt()
            return yield* Effect.failCause(cause)
          }),
        ))
      if (extended) {
        return {
          title: params.description,
          metadata: {
            ...metadata,
            background: true,
            jobId: nextSession.id,
          },
          output: renderOutput({
            sessionID: nextSession.id,
            state: "running",
            summary: "Background task updated",
            text: BACKGROUND_UPDATED,
            attemptID,
          }),
        }
      }

      const info = yield* background
        .start({
          id: nextSession.id,
          type: id,
          title: params.description,
          metadata,
          onPromote: directAttemptBridge.run(ctx.metadata({
            title: params.description,
            metadata: { ...metadata, background: true, jobId: nextSession.id },
          }).pipe(
            Effect.andThen(notify(nextSession.id)),
            Effect.catchCause((cause) =>
              background
                .cancel(nextSession.id)
                .pipe(
                  Effect.catchCause(() => Effect.void),
                  Effect.andThen(cancelAttempt()),
                  Effect.andThen(Effect.failCause(cause)),
                ),
            ),
          )),
          run: supervised(childRun()).pipe(Effect.onInterrupt(() => ops.cancel(nextSession.id))),
        })
        .pipe(Effect.catchCause((cause) =>
          Effect.gen(function* () {
            // The start operation may fail after registering its background
            // runtime. Keep delivery outcome UNKNOWN unless it can be reconciled.
            yield* updateDeliveryAck("unknown").pipe(Effect.ignore)
            yield* cancelAttempt()
            return yield* Effect.failCause(cause)
          }),
        ))

      function backgroundResult() {
        return {
          title: params.description,
          metadata: {
            ...metadata,
            background: true,
            jobId: info.id,
          },
          output: renderOutput({
            sessionID: nextSession.id,
            state: "running",
            summary: "Background task started",
            text: BACKGROUND_STARTED,
            attemptID,
          }),
        }
      }

      if (runInBackground) {
        yield* notify(info.id)
        return backgroundResult()
      }

      // Reuse the bridge captured before child/background setup. Resolving a new
      // bridge after BackgroundJob.start could fail after the child has already
      // begun running, leaving the admitted Attempt without its abort path.
      const runCancel = directAttemptBridge
      const cancel = ops.cancel(nextSession.id)

      function onAbort() {
        runCancel.fork(cancel)
      }

      return yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          ctx.abort.addEventListener("abort", onAbort)
        }),
        () =>
          Effect.gen(function* () {
            const result = yield* Effect.raceFirst(
              background.wait({ id: nextSession.id }).pipe(Effect.map((waited) => waited.info)),
              background.waitForPromotion(nextSession.id),
            )
            if (result?.metadata?.background === true) return backgroundResult()
            if (result?.status === "error") return yield* Effect.fail(new Error(result.error ?? "Task failed"))
            if (result?.status === "cancelled") return yield* Effect.fail(new Error("Task cancelled"))
            return {
              title: params.description,
              metadata: { ...metadata, attemptReceipt: attemptReceipt ?? undefined },
              output: renderOutput({
                sessionID: nextSession.id,
                state: "completed",
                text: result?.output ?? "",
                attemptID,
                ...(attemptReceipt ? { receiptDigest: attemptReceipt } : {}),
              }),
            }
          }),
        (_, exit) =>
          Effect.gen(function* () {
            if (Exit.hasInterrupts(exit)) {
              yield* Effect.all([cancel, background.cancel(nextSession.id)], { discard: true })
              yield* cancelAttempt()
            }
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                ctx.abort.removeEventListener("abort", onAbort)
              }),
            ),
          ),
      )
    })

    return {
      description: flags.experimentalBackgroundSubagents
        ? [DESCRIPTION, BACKGROUND_DESCRIPTION].join("\n\n")
        : DESCRIPTION,
      parameters: Parameters,
      jsonSchema: flags.experimentalBackgroundSubagents ? undefined : ToolJsonSchema.fromSchema(BaseParameters),
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) => {
        const effect = run(params, ctx).pipe(Effect.provideService(SessionSupervisor.Service, supervisor))
        return (ctx.trustedPrincipal ? effect.pipe(Effect.provideService(TrustedPrincipalContext, { principal: ctx.trustedPrincipal })) : effect).pipe(Effect.orDie)
      },
    }
  }),
)

/**
 * Execute only a Rust-selected managed Task. This adapter is called by the
 * managed Run coordinator, never from model supplied Task arguments. The
 * coordinator first prepares the exact child request without dispatch, then
 * admits the Attempt and consumes its one-use handoff before this function
 * permits the frozen request to reach the provider.
 */
export type ManagedTaskPromptInput = {
  readonly selection: ManagedReadyTaskSelectionV1
  readonly admission: ManagedAttemptAdmission
  readonly handoff: ManagedDispatchHandoffV1 & { readonly profileDefinition: AgentProfileV2.AgentProfileDefinitionV2 }
  readonly consumeReceipt: ManagedDispatchConsumeReceiptV1
  readonly trustedPrincipal: NonNullable<Tool.Context["trustedPrincipal"]>
  /** Exact request-1 prompt frozen before Attempt admission and pinned by HostKernel. */
  readonly preparedRequest: ManagedPreparedRequestV1
  readonly promptOps: TaskPromptOps
  /** Injected only by the authenticated managed-run coordinator. */
  readonly managedFollowUpRunner?: SessionPrompt.ManagedFollowUpRunnerV1
  readonly managedPreDispatchRecovery?: SessionPrompt.ManagedPreDispatchRecoveryV1
}

export type ManagedTaskPromptResult = {
  readonly childSessionID: SessionID
  readonly outputDigest: string
  readonly outputBytes: number
  readonly outcomeKind: "assistant_completed" | "assistant_error" | "tool_error"
  readonly completion: import("@/session/session").ManagedChildSessionCompletionProjectionV1
  readonly quiesced: import("@/session/managed-control").ManagedDispatchQuiescedReceiptV1
}

const MAX_MANAGED_CHILD_OUTPUT_BYTES = 8 * 1024 * 1024

/** Cross-check Rust's effective budget against the exact Core Config profile before prompting. */
export function managedTaskTokenBudget(input: {
  readonly effectiveMaxTokens: string
  readonly remainingTokens: string
  readonly profileTokenBudget?: string
}): { readonly effectiveMaxTokens: string; readonly remainingTokens: string } {
  const canonical = (value: string) => /^(0|[1-9][0-9]{0,19})$/.test(value) &&
    BigInt(value) <= 18_446_744_073_709_551_615n
  if (!canonical(input.effectiveMaxTokens) || !canonical(input.remainingTokens) ||
    BigInt(input.effectiveMaxTokens) < 1n || BigInt(input.remainingTokens) < 1n ||
    BigInt(input.remainingTokens) > BigInt(input.effectiveMaxTokens) ||
    (input.profileTokenBudget !== undefined &&
      (!canonical(input.profileTokenBudget) || BigInt(input.profileTokenBudget) < 1n ||
        BigInt(input.effectiveMaxTokens) > BigInt(input.profileTokenBudget)))) {
    throw new RangeError("managed Task token ceiling is missing, exhausted, or differs from its pinned profile")
  }
  return { effectiveMaxTokens: input.effectiveMaxTokens, remainingTokens: input.remainingTokens }
}

export function managedTaskSelectionPinsMatch(input: {
  readonly selection: Pick<ManagedReadyTaskSelectionV1, "goalID" | "runID" | "specDigest">
  readonly task: NonNullable<ManagedReadyTaskSelectionV1["task"]>
  readonly handoff: ManagedDispatchHandoffV1 & { readonly profileDefinition: AgentProfileV2.AgentProfileDefinitionV2 }
}): boolean {
  return input.selection.goalID === input.handoff.goalID &&
    input.selection.runID === input.handoff.runID &&
    input.selection.specDigest === input.handoff.acceptedSpecDigest &&
    input.task.taskID === input.handoff.taskID &&
    input.task.profile.profileID === input.handoff.profileID &&
    input.task.profile.revision === input.handoff.profileRevision &&
    input.task.profile.definitionDigest === input.handoff.profileDigest &&
    input.handoff.profileDefinition.profileId === input.task.profile.profileID &&
    String(input.handoff.profileDefinition.revision) === input.task.profile.revision
}

function boundedManagedOutput(value: string): { readonly text: string; readonly bytes: number; readonly truncated: boolean } {
  const source = Buffer.from(value, "utf8")
  if (source.byteLength <= MAX_MANAGED_CHILD_OUTPUT_BYTES) {
    return { text: value, bytes: source.byteLength, truncated: false }
  }
  const decoder = new TextDecoder("utf-8", { fatal: true })
  for (let length = MAX_MANAGED_CHILD_OUTPUT_BYTES; length >= MAX_MANAGED_CHILD_OUTPUT_BYTES - 4; length--) {
    try {
      return { text: decoder.decode(source.subarray(0, length)), bytes: length, truncated: true }
    } catch {
      // Drop only an incomplete trailing UTF-8 sequence at the byte cap.
    }
  }
  return { text: "", bytes: 0, truncated: true }
}

/** Build the canonical managed lane envelope from trusted Rust handoff pins. */
function managedDeliveryEnvelope(input: {
  readonly handoff: ManagedDispatchHandoffV1
  readonly payload: string
  readonly messageID: string
  readonly deliveryID: string
}): SubagentDeliveryV1.SubagentDeliveryV1 {
  const { handoff } = input
  const leaseExpiry = BigInt(handoff.leaseExpiresAtMs)
  if (leaseExpiry > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError("managed handoff expiry is outside the Core timestamp range")
  }
  const authority: SubagentDeliveryV1.ManagedAttemptAuthorityV1 = {
    delegationBindingDigest: handoff.bindingDigest as SubagentDeliveryV1.ManagedAttemptAuthorityV1["delegationBindingDigest"],
    goalId: handoff.goalID,
    runId: handoff.runID,
    taskId: handoff.taskID,
    attemptId: handoff.attemptID,
  }
  const authorityDigest = SubagentDeliveryV1.authorityDigest({
    lane: "managed_attempt",
    parentExecutionId: handoff.parentSessionID,
    childExecutionId: handoff.sessionID,
    ownerEpoch: handoff.ownerEpoch,
    authority,
  })
  const payloadDigest = `sha256:${createHash("sha256").update(input.payload, "utf8").digest("hex")}`
  return Schema.decodeUnknownSync(SubagentDeliveryV1.SubagentDeliveryV1, { onExcessProperty: "error" })({
    schemaVersion: 1,
    lane: "managed_attempt",
    deliveryId: input.deliveryID,
    requestId: `managed-task-${handoff.attemptID}`,
    parentExecutionId: handoff.parentSessionID,
    childExecutionId: handoff.sessionID,
    messageId: input.messageID,
    payloadRef: `session:${handoff.sessionID}/message:${input.messageID}`,
    payloadDigest,
    kind: "task",
    ackState: "delivered",
    ownerEpoch: handoff.ownerEpoch,
    sequence: "1",
    expiresAt: new Date(Number(leaseExpiry)).toISOString(),
    authorityDigest,
    authority,
  })
}

/** Build one persisted direct-lane delivery bound to the admitted profile scope. */
function directDeliveryEnvelope(input: {
  readonly scope: ManagedControl.DirectAttemptScopeV1
  readonly messageID: string
  readonly payload: string
  readonly sequence: string
  readonly expiresAt: number
}): SubagentDeliveryV1.SubagentDeliveryV1 {
  const scope = input.scope
  const authority: SubagentDeliveryV1.DirectSessionAuthorityV1 = {
    parentSessionId: scope.parentSessionID,
    childSessionId: scope.childSessionID,
    profileId: scope.profileID,
    profileRevision: scope.profileRevision,
    profileDigest: scope.profileDigest as SubagentDeliveryV1.DirectSessionAuthorityV1["profileDigest"],
    permissionScopeDigest: scope.permissionsDigest as SubagentDeliveryV1.DirectSessionAuthorityV1["permissionScopeDigest"],
  }
  const authorityDigest = SubagentDeliveryV1.authorityDigest({
    lane: "direct_session",
    parentExecutionId: scope.parentSessionID,
    childExecutionId: scope.childSessionID,
    ownerEpoch: scope.ownerEpoch,
    authority,
  })
  return Schema.decodeUnknownSync(SubagentDeliveryV1.SubagentDeliveryV1, { onExcessProperty: "error" })({
    schemaVersion: 1,
    lane: "direct_session",
    deliveryId: `subagent_${scope.attemptID}`,
    requestId: `task_${scope.attemptID}`,
    parentExecutionId: scope.parentSessionID,
    childExecutionId: scope.childSessionID,
    messageId: input.messageID,
    payloadRef: `session:${scope.childSessionID}/message:${input.messageID}`,
    payloadDigest: `sha256:${createHash("sha256").update(input.payload, "utf8").digest("hex")}`,
    kind: "task",
    ackState: "queued",
    ownerEpoch: scope.ownerEpoch,
    sequence: input.sequence,
    expiresAt: new Date(input.expiresAt).toISOString(),
    authorityDigest,
    authority,
  })
}

function directDeliverySequence(session: Session.Info | undefined, scope: ManagedControl.DirectAttemptScopeV1): string {
  const prior = session?.metadata?.horizonSubagentDelivery
  if (prior === undefined) {
    if (session) throw new Error("resuming a direct child without its persisted SubagentDeliveryV1 sequence is unavailable")
    return "1"
  }
  const value = Schema.decodeUnknownSync(SubagentDeliveryV1.SubagentDeliveryV1, { onExcessProperty: "error" })(prior)
  if (!("parentSessionId" in value.authority)) throw new Error("resumed direct child has a managed delivery envelope")
  if (value.ackState !== "acknowledged") throw new Error("resumed direct child has an unacknowledged delivery; replay is unavailable")
  const authority = value.authority
  if (value.lane !== "direct_session" || !SubagentDeliveryV1.validateAuthorityLane(value) ||
    value.parentExecutionId !== scope.parentSessionID || value.childExecutionId !== scope.childSessionID ||
    authority.parentSessionId !== scope.parentSessionID || authority.childSessionId !== scope.childSessionID ||
    authority.profileId !== scope.profileID || authority.profileRevision !== scope.profileRevision ||
    authority.profileDigest !== scope.profileDigest || authority.permissionScopeDigest !== scope.permissionsDigest ||
    value.authorityDigest !== SubagentDeliveryV1.authorityDigest({
      lane: "direct_session", parentExecutionId: value.parentExecutionId,
      childExecutionId: value.childExecutionId, ownerEpoch: value.ownerEpoch, authority,
    })) throw new Error("resumed direct child delivery no longer matches its immutable profile or permission scope")
  const sequence = BigInt(value.sequence) + 1n
  if (sequence > 18_446_744_073_709_551_615n) throw new Error("direct child delivery sequence is exhausted")
  return sequence.toString()
}

function managedDeliveryEnvelopeMatches(raw: unknown, pins: {
  readonly parentSessionID: string
  readonly sessionID: string
  readonly ownerEpoch: string
  readonly bindingDigest: string
  readonly goalID: string
  readonly runID: string
  readonly taskID: string
  readonly attemptID: string
}, deliveryID: string): boolean {
  try {
    const envelope = Schema.decodeUnknownSync(SubagentDeliveryV1.SubagentDeliveryV1, { onExcessProperty: "error" })(raw)
    return envelope.lane === "managed_attempt" &&
      envelope.ackState === "acknowledged" &&
      envelope.deliveryId === deliveryID &&
      envelope.parentExecutionId === pins.parentSessionID &&
      envelope.childExecutionId === pins.sessionID &&
      envelope.ownerEpoch === pins.ownerEpoch &&
      envelope.authorityDigest === SubagentDeliveryV1.authorityDigest({
        lane: "managed_attempt",
        parentExecutionId: pins.parentSessionID,
        childExecutionId: pins.sessionID,
        ownerEpoch: pins.ownerEpoch,
        authority: envelope.authority as SubagentDeliveryV1.ManagedAttemptAuthorityV1,
      }) &&
      SubagentDeliveryV1.validateAuthorityLane(envelope) &&
      "delegationBindingDigest" in envelope.authority &&
      envelope.authority.delegationBindingDigest === pins.bindingDigest &&
      envelope.authority.goalId === pins.goalID &&
      envelope.authority.runId === pins.runID &&
      envelope.authority.taskId === pins.taskID &&
      envelope.authority.attemptId === pins.attemptID
  } catch {
    return false
  }
}

export const runManagedTaskPrompt = Effect.fn("TaskTool.runManagedTaskPrompt")(function* (input: ManagedTaskPromptInput) {
  const task = input.selection.task
  const { handoff, admission } = input
  if (!task || input.selection.status !== "READY_TASK" ||
    input.trustedPrincipal.kind !== "server_auth" ||
    !managedTaskSelectionPinsMatch({ selection: input.selection, task, handoff }) ||
    task.taskID !== handoff.taskID || task.taskID !== admission.taskID ||
    handoff.goalID !== input.selection.goalID || handoff.runID !== input.selection.runID ||
    handoff.parentSessionID !== input.selection.sessionID || handoff.sessionID !== admission.sessionID ||
    handoff.sessionID !== ManagedControl.managedTaskSessionID(task.candidateAttemptID) ||
    handoff.attemptID !== admission.attemptID || handoff.profileID !== task.profile.profileID ||
    handoff.profileRevision !== task.profile.revision || handoff.profileDigest !== task.profile.definitionDigest ||
    admission.profile.profileID !== task.profile.profileID || admission.profile.profileRevision !== task.profile.revision ||
    admission.profile.profileDigest !== task.profile.definitionDigest ||
    input.consumeReceipt.status !== "CONSUMED" || input.consumeReceipt.goalID !== handoff.goalID ||
    input.consumeReceipt.runID !== handoff.runID || input.consumeReceipt.taskID !== handoff.taskID ||
    input.consumeReceipt.sessionID !== handoff.sessionID || input.consumeReceipt.attemptID !== handoff.attemptID ||
    input.consumeReceipt.handoffDigest !== handoff.handoffDigest ||
    input.consumeReceipt.bindingDigest !== handoff.bindingDigest) {
    return yield* new ManagedControlError({ operation: "task", code: "managed_protocol", reason: "managed Task prompt inputs do not match the exact Rust READY_TASK, Attempt, handoff and consume receipt" })
  }
  const managedProviderContext: ManagedProviderContextV1 = {
    ...input.preparedRequest.context,
    contextSelectionDigest: admission.managedAttempt.contextSelectionDigest,
    initialSelection: input.preparedRequest.contextSelection,
    initialProviderInput: input.preparedRequest.providerInput,
  }
  if (managedProviderContext.attemptID !== handoff.attemptID ||
    managedProviderContext.taskID !== task.taskID ||
    managedProviderContext.taskRevision !== task.taskRevision ||
    managedProviderContext.taskContextDigest !== task.contextDigest ||
    managedProviderContext.specID !== input.selection.specID ||
    managedProviderContext.specDigest !== input.selection.specDigest ||
    managedProviderContext.profileID !== task.profile.profileID ||
    managedProviderContext.profileRevision !== task.profile.revision ||
    managedProviderContext.profileDigest !== task.profile.definitionDigest ||
    managedProviderContext.contextSelectionDigest !== admission.managedAttempt.contextSelectionDigest ||
    managedProviderContext.selectionSessionID !== handoff.sessionID ||
    managedProviderContext.requestSequence !== "1" ||
    managedProviderContext.requestID !== `req_managed_${task.candidateAttemptID}_1` ||
    input.preparedRequest.contextSelection.sessionID !== handoff.sessionID ||
    input.preparedRequest.contextSelection.attemptID !== handoff.attemptID ||
    input.preparedRequest.contextSelection.requestID !== managedProviderContext.requestID ||
    input.preparedRequest.contextSelection.requestSequence !== "1") {
    return yield* new ManagedControlError({ operation: "task", code: "managed_conflict", reason: "pre-admitted ContextSelection does not match the exact Rust Task, Spec, profile and child Session pins" })
  }
  if (JSON.stringify(input.consumeReceipt.worktreeTarget) !== JSON.stringify(handoff.worktreeTarget) ||
    JSON.stringify(admission.managedAttempt.worktreeTarget) !== JSON.stringify(handoff.worktreeTarget)) {
    return yield* new ManagedControlError({ operation: "task", code: "managed_protocol", reason: "managed Task admission, handoff and consume receipt do not share one exact P8 worktree target" })
  }
  if (!handoff.profileDefinition.enabled || !handoff.profileDefinition.roles.includes("subagent")) {
    return yield* new ManagedControlError({ operation: "task", code: "agent_profile_stale", reason: "managed Task AgentProfile does not match its immutable Rust pin" })
  }
  try {
    const budget = managedTaskTokenBudget({
      effectiveMaxTokens: task.effectiveMaxTokens,
      remainingTokens: task.remainingTokens,
      profileTokenBudget: handoff.profileDefinition.limits.tokenBudget,
    })
    if (admission.managedAttempt.effectiveMaxTokens !== budget.effectiveMaxTokens ||
      admission.managedAttempt.remainingTokens !== budget.remainingTokens) {
      throw new RangeError("admitted HostKernel scope differs from the selected Task token budget")
    }
  } catch {
    return yield* new ManagedControlError({ operation: "task", code: "managed_conflict", reason: "managed Task token budget does not match the pinned AgentProfileV2" })
  }

  const sessions = yield* Session.Service
  const agent = yield* Agent.Service
  const provider = yield* Provider.Service
  const root = yield* sessions.get(SessionID.make(handoff.parentSessionID))
  if (root.parentID || root.workspaceID !== input.selection.workspaceRef ||
    root.metadata?.horizonManagedRoot === undefined ||
    typeof root.metadata.horizonManagedRoot !== "object" || root.metadata.horizonManagedRoot === null ||
    root.metadata.horizonManagedRoot.goalID !== handoff.goalID ||
    root.metadata.horizonManagedRoot.runID !== handoff.runID) {
    return yield* new ManagedControlError({ operation: "task", code: "managed_conflict", reason: "managed Task root Session is not durably bound to the selected Run" })
  }
  const target = handoff.worktreeTarget
  if (target.worktreeID !== handoff.worktreeID || target.worktreeBaseRevision !== handoff.worktreeBaseRevision ||
    target.worktreePoolRevision !== handoff.worktreePoolRevision || target.locationID !== handoff.locationID ||
    target.workspaceRevision !== handoff.workspaceRevision || target.workspaceRef !== input.selection.workspaceRef) {
    return yield* new ManagedControlError({ operation: "task", code: "managed_protocol", reason: "managed Task handoff target differs from its P8 worktree and accepted workspace pins" })
  }
  const supervisor = yield* SessionSupervisorService
  const targetWorkspaceID = WorkspaceV2.ID.make(target.workspaceID)
  const targetDirectory = AbsolutePath.make(target.canonicalRoot)
  const targetLocation = Location.Ref.make({ directory: targetDirectory, workspaceID: targetWorkspaceID })
  const registeredLocationID = yield* supervisor.registerHostLocation(targetLocation).pipe(
    Effect.provideService(TrustedPrincipalContext, { principal: input.trustedPrincipal }),
    Effect.mapError((error) => new ManagedControlError({ operation: "task", code: "managed_unavailable", reason: `P8 worktree Location could not be registered: ${error.message}` })),
  )
  if (registeredLocationID !== target.locationID) {
    return yield* new ManagedControlError({ operation: "task", code: "managed_conflict", reason: "Core registered a different Location than HostKernel's P8 worktree target" })
  }
  const rootInstance = yield* InstanceState.context
  const targetInstance = { ...rootInstance, directory: targetDirectory }

  const childID = SessionID.make(handoff.sessionID)
  const managedLineage = {
    schemaVersion: 1,
    goalID: handoff.goalID,
    runID: handoff.runID,
    taskID: handoff.taskID,
    attemptID: handoff.attemptID,
    ownerEpoch: handoff.ownerEpoch,
    handoffID: handoff.handoffID,
    handoffDigest: handoff.handoffDigest,
    bindingDigest: handoff.bindingDigest,
  }
  const existing = yield* sessions.get(childID).pipe(
    Effect.map(Option.some),
    Effect.catchTag("NotFoundError", () => Effect.succeed(Option.none())),
  )
  let child: Session.Info
  if (Option.isSome(existing)) {
    child = existing.value
    const lineage = child.metadata?.horizonManagedAttempt
    const delivery = child.metadata?.horizonManagedDelivery
    const subagentDelivery = child.metadata?.horizonSubagentDelivery
    const storedWorktreeTarget = child.metadata?.horizonManagedWorktreeTarget
    if (child.parentID !== root.id || typeof lineage !== "object" || lineage === null ||
      Object.keys(managedLineage).some((key) => (lineage as Record<string, unknown>)[key] !== (managedLineage as Record<string, unknown>)[key]) ||
      typeof delivery !== "object" || delivery === null || delivery.handoffDigest !== handoff.handoffDigest ||
      delivery.consumeReceiptDigest !== input.consumeReceipt.receiptDigest ||
      typeof delivery.completionDeliveryID !== "string" ||
      child.workspaceID !== target.workspaceID ||
      JSON.stringify(storedWorktreeTarget) !== JSON.stringify(target) ||
      !managedDeliveryEnvelopeMatches(subagentDelivery, handoff, delivery.completionDeliveryID)) {
      return yield* new ManagedControlError({ operation: "task", code: "managed_conflict", reason: "managed child Session already exists with a different or already-dispatched delivery; prompt replay is forbidden" })
    }
    const expectedCompletionDeliveryID = ManagedControl.managedCompletionDeliveryID(
      handoff.attemptID,
      handoff.handoffDigest,
      input.consumeReceipt.receiptDigest,
    )
    if (delivery.completionDeliveryID !== expectedCompletionDeliveryID) {
      return yield* new ManagedControlError({ operation: "task", code: "managed_conflict", reason: "managed completion delivery ID does not match its exact Attempt and receipt pins" })
    }
    if (delivery.promptState !== "RETURNED" || typeof delivery.outputDigest !== "string" ||
      !/^(sha256|blake3):[0-9a-f]{64}$/.test(delivery.outputDigest) ||
      !Number.isSafeInteger(delivery.outputBytes) || delivery.outputBytes < 0 || delivery.outputBytes > 8 * 1024 * 1024 ||
      !["assistant_completed", "assistant_error", "tool_error"].includes(String(delivery.outcomeKind))) {
      // A consumed delivery with no durable returned marker is ambiguous. Never
      // call the provider again; recovery must reconcile this same child.
      return yield* new ManagedControlError({ operation: "task", code: "managed_unavailable", reason: "managed child delivery is pending or ambiguous; reconcile its existing Session without replay" })
    }
    const completion = yield* sessions.managedChildSessionCompletion({
      sessionID: child.id,
      parentSessionID: root.id,
      goalID: handoff.goalID,
      runID: handoff.runID,
      taskID: handoff.taskID,
      attemptID: handoff.attemptID,
    })
    const quiesced = yield* ManagedControl.completeManagedDispatch({
      trustedPrincipal: input.trustedPrincipal,
      handoff,
      consumeReceipt: input.consumeReceipt,
      childSession: completion,
      deliveryID: delivery.completionDeliveryID,
    })
    const settlement = completion.childSessionOutcomeKind === "assistant_completed"
      ? undefined
      : yield* ManagedControl.settleAttempt({
          trustedPrincipal: input.trustedPrincipal,
          goalID: handoff.goalID,
          runID: handoff.runID,
          taskID: handoff.taskID,
          attemptID: handoff.attemptID,
          outcome: "failed",
          failureCode: "managed_prompt_stopped",
          retryable: false,
          expectedRevision: quiesced.managedRevision,
        })
    return {
      childSessionID: child.id,
      outputDigest: delivery.outputDigest,
      outputBytes: delivery.outputBytes,
      outcomeKind: completion.childSessionOutcomeKind,
      completion,
      quiesced,
      ...(settlement ? { settlement } : {}),
    }
  }

  const profile = handoff.profileDefinition
  const next = yield* agent.getProfile(profile.profileId, profile.revision)
  const parentAgent = yield* agent.get(root.agent ?? "build")
  const childPermission = deriveSubagentSessionPermission({
    parentAgentPermission: parentAgent.permission,
    parentSessionPermission: root.permission ?? [],
    subagent: next,
  })
  const managedToolDenies = [
    ...(next.permission.some((rule) => rule.permission === "todowrite")
      ? []
      : [{ permission: "todowrite" as const, pattern: "*" as const, action: "deny" as const }]),
    ...(next.permission.some((rule) => rule.permission === id)
      ? []
      : [{ permission: id, pattern: "*" as const, action: "deny" as const }]),
  ]
  const childPermissionRules = [
    ...childPermission,
    ...managedToolDenies.filter((deny) => !childPermission.some((rule) =>
      rule.permission === deny.permission && rule.pattern === deny.pattern && rule.action === deny.action)),
  ]
  const model = yield* provider.getModel(ProviderV2.ID.make(profile.model.providerId), ModelV2.ID.make(profile.model.modelId))
  if (!model || handoff.profileID !== profile.profileId || handoff.profileRevision !== String(profile.revision)) {
    return yield* new ManagedControlError({ operation: "task", code: "agent_profile_unavailable", reason: "pinned managed Task provider/model is unavailable" })
  }
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
  if (Buffer.byteLength(promptText, "utf8") > profile.limits.maxMessageBytes || profile.limits.maxPendingMessages < 1) {
    return yield* new ManagedControlError({ operation: "task", code: "agent_profile_limit", reason: "managed child prompt exceeds its pinned AgentProfile message limit" })
  }
  const parts = yield* input.promptOps.resolvePromptParts(promptText)
  const completionDeliveryID = ManagedControl.managedCompletionDeliveryID(
    handoff.attemptID,
    handoff.handoffDigest,
    input.consumeReceipt.receiptDigest,
  )
  const childMessageID = MessageID.ascending()
  const subagentDelivery = managedDeliveryEnvelope({
    handoff,
    payload: promptText,
    messageID: childMessageID,
    deliveryID: completionDeliveryID,
  })
  const childMetadata = {
    horizonManagedAttempt: managedLineage,
    horizonManagedWorktreeTarget: target,
    horizonManagedDelivery: {
      schemaVersion: 1,
      handoffDigest: handoff.handoffDigest,
      consumeReceiptDigest: input.consumeReceipt.receiptDigest,
      completionDeliveryID,
      promptState: "PENDING",
    },
    horizonAgentProfileV2: {
      profileID: profile.profileId,
      profileRevision: String(profile.revision),
      profileDigest: task.profile.definitionDigest,
      permissionCeilingDigest: handoff.permissionScopeDigest,
      harness: profile.harness,
    },
    horizonSubagentDelivery: subagentDelivery,
  }
  child = yield* sessions.create({
    id: childID,
    parentID: root.id,
    title: task.title,
    agent: next.name,
    model: { providerID: model.providerID, id: model.id },
    permission: childPermissionRules,
    workspaceID: targetWorkspaceID,
    metadata: childMetadata,
  }).pipe(Effect.provideService(TrustedPrincipalContext, { principal: input.trustedPrincipal }))

  const authority = ManagedControl.createManagedAttemptAuthority(admission.managedAttempt)
  const result = yield* input.promptOps.prompt({
    messageID: childMessageID,
    sessionID: child.id,
    model: { modelID: model.id, providerID: model.providerID },
    agent: next.name,
    parts,
  }, undefined, authority, undefined, managedProviderContext, input.managedFollowUpRunner, input.managedPreDispatchRecovery).pipe(
    Effect.provideService(InstanceRef, targetInstance),
    Effect.provideService(WorkspaceRef, targetWorkspaceID),
  )
  const toolError = result.parts.findLast((part) => part.type === "tool" && part.state.status === "error")
  const rawText = result.parts.findLast((part) => part.type === "text")?.text ?? ""
  const output = boundedManagedOutput(rawText)
  const outcomeKind = authority.usageStopped?.() || authority.remainingTokens() === "0"
    ? "assistant_error" as const
    : result.info.role === "assistant" && result.info.error
    ? "assistant_error" as const
    : toolError?.type === "tool" && toolError.state.status === "error"
      ? "tool_error" as const
      : output.truncated
        ? "assistant_error" as const
      : "assistant_completed" as const
  const returnedChild = yield* sessions.get(child.id)
  if (JSON.stringify(returnedChild.metadata?.horizonSubagentDelivery) !== JSON.stringify(subagentDelivery)) {
    return yield* new ManagedControlError({ operation: "task", code: "managed_conflict", reason: "managed SubagentDeliveryV1 changed while its child prompt was running" })
  }
  yield* sessions.setMetadata({
    sessionID: child.id,
    metadata: {
      ...(returnedChild.metadata ?? {}),
      horizonSubagentDelivery: { ...subagentDelivery, ackState: "acknowledged" },
      horizonManagedDelivery: {
        schemaVersion: 1,
        handoffDigest: handoff.handoffDigest,
        consumeReceiptDigest: input.consumeReceipt.receiptDigest,
        completionDeliveryID,
        promptState: "RETURNED",
        outcomeKind,
        outputDigest: ManagedControl.managedOutputDigest(output.text),
        outputBytes: output.bytes,
      },
    },
  })
  const completion = yield* sessions.managedChildSessionCompletion({
    sessionID: child.id,
    parentSessionID: root.id,
    goalID: handoff.goalID,
    runID: handoff.runID,
    taskID: handoff.taskID,
    attemptID: handoff.attemptID,
  })
  const quiesced = yield* ManagedControl.completeManagedDispatch({
    trustedPrincipal: input.trustedPrincipal,
    handoff,
    consumeReceipt: input.consumeReceipt,
    childSession: completion,
    deliveryID: completionDeliveryID,
  })
  const settlement = completion.childSessionOutcomeKind === "assistant_completed"
    ? undefined
    : yield* ManagedControl.settleAttempt({
        trustedPrincipal: input.trustedPrincipal,
        goalID: handoff.goalID,
        runID: handoff.runID,
        taskID: handoff.taskID,
        attemptID: handoff.attemptID,
        outcome: "failed",
        failureCode: "managed_prompt_stopped",
        retryable: false,
        expectedRevision: quiesced.managedRevision,
      })
  return {
    childSessionID: child.id,
    outputDigest: ManagedControl.managedOutputDigest(output.text),
    outputBytes: output.bytes,
    outcomeKind: completion.childSessionOutcomeKind,
    completion,
    quiesced,
    ...(settlement ? { settlement } : {}),
  }
})
