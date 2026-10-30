import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import * as RepoIntelligenceSchema from "@horizoncode/schema/repo-intelligence-v1"
import { projectRepoIntelGenerationCacheObservation } from "../src/session/repo-intel-cache-owner"

const digest = `blake3:${"a".repeat(64)}`
const now = Date.parse("2026-10-20T10:00:00.000Z")
const generation = Schema.decodeUnknownSync(RepoIntelligenceSchema.RepoGenerationPinV1)({
  schemaVersion: 1 as const,
  messageType: "generation" as const,
  requestId: "query-123",
  workspaceBinding: "workspace-123",
  sourceGeneration: digest,
  sourceRevision: digest,
  sourceKind: "none" as const,
  coverage: { files: "3", bytes: "128" },
  expiresAt: "2026-10-20T10:00:20.000Z",
})

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
      unavailableReason: "core_projection_not_host_cache_authority",
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
    const withExpiresAt = (expiresAt: string) =>
      Schema.decodeUnknownSync(RepoIntelligenceSchema.RepoGenerationPinV1)({ ...generation, expiresAt })
    expect(
      projectRepoIntelGenerationCacheObservation({
        ...base,
        principal: { kind: "server_auth", subject: "authenticated-core" },
        generation: withExpiresAt("2026-10-20T09:59:59.999Z"),
      }),
    ).toBeUndefined()
    expect(
      projectRepoIntelGenerationCacheObservation({
        ...base,
        principal: { kind: "server_auth", subject: "authenticated-core" },
        generation: withExpiresAt("2026-10-20T10:00:30.001Z"),
      }),
    ).toBeUndefined()
  })

  test("never projects a generation whose coverage or lease is outside its declared bounds", () => {
    const identity = {
      sessionID: "ses_123",
      locationID: `loc_${"b".repeat(64)}`,
      observedAtUnixMs: now,
      principal: { kind: "server_auth", subject: "authenticated-core" } as const,
    }
    const withPin = (overrides: Record<string, unknown>) =>
      Schema.decodeUnknownSync(RepoIntelligenceSchema.RepoGenerationPinV1)({ ...generation, ...overrides })

    // Host-measured coverage outside the declared collection bounds is not a
    // plausible pin and must not project as one.
    expect(
      projectRepoIntelGenerationCacheObservation({
        ...identity,
        generation: withPin({ coverage: { files: "4097", bytes: "128" } }),
      }),
    ).toBeUndefined()
    expect(
      projectRepoIntelGenerationCacheObservation({
        ...identity,
        generation: withPin({ coverage: { files: "3", bytes: "67108865" } }),
      }),
    ).toBeUndefined()

    // The exact boundaries still project, with the pin's own values.
    const boundary = projectRepoIntelGenerationCacheObservation({
      ...identity,
      generation: withPin({ coverage: { files: "4096", bytes: "67108864" } }),
    })
    expect(boundary?.sourceSnapshot).toEqual({
      fileCount: 4096,
      observedBytes: 67_108_864,
      maxFiles: 4096,
      maxObservedBytes: 67_108_864,
    })

    // A lease that expires exactly at the observation instant is already over.
    expect(
      projectRepoIntelGenerationCacheObservation({
        ...identity,
        generation: withPin({ expiresAt: "2026-10-20T10:00:00.000Z" }),
      }),
    ).toBeUndefined()
    // The longest lease this projection will claim is exactly 30 seconds.
    const fullTtl = projectRepoIntelGenerationCacheObservation({
      ...identity,
      generation: withPin({ expiresAt: "2026-10-20T10:00:30.000Z" }),
    })
    expect(fullTtl?.generation.ttlMs).toBe(30_000)
  })
})
