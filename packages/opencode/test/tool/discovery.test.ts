import { describe, expect, it } from "bun:test"
import { searchToolDescriptorsV1, toolSchemaDigestV1 } from "../../src/tool/discovery"

const descriptor = (input: { readonly id?: string; readonly tags?: readonly string[] } = {}) => ({
  id: input.id ?? "files.read",
  description: "Read workspace files",
  tags: input.tags ?? ["workspace", "read"],
  sideEffectClass: "read_only" as const,
  availability: "available" as const,
  requiredCapability: "files.read",
  schemaDigest: toolSchemaDigestV1({ type: "object", properties: {} }),
})

describe("tool discovery", () => {
  it("searches tags deterministically while preserving the descriptor type", () => {
    const read = descriptor()
    const write = descriptor({ id: "files.write", tags: ["workspace", "mutation"] })

    expect(searchToolDescriptorsV1({ query: "mutation", descriptors: [read, write] })).toEqual([write])
    expect(searchToolDescriptorsV1({ query: "workspace", descriptors: [write, read] }).map((item) => item.id))
      .toEqual(["files.read", "files.write"])
  })

  it("rejects malformed or over-budget tags before returning candidates", () => {
    expect(() => searchToolDescriptorsV1({ query: "read", descriptors: [descriptor({ tags: ["x".repeat(65)] })] }))
      .toThrow("tool discovery descriptor is malformed or exceeds its bounds")

    const oversized = Array.from({ length: 256 }, (_, index) => descriptor({
      id: `tool.${index}`,
      tags: Array.from({ length: 8 }, () => "x".repeat(64)),
    }))
    expect(() => searchToolDescriptorsV1({ query: "x", descriptors: oversized })).toThrow(
      "tool discovery descriptions exceed the aggregate bound",
    )
  })
})
