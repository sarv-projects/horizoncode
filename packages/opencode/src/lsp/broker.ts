import { Schema } from "effect"
import { PositiveInt } from "@opencode-ai/core/schema"
import { languageServiceProcessRouteAvailable } from "./launch"
import type { DirectAttemptScopeV1, ManagedAttemptScopeV1 } from "@/session/managed-control"
import {
  HostProcessRefV1,
  freezeDirectAttemptScope,
  freezeManagedAttemptScope,
  sameDirectAttemptScope,
  sameManagedAttemptScope,
  validateExecutionLaunchProfileRef,
  validateHostProcessRef,
  validateHostProcessScope,
} from "./process-scope"

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
  processRef: HostProcessRefV1,
  launchProfileRef: Schema.Struct({ profileId: Schema.String, revision: Schema.String, profileDigest: Schema.String }),
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
 * root + configuration digest + HostKernel executable digest/version + owner type, authenticated
 * principal/read scope, policy generation, and sandbox profile. All authority
 * fields are resolved by trusted host owners; caller-supplied values are not
 * credentials and must never be used to register production snapshots.
 */
export const Identity = Schema.Struct({
  sessionID: Schema.String,
  locationID: Schema.String,
  ownerEpoch: Schema.String,
  managedAttemptScopeKey: Schema.String,
  directAttemptScopeKey: Schema.String,
  workspaceId: Schema.String,
  languageId: Schema.String,
  rootUri: Schema.String,
  configurationDigest: Schema.String,
  principalId: Schema.String,
  readScopeDigest: Schema.String,
  policyGeneration: Schema.String,
  sandboxProfileDigest: Schema.String,
  ownerInstance: Schema.String,
  executableDigest: Schema.optional(Schema.String),
  serverVersion: Schema.optional(Schema.String),
  /** Host process generation; distinct from the LanguageService snapshot generation. */
  processGeneration: Schema.optional(Schema.String),
  launchProfileId: Schema.optional(Schema.String),
  launchProfileRevision: Schema.optional(Schema.String),
  launchProfileDigest: Schema.optional(Schema.String),
  owner: SourceKind,
}).annotate({ identifier: "LanguageServiceIdentityV1" })
export type Identity = typeof Identity.Type

function ownerInstanceOf(source: Source): string {
  switch (source.kind) {
    case "editor":
      return source.clientId
    case "supervised":
      return source.processRef.executionID
    case "external":
      return source.adapterId
  }
}

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
  sessionID: string
  locationID: string
  workspaceRevision: string
  ownerEpoch: string
  managedAttemptScope?: ManagedAttemptScopeV1
  directAttemptScope?: DirectAttemptScopeV1
  workspaceId: string
  languageId: string
  rootUri: string
  configurationDigest: string
  principalId: string
  readScopeDigest: string
  policyGeneration: string
  sandboxProfileDigest: string
  serverVersion?: string
}): Identity {
  for (const [field, value] of Object.entries({
    sessionID: input.sessionID,
    locationID: input.locationID,
    ownerEpoch: input.ownerEpoch,
    workspaceId: input.workspaceId,
    languageId: input.languageId,
    rootUri: input.rootUri,
    configurationDigest: input.configurationDigest,
    principalId: input.principalId,
    readScopeDigest: input.readScopeDigest,
    policyGeneration: input.policyGeneration,
    sandboxProfileDigest: input.sandboxProfileDigest,
  })) {
    if (value.trim().length === 0) throw new TypeError(`language-service identity ${field} must be non-empty`)
  }
  let processGeneration: string | undefined
  let executableDigest: string | undefined
  let launchProfileRef: ReturnType<typeof validateExecutionLaunchProfileRef> | undefined
  if (input.source.kind === "supervised") {
    const processRef = validateHostProcessRef(input.source.processRef)
    if (processRef.kind !== "language_server" || processRef.ownerEpoch !== input.ownerEpoch) {
      throw new TypeError("supervised language-service process ref must match the authenticated owner epoch and language_server kind")
    }
    processGeneration = processRef.generation
    executableDigest = processRef.executableDigest
    launchProfileRef = validateExecutionLaunchProfileRef(input.source.launchProfileRef)
    if (
      processRef.profileID !== launchProfileRef.profileId ||
      processRef.profileRevision !== launchProfileRef.revision ||
      processRef.profileDigest !== launchProfileRef.profileDigest
    ) {
      throw new TypeError("supervised language-service process ref does not match its launch profile pin")
    }
  }
  validateHostProcessScope({
    sessionID: input.sessionID,
    locationID: input.locationID,
    ownerEpoch: input.ownerEpoch,
    workspaceRevision: input.workspaceRevision,
    managedAttemptScope: input.managedAttemptScope,
    directAttemptScope: input.directAttemptScope,
    workspaceID: input.workspaceId,
  })
  return {
    sessionID: input.sessionID,
    locationID: input.locationID,
    ownerEpoch: input.ownerEpoch,
    managedAttemptScopeKey: managedAttemptScopeKey(input.managedAttemptScope),
    directAttemptScopeKey: directAttemptScopeKey(input.directAttemptScope),
    workspaceId: input.workspaceId,
    languageId: input.languageId,
    rootUri: input.rootUri,
    configurationDigest: input.configurationDigest,
    principalId: input.principalId,
    readScopeDigest: input.readScopeDigest,
    policyGeneration: input.policyGeneration,
    sandboxProfileDigest: input.sandboxProfileDigest,
    ownerInstance: ownerInstanceOf(input.source),
    executableDigest,
    serverVersion: input.serverVersion,
    processGeneration,
    launchProfileId: launchProfileRef?.profileId,
    launchProfileRevision: launchProfileRef?.revision,
    launchProfileDigest: launchProfileRef?.profileDigest,
    owner: input.source.kind,
  }
}

