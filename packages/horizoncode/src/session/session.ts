import { LayerNode } from "@horizoncode/core/effect/layer-node"
import { PermissionV1 } from "@horizoncode/core/v1/permission"
import { Slug } from "@horizoncode/core/util/slug"
import { SessionV1 } from "@horizoncode/core/v1/session"
import { serviceUse } from "@horizoncode/core/effect/service-use"
import path from "path"
import { BackgroundJob } from "@/background/job"
import { Decimal } from "decimal.js"
import { createHash } from "node:crypto"
import { blake3 } from "@noble/hashes/blake3.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import type { ProviderMetadata, Usage } from "@horizoncode/llm"
import { SessionMessage as SessionMessageSchema } from "@horizoncode/schema/session-message"
import { InstallationVersion } from "@horizoncode/core/installation/version"
import { Database } from "@horizoncode/core/database/database"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionV2 } from "@horizoncode/core/session"
import { TrustedPrincipalContext } from "@horizoncode/core/trusted-principal"
import { SessionSupervisor, SessionSupervisorError, type Service as SessionSupervisorService } from "@horizoncode/core/session/supervisor"
import { SessionStatus } from "./status"
import * as SessionExecutionLocal from "@horizoncode/core/session/execution/local"
import { locationServiceMapLayer } from "@horizoncode/core/location-services"

import { NotFoundError } from "@/storage/storage"
import { eq } from "drizzle-orm"
import { and } from "drizzle-orm"
import { gte } from "drizzle-orm"
import { isNull } from "drizzle-orm"
import { desc } from "drizzle-orm"
import { like } from "drizzle-orm"
import { sql } from "drizzle-orm"
import { inArray } from "drizzle-orm"
import { lt } from "drizzle-orm"
import { or } from "drizzle-orm"
import type { SQL } from "drizzle-orm"
import { DirectSubagentInboxTable, ManagedSubagentInboxTable, PartTable, SessionTable } from "@horizoncode/core/session/sql"
import { ProjectTable, ProjectDirectoryTable } from "@horizoncode/core/project/sql"
import { AbsolutePath } from "@horizoncode/core/schema"
import { MessageV2 } from "./message-v2"
import type { InstanceContext } from "../project/instance-context"
import { InstanceState } from "@/effect/instance-state"
import { Info as FileDiffSchema } from "@horizoncode/schema/file-diff"
import { ProjectV2 } from "@horizoncode/core/project"
import { WorkspaceV2 } from "@horizoncode/core/workspace"
import { SessionID, MessageID, PartID } from "./schema"

import type { Provider } from "@/provider/provider"
import { Global } from "@horizoncode/core/global"
import { Effect, Layer, Option, Context, Schema, Types } from "effect"
import { NonNegativeInt, optional, RelativePath } from "@horizoncode/core/schema"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@horizoncode/core/provider"
import { ModelV2 } from "@horizoncode/core/model"
import { SessionMessage } from "@horizoncode/schema/session-message"
import { createPartDeltaCursorV1 } from "./part-delta-cursor"
import { DIRECT_SUBAGENT_INBOX_MAX_PENDING, DIRECT_SUBAGENT_INBOX_MAX_RECEIPTS_PER_CHILD } from "./direct-subagent-inbox"
import type { DirectSubagentInboxDraftV1, DirectSubagentInboxStateV1 } from "./direct-subagent-inbox"
import { MANAGED_SUBAGENT_INBOX_MAX_PENDING, MANAGED_SUBAGENT_INBOX_MAX_RECEIPTS_PER_ATTEMPT, managedMessageConsumptionAckDigest, managedMessageInboxReceiptDigest } from "./managed-subagent-inbox"
import type { ManagedSubagentConsumptionProofV1, ManagedSubagentInboxDraftV1, ManagedSubagentInboxStateV1 } from "./managed-subagent-inbox"

const parentTitlePrefix = "New session - "
const childTitlePrefix = "Child session - "

export type DirectSubagentInboxRowV1 = typeof DirectSubagentInboxTable.$inferSelect
export type ManagedSubagentInboxRowV1 = typeof ManagedSubagentInboxTable.$inferSelect

export function isDefaultTitle(title: string) {
  return new RegExp(
    `^(${parentTitlePrefix}|${childTitlePrefix})\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$`,
  ).test(title)
}

type SessionRow = typeof SessionTable.$inferSelect

function worktreeDirectory(directory: string, sessionPath?: string) {
  return path.resolve(directory, path.relative(sessionPath || ".", "."))
}

function revertFiles(row: SessionRow) {
  if (!row.revert) return undefined
  const worktree = worktreeDirectory(row.directory, row.path ?? undefined)
  const legacy = row.revert.files as unknown as Array<string | { path: string }> | undefined
  const files = row.revert.restoreFiles ?? legacy?.map((file) => (typeof file === "string" ? file : file.path))
  return files?.map((file) => {
    const absolute = path.resolve(worktree, file)
    const relative = path.relative(worktree, absolute)
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      throw new Error("Session revert contains a file outside its worktree")
    return absolute
  })
}

export function fromRow(row: SessionRow): Info {
  const summary =
    row.summary_additions !== null || row.summary_deletions !== null || row.summary_files !== null
      ? {
          additions: row.summary_additions ?? 0,
          deletions: row.summary_deletions ?? 0,
          files: row.summary_files ?? 0,
          diffs: row.summary_diffs ?? undefined,
        }
      : undefined
  const share = row.share_url ? { url: row.share_url } : undefined
  const revert = row.revert
    ? {
        messageID: MessageID.make(row.revert.messageID),
        partID: row.revert.partID ? PartID.make(row.revert.partID) : undefined,
        snapshot: row.revert.snapshot,
        diff: row.revert.diff,
        files: revertFiles(row),
      }
    : undefined
  return {
    id: row.id,
    slug: row.slug,
    projectID: row.project_id,
    workspaceID: row.workspace_id ?? undefined,
    directory: row.directory,
    path: row.path ?? undefined,
    parentID: row.parent_id ?? undefined,
    title: row.title,
    agent: row.agent ?? undefined,
    model: row.model
      ? {
          id: ModelV2.ID.make(row.model.id),
          providerID: ProviderV2.ID.make(row.model.providerID),
          variant: row.model.variant,
        }
      : undefined,
    version: row.version,
    summary,
    cost: row.cost,
    tokens: {
      input: row.tokens_input,
      output: row.tokens_output,
      reasoning: row.tokens_reasoning,
      cache: {
        read: row.tokens_cache_read,
        write: row.tokens_cache_write,
      },
    },
    share,
    metadata: row.metadata ?? undefined,
    revert,
    permission: row.permission ? [...row.permission] : undefined,
    time: {
      created: row.time_created,
      updated: row.time_updated,
      compacting: row.time_compacting ?? undefined,
      archived: row.time_archived ?? undefined,
    },
  }
}

export function toRow(info: Info) {
  return {
    id: info.id,
    project_id: info.projectID,
    workspace_id: info.workspaceID,
    parent_id: info.parentID,
    slug: info.slug,
    directory: info.directory,
    path: info.path,
    title: info.title,
    agent: info.agent,
    model: info.model,
    version: info.version,
    share_url: info.share?.url,
    summary_additions: info.summary?.additions,
    summary_deletions: info.summary?.deletions,
    summary_files: info.summary?.files,
    summary_diffs: info.summary?.diffs,
    metadata: info.metadata,
    cost: info.cost ?? 0,
    tokens_input: (info.tokens ?? EmptyTokens).input,
    tokens_output: (info.tokens ?? EmptyTokens).output,
    tokens_reasoning: (info.tokens ?? EmptyTokens).reasoning,
    tokens_cache_read: (info.tokens ?? EmptyTokens).cache.read,
    tokens_cache_write: (info.tokens ?? EmptyTokens).cache.write,
    revert: info.revert
      ? {
          messageID: SessionMessage.ID.make(info.revert.messageID),
          partID: info.revert.partID,
          snapshot: info.revert.snapshot,
          diff: info.revert.diff,
          restoreFiles: info.revert.files?.map((file) => RelativePath.make(file)),
        }
      : null,
    permission: info.permission,
    time_created: info.time.created,
    time_updated: info.time.updated,
    time_compacting: info.time.compacting,
    time_archived: info.time.archived,
  }
}

function getForkedTitle(title: string): string {
  const match = title.match(/^(.+) \(fork #(\d+)\)$/)
  if (match) {
    const base = match[1]
    const num = parseInt(match[2], 10)
    return `${base} (fork #${num + 1})`
  }
  return `${title} (fork #1)`
}

function sessionPath(worktree: string, cwd: string) {
  return path.relative(path.resolve(worktree), cwd).replaceAll("\\", "/")
}

const Summary = Schema.Struct({
  additions: Schema.Finite,
  deletions: Schema.Finite,
  files: Schema.Finite,
  diffs: optional(Schema.Array(FileDiffSchema)),
})

const Tokens = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  reasoning: Schema.Finite,
  cache: Schema.Struct({
    read: Schema.Finite,
    write: Schema.Finite,
  }),
})

const EmptyTokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

const Share = Schema.Struct({
  url: Schema.String,
})

// Legacy HTTP accepted negative values here. Keep archive timestamps permissive
// while excluding non-finite values that cannot round-trip through JSON.
export const ArchivedTimestamp = Schema.Finite

const Time = Schema.Struct({
  created: NonNegativeInt,
  updated: NonNegativeInt,
  compacting: optional(NonNegativeInt),
  archived: optional(ArchivedTimestamp),
})

const Revert = Schema.Struct({
  messageID: MessageID,
  partID: optional(PartID),
  snapshot: optional(Schema.String),
  diff: optional(Schema.String),
  files: optional(Schema.Array(Schema.String)),
})

const Model = Schema.Struct({
  id: ModelV2.ID,
  providerID: ProviderV2.ID,
  variant: optional(Schema.String),
})

export const Metadata = Schema.Record(Schema.String, Schema.Any)

export const Info = Schema.Struct({
  id: SessionID,
  slug: Schema.String,
  projectID: ProjectV2.ID,
  workspaceID: optional(WorkspaceV2.ID),
  directory: Schema.String,
  path: optional(Schema.String),
  parentID: optional(SessionID),
  summary: optional(Summary),
  cost: optional(Schema.Finite),
  tokens: optional(Tokens),
  share: optional(Share),
  title: Schema.String,
  agent: optional(Schema.String),
  model: optional(Model),
  version: Schema.String,
  metadata: optional(Metadata),
  time: Time,
  permission: optional(PermissionV1.Ruleset),
  revert: optional(Revert),
}).annotate({ identifier: "Session" })
export type Info = Types.DeepMutable<Schema.Schema.Type<typeof Info>>

export const ProjectInfo = Schema.Struct({
  id: ProjectV2.ID,
  name: optional(Schema.String),
  worktree: Schema.String,
}).annotate({ identifier: "ProjectSummary" })
export type ProjectInfo = Types.DeepMutable<Schema.Schema.Type<typeof ProjectInfo>>

export const GlobalInfo = Schema.Struct({
  ...Info.fields,
  project: Schema.NullOr(ProjectInfo),
}).annotate({ identifier: "GlobalSession" })
export type GlobalInfo = Types.DeepMutable<Schema.Schema.Type<typeof GlobalInfo>>

export const CreateInput = Schema.optional(
  Schema.Struct({
    parentID: Schema.optional(SessionID),
    title: Schema.optional(Schema.String),
    agent: Schema.optional(Schema.String),
    model: Schema.optional(Model),
    metadata: Schema.optional(Metadata),
    permission: Schema.optional(PermissionV1.Ruleset),
    workspaceID: Schema.optional(WorkspaceV2.ID),
  }),
)
export type CreateInput = Types.DeepMutable<Schema.Schema.Type<typeof CreateInput>>

export const ForkInput = Schema.Struct({
  sessionID: SessionID,
  messageID: Schema.optional(MessageID),
})
export const GetInput = SessionID
export const ChildrenInput = SessionID
export const RemoveInput = SessionID
export const SetTitleInput = Schema.Struct({ sessionID: SessionID, title: Schema.String })
export const SetArchivedInput = Schema.Struct({
  sessionID: SessionID,
  time: Schema.optional(ArchivedTimestamp),
})
export const SetMetadataInput = Schema.Struct({
  sessionID: SessionID,
  metadata: Metadata,
})
export const SetPermissionInput = Schema.Struct({
  sessionID: SessionID,
  permission: PermissionV1.Ruleset,
})
export const SetRevertInput = Schema.Struct({
  sessionID: SessionID,
  revert: Schema.optional(Revert),
  summary: Schema.optional(Summary),
})
export const MessagesInput = Schema.Struct({
  sessionID: SessionID,
  limit: Schema.optional(NonNegativeInt),
})
export type ListInput = {
  directory?: string
  scope?: "project"
  path?: string
  workspaceID?: WorkspaceV2.ID
  roots?: boolean
  start?: number
  search?: string
  limit?: number
}

export type GlobalListInput = {
  directory?: string
  roots?: boolean
  start?: number
  cursor?: number
  search?: string
  limit?: number
  archived?: boolean
}

export const Event = {
  Created: SessionV1.Event.Created,
  Updated: SessionV1.Event.Updated,
  Deleted: SessionV1.Event.Deleted,
  Diff: SessionV1.Event.Diff,
  Error: SessionV1.Event.Error,
}

export function plan(input: { slug: string; time: { created: number } }, instance: InstanceContext) {
  const base = instance.project.vcs
    ? path.join(instance.worktree, ".opencode", "plans")
    : path.join(Global.Path.data, "plans")
  return path.join(base, [input.time.created, input.slug].join("-") + ".md")
}

