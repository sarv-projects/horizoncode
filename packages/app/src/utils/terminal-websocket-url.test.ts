import { describe, expect, test } from "bun:test"
import { terminalWebSocketURL } from "./terminal-websocket-url"

describe("terminal websocket URL", () => {
  test("keeps the legacy V1 route and cursor query framing", () => {
    const url = terminalWebSocketURL({
      protocol: "v1",
      url: "http://localhost:4096",
      id: "pty_test",
      directory: "/repo",
      cursor: 8,
      username: "user",
      password: "secret",
      sameOrigin: true,
    })
    expect(url.pathname).toBe("/pty/pty_test/connect")
    expect(url.protocol).toBe("ws:")
    expect(url.searchParams.get("directory")).toBe("/repo")
    expect(url.searchParams.get("cursor")).toBe("8")
    expect(url.searchParams.has("ticket")).toBe(false)
    expect(url.searchParams.get("auth_token")).toBeTruthy()
    expect(url.searchParams.get("auth_token")).not.toContain("secret")
  })
  test("keeps V1 ticketless even when a ticket argument is supplied", () => {
    const url = terminalWebSocketURL({
      protocol: "v1",
      url: "http://localhost:4096",
      id: "pty_test",
      directory: "/repo",
      cursor: -1,
      ticket: "must-not-appear",
    })
    expect(url.pathname).toBe("/pty/pty_test/connect")
    expect(url.searchParams.has("ticket")).toBe(false)
  })


  test("uses a transport ticket for the V2 route without URL credentials", () => {
    const url = terminalWebSocketURL({
      protocol: "v2",
      url: "https://example.test",
      id: "pty_test",
      directory: "/repo",
      cursor: 5,
      ticket: "one-use",
      username: "user",
      password: "secret",
      authToken: true,
    })
    expect(url.pathname).toBe("/api/pty/pty_test/connect")
    expect(url.protocol).toBe("wss:")
    expect(url.searchParams.get("location[directory]")).toBe("/repo")
    expect(url.searchParams.get("cursor")).toBe("5")
    expect(url.searchParams.get("ticket")).toBe("one-use")
    expect(url.searchParams.has("auth_token")).toBe(false)
  })
})
