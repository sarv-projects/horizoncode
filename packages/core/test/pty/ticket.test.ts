import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { LayerNode } from "@horizoncode/core/effect/layer-node"
import { PtyID } from "@horizoncode/core/pty/schema"
import { PtyTicket } from "@horizoncode/core/pty/ticket"
import { WorkspaceV2 } from "@horizoncode/core/workspace"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(PtyTicket.node))
const itExpiring = testEffect(
  LayerNode.compile(PtyTicket.node, [[PtyTicket.node, Layer.effect(PtyTicket.Service, PtyTicket.make(5))]]),
)

describe("PTY websocket tickets", () => {
  it.live("consumes tickets once", () =>
    Effect.gen(function* () {
      const tickets = yield* PtyTicket.Service
      const scope = { ptyID: PtyID.ascending(), directory: "/tmp/a", principal: "server-auth:user-a", origin: "oc://renderer" }
      const issued = yield* tickets.issue(scope)

      expect(yield* tickets.consume({ ...scope, ticket: issued.ticket })).toBe(true)
      expect(yield* tickets.consume({ ...scope, ticket: issued.ticket })).toBe(false)
    }),
  )

  it.live("rejects tickets scoped to a different request", () =>
    Effect.gen(function* () {
      const tickets = yield* PtyTicket.Service
      const ptyID = PtyID.ascending()
      const scope = { ptyID, directory: "/tmp/a", principal: "server-auth:user-a", origin: "oc://renderer" }
      const issued = yield* tickets.issue(scope)

      expect(yield* tickets.consume({ ...scope, directory: "/tmp/b", ticket: issued.ticket })).toBe(false)
      expect(yield* tickets.consume({ ...scope, principal: "server-auth:user-b", ticket: issued.ticket })).toBe(false)
      expect(yield* tickets.consume({ ...scope, origin: "tauri://localhost", ticket: issued.ticket })).toBe(false)
      expect(
        yield* tickets.consume({
          ...scope,
          ptyID: PtyID.ascending(),
          ticket: issued.ticket,
        }),
      ).toBe(false)
      expect(yield* tickets.consume({ ...scope, ticket: issued.ticket })).toBe(true)
    }),
  )

  itExpiring.live("rejects tickets after the TTL elapses", () =>
    Effect.gen(function* () {
      const tickets = yield* PtyTicket.Service
      const ptyID = PtyID.ascending()
      const scope = { ptyID, principal: "server-auth:user-a", origin: "oc://renderer" }
      const issued = yield* tickets.issue(scope)

      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 25)))

      expect(yield* tickets.consume({ ...scope, ticket: issued.ticket })).toBe(false)
    }),
  )

  it.live("rejects tickets scoped to a different workspace", () =>
    Effect.gen(function* () {
      const tickets = yield* PtyTicket.Service
      const ptyID = PtyID.ascending()
      const workspaceID = WorkspaceV2.ID.ascending()
      const scope = { ptyID, workspaceID, principal: "server-auth:user-a", origin: "oc://renderer" }
      const issued = yield* tickets.issue(scope)

      expect(
        yield* tickets.consume({
          ...scope,
          workspaceID: WorkspaceV2.ID.ascending(),
          ticket: issued.ticket,
        }),
      ).toBe(false)
      expect(yield* tickets.consume({ ...scope, ticket: issued.ticket })).toBe(true)
    }),
  )
})
