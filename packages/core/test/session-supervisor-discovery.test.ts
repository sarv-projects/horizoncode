import { expect, test } from "bun:test"
import { Schema } from "effect"
import {
  RepoDiscoveryPageV1,
  RepoDiscoveryRequestV1,
} from "@opencode-ai/schema/repo-intelligence-v1"
import { repoDiscoveryPageMatchesRequest } from "@opencode-ai/core/session/supervisor"

const digest = `blake3:${"a".repeat(64)}`
const request = Schema.decodeUnknownSync(RepoDiscoveryRequestV1)({
  schemaVersion: 1,
  messageType: "discover",
  requestId: "discovery-validation",
  rootRef: "src",
  mode: "tree",
  maxEntries: 16,
  maxBytes: 4096,
  maxDepth: 4,
  deadline: "2026-10-21T12:00:00.000Z",
})

function page(overrides: Record<string, unknown> = {}) {
  return Schema.decodeUnknownSync(RepoDiscoveryPageV1)({
    schemaVersion: 1,
    messageType: "discovery",
    requestId: request.requestId,
    status: "CURRENT",
    freshness: "current",
    completeness: "complete",
    authority: {
      principalBinding: digest,
      sessionID: "ses_discovery",
      locationID: "loc_discovery",
      ownerEpoch: "1",
      workspaceBinding: digest,
      sourceRevision: digest,
      readPolicyDigest: digest,
      rootRef: request.rootRef,
      mode: request.mode,
      maxEntries: request.maxEntries,
      maxBytes: request.maxBytes,
      maxDepth: request.maxDepth,
    },
    coverage: { entries: 1, bytes: 80, depth: 1 },
    entries: [{ pathRef: "src/a.ts", kind: "file", depth: 1, sizeBytes: "20", languageHint: "typescript" }],
    ...overrides,
  })
}

test("validates discovery depth, strict path ordering, and mode semantics", () => {
  expect(repoDiscoveryPageMatchesRequest(request, page())).toBe(true)
  expect(repoDiscoveryPageMatchesRequest(request, page({ coverage: { entries: 1, bytes: 80, depth: 5 } }))).toBe(false)
  expect(repoDiscoveryPageMatchesRequest(request, page({
    entries: [{ pathRef: "src/nested/a.ts", kind: "file", depth: 1, sizeBytes: "20" }],
  }))).toBe(false)
  expect(repoDiscoveryPageMatchesRequest(request, page({
    entries: [
      { pathRef: "src/a.ts", kind: "file", depth: 1, sizeBytes: "20" },
      { pathRef: "src/a.ts", kind: "file", depth: 1, sizeBytes: "20" },
    ],
    coverage: { entries: 2, bytes: 160, depth: 1 },
  }))).toBe(false)
  expect(repoDiscoveryPageMatchesRequest(request, page({
    entries: [
      { pathRef: "src/b.ts", kind: "file", depth: 1, sizeBytes: "20" },
      { pathRef: "src/a.ts", kind: "file", depth: 1, sizeBytes: "20" },
    ],
    coverage: { entries: 2, bytes: 160, depth: 1 },
  }))).toBe(false)
  expect(repoDiscoveryPageMatchesRequest(request, page({
    entries: [{ pathRef: "src", kind: "directory", depth: 0, sizeBytes: "0" }],
  }))).toBe(false)
  expect(repoDiscoveryPageMatchesRequest(request, page({ coverage: { entries: 1, bytes: 79, depth: 1 } }))).toBe(false)
  expect(repoDiscoveryPageMatchesRequest(request, page({
    entries: [{ pathRef: "src/dir", kind: "directory", depth: 1, sizeBytes: "0", languageHint: "rust" }],
  }))).toBe(false)

  const manifestsRequest = Schema.decodeUnknownSync(RepoDiscoveryRequestV1)({ ...request, mode: "manifests" })
  expect(repoDiscoveryPageMatchesRequest(manifestsRequest, page({
    authority: { ...page().authority, mode: "manifests" },
  }))).toBe(false)
  expect(repoDiscoveryPageMatchesRequest(manifestsRequest, page({
    authority: { ...page().authority, mode: "manifests" },
    coverage: { entries: 1, bytes: 88, depth: 1 },
    entries: [{ pathRef: "src/package.json", kind: "file", depth: 1, sizeBytes: "20", manifestKind: "package_json" }],
  }))).toBe(true)
})
