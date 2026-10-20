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
