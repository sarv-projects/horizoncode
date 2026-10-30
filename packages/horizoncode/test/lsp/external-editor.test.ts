import { describe, expect, spyOn, test } from "bun:test"
import {
  ExternalEditor,
} from "@/lsp/external-editor"
import {
  externalEditorProfileRefV1,
  type ExternalEditorProfileDefinitionV1,
} from "@horizoncode/schema/external-editor-profile-v1"

const REVISION = "blake3:" + "1".repeat(64)
const OTHER_REVISION = "blake3:" + "2".repeat(64)
const FILE_DIGEST = "blake3:" + "3".repeat(64)
const NEW_FILE_DIGEST = "blake3:" + "4".repeat(64)

const profile: ExternalEditorProfileDefinitionV1 = {
  schemaVersion: 1,
  profileId: "code",
  revision: "3",
  executableSelector: "horizoncode:editor:code",
  argv: ["--wait"],
  targetArgIndex: 1,
  launchMode: "wait",
  targetKinds: ["workspace_file"],
  environmentPolicy: "sanitized_host",
}
const selected = externalEditorProfileRefV1(profile)

const processRef = (patch: Record<string, unknown> = {}) => ({
  executionID: "editor_exec_1",
  generation: "7",
  ownerEpoch: "9",
  kind: "external_editor",
  profileID: selected.profileId,
  profileRevision: selected.revision,
  profileDigest: selected.profileDigest,
  executableDigest: "blake3:" + "5".repeat(64),
  ...patch,
})

const completed = (over: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  status: "completed",
  effectID: "effect_1",
  executionID: "editor_exec_1",
  bindingDigest: "blake3:" + "6".repeat(64),
  processRef: processRef(),
  receiptDigest: "blake3:" + "7".repeat(64),
  exitCode: 0,
  resultFileDigest: NEW_FILE_DIGEST,
  observedWorkspaceRevision: OTHER_REVISION,
  ...over,
})

