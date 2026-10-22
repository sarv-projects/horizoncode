export * as SessionStore from "./store"

import { and, eq } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { SessionHistory } from "./history"
import { MessageDecodeError } from "./error"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { DirectProviderRequestTable, SessionMessageTable, SessionTable } from "./sql"
import { fromRow } from "./info"
import type { TrustedPrincipal } from "../trusted-principal"
import {
  digestDirectProviderRequestPinsV1,
  digestContextSelectionV1,
  validateDirectProviderRequestPinsV1,
  type DirectProviderRequestPinsV1,
  type DirectProviderRequestV1,
} from "./provider-request"
import { blake3 } from "@noble/hashes/blake3.js"
import { bytesToHex } from "@noble/hashes/utils.js"

export interface Interface {
  readonly get: (sessionID: SessionSchema.ID) => Effect.Effect<SessionSchema.Info | undefined>
  readonly context: (sessionID: SessionSchema.ID) => Effect.Effect<SessionMessage.Message[], MessageDecodeError>
  readonly runnerContext: (
    sessionID: SessionSchema.ID,
    baselineSeq: number,
  ) => Effect.Effect<SessionMessage.Message[], MessageDecodeError>
  readonly message: (
    messageID: SessionMessage.ID,
  ) => Effect.Effect<{ readonly sessionID: SessionSchema.ID; readonly message: SessionMessage.Message } | undefined>
  /** Persist immutable direct provider pins before any transport dispatch. */
  readonly pinProviderRequest: (input: {
    readonly principal: TrustedPrincipal
    readonly pins: DirectProviderRequestPinsV1
  }) => Effect.Effect<DirectProviderRequestV1>
  /** Durable compare-and-set immediately before provider bytes may be sent. */
  readonly markProviderDispatching: (input: {
    readonly principal: TrustedPrincipal
    readonly sessionID: SessionSchema.ID
    readonly requestID: string
    readonly pinDigest: string
  }) => Effect.Effect<DirectProviderRequestV1>
  /** Invoke from the canonical assistant SessionEvent `commit` callback so projector output, usage, and SETTLED share one DB transaction. */
  readonly settleProviderRequest: (input: {
    readonly principal: TrustedPrincipal
    readonly sessionID: SessionSchema.ID
    readonly requestID: string
    readonly pinDigest: string
    readonly assistantMessageID: SessionMessage.ID
    readonly usage: Readonly<Record<string, unknown>>
  }) => Effect.Effect<DirectProviderRequestV1>
  /** Ambiguous post-dispatch outcomes are terminal and cannot be replayed. */
  readonly markProviderRequestUnknown: (input: {
    readonly principal: TrustedPrincipal
    readonly sessionID: SessionSchema.ID
    readonly requestID: string
    readonly pinDigest: string
  }) => Effect.Effect<DirectProviderRequestV1>
  /** On direct-session recovery, unresolved DISPATCHING requests become UNKNOWN. */
  readonly recoverProviderRequests: (input: {
    readonly principal: TrustedPrincipal
    readonly sessionID: SessionSchema.ID
  }) => Effect.Effect<readonly DirectProviderRequestV1[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SessionStore") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const decodeMessage = Schema.decodeUnknownEffect(SessionMessage.Message)

    const ownerBinding = (principal: TrustedPrincipal) => {
      if (principal.kind !== "server_auth" || !principal.subject || principal.subject.length > 256) {
        throw new TypeError("direct provider inference requires an authenticated server principal")
      }
      return `blake3:${bytesToHex(blake3(Buffer.from(`horizoncode.direct-provider-owner.v1\0${principal.subject}`, "utf8")))}`
    }

    const assertSessionPrincipal = Effect.fnUntraced(function* (sessionID: SessionSchema.ID, principal: TrustedPrincipal) {
      const row = yield* db.select({ metadata: SessionTable.metadata }).from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie)
      const owner = row?.metadata?.horizonPrincipalOwner
      if (principal.kind !== "server_auth" || typeof owner !== "object" || owner === null ||
        (owner as Record<string, unknown>).kind !== "server_auth" || (owner as Record<string, unknown>).subject !== principal.subject) {
        return yield* Effect.die(new Error("direct provider request is not bound to this authenticated Session owner"))
      }
    })

    const readProviderRequest = Effect.fnUntraced(function* (binding: string, sessionID: SessionSchema.ID, requestID: string) {
      return yield* db.select().from(DirectProviderRequestTable).where(and(
        eq(DirectProviderRequestTable.owner_binding, binding),
        eq(DirectProviderRequestTable.session_id, sessionID),
        eq(DirectProviderRequestTable.request_id, requestID),
      )).get().pipe(Effect.orDie)
    })

