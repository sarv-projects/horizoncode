import { expect, test } from "bun:test"
import { Effect } from "effect"
import { withRepoIntelOverlayGate } from "@opencode-ai/core/session/repo-intel-overlay"

test("an unsupported overlay fails before Location registration or generation acquisition", async () => {
  let registrations = 0
  let generations = 0
  const result = await Effect.runPromise(
    withRepoIntelOverlayGate({
      overlayRef: "ovl_test_reference_123456",
      unavailable: () => "capability_unavailable" as const,
      dispatch: () =>
        Effect.sync(() => {
          registrations += 1
        }).pipe(
          Effect.andThen(
            Effect.sync(() => {
              generations += 1
            }),
          ),
          Effect.as("sent" as const),
        ),
    }).pipe(Effect.catch((error) => Effect.succeed(error))),
  )
  expect(result).toBe("capability_unavailable")
  expect(registrations).toBe(0)
  expect(generations).toBe(0)
})

test("every non-undefined overlay reference is refused before dispatch regardless of shape", async () => {
  // Core owns no overlay producer: the gate must fail closed for any reference it
  // is handed and must never inspect, resolve or select an overlay by owner/path
  // itself. Only `undefined` may reach the dispatch.
  const refs: ReadonlyArray<unknown> = [
    undefined,
    null,
    "",
    0,
    true,
    {},
    [],
    "ovl_test_reference_123456",
    "ovl_" + "x".repeat(200),
  ]
  for (const overlayRef of refs) {
    let dispatched = 0
    const result = await Effect.runPromise(
      withRepoIntelOverlayGate({
        overlayRef,
        unavailable: () => "capability_unavailable" as const,
        dispatch: () =>
          Effect.sync(() => {
            dispatched += 1
          }).pipe(Effect.as("sent" as const)),
      }).pipe(Effect.catch((error) => Effect.succeed(error))),
    )
    expect(result).toBe(overlayRef === undefined ? "sent" : "capability_unavailable")
    expect(dispatched).toBe(overlayRef === undefined ? 1 : 0)
  }
})