export const getUsage = (input: { model: Provider.Model; usage: Usage; metadata?: ProviderMetadata }) => {
  const finite = (value: number) => (Number.isFinite(value) ? value : 0)
  const safe = (value: number) => Math.max(0, finite(value))
  const inputTokens = safe(input.usage.inputTokens ?? 0)
  const outputTokens = safe(input.usage.outputTokens ?? 0)
  const reasoningTokens = safe(input.usage.reasoningTokens ?? 0)

  const cacheReadInputTokens = safe(input.usage.cacheReadInputTokens ?? 0)
  const cacheWriteInputTokens = safe(
    Number(
      input.usage.cacheWriteInputTokens ??
        input.metadata?.["anthropic"]?.["cacheCreationInputTokens"] ??
        // google-vertex-anthropic returns metadata under "vertex" key
        // (AnthropicMessagesLanguageModel custom provider key from 'vertex.anthropic.messages')
        input.metadata?.["vertex"]?.["cacheCreationInputTokens"] ??
        // @ts-expect-error
        input.metadata?.["bedrock"]?.["usage"]?.["cacheWriteInputTokens"] ??
        // @ts-expect-error
        input.metadata?.["venice"]?.["usage"]?.["cacheCreationInputTokens"] ??
        0,
    ),
  )

  // AI SDK v6 normalized inputTokens to include cached tokens across all providers
  // (including Anthropic/Bedrock which previously excluded them). Always subtract cache
  // tokens to get the non-cached input count for separate cost calculation.
  const adjustedInputTokens = safe(inputTokens - cacheReadInputTokens - cacheWriteInputTokens)

  const total = input.usage.totalTokens

  const tokens = {
    total,
    input: adjustedInputTokens,
    output: safe(outputTokens - reasoningTokens),
    reasoning: reasoningTokens,
    cache: {
      write: cacheWriteInputTokens,
      read: cacheReadInputTokens,
    },
  }

  const contextTokens = inputTokens
  const costInfo =
    input.model.cost?.tiers
      ?.filter((item) => item.tier.type === "context" && contextTokens > item.tier.size)
      .sort((a, b) => b.tier.size - a.tier.size)[0] ??
    (input.model.cost?.experimentalOver200K && contextTokens > 200_000
      ? input.model.cost.experimentalOver200K
      : input.model.cost)
  const totalNanoAiu = input.metadata?.["copilot"]?.["totalNanoAiu"]
  const rawReportedCost =
    typeof totalNanoAiu === "number" && Number.isFinite(totalNanoAiu) && totalNanoAiu >= 0
      ? new Decimal(totalNanoAiu).div(100_000_000_000).toNumber()
      : undefined
  const providerMetadataRecords = Object.values(input.metadata ?? {}).filter(
    (value): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value),
  )
  const providerIdentity = (keys: readonly string[]) => {
    for (const record of providerMetadataRecords) {
      for (const key of keys) {
        const value = record[key]
        if (typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value)) return value
      }
    }
    return undefined
  }
  const operationID = providerIdentity(["responseId", "operationID", "operationId"])
  const requestID = providerIdentity(["requestID", "requestId"])
  // A scalar billing value without a provider response/request identity is not
  // attributable evidence. Preserve it as unknown instead of calling it reported.
  const reportedCost = rawReportedCost !== undefined && (operationID || requestID) ? rawReportedCost : undefined
  const prices = [costInfo?.input, costInfo?.output, costInfo?.cache?.read, costInfo?.cache?.write]
  const cacheWriteReported =
    input.usage.cacheWriteInputTokens ??
    input.metadata?.["anthropic"]?.["cacheCreationInputTokens"] ??
    input.metadata?.["vertex"]?.["cacheCreationInputTokens"]
  const validCount = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0
  const completeUsage =
    validCount(input.usage.inputTokens) &&
    validCount(input.usage.outputTokens) &&
    validCount(input.usage.reasoningTokens) &&
    validCount(input.usage.cacheReadInputTokens) &&
    validCount(cacheWriteReported)
      ? {
          input: safe(input.usage.inputTokens - input.usage.cacheReadInputTokens - cacheWriteReported),
          output: safe(input.usage.outputTokens - input.usage.reasoningTokens),
          reasoning: input.usage.reasoningTokens,
          cacheRead: input.usage.cacheReadInputTokens,
          cacheWrite: cacheWriteReported,
        }
      : undefined
  const completePrices = prices.every(
    (value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0,
  )
    ? { input: prices[0]!, output: prices[1]!, cacheRead: prices[2]!, cacheWrite: prices[3]! }
    : undefined
  const estimatedCost = (() => {
    if (!completePrices || !completeUsage) return undefined
    return safe(
        new Decimal(0)
          .add(new Decimal(completeUsage.input).mul(completePrices.input).div(1_000_000))
          .add(new Decimal(completeUsage.output).mul(completePrices.output).div(1_000_000))
          .add(new Decimal(completeUsage.cacheRead).mul(completePrices.cacheRead).div(1_000_000))
          .add(new Decimal(completeUsage.cacheWrite).mul(completePrices.cacheWrite).div(1_000_000))
          .add(new Decimal(completeUsage.reasoning).mul(completePrices.output).div(1_000_000))
          .toNumber(),
      )
  })()
  const count = (value: number | undefined) =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0
      ? { status: "provider-reported" as const, value }
      : { status: "unknown" as const }
  const costProvenance =
    reportedCost !== undefined
      ? { status: "provider-reported" as const, value: reportedCost }
      : estimatedCost !== undefined
        ? {
            status: "estimated" as const,
            value: estimatedCost,
            priceSource: "selected-model-catalog",
            pricingRevision: (() => {
              const scaled = [completePrices!.input, completePrices!.output, completePrices!.cacheRead, completePrices!.cacheWrite]
                .map((price) => BigInt(new Decimal(price).toFixed(18).replace(".", "")).toString())
              const preimage = `horizoncode.managed-pricing.v1\0${scaled.join("\0")}\0`
              return `sha256:${createHash("sha256").update(preimage).digest("hex")}`
            })(),
            pricing: {
              input: completePrices!.input,
              output: completePrices!.output,
              cacheRead: completePrices!.cacheRead,
              cacheWrite: completePrices!.cacheWrite,
            },
            algorithm: "per-million-linear-v1" as const,
            tokenInputs: {
              input: completeUsage!.input,
              output: completeUsage!.output,
              reasoning: completeUsage!.reasoning,
              cacheRead: completeUsage!.cacheRead,
              cacheWrite: completeUsage!.cacheWrite,
            },
          }
        : { status: "unknown" as const }
  const usageProvenance: SessionMessageSchema.UsageProvenance = {
    providerID: input.model.providerID,
    modelID: input.model.id,
    ...(operationID ? { operationID } : {}),
    ...(requestID ? { requestID } : {}),
    cost: costProvenance,
    tokens: {
      input: count(input.usage.inputTokens),
      output: count(input.usage.outputTokens),
      reasoning: count(input.usage.reasoningTokens),
      cache: {
        read: count(input.usage.cacheReadInputTokens),
        write: count(
          input.usage.cacheWriteInputTokens ??
            input.metadata?.["anthropic"]?.["cacheCreationInputTokens"] ??
            input.metadata?.["vertex"]?.["cacheCreationInputTokens"] ??
            // @ts-expect-error provider-specific extension metadata
            input.metadata?.["bedrock"]?.["usage"]?.["cacheWriteInputTokens"] ??
            // @ts-expect-error provider-specific extension metadata
            input.metadata?.["venice"]?.["usage"]?.["cacheCreationInputTokens"],
        ),
      },
    },
  }
  return { cost: reportedCost ?? estimatedCost ?? 0, tokens, usageProvenance }
}

export class BusyError extends Schema.TaggedErrorClass<BusyError>()("SessionBusyError", {
  sessionID: SessionID,
}) {}

export type NotFound = NotFoundError

export type ManagedRootSessionLinkProjectionV1 = {
  readonly sessionID: string
  readonly sourceStoreID: string
  readonly sourceInstanceID: string
  readonly sourceCursor: { readonly ownerKind: "session"; readonly ownerId: string; readonly seq: string; readonly eventDigest: string }
  readonly sourceEpoch: string
  /** Present only when replaying the exact immutable Rust-pinned Run link. */
  readonly ownerEpoch?: string
  readonly latestObservedMessageID: string | null
  readonly latestObservedPartID: string | null
  readonly sourceDigest: string
  readonly redactionProfile: "horizon.session-link.ids-only.v1"
  readonly protocolVersion: 1
  readonly goalID: string
  readonly projectID: string
  readonly workspaceID: string
}

export type ManagedChildSessionCompletionProjectionV1 = {
  readonly childSessionSequence: string
  readonly childSessionEventDigest: string
  /** Domain-separated digest of the canonical persisted child completion projection at this cursor. */
  readonly childSessionStateDigest: string
  readonly childSessionOutputDigest: string
  readonly childSessionOutputBytes: number
  readonly childSessionOutcomeKind: "assistant_completed" | "assistant_error" | "tool_error"
}

/** Fresh Core-side observation used only after an owner-epoch change. */
export type ManagedChildSessionRecoveryObservationV1 = {
  readonly childSessionSequence: string
  readonly childSessionEventDigest: string
  readonly childSessionStateDigest: string
  readonly sessionStatus: "idle"
  readonly activePromptCount: 0
  readonly activeProviderTaskCount: 0
  readonly runningBackgroundTaskCount: 0
  readonly pendingToolCallCount: 0
  readonly incompleteAssistantMessageCount: 0
  readonly observationDigest: string
}

/** Domain-separated SHA-256 over ordered u64-BE-length-prefixed UTF-8 fields. */
function managedSessionLinkDigest(fields: readonly string[]): string {
  const hash = createHash("sha256")
  hash.update("horizoncode.session-link.source.v1\0", "utf8")
  for (const field of fields) {
    const bytes = Buffer.from(field, "utf8")
    const length = Buffer.alloc(8)
    length.writeBigUInt64BE(BigInt(bytes.byteLength))
    hash.update(length)
    hash.update(bytes)
  }
  return `sha256:${hash.digest("hex")}`
}

/** BLAKE3 over domain-separated, u64-BE-length-prefixed canonical child receipt fields. */
function managedChildSessionStateDigest(fields: readonly string[]): string {
  const chunks: Uint8Array[] = [Buffer.from("horizoncode.managed-child-session-state.v1\0", "utf8")]
  for (const field of fields) {
    const bytes = Buffer.from(field, "utf8")
    const length = Buffer.alloc(8)
    length.writeBigUInt64BE(BigInt(bytes.byteLength))
    chunks.push(length, bytes)
  }
  return `blake3:${bytesToHex(blake3(Buffer.concat(chunks)))}`
}