describe("external editor open planning", () => {
  test("fails closed without calling the host or spawning a process while the HostKernel route is unavailable", async () => {
    let called = 0
    const spawn = spyOn(Bun, "spawn")
    try {
      const result = await ExternalEditor.openWorkspaceFileV1({
        host: {
          launch: async () => { called += 1; return completed() },
          waitForClose: async () => { called += 1; return completed() },
        },
        profile,
        selected,
        sessionId: "ses_1",
        locationId: "loc_1",
        pathRef: "src/main.ts",
        sourceRevision: REVISION,
        contentDigest: FILE_DIGEST,
      })
      expect(called).toBe(0)
      expect(result).toMatchObject({ status: "unavailable", reason: "route_unavailable" })
      expect(ExternalEditor.externalEditorRouteAvailable()).toBe(false)
      expect(spawn).not.toHaveBeenCalled()
    } finally {
      spawn.mockRestore()
    }
  })

  test("builds a workspace-file request bound to the immutable profile and exact digests", () => {
    const request = ExternalEditor.planWorkspaceOpenV1({
      profile,
      selected,
      sessionId: "ses_1",
      locationId: "loc_1",
      pathRef: "src/main.ts",
      sourceRevision: REVISION,
      contentDigest: FILE_DIGEST,
    })
    expect(request.targetKind).toBe("workspace_file")
    expect(request.targetRelativePath).toBe("src/main.ts")
    expect(request.expectedWorkspaceRevision).toBe(REVISION)
    expect(request.expectedFileDigest).toBe(FILE_DIGEST)
    expect(request.profileRef).toEqual(selected)
  })

  test("builds a host-generated prompt scratch request without a workspace path or preimage", () => {
    const promptProfile = { ...profile, targetKinds: ["prompt_scratch", "workspace_file"] as const }
    const request = ExternalEditor.planPromptScratchV1({
      profile: promptProfile,
      selected: externalEditorProfileRefV1(promptProfile),
      sessionId: "ses_1",
      locationId: "loc_1",
      workspaceRevision: REVISION,
    })
    expect(request.targetKind).toBe("prompt_scratch")
    expect(request.targetRelativePath).toBe("")
    expect(request.expectedWorkspaceRevision).toBe(REVISION)
    expect(request.expectedFileDigest).toBeNull()
  })

  test("rejects prompt scratch when profile selection mismatches or target is not enabled", () => {
    const promptProfile = { ...profile, targetKinds: ["prompt_scratch"] as const }
    const base = {
      profile: promptProfile,
      selected: externalEditorProfileRefV1(promptProfile),
      sessionId: "ses_1",
      locationId: "loc_1",
      workspaceRevision: REVISION,
    }
    expect(() => ExternalEditor.planPromptScratchV1({ ...base, selected: { ...base.selected, revision: "4" } })).toThrow(TypeError)
    expect(() => ExternalEditor.planPromptScratchV1({ ...base, profile: { ...profile, targetKinds: ["workspace_file"] } })).toThrow(TypeError)
    expect(() => ExternalEditor.planPromptScratchV1({ ...base, workspaceRevision: "sha256:wrong" })).toThrow(TypeError)
  })

  test("rejects a mismatched profile ref, missing target kind, traversal and non-digests", () => {
    const base = {
      profile,
      selected,
      sessionId: "ses_1",
      locationId: "loc_1",
      pathRef: "src/main.ts",
      sourceRevision: REVISION,
      contentDigest: FILE_DIGEST,
    }
    expect(() => ExternalEditor.planWorkspaceOpenV1({ ...base, selected: { ...selected, revision: "4" } })).toThrow(TypeError)
    expect(() => ExternalEditor.planWorkspaceOpenV1({
      ...base,
      profile: { ...profile, targetKinds: ["prompt_scratch"] },
    })).toThrow(TypeError)
    expect(() => ExternalEditor.planWorkspaceOpenV1({ ...base, pathRef: "../outside.ts" })).toThrow()
    expect(() => ExternalEditor.planWorkspaceOpenV1({ ...base, pathRef: "/etc/passwd" })).toThrow()
    expect(() => ExternalEditor.planWorkspaceOpenV1({ ...base, contentDigest: "sha256:abc" })).toThrow(TypeError)
  })

  test("rejects workspace paths that are not normalized relative paths", () => {
    const base = {
      profile,
      selected,
      sessionId: "ses_1",
      locationId: "loc_1",
      pathRef: "src/main.ts",
      sourceRevision: REVISION,
      contentDigest: FILE_DIGEST,
    }
    for (const pathRef of [
      "src\\main.ts",
      "src//main.ts",
      "src/./main.ts",
      "src/main.ts/",
      "src/main\u0007.ts",
      "src/main\n.ts",
      "",
      "a".repeat(4097),
    ]) {
      expect(() => ExternalEditor.planWorkspaceOpenV1({ ...base, pathRef }), JSON.stringify(pathRef)).toThrow()
    }
  })

  test("rejects Session and Location identifiers outside the wire identifier contract", () => {
    const base = {
      profile,
      selected,
      sessionId: "ses_1",
      locationId: "loc_1",
      pathRef: "src/main.ts",
      sourceRevision: REVISION,
      contentDigest: FILE_DIGEST,
    }
    for (const [field, value] of [
      ["sessionId", "ses one"],
      ["sessionId", ""],
      ["sessionId", "ses\u0000one"],
      ["locationId", "loc one"],
      ["locationId", "loc/one"],
    ] as const) {
      expect(() => ExternalEditor.planWorkspaceOpenV1({ ...base, [field]: value }), `${field}=${value}`).toThrow()
      expect(() => ExternalEditor.planPromptScratchV1({
        profile: { ...profile, targetKinds: ["prompt_scratch", "workspace_file"] as const },
        selected: externalEditorProfileRefV1({ ...profile, targetKinds: ["prompt_scratch", "workspace_file"] as const }),
        sessionId: "ses_1",
        locationId: "loc_1",
        workspaceRevision: REVISION,
        [field]: value,
      } as never), `scratch ${field}=${value}`).toThrow()
    }
  })

  test("never forwards authority-looking fields carried by the caller's profile selection", () => {
    const request = ExternalEditor.planWorkspaceOpenV1({
      profile,
      selected: { ...selected, principalId: "principal-1", allowEvaluate: true } as never,
      sessionId: "ses_1",
      locationId: "loc_1",
      pathRef: "src/main.ts",
      sourceRevision: REVISION,
      contentDigest: FILE_DIGEST,
    })
    expect(Object.keys(request).sort()).toEqual([
      "expectedFileDigest",
      "expectedWorkspaceRevision",
      "locationId",
      "profileRef",
      "schemaVersion",
      "sessionId",
      "targetKind",
      "targetRelativePath",
    ])
    expect(JSON.stringify(request)).not.toContain("principal-1")
    expect(request.profileRef).toEqual({
      profileId: selected.profileId,
      revision: selected.revision,
      profileDigest: selected.profileDigest,
    })
  })
})

