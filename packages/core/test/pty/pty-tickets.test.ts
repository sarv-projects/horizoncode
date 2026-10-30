import { describe, expect, test } from "bun:test"
import { Cause, Deferred, Effect, Exit, Queue } from "effect"
import { Pty } from "@horizoncode/core/pty"
import type { PtyID } from "@horizoncode/core/pty/schema"
import { probeStartApproval, withLivePty } from "./live-host-kernel"

// PTY-003: terminal tickets are the only way a renderer/desktop surface may attach to an
// owner terminal. Every case here runs against a private live host-kernel so ticket issue,
// one-time consumption, origin/principal binding and revocation are proven by the real
// canonical Guard/ExecutionHost path rather than a stubbed transport.
const bash = Bun.which("bash")

// Ticket cases that must launch a terminal need an approvable `terminal.start` Guard
// challenge; the probe keeps them skipped-or-live instead of vacuously green.
const startApproval = await probeStartApproval()
// PTY-006: native Windows ConPTY is unavailable here and no case may pretend otherwise.
const hostTest = process.platform === "win32" ? test.skip : test.skipIf(startApproval === "no-kernel")
const startTest = process.platform === "win32" ? test.skip : test.skipIf(startApproval !== "eligible")

const origin = "oc://renderer"
const binding = (id: PtyID) => ({ terminalID: id, origin, protocol: "horizon.terminal.v1" }) as const

const errorOf = (result: Exit.Exit<unknown, unknown>) => {
  expect(Exit.isFailure(result)).toBe(true)
  return Exit.isFailure(result) ? Cause.squash(result.cause) : undefined
}

const createTerminal = Effect.fn("PtyTicketsTest.createTerminal")(function* (workspace: string) {
  const pty = yield* Pty.Service
  return yield* Effect.acquireRelease(
    pty.create({ command: bash!, args: ["-c", "exec cat"], cwd: workspace, env: {} }),
    (info) => pty.remove(info.id).pipe(Effect.ignore),
  )
})

const acquire = Effect.fn("PtyTicketsTest.acquire")(function* (id: PtyID) {
  const pty = yield* Pty.Service
  return yield* pty.acquireTicket(binding(id))
})

const attachTicket = Effect.fn("PtyTicketsTest.attachTicket")(function* (id: PtyID, attachmentID: string) {
  const pty = yield* Pty.Service
  const output = yield* Queue.unbounded<string>()
  const ended = yield* Deferred.make<{ exitCode?: number }>()
  const attachment = yield* pty.attach(id, {
    origin,
    protocol: "horizon.terminal.v1",
    attachmentID,
    cursor: -1,
    onData: (chunk) => Queue.offerUnsafe(output, new TextDecoder().decode(chunk)),
    onEnd: (event) => Deferred.doneUnsafe(ended, Effect.succeed(event)),
  })
  attachment.activate()
  return { attachment, output, ended }
})

const waitForOutput = (output: Queue.Queue<string>, text: string) =>
  Effect.gen(function* () {
    let received = ""
    while (!received.includes(text)) received += yield* Queue.take(output)
    return received
  }).pipe(
    Effect.timeoutOrElse({
      duration: "10 seconds",
      orElse: () => Effect.fail(new Error(`timeout waiting for output containing ${JSON.stringify(text)}`)),
    }),
  )

