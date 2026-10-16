import { Schema } from "effect"
import { PositiveInt } from "@opencode-ai/core/schema"

/**
 * LanguageServiceBrokerV1 — language-service identity, routing policy and the
 * generation/stale-reference lifecycle (§30.14 LanguageServiceBroker,
 * §37.6 LanguageServiceBrokerV1).
 *
 * Scope of this module: bookkeeping and fail-closed decisions only. It must
 * never spawn a language server, install a package, restart/kill an
 * editor-owned server or mutate a file. Every server-backed operation is
 * reported and enforced as UNAVAILABLE until the Rust Guard/ExecutionHost
 * mediation for this origin is implemented and independently verified; callers
 * must fall back to parser/lexical tools (RepoIntel) or surface the limitation.
 *
 * What stays unavailable in this module (fail-closed, not policy-dependent):
 * - `server.spawn` / `server.install` / `server.restart` / `server.stop`
 *   require process effects that have no Guard-verified route yet;
 * - `code_action.prepare` / `rename.prepare` must produce Guard-bound
 *   versioned edits before they may run;
 * - no authenticated editor-ingress adapter exists in this codebase, so no
 *   `editor` source can be attached in production. The `editor` routing and
 *   reuse rules are implemented here so a future authenticated ingress can
 *   reuse them unchanged, but creating the ingress is not this module's job.
 *
 * Read-only queries (`query.*`, `diagnostics.pull`) are allowed against a
 * live, current generation snapshot; there is currently no production path
 * that registers one, so they also report `source_absent` today.
 *
 * Applying prepared edits is deliberately NOT part of this module: mutations
 * belong to the canonical file effect (`files.patch`/Guard), never to the
 * language-service broker.
 */

export const SourceKind = Schema.Literals(["editor", "supervised", "external"])
export type SourceKind = typeof SourceKind.Type

export const EditorSource = Schema.Struct({
  kind: Schema.Literal("editor"),
  clientId: Schema.String,
  serverName: Schema.String,
}).annotate({ identifier: "LanguageServiceEditorSourceV1" })
export type EditorSource = typeof EditorSource.Type

export const SupervisedSource = Schema.Struct({
  kind: Schema.Literal("supervised"),
  executionId: Schema.String,
  serverName: Schema.String,
}).annotate({ identifier: "LanguageServiceSupervisedSourceV1" })
export type SupervisedSource = typeof SupervisedSource.Type

export const ExternalSource = Schema.Struct({
  kind: Schema.Literal("external"),
  adapterId: Schema.String,
  serverName: Schema.String,
}).annotate({ identifier: "LanguageServiceExternalSourceV1" })
export type ExternalSource = typeof ExternalSource.Type

export const Source = Schema.Union([EditorSource, SupervisedSource, ExternalSource]).annotate({
  identifier: "LanguageServiceSourceV1",
})
export type Source = typeof Source.Type

export const Health = Schema.Literals(["starting", "healthy", "degraded", "failed"])
export type Health = typeof Health.Type

/**
 * Identity key material for a language service (§37.6): workspace + language +
 * root + configuration digest + executable/version + owner type.
 */
export const Identity = Schema.Struct({
  workspaceId: Schema.String,
  languageId: Schema.String,
  rootUri: Schema.String,
  configurationDigest: Schema.String,
  executable: Schema.String,
  owner: SourceKind,
}).annotate({ identifier: "LanguageServiceIdentityV1" })
export type Identity = typeof Identity.Type

export function executableOf(source: Source): string {
  switch (source.kind) {
    case "editor":
      return `editor:${source.serverName}`
    case "supervised":
      return `supervised:${source.serverName}`
    case "external":
      return `external:${source.adapterId}:${source.serverName}`
  }
}

export function identityOf(input: {
  source: Source
  workspaceId: string
  languageId: string
  rootUri: string
  configurationDigest: string
}): Identity {
  return {
    workspaceId: input.workspaceId,
    languageId: input.languageId,
    rootUri: input.rootUri,
    configurationDigest: input.configurationDigest,
    executable: executableOf(input.source),
    owner: input.source.kind,
  }
}

export function identityKey(identity: Identity): string {
  return JSON.stringify([
    identity.owner,
    identity.workspaceId,
    identity.languageId,
    identity.rootUri,
    identity.configurationDigest,
    identity.executable,
  ])
}