describe("external editor terminal outcome projection", () => {
  const expected = { profile: selected, sourceRevision: REVISION, contentDigest: FILE_DIGEST }

  test("reports a successful edit relative to the pinned preview revision and digest", () => {
    const result = ExternalEditor.projectEditorOutcomeV1(completed(), expected)
    expect(result).toMatchObject({
      status: "completed",
      changed: true,
      workspaceAdvanced: true,
      observedWorkspaceRevision: OTHER_REVISION,
      resultFileDigest: NEW_FILE_DIGEST,
    })
  })

  test("reports unchanged content and an unchanged workspace distinctly", () => {
    const result = ExternalEditor.projectEditorOutcomeV1(
      completed({ resultFileDigest: FILE_DIGEST, observedWorkspaceRevision: REVISION }),
      expected,
    )
    expect(result).toMatchObject({ status: "completed", changed: false, workspaceAdvanced: false })
  })

  test("keeps cancellation and conflict terminal with their exact receipt", () => {
    for (const status of ["cancelled", "conflict"] as const) {
      const result = ExternalEditor.projectEditorOutcomeV1(completed({ status, exitCode: null, resultFileDigest: null, observedWorkspaceRevision: null }), expected)
      expect(result).toMatchObject({ status, receiptDigest: completed().receiptDigest })
    }
  })

  test("cancelled or conflicting prompt-scratch outcome exposes no content that could be imported", () => {
    for (const status of ["cancelled", "conflict"] as const) {
      const result = ExternalEditor.projectEditorOutcomeV1(
        completed({ status, exitCode: null, resultFileDigest: null, observedWorkspaceRevision: null }),
        expected,
      )

      expect(result).toEqual({
        status,
        effectID: "effect_1",
        executionID: "editor_exec_1",
        receiptDigest: completed().receiptDigest,
      })
    }
  })

  test("a non-terminal retained outcome is reported unknown and never retried", () => {
    const result = ExternalEditor.projectEditorOutcomeV1(
      completed({ status: "running", receiptDigest: null, exitCode: null, resultFileDigest: null, observedWorkspaceRevision: null }),
      expected,
    )
    expect(result).toEqual({
      status: "unknown",
      effectID: "effect_1",
      executionID: "editor_exec_1",
      receiptDigest: null,
    })
  })

  test("rejects a completed outcome without exact result pins or a different profile", () => {
    expect(() => ExternalEditor.projectEditorOutcomeV1(
      completed({ receiptDigest: null }),
      expected,
    )).toThrow()
    expect(() => ExternalEditor.projectEditorOutcomeV1(
      completed(),
      { ...expected, profile: { ...selected, revision: "4" } },
    )).toThrow(TypeError)
  })

  test("rejects an outcome carrying fields outside the exact wire contract", () => {
    expect(() => ExternalEditor.projectEditorOutcomeV1(
      { ...completed(), principalId: "principal-1" },
      expected,
    )).toThrow()
    expect(() => ExternalEditor.projectEditorOutcomeV1(
      { ...completed(), status: "paused" },
      expected,
    )).toThrow()
    expect(() => ExternalEditor.projectEditorOutcomeV1(
      { ...completed(), processRef: { ...processRef(), executionID: "editor_exec_other" } },
      expected,
    )).toThrow(TypeError)
  })

  test("rejects terminal outcomes that do not carry exactly one durable receipt", () => {
    for (const status of ["cancelled", "conflict"] as const) {
      expect(() => ExternalEditor.projectEditorOutcomeV1(
        completed({ status, receiptDigest: null }),
        expected,
      ), status).toThrow()
    }
    expect(() => ExternalEditor.projectEditorOutcomeV1(
      completed({
        status: "running",
        receiptDigest: REVISION,
        exitCode: null,
        resultFileDigest: null,
        observedWorkspaceRevision: null,
      }),
      expected,
    )).toThrow()
  })

  test("rejects a completed outcome with a non-zero exit or missing result pins", () => {
    for (const over of [
      { exitCode: 1 },
      { resultFileDigest: null },
      { observedWorkspaceRevision: null },
      { exitCode: 300 },
    ] as const) {
      expect(() => ExternalEditor.projectEditorOutcomeV1(completed(over), expected), JSON.stringify(over)).toThrow()
    }
  })

  test("reports an unchanged completed edit without claiming a workspace advance", () => {
    const result = ExternalEditor.projectEditorOutcomeV1(
      completed({ resultFileDigest: FILE_DIGEST, observedWorkspaceRevision: REVISION }),
      expected,
    )
    expect(result).toEqual({
      status: "completed",
      effectID: "effect_1",
      executionID: "editor_exec_1",
      receiptDigest: completed().receiptDigest,
      changed: false,
      workspaceAdvanced: false,
      observedWorkspaceRevision: REVISION,
      resultFileDigest: FILE_DIGEST,
    })
  })
})
