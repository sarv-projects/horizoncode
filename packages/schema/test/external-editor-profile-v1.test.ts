import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import * as ExternalEditor from "../src/external-editor-profile-v1"

const DIGEST_1 = `blake3:${"1".repeat(64)}`
const DIGEST_2 = `blake3:${"2".repeat(64)}`

const profile: ExternalEditor.ExternalEditorProfileDefinitionV1 = {
  schemaVersion: 1,
  profileId: "code",
  revision: "3",
  executableSelector: "horizoncode:editor:code",
  argv: ["--wait"],
  targetArgIndex: 0,
  launchMode: "wait",
  targetKinds: ["workspace_file"],
  environmentPolicy: "sanitized_host",
}

const profileRef: ExternalEditor.ExternalEditorProfileRefV1 = ExternalEditor.externalEditorProfileRefV1(profile)

describe("external-editor-profile-v1 decode helpers", () => {
  test("workspace launch requests decode to exact records, not partial applications", () => {
    const request = ExternalEditor.externalEditorLaunchRequestV1({
      sessionId: "session-1",
      locationId: "location-1",
      profileRef,
      pathRef: "src/main.ts",
      sourceRevision: DIGEST_1,
      contentDigest: DIGEST_2,
    })
    expect(request).toMatchObject({
      schemaVersion: 1,
      sessionId: "session-1",
      locationId: "location-1",
      targetKind: "workspace_file",
      targetRelativePath: "src/main.ts",
      expectedWorkspaceRevision: DIGEST_1,
      expectedFileDigest: DIGEST_2,
      profileRef,
    })
    expect(typeof request).toBe("object")
  })

  test("prompt scratch requests stay host-generated with no path or preimage digest", () => {
    const request = ExternalEditor.externalEditorPromptScratchRequestV1({
      sessionId: "session-1",
      locationId: "location-1",
      profileRef,
      workspaceRevision: DIGEST_1,
    })
    expect(request).toMatchObject({
      targetKind: "prompt_scratch",
      targetRelativePath: "",
      expectedFileDigest: null,
      expectedWorkspaceRevision: DIGEST_1,
    })
  })

  test("caller-supplied excess fields never enter the decoded request", () => {
    // The helper builds the payload from named fields only; an undeclared
    // authority-looking input property is ignored, not forwarded.
    const request = ExternalEditor.externalEditorLaunchRequestV1({
      sessionId: "session-1",
      locationId: "location-1",
      profileRef,
      pathRef: "src/main.ts",
      sourceRevision: DIGEST_1,
      contentDigest: DIGEST_2,
      principalId: "principal-1",
    } as never)
    expect(Object.keys(request).sort()).toEqual(
      [
        "expectedFileDigest",
        "expectedWorkspaceRevision",
        "locationId",
        "profileRef",
        "schemaVersion",
        "sessionId",
        "targetKind",
        "targetRelativePath",
      ].sort(),
    )
    expect(request).not.toHaveProperty("principalId")
  })

  test("the wire schema itself rejects excess properties under strict parsing", () => {
    const decode = Schema.decodeUnknownSync(ExternalEditor.ExternalEditorLaunchRequestV1)
    const wire = {
      schemaVersion: 1,
      sessionId: "session-1",
      locationId: "location-1",
      profileRef,
      targetKind: "workspace_file",
      targetRelativePath: "src/main.ts",
      expectedWorkspaceRevision: DIGEST_1,
      expectedFileDigest: DIGEST_2,
      // A caller cannot smuggle authority through an undeclared field.
      principalId: "principal-1",
    }
    expect(() => decode(wire, { onExcessProperty: "error" })).toThrow()
    // The default parse strips the excess key instead of forwarding it.
    expect(decode(wire)).not.toHaveProperty("principalId")
  })

  test("workspace targets must be normalized relative paths with an exact digest", () => {
    for (const [pathRef, contentDigest] of [
      ["/etc/passwd", DIGEST_2],
      ["../escape.ts", DIGEST_2],
      ["src//main.ts", DIGEST_2],
      ["src/main.ts", null],
    ] as const) {
      expect(() =>
        ExternalEditor.externalEditorLaunchRequestV1({
          sessionId: "session-1",
          locationId: "location-1",
          profileRef,
          pathRef,
          sourceRevision: DIGEST_1,
          contentDigest: contentDigest as string,
        }),
      ).toThrow()
    }
  })
})

