import { expect, test } from "bun:test"
import { decodeCheckpointPreview, safeCheckpointDisplayText } from "../../src/component/dialog-checkpoint"

const digest = `blake3:${"a".repeat(64)}`

function preview() {
  return {
    checkpointID: "checkpoint-1",
    checkpointArtifact: {
      artifactID: "artifact-1",
      digest,
      byteLength: "16",
      mediaType: "application/vnd.horizoncode.checkpoint+json",
      classification: "workspace",
    },
    workspaceRevision: digest,
    workspaceRevisionChanged: false,
    mode: "FULL",
    selectedPaths: [],
    actions: [],
    conflicts: [{ path: null, kind: "WORKSPACE_STATUS_UNAVAILABLE" }],
    previewDigest: digest,
  }
}

test("checkpoint preview projection preserves read-only conflicts and digest pins", () => {
  const result = decodeCheckpointPreview(preview())
  expect(result).toMatchObject({
    checkpointID: "checkpoint-1",
    workspaceRevision: digest,
    previewDigest: digest,
    conflicts: [{ kind: "WORKSPACE_STATUS_UNAVAILABLE" }],
    actions: [],
  })
})

test("checkpoint preview projection rejects malformed digests and unbounded arrays", () => {
  expect(() => decodeCheckpointPreview({ ...preview(), previewDigest: "bad" })).toThrow()
  expect(() => decodeCheckpointPreview({ ...preview(), actions: Array(2_049).fill({ path: "a" }) })).toThrow()
})

test("checkpoint display strips bidi, terminal controls, and credentials while retaining raw authority IDs", () => {
  const rawID = "checkpoint-1"
  const result = decodeCheckpointPreview({ ...preview(), checkpointID: rawID })
  expect(result.checkpointID).toBe(rawID)
  expect(safeCheckpointDisplayText(rawID, 256)).toBe("checkpoint-1")
  expect(safeCheckpointDisplayText("checkpoint-\u202EBearer secret-value", 256)).toBe("checkpoint-Bearer [REDACTED]")
  expect(safeCheckpointDisplayText("src/\u2066private\u2069\nfile.ts", 512)).toBe("src/private file.ts")
  expect(safeCheckpointDisplayText("x".repeat(300), 24).length).toBeLessThanOrEqual(24)
})
