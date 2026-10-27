import { describe, expect, test } from "bun:test"
import {
  ContextCompilePolicyUnavailableError,
  attachRepoContextAnchorArtifactRefV1,
  compileRepoContextAnchorV1,
  contextCompilePolicyDigestV1,
  decideContextCompileOverlapV1,
  repoContextAnchorEpochDigestV1,
  resolveContextCompilePolicyV1,
  resolveContextSpeedPlanV1,
  shouldReuseRepoContextAnchorV1,
  type RepoContextAnchorEpochV1,
} from "@opencode-ai/core/session/context-compile-policy"

const route = {
  providerID: "anthropic",
  modelID: "claude-sonnet-4-5",
  routeRevision: "rev_route_1",
  endpointRevision: "rev_endpoint_1",
}

const catalogue = (overrides: { source?: "cache" | "bundled" | "override" | "unavailable"; freshness?: "fresh" | "stale" | "unknown"; cacheRead?: number } = {}) => ({
  source: overrides.source ?? ("cache" as const),
  freshness: overrides.freshness ?? ("fresh" as const),
  model: {
    limit: { context: 200_000, output: 8_192 },
    ...(overrides.cacheRead === undefined ? {} : { cost: { cache_read: overrides.cacheRead } }),
  },
})

describe("resolveContextCompilePolicyV1", () => {
  test("auto uses an authoritative cache-capable route adapter", () => {
    const policy = resolveContextCompilePolicyV1({
      route,
      prefixCacheSupport: "explicit_breakpoints",
      catalogSnapshot: catalogue({ cacheRead: 0.3 }),
    })
    expect(policy).toMatchObject({
      requested: "auto",
      effective: "cache_anchor",
      resolvedFrom: "route_adapter",
      prefixCacheSupport: "explicit_breakpoints",
      anchorProjection: "full",
    })
    expect(policy.catalogHints).toMatchObject({ priceCacheReadKnown: true, contextLimitTokens: 200_000 })
  })

  test("auto never claims cache_anchor when the route reports no prefix cache (CX-017)", () => {
    const policy = resolveContextCompilePolicyV1({
      route: { ...route, providerID: "groq", modelID: "llama-fast" },
      prefixCacheSupport: "none",
      catalogSnapshot: catalogue({ cacheRead: 0.1 }),
    })
    expect(policy.effective).toBe("minimize_tokens")
    expect(policy.resolvedFrom).toBe("conservative_default")
    expect(policy.anchorProjection).toBe("compressed")
  })

  test("auto may use a fresh catalog hint when route support is unknown", () => {
    const policy = resolveContextCompilePolicyV1({
      route,
      prefixCacheSupport: "unknown",
      catalogSnapshot: catalogue({ cacheRead: 0.3 }),
    })
    expect(policy.effective).toBe("cache_anchor")
    expect(policy.resolvedFrom).toBe("catalog_hint")
  })

  test("a stale or unavailable catalog cannot drive cache_anchor", () => {
    const stale = resolveContextCompilePolicyV1({
      route,
      prefixCacheSupport: "unknown",
      catalogSnapshot: catalogue({ freshness: "stale", cacheRead: 0.3 }),
    })
    expect(stale.effective).toBe("minimize_tokens")
    const unavailable = resolveContextCompilePolicyV1({
      route,
      prefixCacheSupport: "unknown",
      catalogSnapshot: { source: "unavailable", freshness: "unknown" },
    })
    expect(unavailable.effective).toBe("minimize_tokens")
    expect(unavailable.catalogHints).toMatchObject({ catalogSource: "unavailable", priceCacheReadKnown: false })
  })

  test("explicit cache_anchor fails closed on a no-cache route unless the product downgrade is enabled", () => {
    expect(() =>
      resolveContextCompilePolicyV1({
        requested: { value: "cache_anchor", source: "profile" },
        route,
        prefixCacheSupport: "none",
        catalogSnapshot: catalogue(),
      }),
    ).toThrow(ContextCompilePolicyUnavailableError)

    const downgraded = resolveContextCompilePolicyV1({
      requested: { value: "cache_anchor", source: "profile" },
      route,
      prefixCacheSupport: "none",
      catalogSnapshot: catalogue(),
      allowCacheAnchorDowngrade: true,
    })
    expect(downgraded.effective).toBe("minimize_tokens")
    expect(downgraded.resolvedFrom).toBe("settings")
  })

  test("explicit minimize_tokens stays compressed and never attaches an anchor ref", () => {
    const policy = resolveContextCompilePolicyV1({
      requested: { value: "minimize_tokens", source: "settings" },
      route,
      prefixCacheSupport: "ephemeral",
      catalogSnapshot: catalogue({ cacheRead: 0.3 }),
      anchorArtifactRef: "artifact:should-not-attach",
    })
    expect(policy.effective).toBe("minimize_tokens")
    expect(policy.resolvedFrom).toBe("settings")
    expect(policy.anchorProjection).toBe("compressed")
    expect(policy.anchorArtifactRef).toBeUndefined()
  })

  test("cache_anchor attaches the pinned anchor artifact ref", () => {
    const policy = resolveContextCompilePolicyV1({
      requested: { value: "cache_anchor", source: "profile" },
      route,
      prefixCacheSupport: "ephemeral",
      catalogSnapshot: catalogue(),
      anchorArtifactRef: "artifact:repo-anchor-1",
    })
    expect(policy.anchorArtifactRef).toBe("artifact:repo-anchor-1")
  })

  test("rejects an unavailable catalog carrying a model row and invalid route pins", () => {
    expect(() =>
      resolveContextCompilePolicyV1({
        route,
        prefixCacheSupport: "none",
        catalogSnapshot: { source: "unavailable", freshness: "unknown", model: { limit: { context: 1, output: 1 } } },
      }),
    ).toThrow("cannot carry a model row")
    expect(() =>
      resolveContextCompilePolicyV1({
        route: { ...route, routeRevision: "\u0000" },
        prefixCacheSupport: "none",
        catalogSnapshot: catalogue(),
      }),
    ).toThrow("control or bidi")
  })

  test("policy digest is stable and binds the effective tier", () => {
    const base = resolveContextCompilePolicyV1({ route, prefixCacheSupport: "ephemeral", catalogSnapshot: catalogue() })
    const same = resolveContextCompilePolicyV1({ route, prefixCacheSupport: "ephemeral", catalogSnapshot: catalogue() })
    const different = resolveContextCompilePolicyV1({ route, prefixCacheSupport: "none", catalogSnapshot: catalogue() })
    expect(contextCompilePolicyDigestV1(base)).toBe(contextCompilePolicyDigestV1(same))
    expect(contextCompilePolicyDigestV1(base)).not.toBe(contextCompilePolicyDigestV1(different))
    expect(contextCompilePolicyDigestV1(base)).toMatch(/^blake3:[0-9a-f]{64}$/)
  })

  test("policy digest rejects values that the strict policy schema would not accept", () => {
    const valid = resolveContextCompilePolicyV1({ route, prefixCacheSupport: "ephemeral", catalogSnapshot: catalogue() })
    expect(() =>
      contextCompilePolicyDigestV1({ ...valid, effective: "cache_anchor", prefixCacheSupport: "none" }),
    ).toThrow()
  })
})

