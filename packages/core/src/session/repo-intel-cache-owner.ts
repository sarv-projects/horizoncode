import type { RepoGenerationPinV1 } from "@opencode-ai/schema/repo-intelligence-v1"
import type { TrustedPrincipal } from "../trusted-principal"

/**
 * Legacy diagnostic projection only; this is not consumed by the product path.
 *
 * HostKernel mints and applies its own exact cache observation from the live
 * RepoRead lease and retained generation. This Core projection cannot represent
 * that authority or invoke cache admission/retirement. Source coverage is not
 * allocated index memory and cannot claim reclaimed bytes.
 */
export interface RepoIntelGenerationCacheObservationV1 {
  readonly schemaVersion: 1
  readonly kind: "repo_intel_generation"
  readonly registryStatus: "unavailable"
  readonly unavailableReason: "core_projection_not_host_cache_authority"
  readonly owner: {
    readonly principal: string
    readonly sessionID: string
    readonly locationID: string
  }
  readonly generation: {
    readonly workspaceBinding: string
    readonly sourceGeneration: string
    readonly sourceRevision: string
    readonly sourceKind: RepoGenerationPinV1["sourceKind"]
    readonly expiresAt: string
    readonly ttlMs: number
  }
  /** Host-measured snapshot inputs; these do not measure derived index memory. */
  readonly sourceSnapshot: {
    readonly fileCount: number
    readonly observedBytes: number
    readonly maxFiles: 4096
    readonly maxObservedBytes: 67_108_864
  }
  readonly allocation: {
    readonly allocatedBytes: null
    readonly entryCount: null
    readonly reclaimedBytes: null
  }
}

/**
 * Project one successful HostKernel generation pin into bounded diagnostic
 * metadata. Do not connect this to P8: HostKernel owns exact cache observation,
 * invalidation and retirement proofs; Core cannot recreate them.
 */
export const projectRepoIntelGenerationCacheObservation = (input: {
  readonly principal: TrustedPrincipal
  readonly sessionID: string
  readonly locationID: string
  readonly generation: RepoGenerationPinV1
  readonly observedAtUnixMs: number
}): RepoIntelGenerationCacheObservationV1 | undefined => {
  if (
    input.principal.kind !== "server_auth" ||
    input.principal.subject.length === 0 ||
    input.principal.subject.length > 128 ||
    /[\u0000-\u001f\u007f]/.test(input.principal.subject) ||
    !/^ses_[A-Za-z0-9_-]{1,128}$/.test(input.sessionID) ||
    !/^loc_[0-9a-f]{64}$/.test(input.locationID) ||
    !Number.isSafeInteger(input.observedAtUnixMs) ||
    input.observedAtUnixMs < 0
  ) {
    return undefined
  }

  const expiresAtUnixMs = Date.parse(input.generation.expiresAt)
  if (
    !Number.isFinite(expiresAtUnixMs) ||
    expiresAtUnixMs <= input.observedAtUnixMs ||
    expiresAtUnixMs - input.observedAtUnixMs > 30_000 ||
    input.generation.coverage.files > 4096 ||
    input.generation.coverage.bytes > 67_108_864
  ) {
    return undefined
  }

  return {
    schemaVersion: 1,
    kind: "repo_intel_generation",
    registryStatus: "unavailable",
    unavailableReason: "core_projection_not_host_cache_authority",
    owner: {
      principal: `server_auth:${input.principal.subject}`,
      sessionID: input.sessionID,
      locationID: input.locationID,
    },
    generation: {
      workspaceBinding: input.generation.workspaceBinding,
      sourceGeneration: input.generation.sourceGeneration,
      sourceRevision: input.generation.sourceRevision,
      sourceKind: input.generation.sourceKind,
      expiresAt: input.generation.expiresAt,
      ttlMs: expiresAtUnixMs - input.observedAtUnixMs,
    },
    sourceSnapshot: {
      fileCount: input.generation.coverage.files,
      observedBytes: input.generation.coverage.bytes,
      maxFiles: 4096,
      maxObservedBytes: 67_108_864,
    },
    allocation: {
      allocatedBytes: null,
      entryCount: null,
      reclaimedBytes: null,
    },
  }
}

/** Kept disabled: no product consumer and no Core-side HostKernel cache bridge. */
export const REPO_INTEL_CACHE_OWNER_SINK_ENABLED = false