function managedAttemptScopeKey(scope: ManagedAttemptScopeV1 | undefined): string {
  if (!scope) return "direct"
  // Every authority field participates: two scopes that differ only in the
  // provider-request pin or the leased worktree are different identities and
  // must never share a supervised-process broker generation.
  return JSON.stringify([
    scope.goalID,
    scope.runID,
    scope.taskID,
    scope.attemptID,
    scope.ownerEpoch,
    scope.expectedManagedRevision,
    scope.requestSequence,
    scope.requestID,
    scope.contextSelectionDigest,
    scope.locationID,
    scope.sessionID,
    scope.workspaceRevision,
    scope.effectiveMaxTokens,
    scope.remainingTokens,
    scope.delegationBindingDigest,
    scope.permissionScopeDigest,
    scope.worktreeTarget.worktreeID,
    scope.worktreeTarget.worktreeBaseRevision,
    scope.worktreeTarget.worktreePoolRevision,
    scope.worktreeTarget.locationID,
    scope.worktreeTarget.workspaceID,
    scope.worktreeTarget.workspaceRef,
    scope.worktreeTarget.canonicalRoot,
    scope.worktreeTarget.workspaceRevision,
  ])
}

function directAttemptScopeKey(scope: DirectAttemptScopeV1 | undefined): string {
  if (!scope) return "no-direct-attempt"
  return JSON.stringify([
    scope.attemptID,
    scope.parentSessionID,
    scope.childSessionID,
    scope.ownerEpoch,
    scope.expectedRevision,
    scope.locationID,
    scope.workspaceID,
    scope.workspaceRevision,
    scope.profileID,
    scope.profileRevision,
    scope.profileDigest,
    scope.capabilityDigest,
    scope.permissionsDigest,
    scope.budgetDigest,
    scope.scopeDigest,
  ])
}

export function identityKey(identity: Identity): string {
  return JSON.stringify([
    identity.owner,
    identity.sessionID,
    identity.locationID,
    identity.ownerEpoch,
    identity.managedAttemptScopeKey,
    identity.directAttemptScopeKey,
    identity.workspaceId,
    identity.languageId,
    identity.rootUri,
    identity.configurationDigest,
    identity.principalId,
    identity.readScopeDigest,
    identity.policyGeneration,
    identity.sandboxProfileDigest,
    identity.ownerInstance,
    identity.serverVersion ?? null,
    identity.processGeneration ?? null,
    identity.executableDigest ?? null,
    identity.launchProfileId ?? null,
    identity.launchProfileRevision ?? null,
    identity.launchProfileDigest ?? null,
  ])
}

export const Snapshot = Schema.Struct({
  source: Source,
  /** Authenticated process scope; callers cannot supply these in editor/LSP payloads. */
  sessionID: Schema.String,
  locationID: Schema.String,
  ownerEpoch: Schema.String,
  managedAttemptScope: Schema.optional(Schema.Unknown),
  directAttemptScope: Schema.optional(Schema.Unknown),
  workspaceId: Schema.String,
  /** Trusted workspace content revision when this server snapshot was made. */
  workspaceRevision: Schema.String,
  languageId: Schema.String,
  rootUri: Schema.String,
  configurationDigest: Schema.String,
  principalId: Schema.String,
  readScopeDigest: Schema.String,
  policyGeneration: Schema.String,
  sandboxProfileDigest: Schema.String,
  executable: Schema.optional(Schema.String),
  serverVersion: Schema.optional(Schema.String),
  capabilitiesDigest: Schema.String,
  health: Health,
  generation: PositiveInt,
}).annotate({ identifier: "LanguageServiceSnapshotV1" })
export type Snapshot = Omit<typeof Snapshot.Type, "managedAttemptScope" | "directAttemptScope"> & {
  readonly managedAttemptScope?: ManagedAttemptScopeV1
  readonly directAttemptScope?: DirectAttemptScopeV1
}
export type SnapshotInput = Omit<Snapshot, "generation">