const anchorEpoch: RepoContextAnchorEpochV1 = {
  sessionID: "ses_anchor",
  workspaceBindingDigest: `blake3:${"1".repeat(64)}`,
  sourceRevision: "42",
  harnessID: "native-rich",
  harnessRevision: 1,
  profileID: "horizon.default",
  profileRevision: "3",
  permissionScopeDigest: `blake3:${"2".repeat(64)}`,
}

describe("RepoContextAnchorV1", () => {
  const anchorInput = {
    sessionID: "ses_anchor",
    workspaceBindingDigest: `blake3:${"1".repeat(64)}`,
    sourceRevision: "42",
    repoGenerationDigest: `blake3:${"3".repeat(64)}`,
    files: [
      { pathRef: "src/zeta.ts", symbols: ["zeta", "same"] },
      { pathRef: "src/alpha.ts", symbols: ["alpha", "same"] },
      { pathRef: "README.md", symbols: [] },
    ],
  }

  test("is deterministic, path-sorted and query-independent", () => {
    const first = compileRepoContextAnchorV1(anchorInput)
    const second = compileRepoContextAnchorV1({ ...anchorInput, files: [...anchorInput.files].reverse() })
    expect(first.anchor).toEqual(second.anchor)
    expect(first.fullText).toEqual(second.fullText)
    const text = new TextDecoder().decode(first.fullText)
    expect(text.indexOf("README.md")).toBeLessThan(text.indexOf("src/alpha.ts"))
    expect(text.indexOf("src/alpha.ts")).toBeLessThan(text.indexOf("src/zeta.ts"))
    expect(first.anchor.contentDigest).toBe(first.anchor.projectionFullDigest)
    expect(first.anchor).toMatchObject({ completeness: "complete", fileCount: 3, byteLength: first.fullText.byteLength })
    expect(first.anchor.projectionCompressedDigest).not.toBe(first.anchor.projectionFullDigest)
  })

  test("omits invalid, traversal, control/bidi and credential-shaped paths without leaking them", () => {
    const compiled = compileRepoContextAnchorV1({
      ...anchorInput,
      files: [
        { pathRef: "/etc/passwd", symbols: [] },
        { pathRef: "../outside.ts", symbols: [] },
        { pathRef: "src/\u0000null.ts", symbols: [] },
        { pathRef: "secrets/api-key.txt", symbols: [] },
        { pathRef: "src/safe.ts", symbols: ["ok", "ok"] },
      ],
    })
    const text = new TextDecoder().decode(compiled.fullText)
    expect(text).not.toContain("/etc/passwd")
    expect(text).not.toContain("../outside.ts")
    expect(text).not.toContain("\u0000")
    expect(text).not.toContain("api-key.txt")
    expect(text).toContain("[redacted]")
    expect(text).toContain("src/safe.ts\tok")
    expect(compiled.anchor.completeness).toBe("partial")
    expect(compiled.anchor.partialReason).toBe("invalid_or_sensitive_entries_omitted")
  })

  test("marks the anchor partial when the per-file symbol cap omits valid symbols", () => {
    const symbols = Array.from({ length: 97 }, (_, index) => `symbol_${String(index).padStart(2, "0")}`)
    const compiled = compileRepoContextAnchorV1({
      ...anchorInput,
      files: [{ pathRef: "src/safe.ts", symbols }],
    })
    const text = new TextDecoder().decode(compiled.fullText)
    const line = text.split("\n").find((item) => item.startsWith("src/safe.ts\t"))

    expect(line).toBeDefined()
    expect(line!.slice("src/safe.ts\t".length).split(" ")).toHaveLength(96)
    expect(line).not.toContain("symbol_96")
    expect(compiled.anchor).toMatchObject({ completeness: "partial", partialReason: "symbol_limit" })
  })
  test("bounds file and byte budgets with explicit partial coverage", () => {
    const fileLimited = compileRepoContextAnchorV1({ ...anchorInput, maxFiles: 1 })
    expect(fileLimited.anchor.fileCount).toBe(1)
    expect(fileLimited.anchor).toMatchObject({ completeness: "partial", partialReason: "file_limit" })
    const byteLimited = compileRepoContextAnchorV1({ ...anchorInput, maxBytes: 42 })
    expect(byteLimited.anchor.byteLength).toBeLessThanOrEqual(42)
    expect(byteLimited.compressedText.byteLength).toBeLessThanOrEqual(42)
    expect(byteLimited.anchor).toMatchObject({ completeness: "partial", partialReason: "byte_limit" })
  })

  test("rejects an anchor byte budget that cannot fit its fixed headers", () => {
    expect(() => compileRepoContextAnchorV1({ ...anchorInput, maxBytes: 1 }))
      .toThrow("anchor maxBytes cannot fit its headers")
    expect(() => compileRepoContextAnchorV1({ ...anchorInput, maxBytes: 41 }))
      .toThrow("anchor maxBytes cannot fit its headers")
  })

  test("rejects an oversized anchor source list before indexing it", () => {
    const files = Array.from({ length: 4_097 }, (_, index) => ({ pathRef: `src/${index}.ts`, symbols: [] }))
    expect(() => compileRepoContextAnchorV1({ ...anchorInput, files })).toThrow("anchor source file count exceeds its bound")
  })

  test("rejects uncorrelated generation/workspace digests and synthesizes no artifact ref", () => {
    expect(() => compileRepoContextAnchorV1({ ...anchorInput, repoGenerationDigest: "blake3:short" })).toThrow("repoGenerationDigest")
    expect(() => compileRepoContextAnchorV1({ ...anchorInput, sessionID: "not-a-session" })).toThrow("Session ID")
    const compiled = compileRepoContextAnchorV1(anchorInput)
    expect("artifactRef" in compiled.anchor).toBe(false)
    expect(attachRepoContextAnchorArtifactRefV1(compiled.anchor, "artifact:anchor-1").artifactRef).toBe("artifact:anchor-1")
  })

  test("three consecutive turns keep the RepoContextAnchor digest and projection byte-identical (CX-014)", () => {
    // Turn 1..3: the conversation tail changes per request, but the anchor is
    // compiled from the repository pins alone, so the digest must not move.
    const turns = [compileRepoContextAnchorV1(anchorInput), compileRepoContextAnchorV1(anchorInput), compileRepoContextAnchorV1(anchorInput)]
    const [first, second, third] = turns
    expect(second!.anchor.contentDigest).toBe(first!.anchor.contentDigest)
    expect(third!.anchor.contentDigest).toBe(first!.anchor.contentDigest)
    expect(second!.anchor.projectionFullDigest).toBe(first!.anchor.projectionFullDigest)
    expect(third!.anchor.projectionCompressedDigest).toBe(first!.anchor.projectionCompressedDigest)
    expect(new TextDecoder().decode(third!.fullText)).toBe(new TextDecoder().decode(first!.fullText))
    // Re-sorting the compiled file set (as a fresh query would) does not move
    // the digest: the projection is path-sorted, not request-ordered.
    const reprojected = compileRepoContextAnchorV1({ ...anchorInput, files: [...anchorInput.files].reverse() })
    expect(reprojected.anchor.contentDigest).toBe(first!.anchor.contentDigest)
    // The epoch predicate keeps the same prefix reusable on turn 3.
    expect(shouldReuseRepoContextAnchorV1({ stored: anchorEpoch, current: anchorEpoch })).toBe(true)
  })

  test("anchor epoch reuse requires every workspace/profile/permission pin to match (CX-018)", () => {
    expect(repoContextAnchorEpochDigestV1(anchorEpoch)).toBe(repoContextAnchorEpochDigestV1({ ...anchorEpoch }))
    expect(
      shouldReuseRepoContextAnchorV1({ stored: anchorEpoch, current: { ...anchorEpoch, sourceRevision: "43" } }),
    ).toBe(false)
    expect(
      shouldReuseRepoContextAnchorV1({ stored: anchorEpoch, current: { ...anchorEpoch, profileRevision: "4" } }),
    ).toBe(false)
    expect(
      shouldReuseRepoContextAnchorV1({
        stored: anchorEpoch,
        current: { ...anchorEpoch, permissionScopeDigest: `blake3:${"9".repeat(64)}` },
      }),
    ).toBe(false)
    expect(shouldReuseRepoContextAnchorV1({ stored: anchorEpoch, current: { ...anchorEpoch } })).toBe(true)
  })
})

