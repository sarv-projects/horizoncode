import { describe, expect, test } from "bun:test"
import { projectRepoIntelGenerationCacheObservation } from "../src/session/repo-intel-cache-owner"

const digest = `blake3:${"a".repeat(64)}`
const now = Date.parse("2026-10-20T10:00:00.000Z")
const generation = {
  schemaVersion: 1 as const,
  messageType: "generation" as const,
  requestId: "query-123",
  workspaceBinding: "workspace-123",
  sourceGeneration: digest,
  sourceRevision: digest,
  sourceKind: "none" as const,
  coverage: { files: 3, bytes: 128 },
  expiresAt: "2026-10-20T10:00:20.000Z",
}

describe("RepoIntel cache-owner metadata projection", () => {
  test("projects only authenticated owner and HostKernel generation facts", () => {
    const observation = projectRepoIntelGenerationCacheObservation({
      principal: { kind: "server_auth", subject: "authenticated-core" },
      sessionID: "ses_123",
      locationID: `loc_${"b".repeat(64)}`,
      generation,
      observedAtUnixMs: now,
    })

    expect(observation).toEqual({
      schemaVersion: 1,
      kind: "repo_intel_generation",
      registryStatus: "unavailable",
      unavailableReason: "host_build_identity_not_projected",
      owner: {
        principal: "server_auth:authenticated-core",
        sessionID: "ses_123",
        locationID: `loc_${"b".repeat(64)}`,
      },
      generation: {
        workspaceBinding: "workspace-123",
        sourceGeneration: digest,
        sourceRevision: digest,
        sourceKind: "none",
        expiresAt: generation.expiresAt,
        ttlMs: 20_000,
      },
      sourceSnapshot: {
        fileCount: 3,
        observedBytes: 128,
        maxFiles: 4096,
        maxObservedBytes: 67_108_864,
      },
      allocation: { allocatedBytes: null, entryCount: null, reclaimedBytes: null },
    })
  })

  test("does not project host_os, malformed identity, or expired/overlong leases", () => {
    const base = {
      sessionID: "ses_123",
      locationID: `loc_${"b".repeat(64)}`,
      generation,
      observedAtUnixMs: now,
    }
    expect(projectRepoIntelGenerationCacheObservation({ ...base, principal: { kind: "host_os" } })).toBeUndefined()
    expect(
      projectRepoIntelGenerationCacheObservation({
        ...base,
        principal: { kind: "server_auth", subject: "bad\nsubject" },
      }),
    ).toBeUndefined()
    expect(
      projectRepoIntelGenerationCacheObservation({
        ...base,
        principal: { kind: "server_auth", subject: "authenticated-core" },
        generation: { ...generation, expiresAt: "2026-10-20T09:59:59.999Z" },
      }),
    ).toBeUndefined()
    expect(
      projectRepoIntelGenerationCacheObservation({
        ...base,
        principal: { kind: "server_auth", subject: "authenticated-core" },
        generation: { ...generation, expiresAt: "2026-10-20T10:00:30.001Z" },
      }),
    ).toBeUndefined()
  })
})
