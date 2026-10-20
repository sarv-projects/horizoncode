import { describe, expect, test } from "bun:test"
import {
  EditValidationError,
  MAX_EDIT_DOCUMENTS,
  MAX_EDITS_PER_DOCUMENT,
  validateGuardedEditBatch,
  validatePreparedEdits,
} from "@/lsp/edits"
import { makeLedger, refOf, type SnapshotInput } from "@/lsp/broker"

const expected = {
  serviceGeneration: 3,
  workspaceRevision: "blake3:" + "1".repeat(64),
  workspaceRoot: "/workspace",
  effectIntentDigest: "blake3:" + "c".repeat(64),
  capabilityLeaseDigest: "blake3:" + "a".repeat(64),
}

const batch = (over: Record<string, unknown> = {}) => ({
  serviceGeneration: 3,
  workspaceRevision: expected.workspaceRevision,
  effectIntentDigest: expected.effectIntentDigest,
  capabilityLeaseDigest: expected.capabilityLeaseDigest,
  documents: [
    {
      uri: "file:///workspace/src/main.ts",
      version: 4,
      edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: "new" }],
    },
  ],
  ...over,
})

const workspaceEdit = (over: Record<string, unknown> = {}) => ({
  documentChanges: [
    {
      textDocument: { uri: "file:///workspace/src/main.ts", version: 4 },
      edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: "new" }],
    },
  ],
  ...over,
})

const snapshot = (over: Partial<SnapshotInput> = {}): SnapshotInput => ({
  source: {
    kind: "supervised",
    processRef: {
      executionID: "exec-1",
      generation: "1",
      ownerEpoch: "7",
      kind: "language_server",
      profileID: "lsp-typescript",
      profileRevision: "1",
      profileDigest: "blake3:" + "b".repeat(64),
      executableDigest: "blake3:" + "e".repeat(64),
    },
    launchProfileRef: { profileId: "lsp-typescript", revision: "1", profileDigest: "blake3:" + "b".repeat(64) },
    serverName: "typescript",
  },
  sessionID: "session-1",
  locationID: "location-1",
  ownerEpoch: "7",
  workspaceId: "ws-1",
  workspaceRevision: expected.workspaceRevision,
  languageId: "typescript",
  rootUri: "file:///workspace",
  configurationDigest: "blake3:" + "e".repeat(64),
  principalId: "principal-1",
  readScopeDigest: "blake3:" + "f".repeat(64),
  policyGeneration: "policy-1",
  sandboxProfileDigest: "blake3:" + "9".repeat(64),
  capabilitiesDigest: "blake3:" + "8".repeat(64),
  health: "healthy",
  ...over,
})

function reason(input: unknown) {
  try {
    validateGuardedEditBatch(input, expected)
  } catch (error) {
    if (error instanceof EditValidationError) return error.reason
    throw error
  }
  throw new Error("expected edit batch rejection")
}

