import { expect, test } from "bun:test"
import { searchToolDescriptorsV1, TOOL_DISCOVERY_LIMITS_V1, type ToolDiscoveryDescriptorV1 } from "../../src/tool/discovery"

const descriptor = (id: string): ToolDiscoveryDescriptorV1 => ({
  id,
  description: `Searchable ${id}`,
  tags: ["workspace", "read"],
  sideEffectClass: "read_only",
  availability: "available",
  requiredCapability: "files.read",
  schemaDigest: `blake3:${"a".repeat(64)}`,
})

test("tool discovery ranks within the bounded candidate window", () => {
  const candidates = Array.from({ length: TOOL_DISCOVERY_LIMITS_V1.maxCandidates }, (_, index) => descriptor(`tool.${index}`))
  expect(searchToolDescriptorsV1({ query: "tool.2", descriptors: candidates, limit: 2 }).map((item) => item.id))
    .toEqual(["tool.2", "tool.20"])
})

test("tool discovery rejects oversized candidate collections and malformed descriptors", () => {
  const tooMany = Array.from({ length: TOOL_DISCOVERY_LIMITS_V1.maxCandidates + 1 }, (_, index) => descriptor(`tool.${index}`))
  expect(() => searchToolDescriptorsV1({ query: "tool", descriptors: tooMany })).toThrow(/candidate or query limit/)

  const malformed = { ...descriptor("tool.valid"), schemaDigest: "sha256:wrong-algorithm" }
  expect(() => searchToolDescriptorsV1({ query: "tool", descriptors: [malformed] })).toThrow(/malformed or exceeds/)
})

test("tool discovery rejects aggregate description overflow", () => {
  const oversized = Array.from({ length: 256 }, (_, index) => ({
    ...descriptor(`tool.${index}`),
    tags: Array.from({ length: 32 }, () => "t".repeat(64)),
  }))
  expect(() => searchToolDescriptorsV1({ query: "tool", descriptors: oversized })).toThrow(/aggregate bound/)
})