export interface Interface {
  readonly list: (input?: ListInput) => Effect.Effect<Info[]>
  readonly listGlobal: (input?: GlobalListInput) => Effect.Effect<GlobalInfo[]>
  readonly create: (input?: {
    parentID?: SessionID
    /** Pre-generated id so a subagent Attempt can bind the child before it exists. */
    id?: SessionID
    title?: string
    agent?: string
    model?: Schema.Schema.Type<typeof Model>
    metadata?: typeof Metadata.Type
    permission?: PermissionV1.Ruleset
    workspaceID?: WorkspaceV2.ID
  }) => Effect.Effect<Info>
  readonly fork: (input: { sessionID: SessionID; messageID?: MessageID }) => Effect.Effect<Info, NotFound>
  readonly touch: (sessionID: SessionID) => Effect.Effect<void>
  readonly get: (id: SessionID) => Effect.Effect<Info, NotFound>
  /** Core-owned durable root-session/Goal binding and exact Rust-projection cursor. */
  readonly managedRootSessionLink: (input: {
    readonly sessionID: SessionID
    readonly principalSubject: string
    readonly goalID: string
    readonly runID: string
    readonly projectID: string
    readonly workspaceID: string
  }) => Effect.Effect<ManagedRootSessionLinkProjectionV1, NotFound | SessionSupervisorError>
  /** Exact durable SessionProjection receipt for the authenticated managed child lineage. */
  readonly managedChildSessionCompletion: (input: {
    readonly sessionID: SessionID
    readonly parentSessionID: SessionID
    readonly goalID: string
    readonly runID: string
    readonly taskID: string
    readonly attemptID: string
  }) => Effect.Effect<ManagedChildSessionCompletionProjectionV1, NotFound | SessionSupervisorError>
  /** Current-epoch, no-dispatch observation; never rewrites the original terminal marker. */
  readonly managedChildSessionRecoveryObservation: (input: {
    readonly sessionID: SessionID
    readonly parentSessionID: SessionID
    readonly goalID: string
    readonly runID: string
    readonly taskID: string
    readonly attemptID: string
    readonly currentOwnerEpoch: string
  }) => Effect.Effect<ManagedChildSessionRecoveryObservationV1, NotFound | SessionSupervisorError>
  readonly setTitle: (input: { sessionID: SessionID; title: string }) => Effect.Effect<void>
  readonly setArchived: (input: { sessionID: SessionID; time?: number }) => Effect.Effect<void>
  readonly setMetadata: (input: typeof SetMetadataInput.Type) => Effect.Effect<void>
  readonly directInboxGetByRequest: (input: { parentSessionID: SessionID; childSessionID: SessionID; requestID: string }) => Effect.Effect<typeof DirectSubagentInboxTable.$inferSelect | undefined>
  readonly directInboxGet: (messageID: string) => Effect.Effect<typeof DirectSubagentInboxTable.$inferSelect | undefined>
  readonly directInboxList: (childSessionID: SessionID) => Effect.Effect<(typeof DirectSubagentInboxTable.$inferSelect)[]>
  readonly directInboxCreateDraft: (input: DirectSubagentInboxDraftV1) => Effect.Effect<{ row: typeof DirectSubagentInboxTable.$inferSelect; created: boolean }, Error>
  readonly directInboxClaim: (input: {
    childSessionID: SessionID
    attemptID: string
    ownerEpoch: string
    profileID: string
    profileRevision: string
    profileDigest: string
    permissionScopeDigest: string
    /** Queue never wakes a turn; follow_up claims one trigger for one serialized turn. */
    deliveryMode?: "queue" | "follow_up" | "any"
    /** Exact HostKernel-authorized wake; other follow-ups remain queued. */
    triggerMessageID?: string
  }) => Effect.Effect<(typeof DirectSubagentInboxTable.$inferSelect)[], Error>
  readonly directInboxConsume: (input: {
    readonly rows: readonly { readonly messageID: string; readonly consumptionAckDigest: string }[]
    readonly promptMessageID: string
    readonly consumingAttemptID: string
    readonly consumingOwnerEpoch: string
    readonly consumingScopeDigest: string
    readonly consumingWorkspaceID: string
  }) => Effect.Effect<(typeof DirectSubagentInboxTable.$inferSelect)[], Error>
  readonly directInboxMarkHostConsumed: (input: {
    readonly messageID: string
    readonly consumptionAckDigest: string
    readonly hostConsumedAckDigest: string
  }) => Effect.Effect<void, Error>
  readonly directInboxTransition: (input: {
    messageID: string
    expected: readonly DirectSubagentInboxStateV1[]
    state: DirectSubagentInboxStateV1
    challengeID?: string | null
    effectID?: string | null
    approvalExpiresAtUnixMs?: number | null
    approvalArgumentSummary?: string | null
    approvalPolicySummary?: string | null
    capabilityLeaseDigest?: string | null
    pinsDigest?: string | null
    hostReceiptDigest?: string | null
    inboxReceiptDigest?: string | null
  }) => Effect.Effect<typeof DirectSubagentInboxTable.$inferSelect, Error>
  readonly managedInboxGetByRequest: (input: { parentSessionID: SessionID; childSessionID: SessionID; requestID: string }) => Effect.Effect<ManagedSubagentInboxRowV1 | undefined>
  readonly managedInboxGet: (messageID: string) => Effect.Effect<ManagedSubagentInboxRowV1 | undefined>
  readonly managedInboxList: (attemptID: string) => Effect.Effect<ManagedSubagentInboxRowV1[]>
  readonly managedInboxCreateDraft: (input: ManagedSubagentInboxDraftV1) => Effect.Effect<{ row: ManagedSubagentInboxRowV1; created: boolean; inboxReceiptDigest: string }, Error>
  readonly managedInboxClaim: (input: {
    readonly attemptID: string
    readonly ownerEpoch: string
    readonly profileID: string
    readonly profileRevision: string
    readonly profileDigest: string
    readonly permissionScopeDigest: string
    readonly scopeDigest: string
    readonly workspaceID: string
    readonly workspaceRevision: string
    readonly deliveryMode: "queued" | "follow_up"
    readonly triggerMessageID?: string
  }) => Effect.Effect<ManagedSubagentInboxRowV1[], Error>
  readonly managedInboxRecordWakeClaim: (input: {
    readonly messageID: string
    readonly requestID: string
    readonly nextRequestSequence: string
    readonly inboxReceiptDigest: string
    readonly completedTurnReceiptDigest: string
    readonly wakeReceiptDigest: string
    readonly wakeClaimDigest: string
    readonly wakeClaimScopeDigest: string
    readonly wakeClaimReceiptDigest: string
  }) => Effect.Effect<ManagedSubagentInboxRowV1, Error>
  readonly managedInboxConsume: (proofs: readonly ManagedSubagentConsumptionProofV1[]) => Effect.Effect<ManagedSubagentInboxRowV1[], Error>
  readonly managedInboxMarkHostConsumed: (input: {
    readonly messageID: string
    readonly consumptionAckDigest: string
    readonly hostConsumedAckDigest: string
  }) => Effect.Effect<void, Error>
  readonly managedInboxTransition: (input: {
    readonly messageID: string
    readonly expected: readonly ManagedSubagentInboxStateV1[]
    readonly state: ManagedSubagentInboxStateV1
    readonly challengeID?: string | null
    readonly effectID?: string | null
    readonly pinsDigest?: string | null
    readonly capabilityLeaseDigest?: string | null
    readonly hostReceiptDigest?: string | null
    readonly completedTurnReceiptDigest?: string | null
    readonly wakeReceiptDigest?: string | null
    readonly nextRequestSequence?: string | null
    readonly deliveryOwnerEpoch?: string | null
    readonly deliveryAttemptID?: string | null
  }) => Effect.Effect<ManagedSubagentInboxRowV1, Error>
  readonly setAgentModel: (input: {
    sessionID: SessionID
    agent: string
    model: NonNullable<Info["model"]>
    time: number
  }) => Effect.Effect<void>
  readonly setPermission: (input: { sessionID: SessionID; permission: PermissionV1.Ruleset }) => Effect.Effect<void>
  readonly setRevert: (input: {
    sessionID: SessionID
    revert: Info["revert"]
    summary: Info["summary"]
  }) => Effect.Effect<void>
  readonly clearRevert: (sessionID: SessionID) => Effect.Effect<void>
  readonly setSummary: (input: { sessionID: SessionID; summary: Info["summary"] }) => Effect.Effect<void>
  readonly setShare: (input: { sessionID: SessionID; share: Info["share"] }) => Effect.Effect<void>
  readonly setWorkspace: (input: { sessionID: SessionID; workspaceID: Info["workspaceID"] }) => Effect.Effect<void>
  readonly diff: (sessionID: SessionID) => Effect.Effect<(typeof FileDiffSchema.Type)[]>
  readonly messages: (input: { sessionID: SessionID; limit?: number }) => Effect.Effect<SessionV1.WithParts[], NotFound>
  readonly children: (parentID: SessionID) => Effect.Effect<Info[]>
  readonly remove: (sessionID: SessionID) => Effect.Effect<void, NotFound>
  readonly updateMessage: <T extends SessionV1.Info>(
    msg: T,
    commit?: (sequence: number) => Effect.Effect<void>,
  ) => Effect.Effect<T>
  readonly removeMessage: (input: { sessionID: SessionID; messageID: MessageID }) => Effect.Effect<MessageID>
  readonly removePart: (input: { sessionID: SessionID; messageID: MessageID; partID: PartID }) => Effect.Effect<PartID>
  readonly getPart: (input: {
    sessionID: SessionID
    messageID: MessageID
    partID: PartID
  }) => Effect.Effect<SessionV1.Part | undefined>
  readonly updatePart: <T extends SessionV1.Part>(part: T) => Effect.Effect<T>
  readonly updatePartDelta: (input: {
    sessionID: SessionID
    messageID: MessageID
    partID: PartID
    field: string
    delta: string
  }) => Effect.Effect<void>
  /** Finds the first message matching the predicate, searching newest-first. */
  readonly findMessage: (
    sessionID: SessionID,
    predicate: (msg: SessionV1.WithParts) => boolean,
  ) => Effect.Effect<Option.Option<SessionV1.WithParts>, NotFound>
}

export class Service extends Context.Service<Service, Interface>()("@horizoncode/Session") {}

export const use = serviceUse(Service)

export type Patch = Omit<Partial<Info>, "time" | "share" | "summary" | "revert" | "permission"> & {
  time?: Partial<Info["time"]>
  share?: Partial<NonNullable<Info["share"]>> | null
  summary?: Info["summary"] | null
  revert?: Info["revert"] | null
  permission?: Info["permission"] | null
}

