import { describe, expect, test } from "bun:test"
import { SessionSupervisor } from "@opencode-ai/core/session/supervisor"
import { TrustedPrincipalContext } from "@opencode-ai/core/trusted-principal"
import { Effect, Layer } from "effect"
import {
  AutomationControlError,
  create,
  history,
  list,
  runNow,
  setEnabled,
  update,
  type AutomationDefinition,
} from "@/session/automation-control"

const principal = { kind: "server_auth", subject: "automation-owner" } as const
const scope = {
  locationID: "location-1",
  locationRef: { directory: "/workspace" } as never,
  sessionID: "session-1",
  trustedPrincipal: principal,
}

const definition: AutomationDefinition = {
  actionCapabilityID: "terminal.run",
  actionVersion: 1,
  actionDigest: `blake3:${"a".repeat(64)}`,
  actionSchemaDigest: `blake3:${"b".repeat(64)}`,
  actionInputJSON: '{"argv":["bun","test"]}',
  scheduleExpression: "0 * * * *",
  timezone: "UTC",
  enabled: true,
  overlapPolicy: "SKIP",
  missedRunPolicy: "SKIP",
  retry: { maxAttempts: 2, initialDelayMs: 1_000, maxDelayMs: 60_000 },
}

const occurrence = {
  occurrenceID: "occ-1",
  scheduledAtMs: 1_700_000_000_000,
  attempt: 1,
  status: "pending",
  retryAtMs: null,
  cancelRequested: false,
  guardReceiptRef: null,
}

const summary = {
  automationID: "automation-1",
  version: "3",
  definition: { ...definition, actionInputJSON: null, actionSchemaDigest: null },
  active: null,
  pending: occurrence,
  retryPending: null,
  historyCount: 1,
  invocation: { available: false, reason: "guarded_invocation_unavailable" },
}

function supervisor(
  response: unknown,
  calls: Array<{ service: string; operation: string; body: unknown; options: unknown }> = [],
) {
  return Layer.mock(SessionSupervisor.Service)({
    requestHostKernel: (service, operation, body, options) => {
      calls.push({ service, operation, body, options })
      return Effect.succeed(response as Record<string, unknown>)
    },
  })
}

describe("AutomationControl projection", () => {
  test("lists and decodes bounded definitions with the authenticated location scope", async () => {
    const calls: Array<{ service: string; operation: string; body: unknown; options: unknown }> = []
    const result = await Effect.runPromise(list(scope).pipe(Effect.provide(supervisor({ automations: [summary] }, calls))))
    expect(result.automations).toHaveLength(1)
    expect(result.automations[0]).toMatchObject({
      automationID: "automation-1",
      version: "3",
      definition: { actionCapabilityID: "terminal.run", enabled: true },
      pending: { occurrenceID: "occ-1" },
      invocation: { available: false },
    })
    expect(calls).toEqual([{
      service: "automation.v1",
      operation: "automations.list",
      body: { locationID: "location-1" },
      options: { trustedPrincipal: principal },
    }])
  })

  test("rejects over-limit or malformed list rows before the TUI sees them", async () => {
    for (const response of [
      { automations: Array.from({ length: 129 }, () => summary) },
      { automations: [{ ...summary, version: "-1" }] },
      { automations: [{ ...summary, automationID: "../escape" }] },
    ]) {
      const result = await Effect.runPromise(Effect.result(list(scope).pipe(Effect.provide(supervisor(response)))))
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") expect(result.failure).toBeInstanceOf(AutomationControlError)
    }
  })

  test("history is bounded, ordered, and validated", async () => {
    const result = await Effect.runPromise(history(scope, "automation-1", 32).pipe(Effect.provide(supervisor({
      automationID: "automation-1",
      version: "3",
      history: [occurrence],
      hasMore: false,
    }))))
    expect(result.history).toHaveLength(1)
    expect(result.hasMore).toBe(false)

    const invalid = await Effect.runPromise(Effect.result(
      history(scope, "automation-1", 129).pipe(Effect.provide(supervisor({}))),
    ))
    expect(invalid._tag).toBe("Failure")
    if (invalid._tag === "Failure") expect(invalid.failure).toBeInstanceOf(AutomationControlError)
  })

  test("create/update fail closed before Guard because no canonical schema validator is exposed", async () => {
    const calls: Array<{ service: string; operation: string }> = []
    const layer = supervisor({}, calls as never)
    for (const effect of [
      create(scope, "automation-1", "delivery-1", definition),
      update(scope, "automation-1", "3", "delivery-2", definition),
    ]) {
      const result = await Effect.runPromise(
        Effect.result(
          effect.pipe(
            Effect.provide(layer),
            Effect.provideService(TrustedPrincipalContext, { principal }),
          ),
        ),
      )
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") expect(result.failure).toMatchObject({ code: "capability_unavailable" })
    }
    expect(calls).toEqual([])
  })

  test("enable/disable rejects malformed authority and runNow stays unavailable", async () => {
    const calls: Array<{ service: string; operation: string }> = []
    const invalid = await Effect.runPromise(Effect.result(
      setEnabled(scope, "automation-1", "../bad", "delivery-3", false).pipe(
        Effect.provide(supervisor({}, calls as never)),
        Effect.provideService(TrustedPrincipalContext, { principal }),
      ),
    ))
    expect(invalid._tag).toBe("Failure")
    if (invalid._tag === "Failure") expect(invalid.failure).toBeInstanceOf(AutomationControlError)
    expect(calls).toEqual([])

    const invoked = await Effect.runPromise(Effect.result(
      runNow(scope, "automation-1", "3", "delivery-4").pipe(Effect.provide(supervisor({}, calls as never))),
    ))
    expect(invoked._tag).toBe("Failure")
    if (invoked._tag === "Failure") expect(invoked.failure).toMatchObject({ code: "capability_unavailable" })
    expect(calls).toEqual([])
  })
})