describe("external-editor-profile-v1 outcome adapter", () => {
  const processRef = {
    executionID: "execution-1",
    generation: "1",
    ownerEpoch: "7",
    kind: "external_editor",
    profileID: profileRef.profileId,
    profileRevision: profileRef.revision,
    profileDigest: profileRef.profileDigest,
    executableDigest: DIGEST_2,
  } as const

  test("completed outcomes require a receipt, successful exit and exact result digests", () => {
    const result = ExternalEditor.externalEditorLaunchResultV1({
      schemaVersion: 1,
      status: "completed",
      effectID: "effect-1",
      executionID: "execution-1",
      bindingDigest: DIGEST_1,
      processRef,
      receiptDigest: DIGEST_2,
      exitCode: 0,
      resultFileDigest: DIGEST_2,
      observedWorkspaceRevision: DIGEST_1,
    }, profileRef)
    expect(result.status).toBe("completed")
    expect(result.executionID).toBe(result.processRef.executionID)
  })

  test("non-terminal outcomes cannot expose result evidence", () => {
    expect(() =>
      ExternalEditor.externalEditorLaunchResultV1({
        schemaVersion: 1,
        status: "running",
        effectID: "effect-1",
        executionID: "execution-1",
        bindingDigest: DIGEST_1,
        processRef,
        receiptDigest: null,
        exitCode: null,
        resultFileDigest: DIGEST_2,
        observedWorkspaceRevision: null,
      }),
    ).toThrow()
  })

  test("terminal outcomes require exactly one durable receipt digest", () => {
    expect(() =>
      ExternalEditor.externalEditorLaunchResultV1({
        schemaVersion: 1,
        status: "cancelled",
        effectID: "effect-1",
        executionID: "execution-1",
        bindingDigest: DIGEST_1,
        processRef,
        receiptDigest: null,
        exitCode: null,
        resultFileDigest: null,
        observedWorkspaceRevision: null,
      }),
    ).toThrow()
  })

  test("outcomes from a different execution or immutable profile are rejected", () => {
    const outcome = {
      schemaVersion: 1,
      status: "cancelled",
      effectID: "effect-1",
      executionID: "execution-1",
      bindingDigest: DIGEST_1,
      processRef,
      receiptDigest: DIGEST_2,
      exitCode: null,
      resultFileDigest: null,
      observedWorkspaceRevision: null,
    } as const
    expect(() =>
      ExternalEditor.externalEditorLaunchResultV1({ ...outcome, executionID: "execution-2" }),
    ).toThrow(TypeError)
    expect(() =>
      ExternalEditor.externalEditorLaunchResultV1(outcome, {
        profileId: "other",
        revision: "1",
        profileDigest: DIGEST_1,
      }),
    ).toThrow(TypeError)
  })
})

describe("external-editor-profile-v1 profile identity", () => {
  test("profile refs are stable BLAKE3 identities over the canonical encoding", () => {
    expect(profileRef.profileDigest).toMatch(/^blake3:[a-f0-9]{64}$/)
    expect(ExternalEditor.externalEditorProfileRefV1(profile)).toEqual(profileRef)
    expect(ExternalEditor.externalEditorProfileDigestV1({ ...profile, revision: "4" })).not.toBe(
      profileRef.profileDigest,
    )
  })

  test("profile definitions reject out-of-range target indices and duplicate target kinds", () => {
    const decode = Schema.decodeUnknownSync(ExternalEditor.ExternalEditorProfileDefinitionV1)
    expect(() => decode({ ...profile, targetArgIndex: 2 })).toThrow()
    expect(() => decode({ ...profile, targetKinds: ["workspace_file", "workspace_file"] })).toThrow()
    expect(() => decode({ ...profile, executableSelector: "" })).toThrow()
    expect(decode({ ...profile }).profileId).toBe("code")
  })
})