const layer: Layer.Layer<
  Service,
  never,
  BackgroundJob.Service | RuntimeFlags.Service | Database.Service | EventV2Bridge.Service | SessionSupervisorService | SessionStatus.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const database = yield* Database.Service
    const background = yield* BackgroundJob.Service
    const sessionStatus = yield* SessionStatus.Service
    const events = yield* EventV2Bridge.Service
    const supervisor = yield* SessionSupervisor.Service
    const flags = yield* RuntimeFlags.Service

    const createNext = Effect.fn("Session.createNext")(function* (input: {
      id?: SessionID
      title?: string
      agent?: string
      model?: Schema.Schema.Type<typeof Model>
      parentID?: SessionID
      workspaceID?: WorkspaceV2.ID
      directory: string
      path?: string
      metadata?: typeof Metadata.Type
      permission?: PermissionV1.Ruleset
    }) {
      const ctx = yield* InstanceState.context
      const metadata = { ...(input.metadata ?? {}) }
      // This field is a trusted owner assertion. Never accept it from caller
      // metadata; the authenticated request context is its only writer.
      delete metadata.horizonPrincipalOwner
      const trusted = yield* Effect.serviceOption(TrustedPrincipalContext)
      if (Option.isSome(trusted) && trusted.value.principal.kind === "server_auth") {
        const subject = trusted.value.principal.subject
        if (subject.length > 0 && subject.length <= 256 && !/[\u0000-\u001f\u007f]/.test(subject)) {
          metadata.horizonPrincipalOwner = { kind: "server_auth", subject }
        }
      }
      const persistedMetadata = Object.keys(metadata).length > 0 ? metadata : undefined
      const result: Info = {
        id: SessionID.descending(input.id),
        slug: Slug.create(),
        version: InstallationVersion,
        projectID: ctx.project.id,
        directory: input.directory,
        path: input.path,
        workspaceID: input.workspaceID,
        parentID: input.parentID,
        title: input.title ?? (input.parentID ? childTitlePrefix : parentTitlePrefix) + new Date().toISOString(),
        agent: input.agent,
        model: input.model,
        metadata: persistedMetadata,
        permission: input.permission ? [...input.permission] : undefined,
        cost: 0,
        tokens: EmptyTokens,
        time: {
          created: Date.now(),
          updated: Date.now(),
        },
      }
      yield* Effect.logInfo("created", result)

      yield* events.publish(SessionV1.Event.Created, { sessionID: result.id, info: result })

      return result
    })

    const get = Effect.fn("Session.get")(function* (id: SessionID) {
      const row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, id)).get().pipe(Effect.orDie)
      if (!row) return yield* Effect.fail(new NotFoundError({ message: `Session not found: ${id}` }))
      return fromRow(row)
    })

    const list = Effect.fn("Session.list")(function* (input?: ListInput) {
      const ctx = yield* InstanceState.context
      return yield* listByProject(db, {
        projectID: ctx.project.id,
        experimentalWorkspaces: flags.experimentalWorkspaces,
        ...input,
      })
    })

    const listGlobal = Effect.fn("Session.listGlobal")(function* (input?: GlobalListInput) {
      const conditions: SQL[] = []
      if (input?.directory) conditions.push(eq(SessionTable.directory, input.directory))
      if (input?.roots) conditions.push(isNull(SessionTable.parent_id))
      if (input?.start) conditions.push(gte(SessionTable.time_updated, input.start))
      if (input?.cursor) conditions.push(lt(SessionTable.time_updated, input.cursor))
      if (input?.search) conditions.push(like(SessionTable.title, `%${input.search}%`))
      if (!input?.archived) conditions.push(isNull(SessionTable.time_archived))

      const query =
        conditions.length > 0
          ? db
              .select()
              .from(SessionTable)
              .where(and(...conditions))
          : db.select().from(SessionTable)
      const rows = yield* query
        .orderBy(desc(SessionTable.time_updated), desc(SessionTable.id))
        .limit(input?.limit ?? 100)
        .all()
        .pipe(Effect.orDie)
      const ids = [...new Set(rows.map((row) => row.project_id))]
      const projects = new Map<string, ProjectInfo>()
      if (ids.length > 0) {
        const items = yield* db
          .select({ id: ProjectTable.id, name: ProjectTable.name, worktree: ProjectTable.worktree })
          .from(ProjectTable)
          .where(inArray(ProjectTable.id, ids))
          .all()
          .pipe(Effect.orDie)
        for (const item of items) {
          projects.set(item.id, {
            id: item.id,
            name: item.name ?? undefined,
            worktree: item.worktree,
          })
        }
      }
      return rows.map((row) => ({ ...fromRow(row), project: projects.get(row.project_id) ?? null }))
    })

    const children = Effect.fn("Session.children")(function* (parentID: SessionID) {
      const rows = yield* db
        .select()
        .from(SessionTable)
        .where(and(eq(SessionTable.parent_id, parentID)))
        .all()
        .pipe(Effect.orDie)
      return rows.map(fromRow)
    })

    const remove: Interface["remove"] = Effect.fnUntraced(function* (sessionID: SessionID) {
      const session = yield* get(sessionID)
      try {
        // `remove` needs to work in all cases, such as broken sessions that
        // run cleanup without instance state.
        const hasInstance = yield* InstanceState.directory.pipe(
          Effect.as(true),
          Effect.catchCause(() => Effect.succeed(false)),
        )

        if (hasInstance) yield* cancelBackgroundJobs(background, sessionID)
        const kids = yield* children(sessionID)
        for (const child of kids) {
          yield* remove(child.id)
        }

        yield* events.publish(SessionV1.Event.Deleted, { sessionID, info: session })
        yield* events.remove(sessionID)
      } catch (error) {
        yield* Effect.logError("failed to remove session", { sessionID, error })
      }
    })

    const updateMessage = <T extends SessionV1.Info>(
      msg: T,
      commit?: (sequence: number) => Effect.Effect<void>,
    ): Effect.Effect<T> =>
      Effect.gen(function* () {
        yield* events.publish(
          SessionV1.Event.MessageUpdated,
          { sessionID: msg.sessionID, info: msg },
          commit ? { commit } : undefined,
        )
        return msg
      }).pipe(Effect.withSpan("Session.updateMessage"))

    // Sequence is owned by the emitter, never reconstructed from UI delivery.
    const partDeltaCursor = createPartDeltaCursorV1()

    const updatePart = <T extends SessionV1.Part>(part: T): Effect.Effect<T> =>
      Effect.gen(function* () {
        if ((part.type === "text" || part.type === "reasoning") && part.text.length === 0 && part.time?.end === undefined) {
          partDeltaCursor.begin({ sessionID: part.sessionID, messageID: part.messageID, partID: part.id, field: "text" })
        }
        if ((part.type === "text" || part.type === "reasoning") && part.time?.end !== undefined) {
          partDeltaCursor.end({ sessionID: part.sessionID, messageID: part.messageID, partID: part.id, field: "text" })
        }
        yield* events.publish(SessionV1.Event.PartUpdated, {
          sessionID: part.sessionID,
          part: structuredClone(part),
          time: Date.now(),
        })
        return part
      }).pipe(Effect.withSpan("Session.updatePart"))

    const getPart: Interface["getPart"] = Effect.fn("Session.getPart")(function* (input) {
      const row = yield* db
        .select()
        .from(PartTable)
        .where(
          and(
            eq(PartTable.session_id, input.sessionID),
            eq(PartTable.message_id, input.messageID),
            eq(PartTable.id, input.partID),
          ),
        )
        .get()
        .pipe(Effect.orDie)
      if (!row) return
      return {
        ...row.data,
        id: row.id,
        sessionID: row.session_id,
        messageID: row.message_id,
      } as SessionV1.Part
    })

    const create = Effect.fn("Session.create")(function* (input?: {
      parentID?: SessionID
      id?: SessionID
      title?: string
      agent?: string
      model?: Schema.Schema.Type<typeof Model>
      metadata?: typeof Metadata.Type
      permission?: PermissionV1.Ruleset
      workspaceID?: WorkspaceV2.ID
    }) {
      const ctx = yield* InstanceState.context
      const workspace = yield* InstanceState.workspaceID
      return yield* createNext({
        id: input?.id,
        parentID: input?.parentID,
        directory: ctx.directory,
        path: sessionPath(ctx.worktree, ctx.directory),
        title: input?.title,
        agent: input?.agent,
        model: input?.model,
        metadata: input?.metadata,
        permission: input?.permission,
        workspaceID: input?.workspaceID ?? workspace,
      })
    })

    const fork = Effect.fn("Session.fork")(function* (input: { sessionID: SessionID; messageID?: MessageID }) {
      const ctx = yield* InstanceState.context
      const original = yield* get(input.sessionID)
      const title = getForkedTitle(original.title)
      const session = yield* createNext({
        directory: ctx.directory,
        path: sessionPath(ctx.worktree, ctx.directory),
        workspaceID: original.workspaceID,
        title,
        metadata: structuredClone(original.metadata),
      })
      const msgs = yield* messages({ sessionID: input.sessionID })
      const idMap = new Map<string, MessageID>()
      const target = input.messageID ? msgs.findIndex((msg) => msg.info.id === input.messageID) : msgs.length

      for (const msg of msgs.slice(0, target < 0 ? msgs.length : target)) {
        const newID = MessageID.ascending()
        idMap.set(msg.info.id, newID)

        const parentID = msg.info.role === "assistant" && msg.info.parentID ? idMap.get(msg.info.parentID) : undefined
        const cloned = yield* updateMessage({
          ...msg.info,
          sessionID: session.id,
          id: newID,
          ...(parentID && { parentID }),
        })

        for (const part of msg.parts) {
          const p: SessionV1.Part = {
            ...part,
            id: PartID.ascending(),
            messageID: cloned.id,
            sessionID: session.id,
          }
          if (p.type === "compaction" && p.tail_start_id) {
            p.tail_start_id = idMap.get(p.tail_start_id)
          }
          yield* updatePart(p)
        }
      }
      return session
    })

    const patch = (sessionID: SessionID, info: Patch) =>
      Effect.gen(function* () {
        const current = yield* get(sessionID)
        const next = {
          ...current,
          ...info,
          time: info.time ? { ...current.time, ...info.time } : current.time,
          share: info.share === null ? undefined : info.share ? { ...current.share, ...info.share } : current.share,
          summary: info.summary === null ? undefined : (info.summary ?? current.summary),
          revert: info.revert === null ? undefined : (info.revert ?? current.revert),
          permission: info.permission === null ? undefined : (info.permission ?? current.permission),
        } as Info
        yield* events.publish(SessionV1.Event.Updated, { sessionID, info: next })
      })

    const touch = Effect.fn("Session.touch")(function* (sessionID: SessionID) {
      yield* patch(sessionID, { time: { updated: Date.now() } }).pipe(Effect.orDie)
    })

    const setTitle = Effect.fn("Session.setTitle")(function* (input: { sessionID: SessionID; title: string }) {
      yield* patch(input.sessionID, { title: input.title }).pipe(Effect.orDie)
    })

    const setArchived = Effect.fn("Session.setArchived")(function* (input: { sessionID: SessionID; time?: number }) {
      yield* patch(input.sessionID, { time: { archived: input.time } }).pipe(Effect.orDie)
    })

    const setMetadata = Effect.fn("Session.setMetadata")(function* (input: typeof SetMetadataInput.Type) {
      const current = yield* get(input.sessionID).pipe(Effect.orDie)
      const metadata = { ...input.metadata }
      // Ownership is immutable after creation. Metadata updates may change
      // ordinary fields, but cannot assign, remove, or transfer this authority.
      delete metadata.horizonPrincipalOwner
      const owner = current.metadata?.horizonPrincipalOwner
      if (typeof owner === "object" && owner !== null && !Array.isArray(owner)
        && (owner as Record<string, unknown>).kind === "server_auth"
        && typeof (owner as Record<string, unknown>).subject === "string") {
        metadata.horizonPrincipalOwner = owner
      }
      yield* patch(input.sessionID, { metadata, time: { updated: Date.now() } }).pipe(Effect.orDie)
    })

    const setAgentModel = Effect.fn("Session.setAgentModel")(function* (input: {
      sessionID: SessionID
      agent: string
      model: NonNullable<Info["model"]>
      time: number
    }) {
      yield* patch(input.sessionID, {
        agent: input.agent,
        model: input.model,
        time: { updated: input.time },
      }).pipe(Effect.orDie)
    })

    const setPermission = Effect.fn("Session.setPermission")(function* (input: {
      sessionID: SessionID
      permission: PermissionV1.Ruleset
    }) {
      yield* patch(input.sessionID, { permission: [...input.permission], time: { updated: Date.now() } }).pipe(
        Effect.orDie,
      )
    })

    const setRevert = Effect.fn("Session.setRevert")(function* (input: {
      sessionID: SessionID
      revert: Info["revert"]
      summary: Info["summary"]
    }) {
      yield* patch(input.sessionID, {
        summary: input.summary,
        time: { updated: Date.now() },
        revert: input.revert,
      }).pipe(Effect.orDie)
    })

    const clearRevert = Effect.fn("Session.clearRevert")(function* (sessionID: SessionID) {
      yield* patch(sessionID, { time: { updated: Date.now() }, revert: null }).pipe(Effect.orDie)
    })

    const setSummary = Effect.fn("Session.setSummary")(function* (input: {
      sessionID: SessionID
      summary: Info["summary"]
    }) {
      yield* patch(input.sessionID, { time: { updated: Date.now() }, summary: input.summary }).pipe(Effect.orDie)
    })

    const setShare = Effect.fn("Session.setShare")(function* (input: { sessionID: SessionID; share: Info["share"] }) {
      yield* patch(input.sessionID, { share: input.share ?? null, time: { updated: Date.now() } }).pipe(Effect.orDie)
    })

    const setWorkspace = Effect.fn("Session.setWorkspace")(function* (input: {
      sessionID: SessionID
      workspaceID: Info["workspaceID"]
    }) {
      yield* patch(input.sessionID, { workspaceID: input.workspaceID, time: { updated: Date.now() } }).pipe(
        Effect.orDie,
      )
    })

    const diff = Effect.fn("Session.diff")(function* (sessionID: SessionID) {
      void sessionID
      return [] as (typeof FileDiffSchema.Type)[]
    })

    const messages: Interface["messages"] = Effect.fn("Session.messages")(function* (input) {
      if (input.limit) {
        return (yield* MessageV2.page({ sessionID: input.sessionID, limit: input.limit }).pipe(
          Effect.provideService(Database.Service, database),
        )).items
      }

      const size = 50
      const result = [] as SessionV1.WithParts[]
      let before: string | undefined
      while (true) {
        const page = yield* MessageV2.page({ sessionID: input.sessionID, limit: size, before }).pipe(
          Effect.provideService(Database.Service, database),
        )
        if (page.items.length === 0) break
        for (let i = page.items.length - 1; i >= 0; i--) {
          const item = page.items[i]
          if (item) result.push(item)
        }
        if (!page.more || !page.cursor) break
        before = page.cursor
      }
      return result.reverse()
    })

    const removeMessage = Effect.fn("Session.removeMessage")(function* (input: {
      sessionID: SessionID
      messageID: MessageID
    }) {
      yield* events.publish(SessionV1.Event.MessageRemoved, {
        sessionID: input.sessionID,
        messageID: input.messageID,
      })
      return input.messageID
    })

    const removePart = Effect.fn("Session.removePart")(function* (input: {
      sessionID: SessionID
      messageID: MessageID
      partID: PartID
    }) {
      partDeltaCursor.end({ ...input, field: "text" })
      yield* events.publish(SessionV1.Event.PartRemoved, {
        sessionID: input.sessionID,
        messageID: input.messageID,
        partID: input.partID,
      })
      return input.partID
    })

    const updatePartDelta = Effect.fnUntraced(function* (input: {
      sessionID: SessionID
      messageID: MessageID
      partID: PartID
      field: string
      delta: string
    }) {
      const cursor = partDeltaCursor.append(input, input.delta)
      if (!cursor) {
        return yield* Effect.die(`Message part stream offset exceeded the safe integer range: ${input.partID}`)
      }
      yield* events.publish(MessageV2.Event.PartDelta, {
        ...input,
        ...cursor,
      })
    })

    /** Finds the first message matching the predicate, searching newest-first. */
    const findMessage: Interface["findMessage"] = Effect.fn("Session.findMessage")(function* (sessionID, predicate) {
      const size = 50
      let before: string | undefined
      while (true) {
        const page = yield* MessageV2.page({ sessionID, limit: size, before }).pipe(
          Effect.provideService(Database.Service, database),
        )
        if (page.items.length === 0) break
        for (let i = page.items.length - 1; i >= 0; i--) {
          const item = page.items[i]
          if (item && predicate(item)) return Option.some(item)
        }
        if (!page.more || !page.cursor) break
        before = page.cursor
      }
      return Option.none<SessionV1.WithParts>()
    })

    const managedRootSessionLink: Interface["managedRootSessionLink"] = Effect.fn("Session.managedRootSessionLink")(function* (input) {
      const info = yield* get(input.sessionID)
      if (info.parentID || info.projectID !== input.projectID || info.workspaceID !== input.workspaceID) {
        return yield* Effect.fail(new SessionSupervisorError({
          stage: "managed_root_session",
          reason: "selected Session is not a top-level Session in the authenticated Goal workspace",
        }))
      }
      const owner = info.metadata?.horizonPrincipalOwner
      if (typeof owner !== "object" || owner === null || Array.isArray(owner) ||
        owner.kind !== "server_auth" || owner.subject !== input.principalSubject) {
        return yield* Effect.fail(new SessionSupervisorError({
          stage: "managed_root_session",
          reason: "Session is not durably owned by the authenticated ServerAuth principal",
        }))
      }
      const binding = info.metadata?.horizonManagedRoot
      if (binding !== undefined && (typeof binding !== "object" || binding === null || Array.isArray(binding) ||
        binding.goalID !== input.goalID || binding.runID !== input.runID || binding.projectID !== input.projectID ||
        binding.workspaceID !== input.workspaceID)) {
        return yield* Effect.fail(new SessionSupervisorError({
          stage: "managed_root_session",
          reason: "Session is durably bound to another managed Goal or Run",
        }))
      }
      const cursor = yield* supervisor.sessionProjectionCursor(input.sessionID)
      const ownerKind = cursor.ownerKind
      if (ownerKind !== "session" || cursor.ownerId !== input.sessionID) {
        return yield* Effect.fail(new SessionSupervisorError({
          stage: "managed_root_session",
          reason: "SessionSupervisor returned a cursor for a different Session owner",
        }))
      }
      // Project while the guard's literal narrowing for ownerKind still holds;
      // the durable projection type requires the "session" owner kind exactly.
      const sourceCursor: { ownerKind: "session"; ownerId: string; seq: string; eventDigest: string } = {
        ownerKind,
        ownerId: cursor.ownerId,
        seq: cursor.seq,
        eventDigest: cursor.eventDigest,
      }
      const sourceInstance = yield* database.db
        .select({ sourceInstanceID: ProjectDirectoryTable.source_instance_id })
        .from(ProjectDirectoryTable)
        .where(and(
          eq(ProjectDirectoryTable.project_id, info.projectID),
          eq(ProjectDirectoryTable.directory, AbsolutePath.make(info.directory)),
        ))
        .get()
        .pipe(Effect.orDie)
      const sourceEpochRow = yield* database.db
        .select({ sourceEpoch: SessionTable.source_epoch })
        .from(SessionTable)
        .where(eq(SessionTable.id, input.sessionID))
        .get()
        .pipe(Effect.orDie)
      if (!sourceInstance?.sourceInstanceID || !/^[A-Za-z0-9._-]{1,256}$/.test(sourceInstance.sourceInstanceID) ||
        !sourceEpochRow || !Number.isSafeInteger(sourceEpochRow.sourceEpoch) || sourceEpochRow.sourceEpoch < 1) {
        return yield* Effect.fail(new SessionSupervisorError({
          stage: "managed_root_session",
          reason: "canonical source-instance or source-epoch identity is missing",
        }))
      }
      const latest = yield* messages({ sessionID: input.sessionID, limit: 1 })
      const latestMessage = latest.at(-1)
      const latestPart = latestMessage?.parts.at(-1)
      const sourceProjection = {
        sessionID: info.id,
        sourceStoreID: database.sourceStoreID,
        sourceInstanceID: sourceInstance.sourceInstanceID,
        sourceCursor,
        sourceEpoch: String(sourceEpochRow.sourceEpoch),
        latestObservedMessageID: latestMessage?.info.id ?? null,
        latestObservedPartID: latestPart?.id ?? null,
        redactionProfile: "horizon.session-link.ids-only.v1" as const,
        protocolVersion: 1 as const,
        goalID: input.goalID,
        projectID: info.projectID,
        workspaceID: input.workspaceID,
      }
      const sourceDigest = managedSessionLinkDigest([
        sourceProjection.sessionID,
        sourceProjection.sourceStoreID,
        sourceProjection.sourceInstanceID,
        cursor.ownerKind,
        cursor.ownerId,
        cursor.seq,
        cursor.eventDigest,
        sourceProjection.sourceEpoch,
        sourceProjection.latestObservedMessageID ?? "",
        sourceProjection.latestObservedPartID ?? "",
        sourceProjection.redactionProfile,
        String(sourceProjection.protocolVersion),
        sourceProjection.goalID,
        sourceProjection.projectID,
        sourceProjection.workspaceID,
      ])
      return { ...sourceProjection, sourceDigest }
    })

    const managedChildSessionCompletion: Interface["managedChildSessionCompletion"] = Effect.fn("Session.managedChildSessionCompletion")(function* (input) {
      const info = yield* get(input.sessionID)
      const binding = info.metadata?.horizonManagedAttempt
      if (info.parentID !== input.parentSessionID ||
        typeof binding !== "object" || binding === null || Array.isArray(binding) ||
        binding.schemaVersion !== 1 || binding.goalID !== input.goalID || binding.runID !== input.runID ||
        binding.taskID !== input.taskID || binding.attemptID !== input.attemptID) {
        return yield* Effect.fail(new SessionSupervisorError({
          stage: "managed-attempt",
          reason: "child Session is not durably bound to the exact managed Attempt lineage",
        }))
      }
      const cursor = yield* supervisor.sessionProjectionCursor(input.sessionID)
      if (cursor.ownerKind !== "session" || cursor.ownerId !== input.sessionID ||
        !/^[1-9][0-9]*$/.test(cursor.seq) || !/^blake3:[0-9a-f]{64}$/.test(cursor.eventDigest)) {
        return yield* Effect.fail(new SessionSupervisorError({
          stage: "checkpoint",
          reason: "child Session has no valid acknowledged durable projection receipt",
        }))
      }
      const delivery = info.metadata?.horizonManagedDelivery
      if (typeof delivery !== "object" || delivery === null || Array.isArray(delivery) ||
        delivery.schemaVersion !== 1 || delivery.promptState !== "RETURNED" ||
        typeof delivery.handoffDigest !== "string" || !/^blake3:[0-9a-f]{64}$/.test(delivery.handoffDigest) ||
        typeof delivery.consumeReceiptDigest !== "string" || !/^blake3:[0-9a-f]{64}$/.test(delivery.consumeReceiptDigest) ||
        typeof delivery.completionDeliveryID !== "string" || !/^managed_dispatch_[0-9a-f]{64}$/.test(delivery.completionDeliveryID) ||
        !["assistant_completed", "assistant_error", "tool_error"].includes(String(delivery.outcomeKind)) ||
        typeof delivery.outputDigest !== "string" || !/^(sha256|blake3):[0-9a-f]{64}$/.test(delivery.outputDigest) ||
        !Number.isSafeInteger(delivery.outputBytes) || delivery.outputBytes < 0 || delivery.outputBytes > 8 * 1024 * 1024 ||
        !/^(0|[1-9][0-9]*)$/.test(String(binding.ownerEpoch))) {
        return yield* Effect.fail(new SessionSupervisorError({
          stage: "managed-attempt",
          reason: "child Session has no durable returned-outcome receipt",
        }))
      }
      const childSessionStateDigest = managedChildSessionStateDigest([
        "1",
        input.sessionID,
        input.parentSessionID,
        input.goalID,
        input.runID,
        input.taskID,
        input.attemptID,
        String(binding.ownerEpoch),
        "RETURNED",
        String(delivery.outcomeKind),
        cursor.seq,
        cursor.eventDigest,
        delivery.handoffDigest,
        delivery.consumeReceiptDigest,
        delivery.outputDigest,
        String(delivery.outputBytes),
      ])
      return {
        childSessionSequence: cursor.seq,
        childSessionEventDigest: cursor.eventDigest,
        childSessionStateDigest,
        childSessionOutputDigest: delivery.outputDigest,
        childSessionOutputBytes: delivery.outputBytes,
        childSessionOutcomeKind: delivery.outcomeKind as "assistant_completed" | "assistant_error" | "tool_error",
      }
    })

    const managedChildSessionRecoveryObservation: Interface["managedChildSessionRecoveryObservation"] = Effect.fn("Session.managedChildSessionRecoveryObservation")(function* (input) {
      const info = yield* get(input.sessionID)
      const binding = info.metadata?.horizonManagedAttempt
      if (info.parentID !== input.parentSessionID ||
        typeof binding !== "object" || binding === null || Array.isArray(binding) ||
        binding.schemaVersion !== 1 || binding.goalID !== input.goalID || binding.runID !== input.runID ||
        binding.taskID !== input.taskID || binding.attemptID !== input.attemptID ||
        !/^(0|[1-9][0-9]*)$/.test(input.currentOwnerEpoch) || BigInt(input.currentOwnerEpoch) < 1n) {
        return yield* Effect.fail(new SessionSupervisorError({
          stage: "managed-attempt",
          reason: "recovery observation is not bound to the exact managed child lineage",
        }))
      }
      const status = yield* sessionStatus.get(input.sessionID)
      if (status.type !== "idle") {
        return yield* Effect.fail(new SessionSupervisorError({
          stage: "managed-attempt",
          reason: "managed child still has an active prompt/provider loop",
        }))
      }
      const jobs = yield* background.list()
      const runningBackgroundTasks = jobs.filter((job) => job.status === "running" &&
        (job.id === input.sessionID || job.metadata?.sessionId === input.sessionID || job.metadata?.parentSessionId === input.sessionID))
      if (runningBackgroundTasks.length > 0) {
        return yield* Effect.fail(new SessionSupervisorError({
          stage: "managed-attempt",
          reason: "managed child still owns running background work",
        }))
      }
      const messages = yield* MessageV2.filterCompactedEffect(input.sessionID).pipe(
        Effect.provideService(Database.Service, database),
      )
      const incompleteAssistantMessageCount = messages.filter((message) =>
        message.info.role === "assistant" && message.info.time.completed === undefined,
      ).length
      const pendingToolCallCount = messages.flatMap((message) => message.parts).filter((part) =>
        part.type === "tool" && (part.state.status === "pending" || part.state.status === "running"),
      ).length
      if (pendingToolCallCount !== 0 || incompleteAssistantMessageCount !== 0) {
        return yield* Effect.fail(new SessionSupervisorError({
          stage: "managed-attempt",
          reason: "managed child still has an incomplete assistant/provider response or pending tool call",
        }))
      }
      const cursor = yield* supervisor.sessionProjectionCursor(input.sessionID)
      if (cursor.ownerKind !== "session" || cursor.ownerId !== input.sessionID ||
        !/^[1-9][0-9]*$/.test(cursor.seq) || !/^blake3:[0-9a-f]{64}$/.test(cursor.eventDigest)) {
        return yield* Effect.fail(new SessionSupervisorError({
          stage: "checkpoint",
          reason: "recovery observation has no current durable child Session cursor",
        }))
      }
      const stateDigest = managedChildSessionStateDigest([
        "recovery-v1", input.sessionID, input.parentSessionID, input.goalID, input.runID,
        input.taskID, input.attemptID, input.currentOwnerEpoch, cursor.seq, cursor.eventDigest,
        "idle", "0", "0", String(runningBackgroundTasks.length), String(pendingToolCallCount), String(incompleteAssistantMessageCount),
      ])
      const observationDigest = managedChildSessionStateDigest([
        "current-epoch-recovery-v1", input.sessionID, input.parentSessionID, input.goalID,
        input.runID, input.taskID, input.attemptID, input.currentOwnerEpoch, cursor.seq,
        cursor.eventDigest, stateDigest,
      ])
      return {
        childSessionSequence: cursor.seq,
        childSessionEventDigest: cursor.eventDigest,
        childSessionStateDigest: stateDigest,
        sessionStatus: "idle" as const,
        activePromptCount: 0 as const,
        activeProviderTaskCount: 0 as const,
        runningBackgroundTaskCount: 0 as const,
        pendingToolCallCount: 0 as const,
        incompleteAssistantMessageCount: 0 as const,
        observationDigest,
      }
    })

    const directInboxGetByRequest = Effect.fn("Session.directInboxGetByRequest")(function* (input: {
      parentSessionID: SessionID
      childSessionID: SessionID
      requestID: string
    }) {
      return yield* db.select().from(DirectSubagentInboxTable).where(and(
        eq(DirectSubagentInboxTable.parent_session_id, input.parentSessionID),
        eq(DirectSubagentInboxTable.child_session_id, input.childSessionID),
        eq(DirectSubagentInboxTable.request_id, input.requestID),
      )).get().pipe(Effect.orDie)
    })
    const directInboxGet = Effect.fn("Session.directInboxGet")(function* (messageID: string) {
      return yield* db.select().from(DirectSubagentInboxTable).where(eq(DirectSubagentInboxTable.message_id, messageID)).get().pipe(Effect.orDie)
    })
    const directInboxList = Effect.fn("Session.directInboxList")(function* (childSessionID: SessionID) {
      return yield* db.select().from(DirectSubagentInboxTable).where(eq(DirectSubagentInboxTable.child_session_id, childSessionID)).all().pipe(Effect.orDie)
    })
    const directInboxCreateDraft = Effect.fn("Session.directInboxCreateDraft")(function* (input: DirectSubagentInboxDraftV1) {
      if (input.parentSessionId === input.childSessionId || !/^[A-Za-z0-9._:-]{1,128}$/.test(input.requestId) ||
        !/^msg[A-Za-z0-9._-]{1,256}$/.test(input.messageId) || !/^att_[a-z0-9]{16,64}$/.test(input.childAttemptId) ||
        !/^[1-9][0-9]{0,19}$/.test(input.childOwnerEpoch) || !/^[1-9][0-9]{0,19}$/.test(input.profileRevision) ||
        !/^blake3:[0-9a-f]{64}$/.test(input.profileDigest) || !/^(sha256|blake3):[0-9a-f]{64}$/.test(input.permissionScopeDigest) ||
        !/^sha256:[0-9a-f]{64}$/.test(input.payloadDigest) || !/^(sha256|blake3):[0-9a-f]{64}$/.test(input.inboxReceiptDigest) ||
        input.payloadBytes !== Buffer.byteLength(input.payload, "utf8") || input.payloadBytes < 1 || input.payloadBytes > 16 * 1024 ||
        !Number.isInteger(input.mailboxCapacity) || input.mailboxCapacity < 1 || input.mailboxCapacity > 32) {
        return yield* Effect.fail(new Error("direct inbox draft has invalid authority pins or bounds"))
      }
      return yield* db.transaction((tx) => Effect.gen(function* () {
        const existing = yield* tx.select().from(DirectSubagentInboxTable).where(and(
          eq(DirectSubagentInboxTable.parent_session_id, SessionID.make(input.parentSessionId)),
          eq(DirectSubagentInboxTable.child_session_id, SessionID.make(input.childSessionId)),
          eq(DirectSubagentInboxTable.request_id, input.requestId),
        )).get()
        if (existing) {
          if (existing.message_id !== input.messageId || (existing.payload !== "" && existing.payload !== input.payload) ||
            existing.payload_digest !== input.payloadDigest || existing.payload_bytes !== input.payloadBytes ||
            existing.delivery_mode !== input.deliveryMode || existing.child_attempt_id !== input.childAttemptId ||
            existing.child_owner_epoch !== input.childOwnerEpoch || existing.profile_id !== input.profileId ||
            existing.profile_revision !== input.profileRevision || existing.profile_digest !== input.profileDigest ||
            existing.permission_scope_digest !== input.permissionScopeDigest || existing.mailbox_capacity !== input.mailboxCapacity) {
            return yield* Effect.fail(new Error("request identity was reused with different payload or authority"))
          }
          return { row: existing, created: false }
        }
        const rows = yield* tx.select().from(DirectSubagentInboxTable).where(eq(
          DirectSubagentInboxTable.child_session_id,
          SessionID.make(input.childSessionId),
        )).all()
        if (rows.length >= DIRECT_SUBAGENT_INBOX_MAX_RECEIPTS_PER_CHILD) {
          return yield* Effect.fail(new Error("direct child message receipt limit is exhausted"))
        }
        const pendingStates = ["preparing", "approval_required", "admitted", "appended", "unknown", "delivering"]
        const pending = rows.filter((row) => pendingStates.includes(row.state) || (row.state === "consumed" && !row.host_consumed_ack_digest))
        if (pending.length >= Math.min(DIRECT_SUBAGENT_INBOX_MAX_PENDING, input.mailboxCapacity) ||
          pending.reduce((sum, row) => sum + row.payload_bytes, 0) + input.payloadBytes > Math.min(DIRECT_SUBAGENT_INBOX_MAX_PENDING, input.mailboxCapacity) * 16 * 1024) {
          return yield* Effect.fail(new Error("direct child inbox is full; entries are retained until consumed"))
        }
        let maxSequence = 0n
        for (const row of rows) {
          if (!/^[1-9][0-9]{0,19}$/.test(row.mailbox_sequence)) return yield* Effect.fail(new Error("direct child inbox sequence is malformed"))
          const value = BigInt(row.mailbox_sequence)
          if (value > maxSequence) maxSequence = value
        }
        const sequence = maxSequence + 1n
        if (sequence > 18_446_744_073_709_551_615n) return yield* Effect.fail(new Error("direct child inbox sequence is exhausted"))
        const now = Date.now()
        const inserted = yield* tx.insert(DirectSubagentInboxTable).values({
          message_id: input.messageId,
          parent_session_id: input.parentSessionId,
          child_session_id: input.childSessionId,
          request_id: input.requestId,
          payload: input.payload,
          payload_digest: input.payloadDigest,
          payload_bytes: input.payloadBytes,
          delivery_mode: input.deliveryMode,
          mailbox_sequence: sequence.toString(),
          child_attempt_id: input.childAttemptId,
          child_owner_epoch: input.childOwnerEpoch,
          profile_id: input.profileId,
          profile_revision: input.profileRevision,
          profile_digest: input.profileDigest,
          permission_scope_digest: input.permissionScopeDigest,
          pins_digest: input.inboxReceiptDigest,
          mailbox_capacity: input.mailboxCapacity,
          state: "preparing",
          challenge_id: null,
          effect_id: null,
          approval_expires_at_unix_ms: null,
          approval_argument_summary: null,
          approval_policy_summary: null,
          capability_lease_digest: null,
          host_receipt_digest: null,
          inbox_receipt_digest: input.inboxReceiptDigest,
          time_created: now,
          time_updated: now,
        }).onConflictDoNothing().returning().get()
        if (!inserted) return yield* Effect.fail(new Error("direct child inbox sequence raced; reconcile before retry"))
        return { row: inserted, created: true }
      }))
    })
    const directInboxTransition = Effect.fn("Session.directInboxTransition")(function* (input: {
      messageID: string
      expected: readonly DirectSubagentInboxStateV1[]
      state: DirectSubagentInboxStateV1
      challengeID?: string | null
      effectID?: string | null
      approvalExpiresAtUnixMs?: number | null
      approvalArgumentSummary?: string | null
      approvalPolicySummary?: string | null
      capabilityLeaseDigest?: string | null
      pinsDigest?: string | null
      hostReceiptDigest?: string | null
      inboxReceiptDigest?: string | null
      deliveryAttemptID?: string | null
      deliveryOwnerEpoch?: string | null
    }) {
      const current = yield* directInboxGet(input.messageID)
      if (!current) return yield* Effect.fail(new Error("direct child inbox entry is not found"))
      const hasProjectionUpdate = input.challengeID !== undefined || input.effectID !== undefined ||
        input.approvalExpiresAtUnixMs !== undefined || input.approvalArgumentSummary !== undefined ||
        input.approvalPolicySummary !== undefined || input.capabilityLeaseDigest !== undefined ||
        input.pinsDigest !== undefined || input.hostReceiptDigest !== undefined ||
        input.inboxReceiptDigest !== undefined || input.deliveryAttemptID !== undefined || input.deliveryOwnerEpoch !== undefined
      if (current.state === input.state && !hasProjectionUpdate) return current
      if (!input.expected.includes(current.state as DirectSubagentInboxStateV1)) {
        return yield* Effect.fail(new Error(`direct child inbox state ${current.state} cannot transition to ${input.state}`))
      }
      yield* db.update(DirectSubagentInboxTable).set({
        state: input.state,
        payload: input.state === "consumed" || input.state === "denied" ? "" : current.payload,
        challenge_id: input.challengeID === undefined ? current.challenge_id : input.challengeID,
        effect_id: input.effectID === undefined ? current.effect_id : input.effectID,
        approval_expires_at_unix_ms: input.approvalExpiresAtUnixMs === undefined ? current.approval_expires_at_unix_ms : input.approvalExpiresAtUnixMs,
        approval_argument_summary: input.approvalArgumentSummary === undefined ? current.approval_argument_summary : input.approvalArgumentSummary,
        approval_policy_summary: input.approvalPolicySummary === undefined ? current.approval_policy_summary : input.approvalPolicySummary,
        capability_lease_digest: input.capabilityLeaseDigest === undefined ? current.capability_lease_digest : input.capabilityLeaseDigest,
        // pins_digest / inbox_receipt_digest are NOT NULL in the direct inbox
        // table: a null projection value means "leave the durable pin unchanged".
        pins_digest: input.pinsDigest ?? current.pins_digest,
        host_receipt_digest: input.hostReceiptDigest === undefined ? current.host_receipt_digest : input.hostReceiptDigest,
        inbox_receipt_digest: input.inboxReceiptDigest ?? current.inbox_receipt_digest,
        delivery_attempt_id: input.deliveryAttemptID === undefined ? current.delivery_attempt_id : input.deliveryAttemptID,
        delivery_owner_epoch: input.deliveryOwnerEpoch === undefined ? current.delivery_owner_epoch : input.deliveryOwnerEpoch,
        time_updated: Date.now(),
      }).where(and(
        eq(DirectSubagentInboxTable.message_id, input.messageID),
        inArray(DirectSubagentInboxTable.state, [...input.expected]),
      )).run().pipe(Effect.orDie)
      const updated = yield* directInboxGet(input.messageID)
      if (!updated || updated.state !== input.state) return yield* Effect.fail(new Error("direct child inbox state changed concurrently"))
      return updated
    })
    const directInboxClaim = Effect.fn("Session.directInboxClaim")(function* (input: {
      childSessionID: SessionID
      attemptID: string
      ownerEpoch: string
      profileID: string
      profileRevision: string
      profileDigest: string
      permissionScopeDigest: string
      deliveryMode?: "queue" | "follow_up" | "any"
      triggerMessageID?: string
    }) {
      if (!/^att_[a-z0-9]{16,64}$/.test(input.attemptID) || !/^[1-9][0-9]{0,19}$/.test(input.ownerEpoch)) {
        return yield* Effect.fail(new Error("safe-boundary inbox claim requires a valid current DirectAttempt"))
      }
      return yield* db.transaction((tx) => Effect.gen(function* () {
        const selected = yield* tx.select().from(DirectSubagentInboxTable).where(and(
          eq(DirectSubagentInboxTable.child_session_id, input.childSessionID),
          eq(DirectSubagentInboxTable.state, "committed"),
          eq(DirectSubagentInboxTable.child_attempt_id, input.attemptID),
          eq(DirectSubagentInboxTable.child_owner_epoch, input.ownerEpoch),
          eq(DirectSubagentInboxTable.profile_id, input.profileID),
          eq(DirectSubagentInboxTable.profile_revision, input.profileRevision),
          eq(DirectSubagentInboxTable.profile_digest, input.profileDigest),
          eq(DirectSubagentInboxTable.permission_scope_digest, input.permissionScopeDigest),
        )).all()
        const mode = input.deliveryMode ?? "any"
        if (mode !== "queue" && mode !== "follow_up" && mode !== "any") {
          return yield* Effect.fail(new Error("safe-boundary inbox claim mode is invalid"))
        }
        const rows = selected
          .filter((row) => (mode === "any" || row.delivery_mode === mode) &&
            (row.delivery_mode !== "follow_up" || row.message_id === input.triggerMessageID))
          .sort((left, right) => {
            const a = BigInt(left.mailbox_sequence)
            const b = BigInt(right.mailbox_sequence)
            return a < b ? -1 : a > b ? 1 : 0
          })
          // One follow_up is one promised child turn. Queue entries can share a
          // naturally triggered turn, but cannot consume a turn on their own.
          .slice(0, mode === "follow_up" ? 1 : undefined)
        if (!rows.length) return []
        const updated: (typeof DirectSubagentInboxTable.$inferSelect)[] = []
        for (const row of rows) {
          const claimed = yield* tx.update(DirectSubagentInboxTable).set({
            state: "delivering",
            delivery_attempt_id: input.attemptID,
            delivery_owner_epoch: input.ownerEpoch,
            time_updated: Date.now(),
          }).where(and(
            eq(DirectSubagentInboxTable.message_id, row.message_id),
            eq(DirectSubagentInboxTable.state, "committed"),
          )).returning().get()
          if (!claimed) return yield* Effect.fail(new Error("safe-boundary inbox claim raced; no child prompt may start"))
          updated.push(claimed)
        }
        return updated
      }))
    })
    const directInboxConsume = Effect.fn("Session.directInboxConsume")(function* (input: {
      readonly rows: readonly { readonly messageID: string; readonly consumptionAckDigest: string }[]
      readonly promptMessageID: string
      readonly consumingAttemptID: string
      readonly consumingOwnerEpoch: string
      readonly consumingScopeDigest: string
      readonly consumingWorkspaceID: string
    }) {
      if (!/^msg[A-Za-z0-9._-]{1,256}$/.test(input.promptMessageID) ||
        !/^att_[a-z0-9]{16,64}$/.test(input.consumingAttemptID) ||
        !/^[1-9][0-9]{0,19}$/.test(input.consumingOwnerEpoch) ||
        !/^sha256:[0-9a-f]{64}$/.test(input.consumingScopeDigest) ||
        !/^[A-Za-z0-9._:-]{1,256}$/.test(input.consumingWorkspaceID) ||
        input.rows.length < 1 || input.rows.length > DIRECT_SUBAGENT_INBOX_MAX_PENDING ||
        input.rows.some((row) => !/^msg[A-Za-z0-9._-]{1,256}$/.test(row.messageID) || !/^sha256:[0-9a-f]{64}$/.test(row.consumptionAckDigest))) {
        return yield* Effect.fail(new Error("direct inbox consumption receipt has invalid bounds or authority"))
      }
      return yield* db.transaction((tx) => Effect.gen(function* () {
        const consumed: (typeof DirectSubagentInboxTable.$inferSelect)[] = []
        for (const proof of input.rows) {
          const current = yield* tx.select().from(DirectSubagentInboxTable).where(eq(DirectSubagentInboxTable.message_id, proof.messageID)).get()
          if (!current || current.state !== "delivering" || current.delivery_attempt_id !== input.consumingAttemptID ||
            current.delivery_owner_epoch !== input.consumingOwnerEpoch || current.child_owner_epoch !== input.consumingOwnerEpoch ||
            current.delivery_scope_digest !== null || current.consumption_ack_digest !== null) {
            return yield* Effect.fail(new Error("direct inbox consumption does not match a fresh safe-boundary claim"))
          }
          const updated = yield* tx.update(DirectSubagentInboxTable).set({
            state: "consumed",
            payload: "",
            delivery_prompt_message_id: input.promptMessageID,
            delivery_scope_digest: input.consumingScopeDigest,
            delivery_workspace_id: input.consumingWorkspaceID,
            consumption_ack_digest: proof.consumptionAckDigest,
            time_updated: Date.now(),
          }).where(and(
            eq(DirectSubagentInboxTable.message_id, proof.messageID),
            eq(DirectSubagentInboxTable.state, "delivering"),
            eq(DirectSubagentInboxTable.delivery_attempt_id, input.consumingAttemptID),
          )).returning().get()
          if (!updated) return yield* Effect.fail(new Error("direct inbox consumption raced; receipt was not persisted"))
          consumed.push(updated)
        }
        return consumed
      }))
    })
    const directInboxMarkHostConsumed = Effect.fn("Session.directInboxMarkHostConsumed")(function* (input: {
      readonly messageID: string
      readonly consumptionAckDigest: string
      readonly hostConsumedAckDigest: string
    }) {
      if (!/^sha256:[0-9a-f]{64}$/.test(input.consumptionAckDigest) || !/^blake3:[0-9a-f]{64}$/.test(input.hostConsumedAckDigest)) {
        return yield* Effect.fail(new Error("HostKernel consumption receipt has an invalid digest"))
      }
      const current = yield* directInboxGet(input.messageID)
      if (!current || current.state !== "consumed" || current.consumption_ack_digest !== input.consumptionAckDigest) {
        return yield* Effect.fail(new Error("HostKernel consumption receipt does not match durable Core consumption"))
      }
      if (current.host_consumed_ack_digest && current.host_consumed_ack_digest !== input.hostConsumedAckDigest) {
        return yield* Effect.fail(new Error("HostKernel consumption receipt conflicts with the durable Core receipt"))
      }
      yield* db.update(DirectSubagentInboxTable).set({ host_consumed_ack_digest: input.hostConsumedAckDigest, time_updated: Date.now() })
        .where(and(eq(DirectSubagentInboxTable.message_id, input.messageID), eq(DirectSubagentInboxTable.state, "consumed"), eq(DirectSubagentInboxTable.consumption_ack_digest, input.consumptionAckDigest))).run().pipe(Effect.orDie)
    })

    const managedInboxGetByRequest = Effect.fn("Session.managedInboxGetByRequest")(function* (input: {
      readonly parentSessionID: SessionID
      readonly childSessionID: SessionID
      readonly requestID: string
    }) {
      return yield* db.select().from(ManagedSubagentInboxTable).where(and(
        eq(ManagedSubagentInboxTable.parent_session_id, input.parentSessionID),
        eq(ManagedSubagentInboxTable.child_session_id, input.childSessionID),
        eq(ManagedSubagentInboxTable.request_id, input.requestID),
      )).get().pipe(Effect.orDie)
    })
    const managedInboxGet = Effect.fn("Session.managedInboxGet")(function* (messageID: string) {
      return yield* db.select().from(ManagedSubagentInboxTable).where(eq(ManagedSubagentInboxTable.message_id, messageID)).get().pipe(Effect.orDie)
    })
    const managedInboxList = Effect.fn("Session.managedInboxList")(function* (attemptID: string) {
      // The reader interface is infallible: a malformed Attempt identity is an
      // invariant violation, so it defects instead of opening a query.
      if (!/^attempt_[0-9a-f]{64}$/.test(attemptID)) return yield* Effect.die(new Error("managed inbox Attempt ID is invalid"))
      return yield* db.select().from(ManagedSubagentInboxTable).where(eq(ManagedSubagentInboxTable.attempt_id, attemptID)).all().pipe(Effect.orDie)
    })
    const managedInboxCreateDraft = Effect.fn("Session.managedInboxCreateDraft")(function* (input: ManagedSubagentInboxDraftV1) {
      const id = /^[A-Za-z0-9._:-]{1,256}$/
      const digest = /^blake3:[0-9a-f]{64}$/
      if (input.parentSessionID === input.childSessionID || !id.test(input.messageID) || !id.test(input.requestID) ||
        !id.test(input.goalID) || !id.test(input.runID) || !id.test(input.taskID) ||
        !/^attempt_[0-9a-f]{64}$/.test(input.attemptID) || !/^[1-9][0-9]{0,19}$/.test(input.ownerEpoch) ||
        !digest.test(input.bindingDigest) || !/^[A-Za-z0-9._-]{1,128}$/.test(input.profileID) ||
        !/^[1-9][0-9]{0,19}$/.test(input.profileRevision) || !digest.test(input.profileDigest) ||
        !/^(sha256|blake3):[0-9a-f]{64}$/.test(input.permissionScopeDigest) ||
        !/^sha256:[0-9a-f]{64}$/.test(input.payloadDigest) ||
        input.payloadBytes !== Buffer.byteLength(input.payload, "utf8") || input.payloadBytes < 1 || input.payloadBytes > 16 * 1024 ||
        (input.deliveryMode !== "queued" && input.deliveryMode !== "follow_up") ||
        !Number.isSafeInteger(input.mailboxCapacity) || input.mailboxCapacity < 1 || input.mailboxCapacity > 32) {
        return yield* Effect.fail(new Error("managed inbox draft has invalid HostKernel authority pins or payload bounds"))
      }
      return yield* db.transaction((tx) => Effect.gen(function* () {
        const existing = yield* tx.select().from(ManagedSubagentInboxTable).where(and(
          eq(ManagedSubagentInboxTable.parent_session_id, input.parentSessionID),
          eq(ManagedSubagentInboxTable.child_session_id, input.childSessionID),
          eq(ManagedSubagentInboxTable.request_id, input.requestID),
        )).get()
        if (existing) {
          if (existing.message_id !== input.messageID || existing.goal_id !== input.goalID ||
            existing.run_id !== input.runID || existing.task_id !== input.taskID || existing.attempt_id !== input.attemptID ||
            existing.owner_epoch !== input.ownerEpoch || existing.binding_digest !== input.bindingDigest ||
            existing.profile_id !== input.profileID || existing.profile_revision !== input.profileRevision ||
            existing.profile_digest !== input.profileDigest || existing.permission_scope_digest !== input.permissionScopeDigest ||
            existing.payload_digest !== input.payloadDigest || existing.payload_bytes !== input.payloadBytes ||
            (existing.payload !== "" && existing.payload !== input.payload) || existing.delivery_mode !== input.deliveryMode ||
            existing.mailbox_capacity !== input.mailboxCapacity) {
            return yield* Effect.fail(new Error("managed message request identity was reused with different content or authority"))
          }
          return { row: existing, created: false, inboxReceiptDigest: existing.inbox_receipt_digest }
        }
        const rows = yield* tx.select().from(ManagedSubagentInboxTable).where(eq(
          ManagedSubagentInboxTable.attempt_id, input.attemptID,
        )).all()
        if (rows.length >= MANAGED_SUBAGENT_INBOX_MAX_RECEIPTS_PER_ATTEMPT) {
          return yield* Effect.fail(new Error("managed child message receipt limit is exhausted"))
        }
        const pendingStates = ["preparing", "approval_required", "admitted", "appended", "committed", "unknown", "delivering"]
        const pending = rows.filter((row) => pendingStates.includes(row.state))
        const capacity = Math.min(MANAGED_SUBAGENT_INBOX_MAX_PENDING, input.mailboxCapacity)
        if (pending.length >= capacity || pending.reduce((sum, row) => sum + row.payload_bytes, 0) + input.payloadBytes > capacity * 16 * 1024) {
          return yield* Effect.fail(new Error("managed child inbox is full; unresolved messages remain retained"))
        }
        let maxSequence = 0n
        for (const row of rows) {
          if (!/^[1-9][0-9]{0,19}$/.test(row.mailbox_sequence)) return yield* Effect.fail(new Error("managed inbox sequence is malformed"))
          const sequence = BigInt(row.mailbox_sequence)
          if (sequence > maxSequence) maxSequence = sequence
        }
        const sequence = maxSequence + 1n
        if (sequence > 1024n) return yield* Effect.fail(new Error("managed Attempt message sequence exceeds HostKernel bounds"))
        const mailboxSequence = sequence.toString()
        const inboxReceiptDigest = managedMessageInboxReceiptDigest({ ...input, mailboxSequence })
        const now = Date.now()
        const inserted = yield* tx.insert(ManagedSubagentInboxTable).values({
          message_id: input.messageID,
          parent_session_id: input.parentSessionID,
          child_session_id: input.childSessionID,
          request_id: input.requestID,
          goal_id: input.goalID,
          run_id: input.runID,
          task_id: input.taskID,
          attempt_id: input.attemptID,
          owner_epoch: input.ownerEpoch,
          binding_digest: input.bindingDigest,
          profile_id: input.profileID,
          profile_revision: input.profileRevision,
          profile_digest: input.profileDigest,
          permission_scope_digest: input.permissionScopeDigest,
          payload: input.payload,
          payload_digest: input.payloadDigest,
          payload_bytes: input.payloadBytes,
          delivery_mode: input.deliveryMode === "queued" ? "queue" : "follow_up",
          mailbox_sequence: mailboxSequence,
          mailbox_capacity: input.mailboxCapacity,
          pins_digest: null,
          inbox_receipt_digest: inboxReceiptDigest,
          state: "preparing",
          challenge_id: null,
          effect_id: null,
          capability_lease_digest: null,
          host_receipt_digest: null,
          completed_turn_receipt_digest: null,
          wake_receipt_digest: null,
          next_request_sequence: null,
          delivery_owner_epoch: null,
          delivery_attempt_id: null,
          time_created: now,
          time_updated: now,
        }).onConflictDoNothing().returning().get()
        if (!inserted) return yield* Effect.fail(new Error("managed child inbox sequence raced; inspect before retry"))
        return { row: inserted, created: true, inboxReceiptDigest }
      }))
    })
    const managedInboxClaim = Effect.fn("Session.managedInboxClaim")(function* (input: {
      readonly attemptID: string
      readonly ownerEpoch: string
      readonly profileID: string
      readonly profileRevision: string
      readonly profileDigest: string
      readonly permissionScopeDigest: string
      readonly scopeDigest: string
      readonly workspaceID: string
      readonly workspaceRevision: string
      readonly deliveryMode: "queued" | "follow_up"
      readonly triggerMessageID?: string
    }) {
      const digest = /^(sha256|blake3):[0-9a-f]{64}$/
      if (!/^attempt_[0-9a-f]{64}$/.test(input.attemptID) || !/^[1-9][0-9]{0,19}$/.test(input.ownerEpoch) ||
        !/^[A-Za-z0-9._-]{1,128}$/.test(input.profileID) || !/^[1-9][0-9]{0,19}$/.test(input.profileRevision) ||
        !/^blake3:[0-9a-f]{64}$/.test(input.profileDigest) || !digest.test(input.permissionScopeDigest) ||
        !digest.test(input.scopeDigest) || !/^[A-Za-z0-9._:-]{1,256}$/.test(input.workspaceID) ||
        !digest.test(input.workspaceRevision) || (input.deliveryMode === "follow_up" &&
          (typeof input.triggerMessageID !== "string" || !/^[A-Za-z0-9._:-]{1,256}$/.test(input.triggerMessageID)))) {
        return yield* Effect.fail(new Error("managed inbox claim requires the exact authenticated live Attempt scope"))
      }
      return yield* db.transaction((tx) => Effect.gen(function* () {
        const rows = yield* tx.select().from(ManagedSubagentInboxTable).where(and(
          eq(ManagedSubagentInboxTable.attempt_id, input.attemptID),
          eq(ManagedSubagentInboxTable.state, "committed"),
        )).all()
        const selected = rows.filter((row) => row.delivery_mode === (input.deliveryMode === "queued" ? "queue" : "follow_up") &&
          row.owner_epoch === input.ownerEpoch && row.profile_id === input.profileID && row.profile_revision === input.profileRevision &&
          row.profile_digest === input.profileDigest && row.permission_scope_digest === input.permissionScopeDigest &&
          row.host_receipt_digest !== null && row.capability_lease_digest !== null &&
          (input.deliveryMode !== "follow_up" || row.message_id === input.triggerMessageID &&
            row.completed_turn_receipt_digest !== null && row.wake_receipt_digest !== null && row.next_request_sequence !== null &&
            row.wake_claim_request_id !== null && row.wake_claim_digest !== null && row.wake_claim_scope_digest !== null &&
            row.wake_claim_receipt_digest !== null))
          .sort((left, right) => BigInt(left.mailbox_sequence) < BigInt(right.mailbox_sequence) ? -1 :
            BigInt(left.mailbox_sequence) > BigInt(right.mailbox_sequence) ? 1 : 0)
          .slice(0, input.deliveryMode === "follow_up" ? 1 : MANAGED_SUBAGENT_INBOX_MAX_PENDING)
        const claimed: ManagedSubagentInboxRowV1[] = []
        for (const row of selected) {
          const updated = yield* tx.update(ManagedSubagentInboxTable).set({
            state: "delivering",
            delivery_attempt_id: input.attemptID,
            delivery_owner_epoch: input.ownerEpoch,
            delivery_scope_digest: input.scopeDigest,
            delivery_workspace_id: input.workspaceID,
            delivery_workspace_revision: input.workspaceRevision,
            time_updated: Date.now(),
          }).where(and(eq(ManagedSubagentInboxTable.message_id, row.message_id),
            eq(ManagedSubagentInboxTable.state, "committed"))).returning().get()
          if (!updated) return yield* Effect.fail(new Error("managed inbox claim raced; no model prompt may start"))
          claimed.push(updated)
        }
        return claimed
      }))
    })
    const managedInboxRecordWakeClaim = Effect.fn("Session.managedInboxRecordWakeClaim")(function* (input: {
      readonly messageID: string
      readonly requestID: string
      readonly nextRequestSequence: string
      readonly inboxReceiptDigest: string
      readonly completedTurnReceiptDigest: string
      readonly wakeReceiptDigest: string
      readonly wakeClaimDigest: string
      readonly wakeClaimScopeDigest: string
      readonly wakeClaimReceiptDigest: string
    }) {
      if (!/^msg[A-Za-z0-9._-]{1,256}$/.test(input.messageID) || !/^[A-Za-z0-9._:-]{1,256}$/.test(input.requestID) ||
        !/^[1-9][0-9]{0,19}$/.test(input.nextRequestSequence) || !/^sha256:[0-9a-f]{64}$/.test(input.wakeClaimDigest) ||
        !/^sha256:[0-9a-f]{64}$/.test(input.inboxReceiptDigest) ||
        !/^blake3:[0-9a-f]{64}$/.test(input.completedTurnReceiptDigest) ||
        !/^blake3:[0-9a-f]{64}$/.test(input.wakeReceiptDigest) ||
        !/^blake3:[0-9a-f]{64}$/.test(input.wakeClaimScopeDigest) || !/^blake3:[0-9a-f]{64}$/.test(input.wakeClaimReceiptDigest)) {
        return yield* Effect.fail(new Error("managed wake claim receipt has invalid pins"))
      }
      return yield* db.transaction((tx) => Effect.gen(function* () {
        const current = yield* tx.select().from(ManagedSubagentInboxTable)
          .where(eq(ManagedSubagentInboxTable.message_id, input.messageID)).get()
        if (!current || current.state !== "committed" || current.delivery_mode !== "follow_up" ||
          current.inbox_receipt_digest !== input.inboxReceiptDigest ||
          current.completed_turn_receipt_digest !== input.completedTurnReceiptDigest ||
          current.wake_receipt_digest !== input.wakeReceiptDigest ||
          current.completed_turn_receipt_digest === null || current.wake_receipt_digest === null ||
          current.next_request_sequence !== input.nextRequestSequence) {
          return yield* Effect.fail(new Error("managed wake claim differs from a committed one-use follow-up"))
        }
        if (current.wake_claim_receipt_digest !== null) {
          if (current.wake_claim_request_id === input.requestID && current.inbox_receipt_digest === input.inboxReceiptDigest &&
            current.completed_turn_receipt_digest === input.completedTurnReceiptDigest &&
            current.wake_receipt_digest === input.wakeReceiptDigest && current.wake_claim_digest === input.wakeClaimDigest &&
            current.wake_claim_scope_digest === input.wakeClaimScopeDigest &&
            current.wake_claim_receipt_digest === input.wakeClaimReceiptDigest) return current
          return yield* Effect.fail(new Error("managed wake was already claimed with different request or scope pins"))
        }
        const updated = yield* tx.update(ManagedSubagentInboxTable).set({
          wake_claim_request_id: input.requestID,
          wake_claim_digest: input.wakeClaimDigest,
          wake_claim_scope_digest: input.wakeClaimScopeDigest,
          wake_claim_receipt_digest: input.wakeClaimReceiptDigest,
          time_updated: Date.now(),
        }).where(and(eq(ManagedSubagentInboxTable.message_id, input.messageID),
          eq(ManagedSubagentInboxTable.state, "committed"), eq(ManagedSubagentInboxTable.delivery_mode, "follow_up"),
          isNull(ManagedSubagentInboxTable.wake_claim_receipt_digest))).returning().get()
        if (!updated) return yield* Effect.fail(new Error("managed wake claim changed concurrently"))
        return updated
      }))
    })
    const managedInboxConsume = Effect.fn("Session.managedInboxConsume")(function* (proofs: readonly ManagedSubagentConsumptionProofV1[]) {
      if (proofs.length < 1 || proofs.length > MANAGED_SUBAGENT_INBOX_MAX_PENDING) {
        return yield* Effect.fail(new Error("managed inbox consumption batch exceeds its bound"))
      }
      return yield* db.transaction((tx) => Effect.gen(function* () {
        const consumed: ManagedSubagentInboxRowV1[] = []
        for (const proof of proofs) {
          const digest = /^(sha256|blake3):[0-9a-f]{64}$/
          if (!/^[A-Za-z0-9._:-]{1,256}$/.test(proof.messageID) || !/^sha256:[0-9a-f]{64}$/.test(proof.inboxReceiptDigest) ||
            !/^[A-Za-z0-9._:-]{1,256}$/.test(proof.parentSessionID) || !/^[A-Za-z0-9._:-]{1,256}$/.test(proof.childSessionID) ||
            !/^[A-Za-z0-9._:-]{1,256}$/.test(proof.goalID) || !/^[A-Za-z0-9._:-]{1,256}$/.test(proof.runID) ||
            !/^[A-Za-z0-9._:-]{1,256}$/.test(proof.taskID) || !/^attempt_[0-9a-f]{64}$/.test(proof.attemptID) ||
            !/^[1-9][0-9]{0,19}$/.test(proof.mailboxSequence) || (proof.deliveryMode !== "queued" && proof.deliveryMode !== "follow_up") ||
            !/^msg[A-Za-z0-9._-]{1,256}$/.test(proof.promptMessageID) || !/^attempt_[0-9a-f]{64}$/.test(proof.consumingAttemptID) ||
            !/^[1-9][0-9]{0,19}$/.test(proof.consumingOwnerEpoch) || !/^[A-Za-z0-9._:-]{1,256}$/.test(proof.consumingRequestID) ||
            !/^[1-9][0-9]{0,19}$/.test(proof.consumingRequestSequence) || !digest.test(proof.deliveryScopeDigest) ||
            !digest.test(proof.consumingScopeDigest) ||
            !/^[A-Za-z0-9._:-]{1,256}$/.test(proof.consumingWorkspaceID) || !digest.test(proof.consumingWorkspaceRevision) ||
            !/^sha256:[0-9a-f]{64}$/.test(proof.consumedPayloadDigest) || !/^sha256:[0-9a-f]{64}$/.test(proof.consumptionAckDigest) ||
            (proof.completedTurnReceiptDigest !== undefined && !digest.test(proof.completedTurnReceiptDigest)) ||
            (proof.wakeReceiptDigest !== undefined && !digest.test(proof.wakeReceiptDigest)) ||
            (proof.wakeClaimReceiptDigest !== undefined && !/^blake3:[0-9a-f]{64}$/.test(proof.wakeClaimReceiptDigest)) ||
            (proof.nextRequestSequence !== undefined && !/^[1-9][0-9]{0,19}$/.test(proof.nextRequestSequence))) {
            return yield* Effect.fail(new Error("managed inbox consumption receipt has invalid bounds or authority"))
          }
          const { consumptionAckDigest: _ack, ...digestInput } = proof
          if (managedMessageConsumptionAckDigest(digestInput) !== proof.consumptionAckDigest) {
            return yield* Effect.fail(new Error("managed inbox consumption proof digest does not match its fields"))
          }
          const current = yield* tx.select().from(ManagedSubagentInboxTable).where(eq(ManagedSubagentInboxTable.message_id, proof.messageID)).get()
          if (current?.state === "consumed") {
            const stored = current.consumption_proof_json
            if (current.consumption_ack_digest !== proof.consumptionAckDigest || !stored || stored !== JSON.stringify(proof)) {
              return yield* Effect.fail(new Error("managed inbox consumed proof replay differs from the exact durable safe-boundary receipt"))
            }
            consumed.push(current)
            continue
          }
          if (!current || current.state !== "delivering" || current.delivery_attempt_id !== proof.consumingAttemptID ||
            current.parent_session_id !== proof.parentSessionID || current.child_session_id !== proof.childSessionID ||
            current.delivery_mode !== (proof.deliveryMode === "queued" ? "queue" : "follow_up") || current.goal_id !== proof.goalID ||
            current.run_id !== proof.runID || current.task_id !== proof.taskID || current.attempt_id !== proof.attemptID ||
            current.mailbox_sequence !== proof.mailboxSequence || current.delivery_scope_digest !== proof.deliveryScopeDigest ||
            current.delivery_owner_epoch !== proof.consumingOwnerEpoch || current.owner_epoch !== proof.consumingOwnerEpoch ||
            current.delivery_workspace_id !== proof.consumingWorkspaceID ||
            current.delivery_workspace_revision !== proof.consumingWorkspaceRevision || current.inbox_receipt_digest !== proof.inboxReceiptDigest ||
            current.payload_digest !== proof.consumedPayloadDigest || current.payload === "" || current.delivery_prompt_message_id !== null ||
            current.consumption_ack_digest !== null || current.host_receipt_digest === null) {
            return yield* Effect.fail(new Error("managed inbox consume proof does not match its unique safe-boundary claim"))
          }
          if (current.delivery_mode === "queue" && (proof.completedTurnReceiptDigest !== undefined || proof.wakeReceiptDigest !== undefined ||
              proof.wakeClaimReceiptDigest !== undefined || proof.nextRequestSequence !== undefined) ||
            current.delivery_mode === "follow_up" && (proof.completedTurnReceiptDigest !== current.completed_turn_receipt_digest ||
              proof.wakeReceiptDigest !== current.wake_receipt_digest || proof.nextRequestSequence !== current.next_request_sequence ||
              proof.wakeClaimReceiptDigest !== current.wake_claim_receipt_digest || proof.consumingRequestID !== current.wake_claim_request_id ||
              proof.consumingRequestSequence !== current.next_request_sequence || !current.wake_claim_digest || !current.wake_claim_scope_digest ||
              !current.wake_claim_receipt_digest || !current.wake_claim_request_id)) {
            return yield* Effect.fail(new Error("managed inbox consumption differs from its queued mode or one-use wake pins"))
          }
          const updated = yield* tx.update(ManagedSubagentInboxTable).set({
            state: "consumed", payload: "", delivery_prompt_message_id: proof.promptMessageID,
            consumption_ack_digest: proof.consumptionAckDigest, consumption_proof_json: JSON.stringify(proof), time_updated: Date.now(),
          }).where(and(eq(ManagedSubagentInboxTable.message_id, proof.messageID),
            eq(ManagedSubagentInboxTable.state, "delivering"),
            eq(ManagedSubagentInboxTable.delivery_attempt_id, proof.consumingAttemptID))).returning().get()
          if (!updated) return yield* Effect.fail(new Error("managed inbox consumption raced; acknowledgement was not persisted"))
          consumed.push(updated)
        }
        return consumed
      }))
    })
    const managedInboxMarkHostConsumed = Effect.fn("Session.managedInboxMarkHostConsumed")(function* (input: {
      readonly messageID: string
      readonly consumptionAckDigest: string
      readonly hostConsumedAckDigest: string
    }) {
      if (!/^sha256:[0-9a-f]{64}$/.test(input.consumptionAckDigest) || !/^blake3:[0-9a-f]{64}$/.test(input.hostConsumedAckDigest)) {
        return yield* Effect.fail(new Error("managed HostKernel consumption receipt has an invalid digest"))
      }
      yield* db.transaction((tx) => Effect.gen(function* () {
        const current = yield* tx.select().from(ManagedSubagentInboxTable)
          .where(eq(ManagedSubagentInboxTable.message_id, input.messageID)).get()
        if (!current || current.state !== "consumed" || current.consumption_ack_digest !== input.consumptionAckDigest) {
          return yield* Effect.fail(new Error("HostKernel consumption receipt does not match durable Core consumption"))
        }
        if (current.host_consumed_ack_digest && current.host_consumed_ack_digest !== input.hostConsumedAckDigest) {
          return yield* Effect.fail(new Error("HostKernel consumption receipt conflicts with the durable Core receipt"))
        }
        if (!current.host_consumed_ack_digest) {
          const updated = yield* tx.update(ManagedSubagentInboxTable)
            .set({ host_consumed_ack_digest: input.hostConsumedAckDigest, time_updated: Date.now() })
            .where(and(eq(ManagedSubagentInboxTable.message_id, input.messageID), eq(ManagedSubagentInboxTable.state, "consumed"),
              eq(ManagedSubagentInboxTable.consumption_ack_digest, input.consumptionAckDigest),
              isNull(ManagedSubagentInboxTable.host_consumed_ack_digest))).returning().get()
          if (!updated) return yield* Effect.fail(new Error("HostKernel consumption receipt changed concurrently"))
        }
      }))
    })
    const managedInboxTransition = Effect.fn("Session.managedInboxTransition")(function* (input: {
      readonly messageID: string
      readonly expected: readonly ManagedSubagentInboxStateV1[]
      readonly state: ManagedSubagentInboxStateV1
      readonly challengeID?: string | null
      readonly effectID?: string | null
      readonly pinsDigest?: string | null
      readonly capabilityLeaseDigest?: string | null
      readonly hostReceiptDigest?: string | null
      readonly completedTurnReceiptDigest?: string | null
      readonly wakeReceiptDigest?: string | null
      readonly nextRequestSequence?: string | null
      readonly deliveryOwnerEpoch?: string | null
      readonly deliveryAttemptID?: string | null
    }) {
      const current = yield* managedInboxGet(input.messageID)
      if (!current) return yield* Effect.fail(new Error("managed child inbox entry is not found"))
      const transitions: Readonly<Record<ManagedSubagentInboxStateV1, readonly ManagedSubagentInboxStateV1[]>> = {
        preparing: ["approval_required", "admitted", "unknown", "denied"],
        approval_required: ["approval_required", "admitted", "unknown", "denied"],
        admitted: ["appended", "unknown"],
        appended: ["committed", "unknown"],
        committed: ["unknown"],
        delivering: ["unknown"],
        consumed: [], unknown: ["committed"], denied: [],
      }
      if (input.state === "delivering" || input.state === "consumed") {
        return yield* Effect.fail(new Error("managed inbox delivery claims and consumption require their proof-bound atomic APIs"))
      }
      if (current.state !== input.state && !transitions[current.state as ManagedSubagentInboxStateV1]?.includes(input.state)) {
        return yield* Effect.fail(new Error(`managed inbox state ${current.state} cannot transition to ${input.state}`))
      }
      if (current.state === input.state && input.expected.includes(current.state as ManagedSubagentInboxStateV1) &&
        input.pinsDigest === undefined && input.capabilityLeaseDigest === undefined && input.hostReceiptDigest === undefined &&
        input.wakeReceiptDigest === undefined && input.nextRequestSequence === undefined) return current
      if (!input.expected.includes(current.state as ManagedSubagentInboxStateV1)) {
        return yield* Effect.fail(new Error(`managed inbox state ${current.state} cannot transition to ${input.state}`))
      }
      if (input.state === "committed" && (!current.capability_lease_digest || !current.inbox_receipt_digest || !input.hostReceiptDigest)) {
        return yield* Effect.fail(new Error("managed inbox commit requires retained Guard lease, exact Core receipt and HostKernel ACK"))
      }
      // "delivering"/"consumed" were already rejected above: those states are
      // reachable only through their proof-bound atomic APIs.
      if (input.state === "committed" && current.delivery_mode === "follow_up" &&
        (!input.completedTurnReceiptDigest || !input.wakeReceiptDigest || !input.nextRequestSequence)) {
        return yield* Effect.fail(new Error("managed follow-up ACK requires the exact one-use wake receipt"))
      }
      if (input.state === "committed" && current.delivery_mode === "queue" &&
        (input.completedTurnReceiptDigest != null || input.wakeReceiptDigest != null || input.nextRequestSequence != null)) {
        return yield* Effect.fail(new Error("queued managed messages cannot consume a turn receipt or schedule a wake"))
      }
      const updated = yield* db.update(ManagedSubagentInboxTable).set({
        state: input.state,
        payload: ["consumed", "denied", "unknown"].includes(input.state) ? "" : current.payload,
        challenge_id: input.challengeID === undefined ? current.challenge_id : input.challengeID,
        effect_id: input.effectID === undefined ? current.effect_id : input.effectID,
        pins_digest: input.pinsDigest === undefined ? current.pins_digest : input.pinsDigest,
        capability_lease_digest: input.capabilityLeaseDigest === undefined ? current.capability_lease_digest : input.capabilityLeaseDigest,
        host_receipt_digest: input.hostReceiptDigest === undefined ? current.host_receipt_digest : input.hostReceiptDigest,
        completed_turn_receipt_digest: input.completedTurnReceiptDigest === undefined ? current.completed_turn_receipt_digest : input.completedTurnReceiptDigest,
        wake_receipt_digest: input.wakeReceiptDigest === undefined ? current.wake_receipt_digest : input.wakeReceiptDigest,
        next_request_sequence: input.nextRequestSequence === undefined ? current.next_request_sequence : input.nextRequestSequence,
        delivery_owner_epoch: input.deliveryOwnerEpoch === undefined ? current.delivery_owner_epoch : input.deliveryOwnerEpoch,
        delivery_attempt_id: input.deliveryAttemptID === undefined ? current.delivery_attempt_id : input.deliveryAttemptID,
        time_updated: Date.now(),
      }).where(and(eq(ManagedSubagentInboxTable.message_id, input.messageID), inArray(ManagedSubagentInboxTable.state, [...input.expected]))).returning().get().pipe(Effect.orDie)
      if (!updated) return yield* Effect.fail(new Error("managed child inbox state changed concurrently"))
      return updated
    })

    return Service.of({
      list,
      listGlobal,
      create,
      fork,
      touch,
      get,
      managedRootSessionLink,
      managedChildSessionCompletion,
      managedChildSessionRecoveryObservation,
      setTitle,
      setArchived,
      setMetadata,
      directInboxGetByRequest,
      directInboxGet,
      directInboxList,
      directInboxCreateDraft,
      directInboxClaim,
      directInboxConsume,
      directInboxMarkHostConsumed,
      directInboxTransition,
      managedInboxGetByRequest,
      managedInboxGet,
      managedInboxList,
      managedInboxCreateDraft,
      managedInboxClaim,
      managedInboxRecordWakeClaim,
      managedInboxConsume,
      managedInboxMarkHostConsumed,
      managedInboxTransition,
      setAgentModel,
      setPermission,
      setRevert,
      clearRevert,
      setSummary,
      setShare,
      setWorkspace,
      diff,
      messages,
      children,
      remove,
      updateMessage,
      removeMessage,
      removePart,
      updatePart,
      getPart,
      updatePartDelta,
      findMessage,
    })
  }),
)