describe("pty tickets", () => {
  hostTest("returns typed not found errors for missing terminals", () =>
    withLivePty(({ pty }) =>
      Effect.gen(function* () {
        const id = "pty_ticket_missing" as PtyID

        for (const result of [
          yield* pty.acquireTicket(binding(id)).pipe(Effect.exit),
          yield* pty.consumeTicket({ ...binding(id), ticket: "t".repeat(64) }).pipe(Effect.exit),
          yield* pty.revokeTicket({ terminalID: id, ticketID: "ticket_missing" }).pipe(Effect.exit),
        ]) {
          expect(errorOf(result)).toMatchObject({ _tag: "Pty.NotFoundError", ptyID: id })
        }
      }),
    ),
  30_000)

  startTest("rejects unbound protocols and origins before admitting a ticket", () => {
    if (!bash) return
    return withLivePty(({ workspace }) =>
      Effect.gen(function* () {
        const pty = yield* Pty.Service
        const info = yield* createTerminal(workspace)

        const legacy = yield* pty
          .acquireTicket({ terminalID: info.id, origin, protocol: "legacy" })
          .pipe(Effect.exit)
        expect(errorOf(legacy)).toMatchObject({ _tag: "Pty.InvalidInputError" })

        const malformed = yield* pty
          .acquireTicket({ terminalID: info.id, origin: "not-a-url", protocol: "horizon.terminal.v1" })
          .pipe(Effect.exit)
        expect(errorOf(malformed)).toMatchObject({ _tag: "Pty.InvalidInputError" })

        // `https://evil.example` passes Core's exact-origin validation but is not in the
        // host allowlist, so the kernel must refuse to admit the ticket.
        const foreignOrigin = yield* pty
          .acquireTicket({ terminalID: info.id, origin: "https://evil.example", protocol: "horizon.terminal.v1" })
          .pipe(Effect.exit)
        expect(errorOf(foreignOrigin)).toMatchObject({
          _tag: "SessionSupervisorError",
          stage: "effect",
          hostCode: "BAD_FRAME",
        })

        const shortTicket = yield* pty.consumeTicket({ ...binding(info.id), ticket: "short" }).pipe(Effect.exit)
        expect(errorOf(shortTicket)).toMatchObject({ _tag: "Pty.InvalidInputError" })

        const badTicketID = yield* pty
          .revokeTicket({ terminalID: info.id, ticketID: "not-a-ticket" })
          .pipe(Effect.exit)
        expect(errorOf(badTicketID)).toMatchObject({ _tag: "Pty.InvalidInputError" })
      }),
    )
  }, 60_000)

  startTest("issues a one-shot ticket whose attachment can be consumed exactly once", () => {
    if (!bash) return
    return withLivePty(({ workspace }) =>
      Effect.gen(function* () {
        const pty = yield* Pty.Service
        const info = yield* createTerminal(workspace)
        const acquiredAt = Date.now()
        const ticket = yield* acquire(info.id)

        expect(ticket.ticketID).toMatch(/^ticket_[a-zA-Z0-9_-]{1,128}$/)
        expect(ticket.ticket.length).toBeGreaterThanOrEqual(32)
        expect(ticket.ticket.length).toBeLessThanOrEqual(512)
        expect(Number.isSafeInteger(ticket.ownerEpoch) && ticket.ownerEpoch >= 0).toBe(true)
        expect(ticket.expiresAtUnixMs).toBeGreaterThan(acquiredAt)
        // The host stamps 30 seconds from its own clock, which runs slightly after this
        // process captured `acquiredAt`, so allow a small scheduling skew.
        expect(ticket.expiresAtUnixMs).toBeLessThanOrEqual(acquiredAt + 35_000)

        const consumed = yield* pty.consumeTicket({ ...binding(info.id), ticket: ticket.ticket })
        expect(consumed.ticketID).toBe(ticket.ticketID)
        expect(consumed.attachmentID).toMatch(/^att_[a-zA-Z0-9_-]{1,128}$/)
        expect(consumed.terminalID).toBe(info.id)
        expect(consumed.generation).toBeGreaterThanOrEqual(0)
        expect(consumed.ownerEpoch).toBe(ticket.ownerEpoch)

        const attached = yield* attachTicket(info.id, consumed.attachmentID)
        attached.attachment.write("ticket-attachment-marker\n")
        expect(yield* waitForOutput(attached.output, "ticket-attachment-marker")).toContain("ticket-attachment-marker")

        // A ticket is one-shot: neither the consumed attachment ID nor the token may be reused.
        const reusedAttachment = yield* attachTicket(info.id, consumed.attachmentID).pipe(Effect.exit)
        expect(errorOf(reusedAttachment)).toMatchObject({ _tag: "Pty.UnavailableError", ptyID: info.id })

        const reusedTicket = yield* pty.consumeTicket({ ...binding(info.id), ticket: ticket.ticket }).pipe(Effect.exit)
        expect(errorOf(reusedTicket)).toMatchObject({
          _tag: "SessionSupervisorError",
          stage: "effect",
          hostCode: "DENIED",
        })
      }),
    )
  }, 60_000)

  startTest("revocation is idempotent and prevents later consumption", () => {
    if (!bash) return
    return withLivePty(({ workspace }) =>
      Effect.gen(function* () {
        const pty = yield* Pty.Service
        const info = yield* createTerminal(workspace)
        const ticket = yield* acquire(info.id)

        yield* pty.revokeTicket({ terminalID: info.id, ticketID: ticket.ticketID })
        yield* pty.revokeTicket({ terminalID: info.id, ticketID: ticket.ticketID })

        const consumed = yield* pty.consumeTicket({ ...binding(info.id), ticket: ticket.ticket }).pipe(Effect.exit)
        expect(errorOf(consumed)).toMatchObject({
          _tag: "SessionSupervisorError",
          stage: "effect",
          hostCode: "DENIED",
        })

        // An unknown but well-formed ticket ID is refused by the host, never silently accepted.
        const unknown = yield* pty
          .revokeTicket({ terminalID: info.id, ticketID: "ticket_never_issued" })
          .pipe(Effect.exit)
        expect(errorOf(unknown)).toMatchObject({
          _tag: "SessionSupervisorError",
          stage: "effect",
          hostCode: "DENIED",
        })
      }),
    )
  }, 60_000)

  startTest("revoking a consumed ticket revokes its attachment", () => {
    if (!bash) return
    return withLivePty(({ workspace }) =>
      Effect.gen(function* () {
        const pty = yield* Pty.Service
        const info = yield* createTerminal(workspace)
        const ticket = yield* acquire(info.id)
        const consumed = yield* pty.consumeTicket({ ...binding(info.id), ticket: ticket.ticket })

        yield* pty.revokeTicket({
          terminalID: info.id,
          ticketID: consumed.ticketID,
          attachmentID: consumed.attachmentID,
        })

        const attach = yield* attachTicket(info.id, consumed.attachmentID).pipe(Effect.exit)
        expect(errorOf(attach)).toMatchObject({ _tag: "Pty.UnavailableError", ptyID: info.id })
      }),
    )
  }, 60_000)
})
