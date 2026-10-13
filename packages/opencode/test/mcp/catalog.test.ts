import { expect, test } from "bun:test"
import { McpCatalog } from "@/mcp/catalog"

test("sanitizes MCP server names before constructing code-mode namespaces", () => {
  expect(McpCatalog.sanitize("workspace / tools:v1")).toBe("workspace___tools_v1")
  expect(McpCatalog.sanitize("safe_Name-1")).toBe("safe_Name-1")
})
