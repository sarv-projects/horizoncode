import { describe, expect, test } from "bun:test"
import { compileContextLedgerV2 } from "@opencode-ai/core/session/context-ledger"
import {
  contextCompilePolicyDigestV1,
  resolveContextCompilePolicyV1,
} from "@opencode-ai/core/session/context-compile-policy"
import type { ContextSelectionV1 } from "@opencode-ai/schema/context-selection-v1"

const selection: ContextSelectionV1 = {
  schemaVersion: 1,
  lane: "direct",
  sessionID: "ses_context-ledger" as ContextSelectionV1["sessionID"],
  requestID: "req_direct_1",
  mode: "fresh",
  sourceRevision: "0",
  sources: [{
    kind: "agent-profile",
    sourceID: "horizon.default",
    sourceRevision: "1",
    contentDigest: "blake3:" + "4".repeat(64),
    sourceAuthority: "core-config",
    trust: "system",
    included: true,
    inclusionReason: "profile",
  }, {
    kind: "provider-input",
    sourceID: "req_direct_1",
    sourceRevision: "0",
    contentDigest: "blake3:" + "3".repeat(64),
    sourceAuthority: "core-prompt-compiler",
    trust: "mixed",
    included: true,
    inclusionReason: "current_request",
  }],
}

const base = {
  lane: "direct" as const,
  sessionID: selection.sessionID,
  requestID: selection.requestID,
  sourceRevision: selection.sourceRevision,
  providerID: "provider-test",
  modelID: "model-test",
  harnessID: "harness-test",
  harnessRevision: 1,
  requestPayloadDigest: "blake3:" + "3".repeat(64),
  requestBytes: 128,
  contextSelection: selection,
  entries: [{
    entryID: "agent-profile:horizon.default",
    kind: "environment" as const,
    sourceRef: "agent-profile:horizon.default",
    sourceRevision: "1",
    trust: "system" as const,
    bytes: 0,
    bytesKind: "exact" as const,
    tokens: { kind: "unknown" as const },
    included: true,
    inclusionReason: "active profile pin",
    protected: true,
    digest: "blake3:" + "4".repeat(64),
  }, {
    entryID: "provider-input:req_direct_1",
    kind: "environment" as const,
    sourceRef: "provider-input:req_direct_1",
    sourceRevision: "0",
    trust: "mixed" as const,
    bytes: 128,
    bytesKind: "exact" as const,
    tokens: { kind: "unknown" as const },
    included: true,
    inclusionReason: "exact provider input",
    protected: true,
    digest: "blake3:" + "3".repeat(64),
  }],
}

