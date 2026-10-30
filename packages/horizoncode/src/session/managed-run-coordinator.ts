import { SessionSupervisor } from "@horizoncode/core/session/supervisor"
import { Effect, Option, Result, Schema } from "effect"
import * as SubagentDeliveryV1 from "@horizoncode/schema/subagent-delivery-v1"
import { ProviderV2 } from "@horizoncode/core/provider"
import { ModelV2 } from "@horizoncode/core/model"
import { SessionPrompt } from "@/session/prompt"
import { Session } from "@/session/session"
import { ManagedControl, ManagedControlError } from "@/session/managed-control"
import { sameManagedContextSelectionV1 } from "@/session/llm"
import { managedRouteProjection } from "@/provider/provider"
import { MessageID, SessionID } from "@/session/schema"
import { TrustedPrincipalContext } from "@horizoncode/core/trusted-principal"
import { createHash } from "node:crypto"
import { managedMessageConsumptionAckDigest, managedMessageInboxReceiptDigest } from "./managed-subagent-inbox"

function exactManagedDelivery(raw: unknown, input: {
  readonly deliveryID: string
  readonly parentSessionID: string
  readonly sessionID: string
  readonly ownerEpoch: string
  readonly bindingDigest: string
  readonly goalID: string
  readonly runID: string
  readonly taskID: string
  readonly attemptID: string
}): boolean {
  try {
    const value = Schema.decodeUnknownSync(SubagentDeliveryV1.SubagentDeliveryV1, { onExcessProperty: "error" })(raw)
    if (value.lane !== "managed_attempt" || value.ackState !== "acknowledged" || value.deliveryId !== input.deliveryID ||
      value.parentExecutionId !== input.parentSessionID || value.childExecutionId !== input.sessionID ||
      value.ownerEpoch !== input.ownerEpoch || !SubagentDeliveryV1.validateAuthorityLane(value) ||
      !("delegationBindingDigest" in value.authority)) return false
    return value.authorityDigest === SubagentDeliveryV1.authorityDigest({
      lane: "managed_attempt",
      parentExecutionId: input.parentSessionID,
      childExecutionId: input.sessionID,
      ownerEpoch: input.ownerEpoch,
      authority: value.authority,
    }) && value.authority.delegationBindingDigest === input.bindingDigest &&
      value.authority.goalId === input.goalID && value.authority.runId === input.runID &&
      value.authority.taskId === input.taskID && value.authority.attemptId === input.attemptID
  } catch {
    return false
  }
}

/**
 * Executes one Rust-selected managed Task through Core's existing Task child
 * Session adapter. The caller must pass the exact persisted Run/Session pins;
 * this coordinator never invents Task IDs or retries a consumed prompt.
 */
