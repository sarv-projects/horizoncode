import { describe, expect, test } from "bun:test"
import { SessionSupervisor } from "@opencode-ai/core/session/supervisor"
import { Effect, Layer } from "effect"
import { CheckpointControlError, list, previewRestore } from "@/session/checkpoint-control"

const principal = { kind: "server_auth", subject: "checkpoint-owner" } as const
const scope = { locationID: "location-1", sessionID: "session-1", trustedPrincipal: principal }

function supervisor(response: unknown, onRequest?: (service: string, operation: string, body: unknown, options: unknown) => void) {
  return Layer.mock(SessionSupervisor.Service)({
    requestHostKernel: (service, operation, body, options) => {
      onRequest?.(service, operation, body, options)
      return Effect.succeed(response as Record<string, unknown>)
    },
  })
}

describe("CheckpointControl.list", () => {
  test("uses the registered Session scope and authenticated principal", async () => {
    let call: { service: string; operation: string; body: unknown; options: unknown } | undefined
    const result = await Effect.runPromise(list(scope).pipe(Effect.provide(supervisor(
      { checkpointIDs: ["checkpoint-1", "checkpoint-2"] },
      (service, operation, body, options) => { call = { service, operation, body, options } },
    ))))

    expect(result).toEqual({ checkpointIDs: ["checkpoint-1", "checkpoint-2"] })
    expect(call).toEqual({
      service: "checkpoint.v1",
      operation: "checkpoint.list",
      body: { locationID: "location-1", sessionID: "session-1" },
      options: { trustedPrincipal: principal },
    })
  })

  test("rejects duplicate, malformed, and over-limit IDs", async () => {
    for (const checkpointIDs of [
      ["checkpoint-1", "checkpoint-1"],
      ["../outside"],
      Array.from({ length: 33 }, (_, index) => `checkpoint-${index}`),
    ]) {
      const result = await Effect.runPromise(Effect.either(
        list(scope).pipe(Effect.provide(supervisor({ checkpointIDs }))),
      ))
      expect(result._tag).toBe("Left")
      if (result._tag === "Left") expect(result.left).toBeInstanceOf(CheckpointControlError)
    }
  })
})