    const projectProviderRequest = (row: typeof DirectProviderRequestTable.$inferSelect) => ({
      sessionID: row.session_id,
      requestID: row.request_id,
      sourceRevision: row.source_revision,
      profileID: row.profile_id,
      profileRevision: row.profile_revision,
      profileDigest: row.profile_digest,
      permissionScopeDigest: row.permission_scope_digest,
      contextSelection: row.context_selection_json as unknown as DirectProviderRequestV1["contextSelection"],
      contextSelectionDigest: row.context_selection_digest,
      providerID: row.provider_id,
      modelID: row.model_id,
      ...(row.account_ref ? { accountRef: row.account_ref } : {}),
      harnessID: row.harness_id,
      harnessRevision: row.harness_revision,
      routeRevision: row.route_revision,
      endpointRevision: row.endpoint_revision,
      policyDigest: row.policy_digest,
      normalizedInputDigest: row.normalized_input_digest,
      transportRequestDigest: row.transport_request_digest,
      pinDigest: row.pin_digest,
      state: row.state as DirectProviderRequestV1["state"],
      ...(row.assistant_message_id ? { assistantMessageID: SessionMessage.ID.make(row.assistant_message_id) } : {}),
      ...(row.usage_json ? { usage: row.usage_json } : {}),
    } satisfies DirectProviderRequestV1)