export const Snapshot = Schema.Struct({
  source: Source,
  workspaceId: Schema.String,
  languageId: Schema.String,
  rootUri: Schema.String,
  configurationDigest: Schema.String,
  serverVersion: Schema.optional(Schema.String),
  capabilitiesDigest: Schema.String,
  health: Health,
  generation: PositiveInt,
}).annotate({ identifier: "LanguageServiceSnapshotV1" })
export type Snapshot = typeof Snapshot.Type
export type SnapshotInput = Omit<Snapshot, "generation">

export const Ref = Schema.Struct({
  key: Schema.String,
  generation: PositiveInt,
}).annotate({ identifier: "LanguageServiceRefV1" })
export type Ref = typeof Ref.Type

export function refOf(snapshot: Snapshot): Ref {
  return { key: identityKey(identityOf(snapshot)), generation: snapshot.generation }
}

export const StaleReason = Schema.Literals(["replaced", "invalidated", "failed"])
export type StaleReason = typeof StaleReason.Type

/**
 * A caller-held generation reference no longer identifies a usable snapshot.
 * Stale references must be dropped and re-resolved; they never authorize a
 * query, and they never authorize a write.
 */
export class StaleRefError extends Schema.TaggedErrorClass<StaleRefError>()("LSPStaleRefError", {
  key: Schema.String,
  generation: PositiveInt,
  reason: StaleReason,
  current: Schema.optional(PositiveInt),
}) {}

export const UnavailableReason = Schema.Literals([
  "guard_not_verified",
  "source_absent",
  "stale_generation",
  "editor_ingress_absent",
])
export type UnavailableReason = typeof UnavailableReason.Type

export class UnavailableError extends Schema.TaggedErrorClass<UnavailableError>()("LSPUnavailableError", {
  operation: Schema.String,
  reason: UnavailableReason,
  detail: Schema.optional(Schema.String),
}) {}

/**
 * The complete broker operation surface. `server.*` are process effects;
 * `code_action.prepare`/`rename.prepare` produce versioned edits and stay
 * Guard-gated; `query.*`/`diagnostics.pull` are read-only.
 */
export const Operation = Schema.Literals([
  "server.spawn",
  "server.install",
  "server.restart",
  "server.stop",
  "query.hover",
  "query.definition",
  "query.references",
  "query.document_symbol",
  "query.workspace_symbol",
  "diagnostics.pull",
  "code_action.prepare",
  "rename.prepare",
])
export type Operation = typeof Operation.Type

const PROCESS_OPERATIONS: ReadonlySet<Operation> = new Set([
  "server.spawn",
  "server.install",
  "server.restart",
  "server.stop",
])

const PREPARE_OPERATIONS: ReadonlySet<Operation> = new Set(["code_action.prepare", "rename.prepare"])

export interface Availability {
  readonly operation: Operation
  readonly available: boolean
  readonly reason?: UnavailableReason
  readonly detail?: string
  readonly source?: SourceKind
  readonly generation?: number
}

/**
 * Non-throwing availability report for UI/CLI/status surfaces and tests.
 */
export function availability(input: { operation: Operation; ledger?: Ledger; ref?: Ref }): Availability {
  const operation = input.operation
  if (PROCESS_OPERATIONS.has(operation)) {
    return {
      operation,
      available: false,
      reason: "guard_not_verified",
      detail: "language-server process control needs the Rust Guard/ExecutionHost route, which is not verified for this origin",
    }
  }
  if (PREPARE_OPERATIONS.has(operation)) {
    return {
      operation,
      available: false,
      reason: "guard_not_verified",
      detail: "code-action/rename preparation must return Guard-bound versioned edits before it may run",
    }
  }
  if (input.ledger && input.ref) {
    const current = input.ledger.get(input.ref.key)
    if (!current) {
      return {
        operation,
        available: false,
        reason: "stale_generation",
        detail: `no current snapshot for reference generation ${input.ref.generation}`,
      }
    }
    if (current.generation !== input.ref.generation || current.health === "failed") {
      return {
        operation,
        available: false,
        reason: "stale_generation",
        detail: `reference generation ${input.ref.generation} is not the current usable generation ${current.generation}`,
      }
    }
    return {
      operation,
      available: true,
      source: current.source.kind,
      generation: current.generation,
    }
  }
  return {
    operation,
    available: false,
    reason: "source_absent",
    detail: "no live language-service generation is attached for this query",
  }
}

/**
 * Fail-closed enforcement. Returns the live snapshot for read-only queries, and
 * throws `UnavailableError` (server-backed/prepare operations, missing source)
 * or `StaleRefError` (dropped generation) otherwise.
 */
