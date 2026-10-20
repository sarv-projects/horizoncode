import { describe, expect, test } from "bun:test"
import { mcpStatusDetail, mcpStatusLabel } from "../../src/component/dialog-mcp"

describe("MCP connection status presentation", () => {
  test("shows an unavailable label and the backend's fail-closed reason", () => {
    const status = {
      status: "failed",
      error: "MCP connections are unavailable until the canonical Rust execution broker supports MCP process and network effects.",
    } as const

    expect(mcpStatusLabel(status)).toBe("Unavailable")
    expect(mcpStatusDetail(status)).toBe(status.error)
  })

  test("distinguishes connected, disabled, authentication, and client-registration states", () => {
    expect(mcpStatusLabel({ status: "connected" })).toBe("Connected")
    expect(mcpStatusLabel({ status: "disabled" })).toBe("Disabled")
    expect(mcpStatusLabel({ status: "needs_auth" })).toBe("Needs authentication")
    expect(
      mcpStatusLabel({ status: "needs_client_registration", error: "Client registration is required." }),
    ).toBe("Client registration required")
    expect(mcpStatusDetail({ status: "connected" })).toBeUndefined()
    expect(mcpStatusDetail({ status: "needs_client_registration", error: "Client registration is required." })).toBe(
      "Client registration is required.",
    )
  })
})
