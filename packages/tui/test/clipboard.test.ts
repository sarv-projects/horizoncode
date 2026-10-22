import { expect, test } from "bun:test"
import { copyCommand } from "../src/clipboard"

test("never resolves platform clipboard child processes", () => {
  expect(copyCommand("linux", true, () => true)).toBeUndefined()
  expect(copyCommand("darwin", false, () => true)).toBeUndefined()
})

test("clipboard reads remain unavailable without a Guarded host bridge", async () => {
  const { read } = await import("../src/clipboard")
  await expect(read()).resolves.toBeUndefined()
})
