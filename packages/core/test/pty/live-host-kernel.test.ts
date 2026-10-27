import { expect, test } from "bun:test"
import { livePtyFixtureRoot, livePtySocketPaths } from "./live-host-kernel"

test("live PTY fixture keeps host and observer socket paths within sockaddr_un", () => {
  const root = livePtyFixtureRoot().replace(/XXXXXX$/, "abcdef")
  for (const socketPath of livePtySocketPaths(root)) {
    expect(Buffer.byteLength(socketPath)).toBeLessThan(108)
  }
})
