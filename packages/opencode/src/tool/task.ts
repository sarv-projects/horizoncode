import * as Tool from "./tool"
import DESCRIPTION from "./task.txt"
import { ToolJsonSchema } from "./json-schema"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { BackgroundJob } from "@/background/job"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { SessionID, MessageID } from "../session/schema"
import { MessageV2 } from "../session/message-v2"
import { Agent } from "../agent/agent"
import { Provider } from "@/provider/provider"
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
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap } from "@opencode-ai/core/location-services"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { TrustedPrincipalContext } from "@opencode-ai/core/trusted-principal"
import { AgentProfileService } from "@opencode-ai/core/config"
import * as AgentProfileV2 from "@opencode-ai/schema/agent-profile-v2"
import { ManagedControl, ManagedControlError } from "@/session/managed-control"
import {
  isNextDirectAttemptScope,
  isReceiptAdvancedDirectAttemptScope,
  sameDirectAttemptScope,
} from "@/session/managed-control"
import type { ManagedAttemptAuthority } from "@/session/managed-control"
import type { DirectAttemptAuthority } from "@/session/tool-batch"
import type { Image } from "@/image/image"

export interface TaskPromptOps {
  cancel(sessionID: SessionID): Effect.Effect<void>
  resolvePromptParts(template: string): Effect.Effect<SessionPrompt.PromptInput["parts"], SessionSupervisorError>
  prompt(
    input: SessionPrompt.PromptInput,
    directAttempt?: DirectAttemptAuthority,
    managedAttempt?: ManagedAttemptAuthority,
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
    profileRevision: value.profileRevision,
    profileDigest: value.profileDigest,
    permissionsDigest: value.permissionsDigest,
    harness: value.harness,
  }
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
      const locationRef = Location.Ref.make({ directory: AbsolutePath.make(instance.directory) })
      const { definitions, selectedProfile } = yield* Effect.gen(function* () {
        const profiles = yield* AgentProfileService
        const definitions = yield* profiles.agentProfiles()
        const selectedProfile = yield* profiles.agentProfileSelector(params.subagent_type)
        return { definitions, selectedProfile }
      }).pipe(
        Effect.provide(locations.get(locationRef)),
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
      const projectSessions = yield* sessions.list({ workspaceID: parent.workspaceID })
      const profileChildren = projectSessions.filter((candidate) => {
        const pin = directProfilePin(candidate.metadata)
        return candidate.parentID === parent.id && pin?.profileID === profileDefinition.profileId
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
      const attemptID = ManagedControl.newAttemptID()
      const scopeDigest = ManagedControl.scopeDigest({
        parentSessionID: ctx.sessionID,
        childSessionID: childID,
        agent: next.name,
        profileID: profileDefinition.profileId,
        profileRevision: profileDefinition.revision,
        profileHarness: profileDefinition.harness,
        profileDefinition,
        providerID: model.providerID,
        modelID: model.modelID,
        workspaceRoot: instance.worktree,
        permissionRules: effectivePermissionRules,
        deniedTools: childToolDenies.map((deny) => deny.permission),
        background: runInBackground,
        maxAttempts: 1,
        subagentDepth: cfg.subagent_depth ?? 1,
      })
      const admitted = yield* ManagedControl.admitDirectAttempt({
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
        yield* ManagedControl.cancelDirectAttempt({
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
      const cancelAttempt = Effect.fn("TaskTool.cancelAttempt")(function* () {
        if (cancellationRequested) return
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
          const valid = transition === "batch_bind"
            ? isNextDirectAttemptScope(previous, refreshed)
            : transition === "effect_receipt" && isReceiptAdvancedDirectAttemptScope(previous, refreshed)
          if (!valid) throw new Error("HostKernel returned a stale or mismatched Direct Attempt scope")
          const nextRevision = Number(refreshed.expectedRevision)
          if (!Number.isSafeInteger(nextRevision) || nextRevision < 0 || BigInt(nextRevision) !== BigInt(refreshed.expectedRevision)) {
            throw new Error("Direct Attempt revision exceeds the supported settlement range")
          }
          directAttemptScope = refreshed
          attemptRevision = nextRevision
        },
      }

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
          metadata: { [PROFILE_PIN_KEY]: sessionProfilePin },
        })
      }).pipe(
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
            metadata: { ...(session.metadata ?? {}), [PROFILE_PIN_KEY]: sessionProfilePin },
          })
          .pipe(Effect.catchCause((cause) => cancelAttempt().pipe(Effect.andThen(Effect.failCause(cause)))))
      }
      const metadata = {
        parentSessionId: ctx.sessionID,
        sessionId: nextSession.id,
        model,
        attemptID,
        attemptScopeDigest: scopeDigest,
        background: runInBackground,
        jobId: undefined as string | undefined,
        attemptReceipt: undefined as string | undefined,
      }

      yield* ctx.metadata({
        title: params.description,
        metadata,
      }).pipe(Effect.catchCause((cause) => cancelAttempt().pipe(Effect.andThen(Effect.failCause(cause)))))

      const ops = ctx.extra?.promptOps as TaskPromptOps
      if (!ops) {
        yield* cancelAttempt()
        return yield* Effect.fail(new Error("TaskTool requires promptOps in ctx.extra"))
      }

      const runTask = Effect.fn("TaskTool.runTask")(function* () {
        const parts = yield* ops.resolvePromptParts(params.prompt)
        const result = yield* ops.prompt({
          messageID: MessageID.ascending(),
          sessionID: nextSession.id,
          model: {
            modelID: model.modelID,
            providerID: model.providerID,
          },
          variant: undefined,
          agent: next.name,
          parts,
        }, directAttemptAuthority)
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
        const exit = wallTimeMs === undefined
          ? yield* runTask().pipe(Effect.exit)
          : yield* Effect.gen(function* () {
              const timed = yield* runTask().pipe(Effect.timeout(`${wallTimeMs} millis`))
              if (Option.isNone(timed)) {
                return yield* Effect.fail(new Error(`AgentProfileV2 wall-time limit exceeded (${wallTimeMs} ms)`)).pipe(Effect.exit)
              }
              return yield* Effect.succeed(timed.value).pipe(Effect.exit)
            })
        if (Exit.isSuccess(exit)) {
          const text = exit.value
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
        if (Cause.hasInterrupts(exit.cause) || ctx.abort.aborted) {
          yield* cancelAttempt()
          return yield* Effect.failCause(exit.cause)
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
            variant,
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
        effect.pipe(Effect.provideService(SessionSupervisor.Service, supervisor))

      const extended = yield* background
        .extend({ id: nextSession.id, run: supervised(childRun()) })
        .pipe(Effect.catchCause((cause) => cancelAttempt().pipe(Effect.andThen(Effect.failCause(cause)))))
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
        .pipe(Effect.catchCause((cause) => cancelAttempt().pipe(Effect.andThen(Effect.failCause(cause)))))

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
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.provideService(SessionSupervisor.Service, supervisor), Effect.orDie),
    }
  }),
)