const cancelBackgroundJobs = Effect.fn("Session.cancelBackgroundJobs")(function* (
  background: BackgroundJob.Interface,
  sessionID: SessionID,
) {
  const jobs = yield* background.list()
  yield* Effect.forEach(
    jobs.filter((job) => {
      if (job.status !== "running") return false
      if (job.id === sessionID) return true
      if (job.metadata?.sessionId === sessionID) return true
      return job.metadata?.parentSessionId === sessionID
    }),
    (job) => background.cancel(job.id),
    { concurrency: "unbounded", discard: true },
  )
})

function listByProject(
  db: Database.Interface["db"],
  input: ListInput & {
    projectID: ProjectV2.ID
    experimentalWorkspaces: boolean
  },
) {
  const conditions = [eq(SessionTable.project_id, input.projectID)]

  if (input.workspaceID) {
    conditions.push(eq(SessionTable.workspace_id, input.workspaceID))
  }
  if (input.path !== undefined) {
    if (input.path) {
      const conds = [
        eq(SessionTable.path, input.path),
        like(SessionTable.path, sql.param(`${input.path}/%`, SessionTable.path)),
      ]

      conditions.push(
        input.directory
          ? or(...conds, and(isNull(SessionTable.path), eq(SessionTable.directory, input.directory))!)!
          : or(...conds)!,
      )
    }
  } else if (input.scope !== "project") {
    if (input.directory) {
      conditions.push(eq(SessionTable.directory, input.directory))
    }
  }
  if (input.roots) {
    conditions.push(isNull(SessionTable.parent_id))
  }
  if (input.start) {
    conditions.push(gte(SessionTable.time_updated, input.start))
  }
  if (input.search) {
    conditions.push(like(SessionTable.title, `%${input.search}%`))
  }

  const limit = input.limit ?? 100

  return db
    .select()
    .from(SessionTable)
    .where(and(...conditions))
    .orderBy(desc(SessionTable.time_updated))
    .limit(limit)
    .all()
    .pipe(
      Effect.orDie,
      Effect.map((rows) => rows.map(fromRow)),
    )
}

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [BackgroundJob.node, RuntimeFlags.node, Database.node, EventV2Bridge.node, SessionSupervisor.node, SessionStatus.node],
})

export * as Session from "./session"