export const executeNextManagedTask = Effect.fn("ManagedRunCoordinator.executeNextManagedTask")(function* (input: {
  readonly goalID: string
  readonly runID: string
  readonly rootSessionID: string
  readonly locationID: string
  readonly expectedRevision: string
}) {
  const authenticated = yield* TrustedPrincipalContext
  if (authenticated.principal.kind !== "server_auth" || !authenticated.principal.subject) {
    return yield* new ManagedControlError({ operation: "next_schedulable_task", code: "authorization_denied", reason: "managed scheduler requires authenticated ServerAuth" })
  }
  const supervisor = yield* SessionSupervisor.Service
  const prompt = yield* SessionPrompt.Service
  const sessions = yield* Session.Service
  const managedFollowUpRunner: SessionPrompt.ManagedFollowUpRunnerV1 = (runInput) => Effect.gen(function* () {
    const scope = runInput.authority.currentScope()
    if (runInput.sessionID !== scope.sessionID || runInput.context.selectionSessionID !== scope.sessionID ||
      runInput.context.attemptID !== scope.attemptID || runInput.context.taskID !== scope.taskID ||
      runInput.context.requestID !== scope.requestID || runInput.context.requestSequence !== scope.requestSequence ||
      runInput.context.contextSelectionDigest !== scope.contextSelectionDigest ||
      runInput.completion.requestSequence !== scope.requestSequence ||
      runInput.completion.managedAttempt.expectedManagedRevision !== scope.expectedManagedRevision) {
      return yield* new ManagedControlError({ operation: "managed_follow_up", code: "managed_conflict", reason: "completed turn does not match the live managed Attempt and current ContextSelection" })
    }
    const rows = yield* sessions.managedInboxList(scope.attemptID)
    const candidates = rows.filter((row) => (row.state === "committed" || row.state === "consumed" && row.host_consumed_ack_digest === null) && row.delivery_mode === "follow_up" &&
      row.completed_turn_receipt_digest === runInput.completion.completionReceiptDigest &&
      row.owner_epoch === scope.ownerEpoch && row.host_receipt_digest !== null && row.inbox_receipt_digest !== null)
    if (candidates.length === 0) return undefined
    if (candidates.length !== 1) {
      return yield* new ManagedControlError({ operation: "managed_follow_up", code: "managed_conflict", reason: "more than one committed follow-up names the completed managed turn" })
    }
    const row = candidates[0]!
    const pins = {
      lane: "managed_attempt" as const,
      goalID: row.goal_id,
      runID: row.run_id,
      taskID: row.task_id,
      attemptID: row.attempt_id,
      parentSessionID: row.parent_session_id,
      childSessionID: row.child_session_id,
      ownerEpoch: row.owner_epoch,
      bindingDigest: row.binding_digest,
      profileID: row.profile_id,
      profileRevision: row.profile_revision,
      profileDigest: row.profile_digest,
      permissionScopeDigest: row.permission_scope_digest,
      messageID: row.message_id,
      deliveryMode: "follow_up" as const,
      payloadDigest: row.payload_digest,
      payloadBytes: row.payload_bytes,
      mailboxSequence: row.mailbox_sequence,
      mailboxCapacity: row.mailbox_capacity,
    }
    if (pins.goalID !== scope.goalID || pins.runID !== scope.runID || pins.taskID !== scope.taskID ||
      pins.attemptID !== scope.attemptID || pins.childSessionID !== scope.sessionID || pins.ownerEpoch !== scope.ownerEpoch ||
      pins.bindingDigest !== scope.delegationBindingDigest || pins.permissionScopeDigest !== scope.permissionScopeDigest ||
      row.completed_turn_receipt_digest !== runInput.completion.completionReceiptDigest ||
      !row.wake_receipt_digest || !row.next_request_sequence ||
      BigInt(row.next_request_sequence) !== BigInt(scope.requestSequence) + 1n ||
      (row.state === "committed" && row.inbox_receipt_digest !== managedMessageInboxReceiptDigest({
        messageID: row.message_id,
        parentSessionID: row.parent_session_id,
        childSessionID: row.child_session_id,
        requestID: row.request_id,
        goalID: row.goal_id,
        runID: row.run_id,
        taskID: row.task_id,
        attemptID: row.attempt_id,
        ownerEpoch: row.owner_epoch,
        bindingDigest: row.binding_digest,
        profileID: row.profile_id,
        profileRevision: row.profile_revision,
        profileDigest: row.profile_digest,
        permissionScopeDigest: row.permission_scope_digest,
        payload: row.payload,
        payloadDigest: row.payload_digest,
        payloadBytes: row.payload_bytes,
        deliveryMode: "follow_up",
        mailboxCapacity: row.mailbox_capacity,
        mailboxSequence: row.mailbox_sequence,
      })) || (row.state === "consumed" && (!row.consumption_proof_json || !row.consumption_ack_digest))) {
      return yield* new ManagedControlError({ operation: "managed_follow_up", code: "managed_conflict", reason: "committed follow-up inbox row differs from the current Attempt, completed turn, or exact successor sequence" })
    }
    if (row.state === "consumed") {
      if (!row.consumption_proof_json || !row.consumption_ack_digest) {
        return yield* new ManagedControlError({ operation: "managed_follow_up_recovery", code: "managed_unknown", reason: "consumed follow-up is missing its durable exact ACK proof" })
      }
      const proof = yield* Effect.try({
        try: () => JSON.parse(row.consumption_proof_json!) as import("@/session/managed-subagent-inbox").ManagedSubagentConsumptionProofV1,
        catch: () => new ManagedControlError({ operation: "managed_follow_up_recovery", code: "managed_unknown", reason: "stored follow-up ACK proof is malformed" }),
      })
      const { consumptionAckDigest, ...proofFields } = proof
      if (consumptionAckDigest !== row.consumption_ack_digest ||
        managedMessageConsumptionAckDigest(proofFields) !== consumptionAckDigest ||
        proof.messageID !== row.message_id || proof.inboxReceiptDigest !== row.inbox_receipt_digest ||
        proof.consumingRequestID !== scope.requestID || proof.consumingRequestSequence !== scope.requestSequence ||
        proof.consumingScopeDigest !== ManagedControl.managedAttemptEffectScopeDigest(scope)) {
        return yield* new ManagedControlError({ operation: "managed_follow_up_recovery", code: "managed_unknown", reason: "stored follow-up ACK proof cannot be reconciled against the current HostKernel scope" })
      }
      const prompt = yield* sessions.findMessage(SessionID.make(scope.sessionID), (item) => item.info.id === proof.promptMessageID).pipe(
        Effect.catchTag("NotFoundError", () => Effect.succeed(Option.none())),
      )
      if (Option.isNone(prompt) || prompt.value.info.role !== "user" || prompt.value.parts.length !== 1 ||
        prompt.value.parts[0]?.type !== "text" ||
        `sha256:${createHash("sha256").update(prompt.value.parts[0].text, "utf8").digest("hex")}` !== row.payload_digest) {
        return yield* new ManagedControlError({ operation: "managed_follow_up_recovery", code: "managed_unknown", reason: "persisted follow-up prompt cannot be reconciled against the consumed inbox record" })
      }
      const ack = yield* ManagedControl.acknowledgeManagedMessageConsumed({ scope, pins, proof })
      yield* sessions.managedInboxMarkHostConsumed({
        messageID: row.message_id,
        consumptionAckDigest,
        hostConsumedAckDigest: ack.receiptDigest,
      }).pipe(Effect.mapError((error) => new ManagedControlError({ operation: "managed_follow_up_recovery", code: "managed_unknown", reason: `Core could not persist recovered HostKernel ACK: ${error.message}` })))
      return undefined
    }
    const committed = yield* ManagedControl.inspectManagedMessage({ scope, pins })
    if (committed.status !== "FOLLOW_UP_SCHEDULED" || committed.receiptDigest !== row.host_receipt_digest ||
      committed.wakeReceiptDigest !== row.wake_receipt_digest || committed.nextRequestSequence !== row.next_request_sequence) {
      return yield* new ManagedControlError({ operation: "managed_follow_up", code: "managed_unknown", reason: "HostKernel cannot confirm the exact committed follow-up receipt" })
    }
    const requestID = `req_managed_${scope.attemptID}_${row.next_request_sequence}`
    const claimedWake = yield* ManagedControl.claimManagedMessageWake({
      scope, pins, inboxReceiptDigest: row.inbox_receipt_digest!,
      completedTurnReceiptDigest: row.completed_turn_receipt_digest!,
      wakeReceiptDigest: row.wake_receipt_digest,
      nextRequestSequence: row.next_request_sequence,
      requestID,
    })
    const deliveryScopeDigest = ManagedControl.managedAttemptEffectScopeDigest(scope)
    yield* sessions.managedInboxRecordWakeClaim({
      messageID: row.message_id,
      requestID,
      nextRequestSequence: row.next_request_sequence,
      inboxReceiptDigest: row.inbox_receipt_digest!,
      completedTurnReceiptDigest: row.completed_turn_receipt_digest!,
      wakeReceiptDigest: row.wake_receipt_digest,
      wakeClaimDigest: claimedWake.wakeClaimDigest,
      wakeClaimScopeDigest: deliveryScopeDigest,
      wakeClaimReceiptDigest: claimedWake.wakeClaimReceiptDigest,
    }).pipe(Effect.mapError((error) => new ManagedControlError({ operation: "managed_follow_up", code: "managed_unknown", reason: `Core could not persist the exact wake claim: ${error.message}` })))
    const claimed = yield* sessions.managedInboxClaim({
      attemptID: scope.attemptID,
      ownerEpoch: scope.ownerEpoch,
      profileID: pins.profileID,
      profileRevision: pins.profileRevision,
      profileDigest: pins.profileDigest,
      permissionScopeDigest: scope.permissionScopeDigest,
      scopeDigest: deliveryScopeDigest,
      workspaceID: scope.worktreeTarget.workspaceID,
      workspaceRevision: scope.workspaceRevision,
      deliveryMode: "follow_up",
      triggerMessageID: row.message_id,
    }).pipe(Effect.mapError((error) => new ManagedControlError({ operation: "managed_follow_up", code: "managed_unknown", reason: `Core could not claim the committed follow-up: ${error.message}` })))
    if (claimed.length !== 1 || claimed[0]?.message_id !== row.message_id ||
      claimed[0]?.delivery_scope_digest !== deliveryScopeDigest) {
      return yield* new ManagedControlError({ operation: "managed_follow_up", code: "managed_conflict", reason: "Core did not claim exactly the HostKernel-authorized follow-up row" })
    }
    const promptMessageID = `msg_managed_followup_${createHash("sha256").update(`${row.message_id}\0${requestID}`).digest("hex").slice(0, 32)}`
    const prepared = yield* prompt.prepareManagedFollowUp({
      prompt: { messageID: MessageID.make(promptMessageID), sessionID: SessionID.make(scope.sessionID), parts: [{ type: "text", text: row.payload }] },
      authority: runInput.authority,
      context: runInput.context,
      requestID,
    }).pipe(Effect.provideService(SessionSupervisor.Service, supervisor))
    if (prepared.contextSelection.requestID !== requestID ||
      prepared.contextSelection.requestSequence !== row.next_request_sequence ||
      prepared.contextSelection.attemptID !== scope.attemptID ||
      prepared.contextSelection.sessionID !== scope.sessionID) {
      return yield* new ManagedControlError({ operation: "managed_follow_up", code: "managed_conflict", reason: "Core compiled a different follow-up ContextSelection" })
    }
    const advanced = yield* ManagedControl.advanceManagedContext({
      scope,
      contextSelection: prepared.contextSelection,
      wakeClaim: claimedWake,
    })
    try {
      runInput.authority.acceptRefreshedScope({ previous: scope, refreshed: advanced.managedAttempt, transition: "context_selection" })
    } catch {
      return yield* new ManagedControlError({ operation: "managed_follow_up", code: "managed_protocol", reason: "HostKernel next-request scope could not be installed on the live managed Attempt" })
    }
    const context: import("@/session/llm").ManagedProviderContextV1 = {
      ...prepared.context,
      contextSelectionDigest: advanced.contextSelectionDigest,
      initialSelection: prepared.contextSelection,
      initialProviderInput: prepared.providerInput,
    }
    return {
      prompt: { messageID: MessageID.make(promptMessageID), sessionID: SessionID.make(scope.sessionID), parts: [{ type: "text" as const, text: row.payload }] },
      context,
      onPromptCommitted: ({ promptMessageID: committedPromptMessageID }: { readonly promptMessageID: string }) => Effect.gen(function* () {
        if (committedPromptMessageID !== promptMessageID || !ManagedControl.sameManagedAttemptScope(runInput.authority.currentScope(), advanced.managedAttempt)) {
          return yield* new ManagedControlError({ operation: "managed_follow_up", code: "managed_conflict", reason: "committed prompt no longer matches the one-use managed wake claim" })
        }
        const message = yield* sessions.findMessage(SessionID.make(scope.sessionID), (item) => item.info.id === promptMessageID).pipe(
          Effect.catchTag("NotFoundError", () => Effect.succeed(Option.none())),
        )
        if (Option.isNone(message) || message.value.info.role !== "user" || message.value.parts.length !== 1 ||
          message.value.parts[0]?.type !== "text" || message.value.parts[0].text !== row.payload) {
          return yield* new ManagedControlError({ operation: "managed_follow_up", code: "managed_conflict", reason: "persisted follow-up message differs from the exact compiled inbox payload" })
        }
        const consumingScope = runInput.authority.currentScope()
        const proofBase = {
          messageID: row.message_id,
          parentSessionID: row.parent_session_id,
          childSessionID: row.child_session_id,
          deliveryMode: "follow_up" as const,
          goalID: row.goal_id,
          runID: row.run_id,
          taskID: row.task_id,
          attemptID: row.attempt_id,
          mailboxSequence: row.mailbox_sequence,
          inboxReceiptDigest: row.inbox_receipt_digest!,
          promptMessageID,
          consumingAttemptID: consumingScope.attemptID,
          consumingOwnerEpoch: consumingScope.ownerEpoch,
          consumingRequestID: consumingScope.requestID,
          consumingRequestSequence: consumingScope.requestSequence,
          deliveryScopeDigest,
          consumingScopeDigest: ManagedControl.managedAttemptEffectScopeDigest(consumingScope),
          wakeClaimReceiptDigest: claimedWake.wakeClaimReceiptDigest,
          consumingWorkspaceID: consumingScope.worktreeTarget.workspaceID,
          consumingWorkspaceRevision: consumingScope.workspaceRevision,
          consumedPayloadDigest: row.payload_digest,
          completedTurnReceiptDigest: row.completed_turn_receipt_digest!,
          wakeReceiptDigest: row.wake_receipt_digest!,
          nextRequestSequence: row.next_request_sequence!,
        }
        const proof = { ...proofBase, consumptionAckDigest: managedMessageConsumptionAckDigest(proofBase) }
        const consumed = yield* sessions.managedInboxConsume([proof]).pipe(
          Effect.mapError((error) => new ManagedControlError({ operation: "managed_follow_up", code: "managed_unknown", reason: `Core could not persist follow-up consumption: ${error.message}` })),
        )
        if (consumed.length !== 1 || consumed[0]?.state !== "consumed" || consumed[0]?.consumption_ack_digest !== proof.consumptionAckDigest) {
          return yield* new ManagedControlError({ operation: "managed_follow_up", code: "managed_unknown", reason: "Core consumption persistence did not return the exact follow-up proof" })
        }
        const ack = yield* ManagedControl.acknowledgeManagedMessageConsumed({ scope: consumingScope, pins, proof })
        yield* sessions.managedInboxMarkHostConsumed({
          messageID: row.message_id,
          consumptionAckDigest: proof.consumptionAckDigest,
          hostConsumedAckDigest: ack.receiptDigest,
        }).pipe(Effect.mapError((error) => new ManagedControlError({ operation: "managed_follow_up", code: "managed_unknown", reason: `Core could not persist HostKernel consumption receipt: ${error.message}` })))
      }).pipe(Effect.provideService(SessionSupervisor.Service, supervisor)),
    }
  }).pipe(Effect.provideService(SessionSupervisor.Service, supervisor))
  const managedPreDispatchRecovery: SessionPrompt.ManagedPreDispatchRecoveryV1 = (runInput) => Effect.gen(function* () {
    const scope = runInput.authority.currentScope()
    if (runInput.sessionID !== scope.sessionID || runInput.context.selectionSessionID !== scope.sessionID ||
      runInput.context.attemptID !== scope.attemptID || runInput.context.taskID !== scope.taskID ||
      runInput.context.requestID !== scope.requestID || runInput.context.requestSequence !== scope.requestSequence ||
      runInput.context.contextSelectionDigest !== scope.contextSelectionDigest) {
      return yield* new ManagedControlError({ operation: "managed_pre_dispatch_recovery", code: "managed_conflict", reason: "pre-dispatch recovery scope differs from the live managed ContextSelection" })
    }
    const rows = yield* sessions.managedInboxList(scope.attemptID)
    const matching = rows.filter((row) => row.delivery_mode === "follow_up" &&
      row.wake_claim_request_id === scope.requestID && row.next_request_sequence === scope.requestSequence)
    if (matching.length === 0) return
    if (matching.length !== 1) return yield* new ManagedControlError({
      operation: "managed_pre_dispatch_recovery", code: "managed_conflict", reason: "multiple committed inbox rows claim this managed request boundary",
    })
    const row = matching[0]!
    if (!row.inbox_receipt_digest || !row.host_receipt_digest || !row.delivery_scope_digest ||
      !row.wake_claim_receipt_digest || !row.wake_claim_scope_digest || !row.wake_claim_digest ||
      row.owner_epoch !== scope.ownerEpoch || row.attempt_id !== scope.attemptID || row.child_session_id !== scope.sessionID ||
      row.binding_digest !== scope.delegationBindingDigest || row.permission_scope_digest !== scope.permissionScopeDigest ||
      row.goal_id !== scope.goalID || row.run_id !== scope.runID || row.task_id !== scope.taskID ||
      row.wake_claim_scope_digest !== row.delivery_scope_digest ||
      `msg_managed_followup_${createHash("sha256").update(`${row.message_id}\0${scope.requestID}`).digest("hex").slice(0, 32)}` !== runInput.promptMessageID) {
      return yield* new ManagedControlError({ operation: "managed_pre_dispatch_recovery", code: "managed_unknown", reason: "persisted follow-up claim does not match this exact Attempt request and prompt identity" })
    }
    const textDigest = `sha256:${createHash("sha256").update(runInput.promptText, "utf8").digest("hex")}`
    if (textDigest !== row.payload_digest) return yield* new ManagedControlError({
      operation: "managed_pre_dispatch_recovery", code: "managed_conflict", reason: "persisted managed user message differs from the committed inbox payload digest",
    })
    const pins = {
      lane: "managed_attempt" as const, goalID: row.goal_id, runID: row.run_id, taskID: row.task_id,
      attemptID: row.attempt_id, parentSessionID: row.parent_session_id, childSessionID: row.child_session_id,
      ownerEpoch: row.owner_epoch, bindingDigest: row.binding_digest, profileID: row.profile_id,
      profileRevision: row.profile_revision, profileDigest: row.profile_digest,
      permissionScopeDigest: row.permission_scope_digest, messageID: row.message_id,
      deliveryMode: "follow_up" as const, payloadDigest: row.payload_digest, payloadBytes: row.payload_bytes,
      mailboxSequence: row.mailbox_sequence, mailboxCapacity: row.mailbox_capacity,
    }
    let proof: import("@/session/managed-subagent-inbox").ManagedSubagentConsumptionProofV1
    if (row.state === "consumed") {
      if (!row.consumption_proof_json || !row.consumption_ack_digest) return yield* new ManagedControlError({
        operation: "managed_pre_dispatch_recovery", code: "managed_unknown", reason: "consumed inbox row has no durable exact HostKernel ACK proof",
      })
      proof = yield* Effect.try({
        try: () => JSON.parse(row.consumption_proof_json!) as typeof proof,
        catch: () => new ManagedControlError({ operation: "managed_pre_dispatch_recovery", code: "managed_unknown", reason: "persisted consumed proof is malformed" }),
      })
    } else if (row.state === "delivering" && row.delivery_attempt_id === scope.attemptID &&
      row.delivery_owner_epoch === scope.ownerEpoch && row.payload === runInput.promptText && row.completed_turn_receipt_digest &&
      row.wake_receipt_digest && row.next_request_sequence && row.wake_claim_request_id === scope.requestID) {
      const base = {
        messageID: row.message_id, parentSessionID: row.parent_session_id, childSessionID: row.child_session_id,
        deliveryMode: "follow_up" as const, goalID: row.goal_id, runID: row.run_id, taskID: row.task_id,
        attemptID: row.attempt_id, mailboxSequence: row.mailbox_sequence, inboxReceiptDigest: row.inbox_receipt_digest,
        promptMessageID: runInput.promptMessageID, consumingAttemptID: scope.attemptID,
        consumingOwnerEpoch: scope.ownerEpoch, consumingRequestID: scope.requestID,
        consumingRequestSequence: scope.requestSequence, deliveryScopeDigest: row.delivery_scope_digest,
        consumingScopeDigest: ManagedControl.managedAttemptEffectScopeDigest(scope),
        wakeClaimReceiptDigest: row.wake_claim_receipt_digest, consumingWorkspaceID: scope.worktreeTarget.workspaceID,
        consumingWorkspaceRevision: scope.workspaceRevision, consumedPayloadDigest: row.payload_digest,
        completedTurnReceiptDigest: row.completed_turn_receipt_digest, wakeReceiptDigest: row.wake_receipt_digest,
        nextRequestSequence: row.next_request_sequence,
      }
      proof = { ...base, consumptionAckDigest: managedMessageConsumptionAckDigest(base) }
      const consumed = yield* sessions.managedInboxConsume([proof]).pipe(Effect.mapError((error) => new ManagedControlError({
        operation: "managed_pre_dispatch_recovery", code: "managed_unknown", reason: `Core could not reconcile exact prompt append: ${error.message}`,
      })))
      if (consumed.length !== 1 || consumed[0]?.state !== "consumed") return yield* new ManagedControlError({
        operation: "managed_pre_dispatch_recovery", code: "managed_unknown", reason: "Core did not persist the exact recovered prompt consumption",
      })
    } else {
      return yield* new ManagedControlError({ operation: "managed_pre_dispatch_recovery", code: "managed_unknown", reason: "follow-up delivery is ambiguous and cannot be replayed safely" })
    }
    const { consumptionAckDigest, ...proofFields } = proof
    if (proof.messageID !== row.message_id || proof.promptMessageID !== runInput.promptMessageID ||
      proof.inboxReceiptDigest !== row.inbox_receipt_digest || proof.consumingRequestID !== scope.requestID ||
      proof.consumingRequestSequence !== scope.requestSequence ||
      proof.consumingScopeDigest !== ManagedControl.managedAttemptEffectScopeDigest(scope) ||
      managedMessageConsumptionAckDigest(proofFields) !== consumptionAckDigest ||
      (row.state === "consumed" && consumptionAckDigest !== row.consumption_ack_digest)) {
      return yield* new ManagedControlError({ operation: "managed_pre_dispatch_recovery", code: "managed_unknown", reason: "stored consumption proof differs from the current exact provider request boundary" })
    }
    const ack = yield* ManagedControl.acknowledgeManagedMessageConsumed({ scope, pins, proof })
    yield* sessions.managedInboxMarkHostConsumed({ messageID: row.message_id, consumptionAckDigest, hostConsumedAckDigest: ack.receiptDigest }).pipe(
      Effect.mapError((error) => new ManagedControlError({ operation: "managed_pre_dispatch_recovery", code: "managed_unknown", reason: `Core could not persist the recovered HostKernel ACK: ${error.message}` })),
    )
  }).pipe(Effect.provideService(SessionSupervisor.Service, supervisor))
  const selection = yield* ManagedControl.nextSchedulableTask({
    trustedPrincipal: authenticated.principal,
    goalID: input.goalID,
    runID: input.runID,
    locationID: input.locationID,
    sessionID: input.rootSessionID,
    expectedRevision: input.expectedRevision,
  })
  if (selection.status === "NO_TASK") {
    const recovery = yield* ManagedControl.activeAttemptRecovery({
      trustedPrincipal: authenticated.principal,
      goalID: input.goalID,
      runID: input.runID,
      locationID: input.locationID,
      sessionID: input.rootSessionID,
      expectedRevision: selection.revision,
    })
    if (recovery.status === "NO_ACTIVE_ATTEMPT") return { status: "NO_TASK" as const, selection, recovery }
    const task = recovery.task
    const attempt = recovery.attempt
    if (!task || !attempt) {
      return yield* new ManagedControlError({ operation: "active_attempt_recovery", code: "managed_protocol", reason: "Rust recovery omitted the active Task or Attempt" })
    }
    if (attempt.quiescence) {
      if (attempt.unknownEffect || attempt.phase === "UNKNOWN" || attempt.phase === "SETTLING") {
        return { status: "PROMPT_UNKNOWN" as const, selection, recovery, quiesced: attempt.quiescence }
      }
      const cancellationPending = recovery.runPhase === "CANCELLING"
      const assistantCompleted = attempt.quiescence.childSessionOutcomeKind === "assistant_completed"
      const settlement = attempt.phase === "SUCCEEDED" || attempt.phase === "FAILED" ||
        assistantCompleted && !cancellationPending
        ? undefined
        : yield* ManagedControl.settleAttempt({
            trustedPrincipal: authenticated.principal,
            goalID: recovery.goalID,
            runID: recovery.runID,
            taskID: task.taskID,
            attemptID: attempt.attemptID,
            outcome: "failed",
            failureCode: "managed_prompt_stopped",
            retryable: false,
            expectedRevision: attempt.quiescence.managedRevision,
          })
      if (settlement?.attemptPhase === "UNKNOWN") {
        return { status: "PROMPT_UNKNOWN" as const, selection, recovery, quiesced: attempt.quiescence, settlement }
      }
      const dispatchSettlement = attempt.phase === "FAILED" || settlement?.attemptPhase === "FAILED"
        ? yield* ManagedControl.settleManagedDispatch({
            trustedPrincipal: authenticated.principal,
            goalID: recovery.goalID,
            runID: recovery.runID,
            taskID: task.taskID,
            attemptID: attempt.attemptID,
            deliveryID: `managed_settle_${attempt.attemptID}`,
          })
        : undefined
      if (dispatchSettlement && dispatchSettlement.status !== "QUARANTINED") {
        return yield* new ManagedControlError({ operation: "settle_dispatch", code: "managed_protocol", reason: "failed managed child did not receive the exact P8 quarantine receipt" })
      }
      const cancellation = cancellationPending && dispatchSettlement?.status === "QUARANTINED"
        ? yield* ManagedControl.cancelRun({
            trustedPrincipal: authenticated.principal,
            goalID: recovery.goalID,
            runID: recovery.runID,
            expectedRevision: settlement?.revision ?? recovery.revision,
          })
        : undefined
      return {
        status: assistantCompleted ? "PROMPT_RETURNED" as const : "PROMPT_RETURNED_ERROR" as const,
        selection,
        recovery,
        quiesced: attempt.quiescence,
        ...(settlement ? { settlement } : {}),
        ...(dispatchSettlement ? { dispatchSettlement } : {}),
        ...(cancellation ? { cancellation } : {}),
      }
    }
    if (attempt.unknownEffect || attempt.phase === "UNKNOWN" || attempt.phase === "SETTLING" ||
      attempt.phase === "SUCCEEDED" || attempt.phase === "FAILED") {
      // A consumed callback without a durable RETURNED marker is ambiguous;
      // terminal/unknown Attempts never re-enter TaskTool or prompt().
      return { status: "PROMPT_UNKNOWN" as const, selection, recovery }
    }

    if (task.effectiveMaxTokens === undefined || task.remainingTokens === undefined) {
      // The current restart DTO is intentionally read-only and omits budget
      // authority. Never reconstruct it from profile or Task prose.
      return { status: "UNAVAILABLE" as const, selection, recovery, reason: "recovery projection omits the durable Task token budget" }
    }
    const recoveredTaskWithBudget = {
      ...task,
      effectiveMaxTokens: task.effectiveMaxTokens,
      remainingTokens: task.remainingTokens,
    }

    if (!attempt.consumed) {
      const scope = attempt.managedAttempt
      // HostKernel grants this scope only for the exact unconsumed ADMITTED or
      // EXECUTING Attempt. A missing scope means pause/cancel, stale authority,
      // or an unsupported state: Core must not reconstruct authority locally.
      if (!scope || attempt.runPhase !== "RUNNING" ||
        (attempt.phase !== "ADMITTED" && attempt.phase !== "EXECUTING") ||
        scope.goalID !== recovery.goalID || scope.runID !== recovery.runID ||
        scope.taskID !== task.taskID || scope.attemptID !== attempt.attemptID ||
        scope.ownerEpoch !== attempt.ownerEpoch || scope.expectedManagedRevision !== recovery.revision ||
        scope.effectiveMaxTokens === "0" || scope.remainingTokens === "0" ||
        scope.locationID !== recovery.locationID || scope.sessionID !== attempt.sessionID ||
        scope.delegationBindingDigest !== attempt.bindingDigest) {
        return { status: "UNAVAILABLE" as const, selection, recovery }
      }
      const activeSelection = {
        status: "READY_TASK" as const,
        goalID: recovery.goalID,
        runID: recovery.runID,
        revision: recovery.revision,
        runPhase: recovery.runPhase,
        specID: recovery.specID,
        specDigest: recovery.specDigest,
        goalObjective: recovery.goalObjective,
        specConstraints: recovery.specConstraints,
        locationID: recovery.locationID,
        sessionID: recovery.sessionID,
        workspaceRef: recovery.workspaceRef,
        task: recoveredTaskWithBudget,
      }
      // A restart may not reconstruct the prompt from current Session state.
      // Recompile on the exact pinned worktree and compare the entire saved
      // selection before any one-use dispatch claim or consume.
      if (!attempt.contextSelection || scope.requestSequence !== "1" ||
        scope.requestID !== attempt.contextSelection.requestID ||
        attempt.contextSelectionDigest !== scope.contextSelectionDigest) {
        return { status: "UNAVAILABLE" as const, selection, recovery, reason: "persisted initial ContextSelection is unavailable for exact pre-consume recovery" }
      }
      const preparedResult = yield* Effect.result(prompt.prepareManagedTaskRequest({
        selection: activeSelection,
        rootSessionID: input.rootSessionID,
        childSessionID: attempt.sessionID,
        preAdmissionTarget: scope.worktreeTarget,
        requestID: scope.requestID,
        requestSequence: scope.requestSequence,
        trustedPrincipal: authenticated.principal,
      }).pipe(Effect.provideService(SessionSupervisor.Service, supervisor)))
      if (Result.isFailure(preparedResult)) {
        return { status: "UNAVAILABLE" as const, selection, recovery, reason: "exact initial managed provider request could not be safely re-prepared" }
      }
      const prepared = preparedResult.success
      if (!sameManagedContextSelectionV1(prepared.contextSelection, attempt.contextSelection) ||
        prepared.contextSelection.attemptID !== attempt.attemptID ||
        prepared.contextSelection.sessionID !== attempt.sessionID ||
        prepared.contextSelection.requestID !== scope.requestID ||
        prepared.contextSelection.requestSequence !== scope.requestSequence) {
        return { status: "UNAVAILABLE" as const, selection, recovery, reason: "reprepared initial provider context differs from the durable HostKernel selection" }
      }
      const handoff = yield* ManagedControl.claimManagedDispatch({
        goalID: recovery.goalID,
        runID: recovery.runID,
        taskID: task.taskID,
        parentSessionID: recovery.sessionID,
        attemptID: attempt.attemptID,
        profileSelection: { profileId: task.profile.profileID, revision: task.profile.revision },
        deliveryID: `managed_claim_${attempt.attemptID}`,
      })
      if (handoff.bindingDigest !== attempt.bindingDigest || handoff.sessionID !== attempt.sessionID ||
        handoff.ownerEpoch !== attempt.ownerEpoch || handoff.expectedManagedRevision !== scope.expectedManagedRevision ||
        handoff.profileDigest !== task.profile.definitionDigest ||
        JSON.stringify(handoff.worktreeTarget) !== JSON.stringify(scope.worktreeTarget)) {
        return yield* new ManagedControlError({ operation: "claim_dispatch", code: "managed_protocol", reason: "recovered handoff differs from the existing HostKernel Attempt pins" })
      }
      const consumeReceipt = yield* ManagedControl.consumeManagedDispatch({
        handoff,
        profileDefinition: handoff.profileDefinition,
        deliveryID: `managed_consume_${attempt.attemptID}`,
      })
      if (consumeReceipt.bindingDigest !== attempt.bindingDigest || consumeReceipt.sessionID !== attempt.sessionID ||
        consumeReceipt.ownerEpoch !== attempt.ownerEpoch ||
        JSON.stringify(consumeReceipt.worktreeTarget) !== JSON.stringify(handoff.worktreeTarget)) {
        return yield* new ManagedControlError({ operation: "consume_dispatch", code: "managed_protocol", reason: "recovered consume receipt differs from the existing HostKernel Attempt pins" })
      }
      // The provider route is re-derived from the Rust-pinned handoff profile,
      // the same trusted source the main admission path pins it from.
      const managedProviderRoute = yield* Effect.mapError(
        managedRouteProjection({
          providerID: ProviderV2.ID.make(handoff.profileDefinition.model.providerId),
          modelID: ModelV2.ID.make(handoff.profileDefinition.model.modelId),
          harnessID: handoff.profileDefinition.harness,
        }),
        (error) => new ManagedControlError({ operation: "claim_dispatch", code: "provider_route_unavailable", reason: error.message }),
      )
      const admission = {
        goalID: recovery.goalID,
        runID: recovery.runID,
        taskID: task.taskID,
        attemptID: attempt.attemptID,
        parentSessionID: recovery.sessionID,
        ownerEpoch: attempt.ownerEpoch,
        locationID: recovery.locationID,
        sessionID: attempt.sessionID,
        workspaceRevision: scope.workspaceRevision,
        attemptPhase: attempt.phase,
        runPhase: attempt.runPhase,
        revision: scope.expectedManagedRevision,
        requestSequence: scope.requestSequence,
        requestID: scope.requestID,
        contextSelectionDigest: scope.contextSelectionDigest,
        profile: {
          profileID: task.profile.profileID,
          profileRevision: task.profile.revision,
          profileDigest: task.profile.definitionDigest,
        },
        managedProviderRoute,
        managedAttempt: scope,
      }
      const child = yield* prompt.runManagedTask({
        selection: activeSelection,
        admission,
        handoff,
        consumeReceipt,
        trustedPrincipal: authenticated.principal,
        preparedRequest: prepared,
        managedFollowUpRunner,
        managedPreDispatchRecovery,
      }).pipe(Effect.provideService(SessionSupervisor.Service, supervisor))
      const dispatchSettlement = child.outcomeKind === "assistant_completed"
        ? undefined
        : yield* ManagedControl.settleManagedDispatch({
            trustedPrincipal: authenticated.principal,
            goalID: selection.goalID,
            runID: selection.runID,
            taskID: task.taskID,
            attemptID: admission.attemptID,
            deliveryID: `managed_settle_${admission.attemptID}`,
          })
      if (dispatchSettlement && dispatchSettlement.status !== "QUARANTINED") {
        return yield* new ManagedControlError({ operation: "settle_dispatch", code: "managed_protocol", reason: "failed managed child did not receive the exact P8 quarantine receipt" })
      }
      return {
        status: child.outcomeKind === "assistant_completed" ? "PROMPT_RETURNED" as const : "PROMPT_RETURNED_ERROR" as const,
        selection,
        recovery,
        admission,
        handoff,
        consumeReceipt,
        child,
        ...(dispatchSettlement ? { dispatchSettlement } : {}),
      }
    }

    const childID = SessionID.make(attempt.sessionID)
    const child = yield* sessions.get(childID).pipe(
      Effect.map(Option.some),
      Effect.catchTag("NotFoundError", () => Effect.succeed(Option.none())),
    )
    if (!Option.isSome(child)) return { status: "PROMPT_UNKNOWN" as const, selection, recovery }
    const info = child.value
    const lineage = info.metadata?.horizonManagedAttempt
    const delivery = info.metadata?.horizonManagedDelivery
    const worktreeTarget = info.metadata?.horizonManagedWorktreeTarget
    const subagentDelivery = info.metadata?.horizonSubagentDelivery
    const consume = attempt.consumed
    const completionDeliveryID = ManagedControl.managedCompletionDeliveryID(attempt.attemptID, consume.handoffDigest, consume.receiptDigest)
    if (info.parentID !== input.rootSessionID || typeof lineage !== "object" || lineage === null ||
      lineage.goalID !== recovery.goalID || lineage.runID !== recovery.runID || lineage.taskID !== task.taskID ||
      lineage.attemptID !== attempt.attemptID || lineage.ownerEpoch !== attempt.ownerEpoch ||
      lineage.handoffID !== consume.handoffID || lineage.handoffDigest !== consume.handoffDigest ||
      lineage.bindingDigest !== attempt.bindingDigest || typeof delivery !== "object" || delivery === null ||
      info.workspaceID !== consume.worktreeTarget.workspaceID ||
      JSON.stringify(worktreeTarget) !== JSON.stringify(consume.worktreeTarget) ||
      delivery.schemaVersion !== 1 || delivery.promptState !== "RETURNED" ||
      delivery.handoffDigest !== consume.handoffDigest || delivery.consumeReceiptDigest !== consume.receiptDigest ||
      delivery.completionDeliveryID !== completionDeliveryID ||
      !exactManagedDelivery(subagentDelivery, {
        deliveryID: completionDeliveryID,
        parentSessionID: recovery.sessionID,
        sessionID: attempt.sessionID,
        ownerEpoch: attempt.ownerEpoch,
        bindingDigest: attempt.bindingDigest,
        goalID: recovery.goalID,
        runID: recovery.runID,
        taskID: task.taskID,
        attemptID: attempt.attemptID,
      })) {
      // There is a durable consume but no exact returned-child projection. Do
      // not call TaskTool or prompt() again after this point.
      return { status: "PROMPT_UNKNOWN" as const, selection, recovery }
    }
    const completion = yield* sessions.managedChildSessionCompletion({
      sessionID: childID,
      parentSessionID: SessionID.make(input.rootSessionID),
      goalID: recovery.goalID,
      runID: recovery.runID,
      taskID: task.taskID,
      attemptID: attempt.attemptID,
    })
    const quiesced = yield* ManagedControl.completeRecoveredManagedDispatch({
      trustedPrincipal: authenticated.principal,
      consumeReceipt: consume,
      childSession: completion,
    })
    const settlement = completion.childSessionOutcomeKind === "assistant_completed"
      ? undefined
      : yield* ManagedControl.settleAttempt({
          trustedPrincipal: authenticated.principal,
          goalID: recovery.goalID,
          runID: recovery.runID,
          taskID: task.taskID,
          attemptID: attempt.attemptID,
          outcome: "failed",
          failureCode: "managed_prompt_stopped",
          retryable: false,
          expectedRevision: quiesced.managedRevision,
        })
    const dispatchSettlement = settlement?.attemptPhase === "FAILED"
      ? yield* ManagedControl.settleManagedDispatch({
          trustedPrincipal: authenticated.principal,
          goalID: recovery.goalID,
          runID: recovery.runID,
          taskID: task.taskID,
          attemptID: attempt.attemptID,
          deliveryID: `managed_settle_${attempt.attemptID}`,
        })
      : undefined
    if (dispatchSettlement && dispatchSettlement.status !== "QUARANTINED") {
      return yield* new ManagedControlError({ operation: "settle_dispatch", code: "managed_protocol", reason: "failed managed child did not receive the exact P8 quarantine receipt" })
    }
    return {
      status: completion.childSessionOutcomeKind === "assistant_completed" ? "PROMPT_RETURNED" as const : "PROMPT_RETURNED_ERROR" as const,
      selection,
      recovery,
      completion,
      quiesced,
      ...(settlement ? { settlement } : {}),
      ...(dispatchSettlement ? { dispatchSettlement } : {}),
    }
  }
  const task = selection.task
  if (!task) {
    return yield* new ManagedControlError({ operation: "next_schedulable_task", code: "managed_protocol", reason: "Rust READY_TASK projection omitted its Task" })
  }
  const reservation = yield* ManagedControl.reserveManagedPreAdmissionTarget({
    trustedPrincipal: authenticated.principal,
    selection,
  })
  if (reservation.candidateAttemptID !== task.candidateAttemptID || reservation.taskRevision !== task.taskRevision ||
    reservation.preAdmissionTarget.workspaceRef !== selection.workspaceRef ||
    reservation.preAdmissionTarget.locationID !== selection.locationID) {
    return { status: "UNAVAILABLE" as const, selection, reason: "authenticated Stage-A P8 reservation differs from the exact Rust READY_TASK candidate" }
  }
  const childSessionID = SessionID.make(ManagedControl.managedTaskSessionID(task.candidateAttemptID))
  const activeSelection = {
    status: "READY_TASK" as const,
    goalID: selection.goalID,
    runID: selection.runID,
    revision: selection.revision,
    runPhase: selection.runPhase,
    specID: selection.specID,
    specDigest: selection.specDigest,
    goalObjective: selection.goalObjective,
    specConstraints: selection.specConstraints,
    locationID: selection.locationID,
    sessionID: selection.sessionID,
    workspaceRef: selection.workspaceRef,
    task,
  }
  // P8 first reserves against trusted facts that do not depend on the prompt.
  // Core then compiles on that exact target without dispatch and binds the
  // resulting selection to the same reservation before Attempt admission.
  const preparedResult = yield* Effect.result(prompt.prepareManagedTaskRequest({
    selection: activeSelection,
    rootSessionID: input.rootSessionID,
    childSessionID,
    preAdmissionTarget: reservation.preAdmissionTarget,
    requestID: `req_managed_${task.candidateAttemptID}_1`,
    requestSequence: "1",
    trustedPrincipal: authenticated.principal,
  }))
  if (Result.isFailure(preparedResult)) {
    return { status: "UNAVAILABLE" as const, selection, reason: "exact managed provider request preflight is unavailable" }
  }
  const prepared = preparedResult.success
  // Re-submit Stage B with the exact persisted selection. This is an
  // idempotent identity check when reserve reports an already-bound candidate,
  // and reconciles a lost bind response without minting a second reservation.
  const boundReservation = yield* ManagedControl.bindManagedPreAdmissionContext({
    trustedPrincipal: authenticated.principal,
    selection,
    reservation,
    contextSelection: prepared.contextSelection,
  })
  if (!boundReservation.contextSelectionDigest) {
    return { status: "UNAVAILABLE" as const, selection, reason: "HostKernel Stage-B receipt omitted its canonical ContextSelection digest" }
  }
  const preAdmissionProofDigest = boundReservation.preAdmissionProof.receiptDigest
  if (preAdmissionProofDigest === undefined) {
    return { status: "UNAVAILABLE" as const, selection, reason: "HostKernel Stage-B receipt omitted its stable context-bound receipt identity" }
  }
  const admission = yield* ManagedControl.admitAttempt({
    goalID: selection.goalID,
    runID: selection.runID,
    taskID: task.taskID,
    attemptID: task.candidateAttemptID,
    parentSessionID: selection.sessionID,
    locationID: selection.locationID,
    sessionID: childSessionID,
    expectedRevision: selection.revision,
    profileSelection: { profileId: task.profile.profileID, revision: task.profile.revision },
    preAdmissionProofDigest,
    contextSelection: prepared.contextSelection,
  })
  if (admission.contextSelectionDigest !== boundReservation.contextSelectionDigest ||
    admission.sessionID !== childSessionID || admission.attemptID !== reservation.candidateAttemptID) {
    return yield* new ManagedControlError({ operation: "admit", code: "managed_protocol", reason: "Attempt admission did not consume the exact Stage-B reservation, candidate, and ContextSelection digest" })
  }
  if (admission.sessionID !== ManagedControl.managedTaskSessionID(task.candidateAttemptID)) {
    return yield* new ManagedControlError({ operation: "admit", code: "managed_protocol", reason: "Rust admission changed the canonical candidate child Session ID" })
  }
  const handoff = yield* ManagedControl.claimManagedDispatch({
    goalID: selection.goalID,
    runID: selection.runID,
    taskID: task.taskID,
    parentSessionID: selection.sessionID,
    attemptID: admission.attemptID,
    profileSelection: { profileId: task.profile.profileID, revision: task.profile.revision },
    deliveryID: `managed_claim_${task.candidateAttemptID}`,
  })
  const consumeReceipt = yield* ManagedControl.consumeManagedDispatch({
    handoff,
    profileDefinition: handoff.profileDefinition,
    deliveryID: `managed_consume_${task.candidateAttemptID}`,
  })
  const child = yield* prompt.runManagedTask({
    selection: activeSelection,
    admission,
    handoff,
    consumeReceipt,
    trustedPrincipal: authenticated.principal,
    preparedRequest: prepared,
    managedFollowUpRunner,
    managedPreDispatchRecovery,
  }).pipe(Effect.provideService(SessionSupervisor.Service, supervisor))
  return {
    status: child.outcomeKind === "assistant_completed" ? "PROMPT_RETURNED" as const : "PROMPT_RETURNED_ERROR" as const,
    selection,
    admission,
    handoff,
    consumeReceipt,
    child,
  }
})
