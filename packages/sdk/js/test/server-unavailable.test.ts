import { expect, test } from "bun:test"
import * as v1 from "../src/server"
import * as v2 from "../src/v2/server"

test("v1 SDK process launch APIs fail before spawn", async () => {
  await expect(v1.createOpencodeServer()).rejects.toMatchObject({ _tag: "ProcessUnavailableError" })
  expect(() => v1.createOpencodeTui()).toThrow("SDK process launch is unavailable")
})

test("v2 SDK process launch APIs fail before spawn", async () => {
  await expect(v2.createOpencodeServer()).rejects.toMatchObject({ _tag: "ProcessUnavailableError" })
  expect(() => v2.createOpencodeTui()).toThrow("SDK process launch is unavailable")
})
