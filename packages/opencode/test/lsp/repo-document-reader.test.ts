import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { TrustedPrincipalContext } from "@opencode-ai/core/trusted-principal"
import { MAX_REPO_DOCUMENT_BYTES } from "@opencode-ai/schema/repo-intelligence-v1"
import { makeRepoDocumentReader } from "../../src/lsp/repo-document-reader"

describe("authenticated LSP document reader composition", () => {
  test("uses only the authenticated Core supervisor and clamps to the HostKernel read bound", async () => {
    let received: unknown
    const supervisor = {
      readRepoDocument: (input: unknown) => {
        received = input
        return Effect.succeed({
          text: "source",
          contentDigest: `blake3:${"a".repeat(64)}`,
          observedWorkspaceRevision: `blake3:${"b".repeat(64)}`,
        })
      },
    } as never
    const readDocument = makeRepoDocumentReader(
      supervisor,
      { sessionID: "ses_reader", locationRef: { directory: "/repo" } as never },
      <A, E>(effect: Effect.Effect<A, E, TrustedPrincipalContext>) => Effect.runPromise(
        Effect.provideService(effect, TrustedPrincipalContext, {
          principal: { kind: "server_auth", subject: "test-principal" },
        }),
      ),
    )

    const document = await readDocument({
      schemaVersion: 1,
      pathRef: "src/main.ts",
      expectedWorkspaceRevision: `blake3:${"b".repeat(64)}`,
      maxBytes: MAX_REPO_DOCUMENT_BYTES * 4,
    })
    expect(document.text).toBe("source")
    expect(received).toEqual({
      sessionID: "ses_reader",
      locationRef: { directory: "/repo" },
      request: {
        schemaVersion: 1,
        revisionKind: "workspace",
        pathRef: "src/main.ts",
        expectedWorkspaceRevision: `blake3:${"b".repeat(64)}`,
        maxBytes: MAX_REPO_DOCUMENT_BYTES,
      },
    })
  })

  test("does not substitute a filesystem fallback when Core read is unavailable", async () => {
    const readDocument = makeRepoDocumentReader(
      {},
      { sessionID: "ses_reader", locationRef: { directory: "/repo" } as never },
      <A, E>(effect: Effect.Effect<A, E, TrustedPrincipalContext>) => Effect.runPromise(
        Effect.provideService(effect, TrustedPrincipalContext, {
          principal: { kind: "server_auth", subject: "test-principal" },
        }),
      ),
    )
    await expect(readDocument({
      schemaVersion: 1,
      pathRef: "src/main.ts",
      expectedWorkspaceRevision: `blake3:${"b".repeat(64)}`,
      maxBytes: 1024,
    })).rejects.toMatchObject({ _tag: "SessionSupervisorError" })
  })

  test("rejects a document path outside the canonical relative contract before the supervisor", async () => {
    let called = false
    const supervisor = {
      readRepoDocument: () => {
        called = true
        return Effect.succeed({
          text: "source",
          contentDigest: `blake3:${"a".repeat(64)}`,
          observedWorkspaceRevision: `blake3:${"b".repeat(64)}`,
        })
      },
    } as never
    const readDocument = makeRepoDocumentReader(
      supervisor,
      { sessionID: "ses_reader", locationRef: { directory: "/repo" } as never },
      <A, E>(effect: Effect.Effect<A, E, TrustedPrincipalContext>) => Effect.runPromise(
        Effect.provideService(effect, TrustedPrincipalContext, {
          principal: { kind: "server_auth", subject: "test-principal" },
        }),
      ),
    )
    await expect(readDocument({
      schemaVersion: 1,
      pathRef: ".",
      expectedWorkspaceRevision: `blake3:${"b".repeat(64)}`,
      maxBytes: 1024,
    })).rejects.toMatchObject({
      _tag: "SessionSupervisorError",
      reason: "document read request failed strict schema validation",
    })
    expect(called).toBe(false)
  })
})