/** Authenticated owner scope required for a language-service read. */
export type AuthorityBinding = Pick<
  Snapshot,
  | "sessionID"
  | "locationID"
  | "ownerEpoch"
  | "managedAttemptScope"
  | "directAttemptScope"
  | "workspaceId"
  | "workspaceRevision"
  | "principalId"
  | "readScopeDigest"
  | "policyGeneration"
  | "sandboxProfileDigest"
>

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

export class NotReadyError extends Schema.TaggedErrorClass<NotReadyError>()("LSPGenerationNotReadyError", {
  key: Schema.String,
  generation: PositiveInt,
  health: Schema.Literal("starting"),
}) {}

export const UnavailableReason = Schema.Literals([
  "guard_not_verified",
  "source_absent",
  "source_starting",
  "stale_generation",
  "editor_ingress_absent",
  "owner_scope_mismatch",
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
export function availability(input: {
  operation: Operation
  ledger?: Ledger
  ref?: Ref
  authority?: AuthorityBinding
}): Availability {
  const operation = input.operation
  if (PROCESS_OPERATIONS.has(operation)) {
    // Process control is reported available only when the single spawn choke point
    // (`launch.ts`) actually has a registered Guard/ExecutionHost route. Today it does not,
    // so the broker, the status surface and the gate all agree on `guard_not_verified`.
    if (!languageServiceProcessRouteAvailable()) {
      return {
        operation,
        available: false,
        reason: "guard_not_verified",
        detail:
          "language-server process control needs the Rust Guard/ExecutionHost route, which is not registered for this origin",
      }
    }
    return { operation, available: true }
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
    if (current.health === "starting") {
      return {
        operation,
        available: false,
        reason: "source_starting",
        detail: `language-service generation ${current.generation} is still starting`,
      }
    }
    if (!input.authority || !authorityMatches(current, input.authority)) {
      return {
        operation,
        available: false,
        reason: "owner_scope_mismatch",
        detail: "language-service query requires the authenticated workspace, read scope, policy and sandbox binding",
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
export function requireAvailable(input: {
  operation: Operation
  ledger?: Ledger
  ref?: Ref
  authority?: AuthorityBinding
}): Snapshot {
  if (PROCESS_OPERATIONS.has(input.operation) || PREPARE_OPERATIONS.has(input.operation)) {
    const report = availability(input)
    throw new UnavailableError({
      operation: input.operation,
      reason: report.reason ?? "guard_not_verified",
      detail: report.detail,
    })
  }
  if (input.ledger && input.ref) {
    const report = availability(input)
    if (report.reason === "source_starting" || report.reason === "owner_scope_mismatch") {
      throw new UnavailableError({
        operation: input.operation,
        reason: report.reason,
        detail: report.detail,
      })
    }
    return input.ledger.require(input.ref, input.authority!)
  }
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
  /** Throws `StaleRefError` for stale/failed refs and `NotReadyError` while a generation is starting. */
  readonly require: (ref: Ref, authority: AuthorityBinding) => Snapshot
  /**
   * Hold the exact usable generation for the lifetime of one read-only query.
   * The caller supplies its cancellation/deadline signal and must settle the
   * query before the pin is released; an abort request alone never drains it.
   */
  readonly withQueryPin: <T>(
    ref: Ref,
    authority: AuthorityBinding,
    query: (snapshot: Snapshot, signal?: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ) => Promise<T>
  /** Active query pins for this exact generation; useful to an owner before idle eviction. */
  readonly queryPinCount: (ref: Ref) => number
  /** Drop the referenced generation. Stale references are ignored, not errors. */
  readonly invalidate: (ref: Ref) => void
  readonly list: () => readonly Snapshot[]
}

export function makeLedger(): Ledger {
  const generations = new Map<string, number>()
  const snapshots = new Map<string, Snapshot>()
  const queryPins = new Map<string, Map<number, number>>()

  const requireSnapshot = (ref: Ref): Snapshot => {
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
    if (snapshot.health === "starting") {
      throw new NotReadyError({ key: ref.key, generation: ref.generation, health: snapshot.health })
    }
    return snapshot
  }

  const requireAuthority = (snapshot: Snapshot, authority: AuthorityBinding): void => {
    if (!authorityMatches(snapshot, authority)) {
      throw new UnavailableError({
        operation: "query.hover",
        reason: "owner_scope_mismatch",
        detail: "language-service query scope does not match the authenticated owner binding",
      })
    }
  }

  return {
    register(input) {
      if (!input.workspaceRevision.trim()) {
        throw new TypeError("language-service snapshot workspaceRevision must be non-empty")
      }
      try {
        validateHostProcessScope({
          sessionID: input.sessionID,
          locationID: input.locationID,
          ownerEpoch: input.ownerEpoch,
          workspaceRevision: input.workspaceRevision,
          managedAttemptScope: input.managedAttemptScope as ManagedAttemptScopeV1 | undefined,
          directAttemptScope: input.directAttemptScope as DirectAttemptScopeV1 | undefined,
          workspaceID: input.workspaceId,
        })
      } catch (error) {
        throw new TypeError(error instanceof Error ? error.message : "language-service process scope is invalid")
      }
      const key = identityKey(identityOf(input))
      const generation = (generations.get(key) ?? 0) + 1
      generations.set(key, generation)
      const snapshot: Snapshot = Object.freeze({
        ...input,
        source:
          input.source.kind === "supervised"
            ? Object.freeze({
                ...input.source,
                processRef: Object.freeze({ ...validateHostProcessRef(input.source.processRef) }),
                launchProfileRef: validateExecutionLaunchProfileRef(input.source.launchProfileRef),
              })
            : Object.freeze({ ...input.source }),
        managedAttemptScope: freezeManagedAttemptScope(input.managedAttemptScope),
        directAttemptScope: freezeDirectAttemptScope(input.directAttemptScope),
        generation,
      })
      snapshots.set(key, snapshot)
      return snapshot
    },
    get(key) {
      return snapshots.get(key)
    },
    require(ref, authority) {
      const snapshot = requireSnapshot(ref)
      requireAuthority(snapshot, authority)
      return snapshot
    },
    async withQueryPin(ref, authority, query, signal) {
      signal?.throwIfAborted()
      const snapshot = requireSnapshot(ref)
      requireAuthority(snapshot, authority)
      let generations = queryPins.get(ref.key)
      if (!generations) {
        generations = new Map()
        queryPins.set(ref.key, generations)
      }
      generations.set(ref.generation, (generations.get(ref.generation) ?? 0) + 1)

      try {
        signal?.throwIfAborted()
        return await query(snapshot, signal)
      } finally {
        const remaining = (generations.get(ref.generation) ?? 1) - 1
        if (remaining === 0) generations.delete(ref.generation)
        else generations.set(ref.generation, remaining)
        if (generations.size === 0) queryPins.delete(ref.key)
      }
    },
    queryPinCount(ref) {
      return queryPins.get(ref.key)?.get(ref.generation) ?? 0
    },
    invalidate(ref) {
      const snapshot = snapshots.get(ref.key)
      if (!snapshot || snapshot.generation !== ref.generation) return
      // Eviction is allowed only after every read pinned to this exact
      // generation has settled. The caller may retry invalidation afterward;
      // cancellation by itself does not drain a query.
      if ((queryPins.get(ref.key)?.get(ref.generation) ?? 0) > 0) return
      snapshots.delete(ref.key)
    },
    list() {
      return [...snapshots.values()]
    },
  }
}

function authorityMatches(snapshot: Snapshot, authority: AuthorityBinding): boolean {
  return (
    snapshot.sessionID === authority.sessionID &&
    snapshot.locationID === authority.locationID &&
    snapshot.ownerEpoch === authority.ownerEpoch &&
    sameManagedAttemptScope(
      snapshot.managedAttemptScope as ManagedAttemptScopeV1 | undefined,
      authority.managedAttemptScope as ManagedAttemptScopeV1 | undefined,
    ) &&
    sameDirectAttemptScope(
      snapshot.directAttemptScope as DirectAttemptScopeV1 | undefined,
      authority.directAttemptScope as DirectAttemptScopeV1 | undefined,
    ) &&
    snapshot.workspaceId === authority.workspaceId &&
    snapshot.workspaceRevision === authority.workspaceRevision &&
    snapshot.principalId === authority.principalId &&
    snapshot.readScopeDigest === authority.readScopeDigest &&
    snapshot.policyGeneration === authority.policyGeneration &&
    snapshot.sandboxProfileDigest === authority.sandboxProfileDigest
  )
}

export * as Broker from "./broker"
