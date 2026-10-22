import { describe, expect, test } from "bun:test"
import { compileContextLedgerV2 } from "@opencode-ai/core/session"
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
    contentDigest: "blake3:" + "1".repeat(64),
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
})