describe("§30.28 speed planning", () => {
  test("compile overlap is allowed only for an unchanged ledger and policy", () => {
    const previous = { ledgerDigest: `blake3:${"1".repeat(64)}`, compilePolicyDigest: `blake3:${"2".repeat(64)}` }
    expect(decideContextCompileOverlapV1({ previous, current: previous })).toMatchObject({ overlap: true, reason: "digest_unchanged" })
    expect(
      decideContextCompileOverlapV1({ previous, current: { ...previous, ledgerDigest: `blake3:${"3".repeat(64)}` } }),
    ).toMatchObject({ overlap: false, reason: "digest_changed" })
    expect(
      decideContextCompileOverlapV1({ previous, current: { ...previous, compilePolicyDigest: `blake3:${"4".repeat(64)}` } }),
    ).toMatchObject({ overlap: false, reason: "compile_policy_changed" })
    expect(
      decideContextCompileOverlapV1({
        previous,
        current: { ledgerDigest: previous.ledgerDigest },
      }),
    ).toMatchObject({ overlap: false, reason: "compile_policy_changed" })
    expect(
      decideContextCompileOverlapV1({
        previous: { ledgerDigest: previous.ledgerDigest },
        current: previous,
      }),
    ).toMatchObject({ overlap: false, reason: "compile_policy_changed" })
    expect(
      decideContextCompileOverlapV1({ current: previous }),
    ).toMatchObject({ overlap: false, reason: "no_previous_ledger" })
  })

  test("compile overlap rejects malformed ledger and policy digests", () => {
    const valid = { ledgerDigest: `blake3:${"1".repeat(64)}`, compilePolicyDigest: `blake3:${"2".repeat(64)}` }
    const malformedLedger = { ledgerDigest: "not-a-digest", compilePolicyDigest: valid.compilePolicyDigest }
    const malformedPolicy = { ledgerDigest: valid.ledgerDigest, compilePolicyDigest: "also-not-a-digest" }

    expect(() => decideContextCompileOverlapV1({ previous: malformedLedger, current: malformedLedger }))
      .toThrow("ledgerDigest")
    expect(() => decideContextCompileOverlapV1({ previous: malformedPolicy, current: malformedPolicy }))
      .toThrow("compilePolicyDigest")
  })

  test("speed planning rejects non-boolean native tool capability input", () => {
    expect(() =>
      resolveContextSpeedPlanV1({
        indexStatus: "current",
        contextLimitTokens: 200_000,
        nativeTools: "false" as unknown as boolean,
      }),
    ).toThrow("nativeTools must be a boolean")
  })

  test("cold RepoIntel never blocks Send and keeps symbol-first bias (SP-B/C)", () => {
    for (const indexStatus of ["absent", "building", "stale", "partial", "failed"] as const) {
      const plan = resolveContextSpeedPlanV1({ indexStatus, contextLimitTokens: 8_000, nativeTools: true })
      expect(plan.sendBlocked).toBe(false)
      expect(plan.indexWarming).toBe(true)
      expect(plan.indexMode).toBe("lexical_fallback")
      expect(plan.toolBias[0]).toBe("repo.tree")
      expect(plan.harnessPreference).toBe("native-minimal")
    }
    const warm = resolveContextSpeedPlanV1({ indexStatus: "current", contextLimitTokens: 200_000, nativeTools: true })
    expect(warm).toMatchObject({ indexWarming: false, indexMode: "index", harnessPreference: "native-rich" })
  })
})
