import { describe, expect, test } from "bun:test"
import { makeProtocolDispatchQueue } from "@/lsp/protocol-dispatch-queue"

describe("protocol dispatch queue", () => {
  test("does not dispatch queued work after an earlier dispatch becomes uncertain", async () => {
    const queue = makeProtocolDispatchQueue()
    const calls: string[] = []
    let rejectFirst!: (error: Error) => void
    const firstFailure = new Error("dispatch outcome is unknown")

    const first = queue.run(() => {
      calls.push("first")
      return new Promise<void>((_resolve, reject) => {
        rejectFirst = reject
      })
    })
    const second = queue.run(async () => {
      calls.push("second")
    })

    await Promise.resolve()
    rejectFirst(firstFailure)
    await expect(first).rejects.toBe(firstFailure)
    await expect(second).rejects.toBe(firstFailure)
    expect(calls).toEqual(["first"])
  })
})