describe("ContextLedgerV2 compiler", () => {
  test("binds a direct provider payload to the exact Core selection", () => {
    const result = compileContextLedgerV2(base)
    expect(result.ledger.lane).toBe("direct")
    expect(result.ledger.contextSelection).toEqual(selection)
    expect(result.ledger.requestPayloadDigest).toBe(base.requestPayloadDigest)
    expect(result.ledgerDigest).toMatch(/^blake3:[0-9a-f]{64}$/)
  })

  test("fails closed when a direct selection or a selected source entry is missing", () => {
    expect(() => compileContextLedgerV2({ ...base, contextSelection: undefined })).toThrow("exact ContextSelection")
    expect(() => compileContextLedgerV2({ ...base, entries: [] })).toThrow("omits an included")
  })

  test("binds the §30.26 compile policy and its catalog provenance (CX-019)", () => {
    const compilePolicy = resolveContextCompilePolicyV1({
      route: {
        providerID: "provider-test",
        modelID: "model-test",
        routeRevision: "rev_1",
        endpointRevision: "endpoint_1",
      },
      prefixCacheSupport: "ephemeral",
      catalogSnapshot: {
        source: "cache",
        freshness: "fresh",
        model: { limit: { context: 200_000, output: 8_192 }, cost: { cache_read: 0.3 } },
      },
    })
    const result = compileContextLedgerV2({ ...base, compilePolicy })
    expect(result.ledger.compilePolicy).toEqual(compilePolicy)
    expect(result.ledger.compilePolicy?.catalogHints).toMatchObject({
      catalogSource: "cache",
      catalogFreshness: "fresh",
      priceCacheReadKnown: true,
    })
    const withoutPolicy = compileContextLedgerV2(base)
    expect(withoutPolicy.ledgerDigest).not.toBe(result.ledgerDigest)
    expect(withoutPolicy.ledger.compilePolicy).toBeUndefined()
  })

  test("rejects a policy that names another route tier or provider", () => {
    const policy = resolveContextCompilePolicyV1({
      route: {
        providerID: "provider-test",
        modelID: "model-test",
        routeRevision: "rev_1",
        endpointRevision: "endpoint_1",
      },
      prefixCacheSupport: "ephemeral",
      catalogSnapshot: { source: "cache", freshness: "fresh" },
    })
    expect(() =>
      compileContextLedgerV2({ ...base, compilePolicy: { ...policy, catalogHints: { ...policy.catalogHints!, providerID: "other" } } }),
    ).toThrow("different provider")
    expect(() =>
      compileContextLedgerV2({
        ...base,
        compilePolicy: { ...policy, effective: "cache_anchor", prefixCacheSupport: "none" },
      }),
    ).toThrow("without prefix-cache support")
    expect(() =>
      compileContextLedgerV2({
        ...base,
        compilePolicy: { ...policy, effective: "minimize_tokens", anchorProjection: "full" },
      }),
    ).toThrow("projection does not match")
  })

  test("CTX-001: rejects a request payload digest that disagrees with the pinned provider-input source", () => {
    expect(() =>
      compileContextLedgerV2({
        ...base,
        requestPayloadDigest: "blake3:" + "5".repeat(64),
      }),
    ).toThrow("provider input digest")
  })

  test("CTX-001: the ledger digest binds the exact normalized payload and every request pin", () => {
    const first = compileContextLedgerV2(base)

    // One byte of the normalized provider payload (its digest and byte count)
    // changes → the request binding changes with it.
    const alteredDigest = "blake3:" + "3".repeat(63) + "4"
    const alteredPayload = compileContextLedgerV2({
      ...base,
      requestPayloadDigest: alteredDigest,
      requestBytes: 129,
      contextSelection: {
        ...selection,
        sources: selection.sources.map((source) =>
          source.kind === "provider-input" ? { ...source, contentDigest: alteredDigest } : source,
        ),
      },
      entries: base.entries.map((entry) =>
        entry.sourceRef.startsWith("provider-input:")
          ? { ...entry, digest: alteredDigest, bytes: 129 }
          : entry,
      ),
    })
    expect(alteredPayload.ledgerDigest).not.toBe(first.ledgerDigest)
    expect(alteredPayload.ledger.requestPayloadDigest).not.toBe(first.ledger.requestPayloadDigest)

    // Any selection/request/revision mismatch fails closed before transport.
    expect(() => compileContextLedgerV2({ ...base, requestID: "req_other" })).toThrow("identity differs")
    expect(() => compileContextLedgerV2({ ...base, sourceRevision: "1" })).toThrow("identity differs")
    expect(() => compileContextLedgerV2({ ...base, sessionID: "ses_other" })).toThrow("identity differs")
    expect(() => compileContextLedgerV2({ ...base, lane: "managed" })).toThrow("lane differs")
    expect(() =>
      compileContextLedgerV2({ ...base, lane: "managed", contextSelection: { ...selection, lane: "managed" } }),
    ).toThrow("HostKernel ContextSelection digest")

    expect(first.ledgerDigest).toMatch(/^blake3:[0-9a-f]{64}$/)
  })

  test("CTX-003: an included entry must map to a pinned ContextSelection source", () => {
    expect(() =>
      compileContextLedgerV2({
        ...base,
        entries: [
          ...base.entries,
          { ...base.entries[1]!, entryID: "instruction:rogue", sourceRef: "instruction:rogue" },
        ],
      }),
    ).toThrow("does not match a pinned")
    // ...while an excluded entry is allowed without a matching selection pin.
    const excluded = compileContextLedgerV2({
      ...base,
      entries: [
        ...base.entries,
        { ...base.entries[1]!, entryID: "instruction:vendor", sourceRef: "instruction:vendor", included: false },
      ],
    })
    expect(excluded.ledger.entries.filter((entry) => entry.included)).toHaveLength(2)
    expect(excluded.ledger.entries.find((entry) => entry.entryID === "instruction:vendor")?.included).toBe(false)
  })

  test("CX-014: three consecutive turns keep the static ledger segments identical while the tail is request-bound", () => {
    const turn = (requestID: string, payloadDigest: string) =>
      compileContextLedgerV2({
        ...base,
        requestID,
        requestPayloadDigest: payloadDigest,
        contextSelection: {
          ...selection,
          requestID: requestID as ContextSelectionV1["requestID"],
          sources: selection.sources.map((source) =>
            source.kind === "provider-input"
              ? { ...source, sourceID: requestID, contentDigest: payloadDigest }
              : source,
          ),
        },
        entries: base.entries.map((entry) =>
          entry.sourceRef.startsWith("provider-input:")
            ? { ...entry, entryID: `provider-input:${requestID}`, sourceRef: `provider-input:${requestID}`, digest: payloadDigest }
            : entry,
        ),
      })

    const runs = [
      turn("req_direct_1", "blake3:" + "3".repeat(64)),
      turn("req_direct_2", "blake3:" + "5".repeat(64)),
      turn("req_direct_3", "blake3:" + "7".repeat(64)),
    ]

    const staticSegments = (run: (typeof runs)[number]) =>
      JSON.stringify({
        profileEntry: run.ledger.entries.find((entry) => entry.sourceRef.startsWith("agent-profile:")),
        profileSource: run.ledger.contextSelection.sources.find((source) => source.kind === "agent-profile"),
        route: { providerID: run.ledger.providerID, modelID: run.ledger.modelID, harnessID: run.ledger.harnessID },
        lane: run.ledger.lane,
      })

    // Static segments (profile entry, profile pin, pinned route) are unchanged
    // across the three turns: no provider/model switch, no anchor mutation.
    expect(staticSegments(runs[1]!)).toBe(staticSegments(runs[0]!))
    expect(staticSegments(runs[2]!)).toBe(staticSegments(runs[0]!))

    // The tail (exact request payload) is per-turn and the digest stays bound
    // to it, so the full ledger digest differs without moving the static part.
    expect(runs[1]!.ledgerDigest).not.toBe(runs[0]!.ledgerDigest)
    expect(runs[2]!.ledgerDigest).not.toBe(runs[0]!.ledgerDigest)
    expect(runs.map((run) => run.ledger.requestPayloadDigest)).toEqual([
      "blake3:" + "3".repeat(64),
      "blake3:" + "5".repeat(64),
      "blake3:" + "7".repeat(64),
    ])
  })

  test("policy digests are stable and change with the effective tier", () => {
    const input = {
      route: {
        providerID: "provider-test",
        modelID: "model-test",
        routeRevision: "rev_1",
        endpointRevision: "endpoint_1",
      },
      prefixCacheSupport: "ephemeral" as const,
      catalogSnapshot: { source: "cache" as const, freshness: "fresh" as const },
    }
    const first = resolveContextCompilePolicyV1(input)
    expect(contextCompilePolicyDigestV1(first)).toBe(contextCompilePolicyDigestV1(resolveContextCompilePolicyV1(input)))
    expect(contextCompilePolicyDigestV1(first)).not.toBe(
      contextCompilePolicyDigestV1(resolveContextCompilePolicyV1({ ...input, prefixCacheSupport: "none" })),
    )
  })
})