describe("lsp guarded edit batch contract", () => {
  test("accepts bounded, versioned edits in the current workspace and generation", () => {
    expect(validateGuardedEditBatch(batch(), expected).documents[0]?.version).toBe(4)
  })

  test("rejects stale generation, workspace revision and lease", () => {
    expect(reason(batch({ serviceGeneration: 2 }))).toBe("stale_service")
    expect(reason(batch({ workspaceRevision: "blake3:" + "2".repeat(64) }))).toBe("stale_workspace")
    expect(reason(batch({ effectIntentDigest: "blake3:" + "d".repeat(64) }))).toBe("lease_mismatch")
    expect(reason(batch({ capabilityLeaseDigest: "blake3:" + "b".repeat(64) }))).toBe("lease_mismatch")
  })

  test("rejects unversioned, out-of-workspace and duplicate document edits", () => {
    expect(
      reason(
        batch({
          documents: [{ uri: "file:///workspace/src/main.ts", version: null, edits: [] }],
        }),
      ),
    ).toBe("unversioned")
    expect(
      reason(
        batch({
          documents: [{ uri: "file:///workspace-other/main.ts", version: 1, edits: [] }],
        }),
      ),
    ).toBe("outside_workspace")
    expect(
      reason(
        batch({
          documents: [
            { uri: "file:///workspace/src/main.ts", version: 1, edits: [] },
            { uri: "file:///workspace/src/main.ts", version: 1, edits: [] },
          ],
        }),
      ),
    ).toBe("duplicate_document")
  })

  test("rejects overlapping ranges and overlarge output", () => {
    expect(
      reason(
        batch({
          documents: [
            {
              uri: "file:///workspace/src/main.ts",
              version: 1,
              edits: [
                { range: { start: { line: 1, character: 0 }, end: { line: 2, character: 0 } }, newText: "a" },
                { range: { start: { line: 1, character: 1 }, end: { line: 2, character: 1 } }, newText: "b" },
              ],
            },
          ],
        }),
      ),
    ).toBe("overlapping_edits")
    expect(
      reason(
        batch({
          documents: [
            {
              uri: "file:///workspace/src/main.ts",
              version: 1,
              edits: [
                { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: "x".repeat(3 * 1024 * 1024) },
              ],
            },
          ],
        }),
      ),
    ).toBe("too_many_bytes")
  })

  test("rejects extension fields such as executable LSP command payloads instead of stripping them", () => {
    expect(
      reason(
        batch({
          command: { command: "workspace.applyEdit", arguments: ["../../outside"] },
        }),
      ),
    ).toBe("malformed")
  })

  test("rejects document and edit count overflows before walking or decoding the payload", () => {
    expect(
      reason(
        batch({
          documents: Array.from({ length: MAX_EDIT_DOCUMENTS + 1 }, () => ({ uri: "bad", version: 1, edits: [] })),
        }),
      ),
    ).toBe("too_many_documents")
    expect(
      reason(
        batch({
          documents: [
            {
              uri: "file:///workspace/src/main.ts",
              version: 1,
              edits: Array.from({ length: MAX_EDITS_PER_DOCUMENT + 1 }, () => ({
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
                newText: "x",
              })),
            },
          ],
        }),
      ),
    ).toBe("too_many_edits")
  })

  test("derives the service generation and workspace revision from the authenticated ledger", () => {
    const ledger = makeLedger()
    const current = ledger.register(snapshot())
    const ref = refOf(current)
    const binding = {
      sessionID: "session-1",
      locationID: "location-1",
      ownerEpoch: "7",
      workspaceId: "ws-1",
      workspaceRevision: expected.workspaceRevision,
      principalId: "principal-1",
      readScopeDigest: "blake3:" + "f".repeat(64),
      policyGeneration: "policy-1",
      sandboxProfileDigest: "blake3:" + "9".repeat(64),
    }
    const prepared = validatePreparedEdits(workspaceEdit(), {
        ledger,
        ref,
        binding,
        workspaceRoot: "/workspace",
        effectIntentDigest: expected.effectIntentDigest,
        capabilityLeaseDigest: expected.capabilityLeaseDigest,
      })
    expect(prepared.workspaceRevision).toBe(expected.workspaceRevision)
    expect(prepared.effectIntentDigest).toBe(expected.effectIntentDigest)
    expect(prepared.capabilityLeaseDigest).toBe(expected.capabilityLeaseDigest)
    expect(Object.isFrozen(prepared)).toBe(true)
    expect(Object.isFrozen(prepared.documents)).toBe(true)
    expect(Object.isFrozen(prepared.documents[0]?.edits[0]?.range.start)).toBe(true)
    expect(() =>
      validatePreparedEdits(workspaceEdit(), {
        ledger,
        ref,
        binding,
        workspaceRoot: "/workspace",
        effectIntentDigest: expected.effectIntentDigest,
        capabilityLeaseDigest: expected.capabilityLeaseDigest,
      }),
    ).toThrow()
  })

  test("does not accept prepared edits from an untrusted external language service", () => {
    const ledger = makeLedger()
    const current = ledger.register(
      snapshot({ source: { kind: "external", adapterId: "external-1", serverName: "typescript" } }),
    )
    let thrown: unknown
    try {
      validatePreparedEdits(workspaceEdit(), {
        ledger,
        ref: refOf(current),
        binding: {
          sessionID: "session-1",
          locationID: "location-1",
          ownerEpoch: "7",
          workspaceId: "ws-1",
          workspaceRevision: expected.workspaceRevision,
          principalId: "principal-1",
          readScopeDigest: "blake3:" + "f".repeat(64),
          policyGeneration: "policy-1",
          sandboxProfileDigest: "blake3:" + "9".repeat(64),
        },
        workspaceRoot: "/workspace",
        effectIntentDigest: expected.effectIntentDigest,
        capabilityLeaseDigest: expected.capabilityLeaseDigest,
      })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(EditValidationError)
    expect(thrown).toMatchObject({ reason: "unsupported_source" })
  })

  test("rejects unversioned changes and file resource operations from standard WorkspaceEdit", () => {
    const ledger = makeLedger()
    const current = ledger.register(snapshot())
    const authority = {
      ledger,
      ref: refOf(current),
      binding: {
        sessionID: "session-1",
        locationID: "location-1",
        ownerEpoch: "7",
        workspaceId: "ws-1",
        workspaceRevision: expected.workspaceRevision,
        principalId: "principal-1",
        readScopeDigest: "blake3:" + "f".repeat(64),
        policyGeneration: "policy-1",
        sandboxProfileDigest: "blake3:" + "9".repeat(64),
      },
      workspaceRoot: "/workspace",
      effectIntentDigest: expected.effectIntentDigest,
      capabilityLeaseDigest: expected.capabilityLeaseDigest,
    }
    const capture = (input: unknown) => {
      try {
        validatePreparedEdits(input, authority)
      } catch (error) {
        return error
      }
      throw new Error("expected prepared-edit refusal")
    }
    expect(capture({ changes: {} })).toMatchObject({ reason: "unversioned" })
    expect(
      capture({ documentChanges: [{ kind: "rename", oldUri: "file:///workspace/a", newUri: "file:///workspace/b" }] }),
    ).toMatchObject({ reason: "unsupported_workspace_operation" })
  })
})
