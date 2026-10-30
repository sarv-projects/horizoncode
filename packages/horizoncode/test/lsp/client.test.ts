import { describe, expect, test } from "bun:test"
import { LSPClient } from "@/lsp/client"
import { LanguageServiceProcessError } from "@/lsp/launch"
import type { HostProcessRefV1 } from "@/lsp/process-scope"
import type { LspProtocolAdapter } from "@/lsp/client"

const processRef: HostProcessRefV1 = {
  executionID: "lsp-test-process",
  generation: "1",
  ownerEpoch: "7",
  kind: "language_server",
  profileID: "trusted-typescript",
  profileRevision: "1",
  profileDigest: `blake3:${"3".repeat(64)}`,
  executableDigest: `blake3:${"4".repeat(64)}`,
}

describe("LSP client process boundary", () => {
  test("creation remains unavailable and performs no typed HostKernel IO", async () => {
    const calls: string[] = []
    const protocol: LspProtocolAdapter = {
      onNotification() {},
      onRequest() {},
      listen() {},
      sendRequest: async <T,>() => undefined as T,
      sendNotification: async () => undefined,
      end() {},
      dispose() {},
    }

    await expect(
      LSPClient.create({
        serverID: "typescript",
        protocol,
        processRef,
        launchProfileRef: {
          profileId: processRef.profileID,
          revision: processRef.profileRevision,
          profileDigest: processRef.profileDigest,
        },
        root: "/workspace",
        directory: "/workspace",
        instance: {} as never,
        workspaceRevision: `blake3:${"1".repeat(64)}`,
        readDocument: async () => {
          calls.push("read_document")
          throw new Error("must not read workspace")
        },
        stopServer: async () => {
          calls.push("stop")
          throw new Error("must not stop process")
        },
      }),
    ).rejects.toBeInstanceOf(LanguageServiceProcessError)

    expect(calls).toEqual([])
  })
})