describe("CheckpointControl.previewRestore", () => {
  const preview = {
    checkpointID: "checkpoint-1",
    checkpointArtifact: { artifactID: "artifact-1", digest: `blake3:${"a".repeat(64)}`, byteLength: "42", mediaType: "application/vnd.horizoncode.checkpoint+json", classification: "workspace" },
    workspaceRevision: `blake3:${"b".repeat(64)}`,
    workspaceRevisionChanged: false,
    mode: "FULL",
    selectedPaths: [],
    actions: [],
    conflicts: [{ path: null, kind: "WORKSPACE_STATUS_UNAVAILABLE" }],
    previewDigest: `blake3:${"c".repeat(64)}`,
  }
  const action = (path: string) => ({
    path,
    expectedBeforeDigest: `blake3:${"d".repeat(64)}`,
    target: {
      kind: "REGULAR_FILE",
      digest: `blake3:${"e".repeat(64)}`,
      byteLength: 1,
      executable: false,
      linkCount: 1,
    },
  })

  test("binds exact preview request to the registered Location, Session, and ServerAuth principal", async () => {
    let call: { service: string; operation: string; body: unknown; options: unknown } | undefined
    const result = await Effect.runPromise(previewRestore(scope, {
      checkpointID: "checkpoint-1", mode: "FULL", selectedPaths: [],
    }).pipe(Effect.provide(supervisor(preview, (service, operation, body, options) => { call = { service, operation, body, options } }))))
    expect(result).toEqual({ ...preview, conflicts: [{ kind: "WORKSPACE_STATUS_UNAVAILABLE" }] })
    expect(call).toEqual({
      service: "checkpoint.v1",
      operation: "checkpoint.restore_preview",
      body: { checkpointID: "checkpoint-1", locationID: "location-1", sessionID: "session-1", mode: "FULL", selectedPaths: [] },
      options: { trustedPrincipal: principal },
    })
  })

  test("rejects inconsistent mode, action/conflict mixtures, and malformed digests", async () => {
    const cases = [
      { ...preview, selectedPaths: ["file.txt"] },
      { ...preview, actions: [{ path: "file.txt" }], conflicts: [{ path: null, kind: "WORKSPACE_STATUS_UNAVAILABLE" }] },
      { ...preview, previewDigest: "bad" },
    ]
    for (const response of cases) {
      const result = await Effect.runPromise(Effect.either(previewRestore(scope, {
        checkpointID: "checkpoint-1", mode: "FULL", selectedPaths: [],
      }).pipe(Effect.provide(supervisor(response)))))
      expect(result._tag).toBe("Left")
      if (result._tag === "Left") expect(result.left).toBeInstanceOf(CheckpointControlError)
    }
  })

  test("rejects a preview that does not match the requested checkpoint or path selection", async () => {
    const selectedRequest = { checkpointID: "checkpoint-1", mode: "SELECTED_PATHS" as const, selectedPaths: ["src/a.ts"] }
    const responses = [
      { ...preview, checkpointID: "checkpoint-other" },
      { ...preview },
      { ...preview, mode: "SELECTED_PATHS", selectedPaths: ["src/b.ts"], conflicts: [{ path: null, kind: "WORKSPACE_STATUS_UNAVAILABLE" }] },
      { ...preview, workspaceRevisionChanged: true },
      { ...preview, workspaceRevisionChanged: true, mode: "SELECTED_PATHS", selectedPaths: ["src/a.ts"], conflicts: [{ path: null, kind: "WORKSPACE_REVISION_CHANGED" }] },
      { ...preview, mode: "SELECTED_PATHS", selectedPaths: ["../outside"], conflicts: [{ path: null, kind: "WORKSPACE_STATUS_UNAVAILABLE" }] },
    ]
    for (const response of responses) {
      const result = await Effect.runPromise(Effect.either(
        previewRestore(scope, selectedRequest).pipe(Effect.provide(supervisor(response))),
      ))
      expect(result._tag).toBe("Left")
      if (result._tag === "Left") expect(result.left).toBeInstanceOf(CheckpointControlError)
    }
  })

  test("rejects unsafe, duplicate, and out-of-selection restore actions", async () => {
    const selectedRequest = { checkpointID: "checkpoint-1", mode: "SELECTED_PATHS" as const, selectedPaths: ["src/a.ts"] }
    const selectedBase = { ...preview, mode: "SELECTED_PATHS", selectedPaths: ["src/a.ts"], conflicts: [] }
    for (const actions of [
      [action("../outside")],
      [action("src/a.ts"), action("src/a.ts")],
      [action("src/other.ts")],
      [{ ...action("src/a.ts"), target: { ...action("src/a.ts").target, linkCount: 2 } }],
      [{ ...action("src/a.ts"), target: { ...action("src/a.ts").target, kind: "ABSENT", digest: null } }],
    ]) {
      const result = await Effect.runPromise(Effect.either(previewRestore(scope, selectedRequest).pipe(
        Effect.provide(supervisor({ ...selectedBase, actions })),
      )))
      expect(result._tag).toBe("Left")
      if (result._tag === "Left") expect(result.left).toBeInstanceOf(CheckpointControlError)
    }
  })

  test("retains selected-path preview across a changed revision when trusted observations allow it", async () => {
    const selected = {
      ...preview,
      workspaceRevision: `blake3:${"d".repeat(64)}`,
      workspaceRevisionChanged: true,
      mode: "SELECTED_PATHS",
      selectedPaths: ["src/a.ts"],
      actions: [],
      conflicts: [],
    }
    const result = await Effect.runPromise(previewRestore(scope, {
      checkpointID: "checkpoint-1", mode: "SELECTED_PATHS", selectedPaths: ["src/a.ts"],
    }).pipe(Effect.provide(supervisor(selected))))
    expect(result.workspaceRevisionChanged).toBe(true)
    expect(result.conflicts).toEqual([])
  })

  test("rejects duplicate selected paths before asking HostKernel", async () => {
    let dispatched = false
    const result = await Effect.runPromise(Effect.either(previewRestore(scope, {
      checkpointID: "checkpoint-1", mode: "SELECTED_PATHS", selectedPaths: ["src/a.ts", "src/a.ts"],
    }).pipe(Effect.provide(supervisor(preview, () => { dispatched = true }))))))
    expect(result._tag).toBe("Left")
    if (result._tag === "Left") expect(result.left).toBeInstanceOf(CheckpointControlError)
    expect(dispatched).toBe(false)
  })

  test("rejects unsafe selected paths before asking HostKernel", async () => {
    let dispatched = false
    for (const selectedPath of ["../outside", "/absolute", "a\\b", "a//b"]) {
      const service = supervisor(preview, () => { dispatched = true })
      const result = await Effect.runPromise(
        Effect.either(
          previewRestore(scope, {
            checkpointID: "checkpoint-1", mode: "SELECTED_PATHS", selectedPaths: [selectedPath],
          }).pipe(Effect.provide(service)),
        ),
      )
      expect(result._tag).toBe("Left")
      if (result._tag === "Left") expect(result.left).toBeInstanceOf(CheckpointControlError)
    }
    expect(dispatched).toBe(false)
  })

  test("rejects aggregate conflict path data over the projection byte bound", async () => {
    const response = {
      ...preview,
      conflicts: Array.from({ length: 1_025 }, () => ({ path: "x".repeat(4_096), kind: "UNSAFE_PATH" })),
    }
    const result = await Effect.runPromise(
      Effect.either(
        previewRestore(scope, {
          checkpointID: "checkpoint-1", mode: "FULL", selectedPaths: [],
        }).pipe(Effect.provide(supervisor(response))),
      ),
    )
    expect(result._tag).toBe("Left")
    if (result._tag === "Left") expect(result.left).toBeInstanceOf(CheckpointControlError)
  })
})