    return Service.of({
      get: Effect.fn("SessionStore.get")(function* (sessionID) {
        const row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie)
        return row ? fromRow(row) : undefined
      }),
      context: Effect.fn("SessionStore.context")(function* (sessionID) {
        return yield* SessionHistory.load(db, sessionID)
      }),
      runnerContext: Effect.fn("SessionStore.runnerContext")(function* (sessionID, baselineSeq) {
        return yield* SessionHistory.loadForRunner(db, sessionID, baselineSeq)
      }),
      message: Effect.fn("SessionStore.message")(function* (messageID) {
        const row = yield* db
          .select()
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.id, messageID))
          .get()
          .pipe(Effect.orDie)
        return row
          ? {
              sessionID: SessionSchema.ID.make(row.session_id),
              message: yield* decodeMessage({ ...row.data, id: row.id, type: row.type }).pipe(Effect.orDie),
            }
          : undefined
      }),
      pinProviderRequest: Effect.fn("SessionStore.pinProviderRequest")(function* ({ principal, pins }) {
        const validated = validateDirectProviderRequestPinsV1(pins)
        yield* assertSessionPrincipal(validated.sessionID, principal)
        const binding = ownerBinding(principal)
        const contextSelectionDigest = digestContextSelectionV1(validated.contextSelection)
        const pinDigest = digestDirectProviderRequestPinsV1(validated)
        const existing = yield* readProviderRequest(binding, validated.sessionID, validated.requestID)
        if (existing) {
          if (existing.pin_digest !== pinDigest || existing.context_selection_digest !== contextSelectionDigest) {
            return yield* Effect.die(new Error("provider request identity was reused with different immutable pins"))
          }
          return projectProviderRequest(existing)
        }
        const now = Date.now()
        yield* db.insert(DirectProviderRequestTable).values({
          owner_binding: binding,
          session_id: validated.sessionID,
          request_id: validated.requestID,
          source_revision: validated.sourceRevision,
          profile_id: validated.profileID,
          profile_revision: validated.profileRevision,
          profile_digest: validated.profileDigest,
          permission_scope_digest: validated.permissionScopeDigest,
          context_selection_json: validated.contextSelection as unknown as Record<string, unknown>,
          context_selection_digest: contextSelectionDigest,
          provider_id: validated.providerID,
          model_id: validated.modelID,
          account_ref: validated.accountRef ?? null,
          harness_id: validated.harnessID,
          harness_revision: validated.harnessRevision,
          route_revision: validated.routeRevision,
          endpoint_revision: validated.endpointRevision,
          policy_digest: validated.policyDigest,
          normalized_input_digest: validated.normalizedInputDigest,
          transport_request_digest: validated.transportRequestDigest,
          pin_digest: pinDigest,
          state: "PINNED",
          time_created: now,
          time_updated: now,
        }).onConflictDoNothing().run().pipe(Effect.orDie)
        const stored = yield* readProviderRequest(binding, validated.sessionID, validated.requestID)
        if (!stored || stored.pin_digest !== pinDigest || stored.context_selection_digest !== contextSelectionDigest) {
          return yield* Effect.die(new Error("provider request pin conflict"))
        }
        return projectProviderRequest(stored)
      }),
      markProviderDispatching: Effect.fn("SessionStore.markProviderDispatching")(function* ({ principal, sessionID, requestID, pinDigest }) {
        yield* assertSessionPrincipal(sessionID, principal)
        const binding = ownerBinding(principal)
        const updated = yield* db.update(DirectProviderRequestTable).set({ state: "DISPATCHING", time_updated: Date.now() }).where(and(
          eq(DirectProviderRequestTable.owner_binding, binding),
          eq(DirectProviderRequestTable.session_id, sessionID),
          eq(DirectProviderRequestTable.request_id, requestID),
          eq(DirectProviderRequestTable.pin_digest, pinDigest),
          eq(DirectProviderRequestTable.state, "PINNED"),
        )).returning({ requestID: DirectProviderRequestTable.request_id }).get().pipe(Effect.orDie)
        const row = yield* readProviderRequest(binding, sessionID, requestID)
        if (!row || !updated || row.state !== "DISPATCHING") return yield* Effect.die(new Error("provider request is not an undispatched exact PINNED request"))
        return projectProviderRequest(row)
      }),
      settleProviderRequest: Effect.fn("SessionStore.settleProviderRequest")(function* ({ principal, sessionID, requestID, pinDigest, assistantMessageID, usage }) {
        yield* assertSessionPrincipal(sessionID, principal)
        const binding = ownerBinding(principal)
        const validatedUsage = yield* Schema.decodeUnknownEffect(SessionMessage.UsageProvenance, { onExcessProperty: "error" })(usage).pipe(Effect.orDie)
        const encodedUsage = JSON.stringify(validatedUsage)
        if (Buffer.byteLength(encodedUsage, "utf8") > 16 * 1024 ||
          validatedUsage.requestID !== undefined && validatedUsage.requestID !== requestID) {
          return yield* Effect.die(new TypeError("provider settlement usage is mismatched or over limit"))
        }
        const current = yield* readProviderRequest(binding, sessionID, requestID)
        if (!current || current.pin_digest !== pinDigest || validatedUsage.providerID !== current.provider_id || validatedUsage.modelID !== current.model_id) {
          return yield* Effect.die(new Error("provider usage provenance differs from the pinned provider/model request"))
        }
        const assistant = yield* db.select().from(SessionMessageTable).where(and(
            eq(SessionMessageTable.id, assistantMessageID),
            eq(SessionMessageTable.session_id, sessionID),
            eq(SessionMessageTable.type, "assistant"),
          )).get().pipe(Effect.orDie)
        if (!assistant) return yield* Effect.die(new Error("provider settlement must run after the canonical assistant projection in its EventV2 commit callback"))
        const projected = yield* decodeMessage({ ...assistant.data, id: assistant.id, type: assistant.type }).pipe(Effect.orDie)
        if (projected.type !== "assistant" || JSON.stringify(projected.usageProvenance) !== encodedUsage) {
          return yield* Effect.die(new Error("provider settlement usage does not match the projected assistant entry"))
        }
        const settled = yield* db.update(DirectProviderRequestTable).set({
            state: "SETTLED", assistant_message_id: assistantMessageID, usage_json: validatedUsage, time_updated: Date.now(),
          }).where(and(
            eq(DirectProviderRequestTable.owner_binding, binding),
            eq(DirectProviderRequestTable.session_id, sessionID),
            eq(DirectProviderRequestTable.request_id, requestID),
            eq(DirectProviderRequestTable.pin_digest, pinDigest),
            eq(DirectProviderRequestTable.state, "DISPATCHING"),
          )).returning({ requestID: DirectProviderRequestTable.request_id }).get().pipe(Effect.orDie)
        if (!settled) return yield* Effect.die(new Error("provider settlement lost its exact DISPATCHING compare-and-set"))
        const row = yield* readProviderRequest(binding, sessionID, requestID)
        if (!row) return yield* Effect.die(new Error("settled provider request disappeared"))
        return projectProviderRequest(row)
      }),
      markProviderRequestUnknown: Effect.fn("SessionStore.markProviderRequestUnknown")(function* ({ principal, sessionID, requestID, pinDigest }) {
        yield* assertSessionPrincipal(sessionID, principal)
        const binding = ownerBinding(principal)
        yield* db.update(DirectProviderRequestTable).set({ state: "UNKNOWN", time_updated: Date.now() }).where(and(
          eq(DirectProviderRequestTable.owner_binding, binding),
          eq(DirectProviderRequestTable.session_id, sessionID),
          eq(DirectProviderRequestTable.request_id, requestID),
          eq(DirectProviderRequestTable.pin_digest, pinDigest),
          eq(DirectProviderRequestTable.state, "DISPATCHING"),
        )).run().pipe(Effect.orDie)
        const row = yield* readProviderRequest(binding, sessionID, requestID)
        if (!row || row.pin_digest !== pinDigest || !["UNKNOWN", "SETTLED"].includes(row.state)) {
          return yield* Effect.die(new Error("unknown provider outcome does not match an exact dispatch"))
        }
        return projectProviderRequest(row)
      }),
      recoverProviderRequests: Effect.fn("SessionStore.recoverProviderRequests")(function* ({ principal, sessionID }) {
        yield* assertSessionPrincipal(sessionID, principal)
        const binding = ownerBinding(principal)
        yield* db.update(DirectProviderRequestTable).set({ state: "UNKNOWN", time_updated: Date.now() }).where(and(
          eq(DirectProviderRequestTable.owner_binding, binding),
          eq(DirectProviderRequestTable.session_id, sessionID),
          eq(DirectProviderRequestTable.state, "DISPATCHING"),
        )).run().pipe(Effect.orDie)
        const rows = yield* db.select().from(DirectProviderRequestTable).where(and(
          eq(DirectProviderRequestTable.owner_binding, binding),
          eq(DirectProviderRequestTable.session_id, sessionID),
        )).all().pipe(Effect.orDie)
        return rows.map(projectProviderRequest)
      }),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