export function requireAvailable(input: { operation: Operation; ledger?: Ledger; ref?: Ref }): Snapshot {
  if (PROCESS_OPERATIONS.has(input.operation) || PREPARE_OPERATIONS.has(input.operation)) {
    const report = availability(input)
    throw new UnavailableError({
      operation: input.operation,
      reason: report.reason ?? "guard_not_verified",
      detail: report.detail,
    })
  }
  if (input.ledger && input.ref) return input.ledger.require(input.ref)
  throw new UnavailableError({
    operation: input.operation,
    reason: "source_absent",
    detail: "no live language-service generation is attached for this query",
  })
}

export type ControlTrigger = "model_query" | "human_action" | "supervisor"

/**
 * Process-control policy (§30.14): an editor-owned server is never
 * restarted/killed/reconfigured by HorizonCode, and a model query never
 * controls a language-service process. Policy alone is not authorization:
 * permitted controls still require the canonical Guard/ExecutionHost route.
 */
export function controlAllowed(source: Source, trigger: ControlTrigger): boolean {
  if (source.kind === "editor") return false
  return trigger !== "model_query"
}

export type RouteDecision =
  | { readonly action: "reuse"; readonly snapshot: Snapshot }
  | { readonly action: "wait"; readonly snapshot: Snapshot }
  | { readonly action: "start_required"; readonly error: UnavailableError }
  | { readonly action: "restart_required"; readonly error: UnavailableError }
  | {
      readonly action: "fallback"
      readonly reason: "editor_source_unusable" | "no_usable_source"
      readonly detail?: string
    }

/**
 * Capability- and trust-based routing order (§30.14): reuse a healthy editor/
 * supervised service, wait for a starting one, otherwise require a supervised
 * start/restart — which is blocked here because the Guard-mediated start does
 * not exist yet. Callers fall back to parser/lexical tools on `fallback`.
 * This function never starts, restarts or stops anything.
 */
export function route(input: { ledger: Ledger; identity: Identity }): RouteDecision {
  const snapshot = input.ledger.get(identityKey(input.identity))
  if (!snapshot) {
    return {
      action: "start_required",
      error: new UnavailableError({
        operation: "server.spawn",
        reason: "guard_not_verified",
        detail: "starting a supervised language service requires the Guard/ExecutionHost route",
      }),
    }
  }
  if (snapshot.health === "healthy" || snapshot.health === "degraded") {
    return { action: "reuse", snapshot }
  }
  if (snapshot.health === "starting") {
    return { action: "wait", snapshot }
  }
  if (snapshot.source.kind === "editor") {
    return {
      action: "fallback",
      reason: "editor_source_unusable",
      detail: "editor-owned language services are never restarted or reconfigured by HorizonCode",
    }
  }
  return {
    action: "restart_required",
    error: new UnavailableError({
      operation: "server.restart",
      reason: "guard_not_verified",
      detail: "restarting a supervised language service requires the Guard/ExecutionHost route",
    }),
  }
}

export interface Ledger {
  /** Register or replace a snapshot. Replacement advances the generation. */
  readonly register: (input: SnapshotInput) => Snapshot
  readonly get: (key: string) => Snapshot | undefined
  /** Throws `StaleRefError` unless the reference names the current usable generation. */
  readonly require: (ref: Ref) => Snapshot
  /** Drop the referenced generation. Stale references are ignored, not errors. */
  readonly invalidate: (ref: Ref) => void
  readonly list: () => readonly Snapshot[]
}

export function makeLedger(): Ledger {
  const generations = new Map<string, number>()
  const snapshots = new Map<string, Snapshot>()

  return {
    register(input) {
      const key = identityKey(identityOf(input))
      const generation = (generations.get(key) ?? 0) + 1
      generations.set(key, generation)
      const snapshot: Snapshot = { ...input, generation }
      snapshots.set(key, snapshot)
      return snapshot
    },
    get(key) {
      return snapshots.get(key)
    },
    require(ref) {
      const snapshot = snapshots.get(ref.key)
      if (!snapshot) {
        throw new StaleRefError({ key: ref.key, generation: ref.generation, reason: "invalidated" })
      }
      if (snapshot.generation !== ref.generation) {
        throw new StaleRefError({
          key: ref.key,
          generation: ref.generation,
          reason: "replaced",
          current: snapshot.generation,
        })
      }
      if (snapshot.health === "failed") {
        throw new StaleRefError({ key: ref.key, generation: ref.generation, reason: "failed" })
      }
      return snapshot
    },
    invalidate(ref) {
      const snapshot = snapshots.get(ref.key)
      if (!snapshot || snapshot.generation !== ref.generation) return
      snapshots.delete(ref.key)
    },
    list() {
      return [...snapshots.values()]
    },
  }
}

export * as Broker from "./broker"
