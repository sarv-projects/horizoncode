import { expect, test } from "bun:test"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Schema } from "effect"
import { SecretBrokerV1 } from "@horizoncode/schema/secret-broker-v1"
import { SecureInputError } from "@/auth/secure-input"
import {
  providerCatalog,
  runProviderCredentialEntry,
  type ProviderCatalogEntry,
} from "@/cli/cmd/provider"

const encoder = new TextEncoder()

const metadata = (providerId: string) =>
  Schema.decodeUnknownSync(SecretBrokerV1.MetadataV1)({
    schemaVersion: 1,
    secretRef: "secret_test" as SecretBrokerV1.SecretRef,
    providerId,
    status: "AVAILABLE",
    version: 1,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  })

const catalog = {
  anthropic: { name: "Anthropic", models: { "claude-sonnet": { name: "Claude Sonnet" } } },
  openai: { name: "OpenAI", models: { "gpt-5": { name: "GPT-5" }, "gpt-5-mini": { name: "GPT-5 mini" } } },
}

test("provider catalog is deterministic and bounded", () => {
  const entries = providerCatalog(catalog)
  expect(entries.map((entry) => entry.id)).toEqual(["anthropic", "openai"])
  expect(entries[1]).toEqual({ id: "openai", name: "OpenAI", models: ["gpt-5", "gpt-5-mini"] })

  const oversized = Object.fromEntries(
    Array.from({ length: 80 }, (_, index) => [
      `provider-${String(index).padStart(2, "0")}`,
      { name: `Provider ${index}`, models: Object.fromEntries(Array.from({ length: 40 }, (_, model) => [`model-${model}`, {}])) },
    ]),
  )
  const bounded = providerCatalog(oversized)
  expect(bounded).toHaveLength(64)
  expect(bounded[0]!.models).toHaveLength(24)
})

test("provider entry refuses before reading a key when the grant seam is unavailable", async () => {
  const events: string[] = []
  const result = await runProviderCredentialEntry({
    catalog,
    io: {
      write: (text) => events.push(text),
      selectProvider: async () => {
        events.push("select")
        return "openai"
      },
      readSecureInput: async () => {
        events.push("read")
        return encoder.encode("sk-live-secret")
      },
    },
    mutationAvailable: false,
    issueHandle: async () => {
      events.push("issue")
      return "opaque-handle"
    },
    putCredential: async () => {
      events.push("put")
      return metadata("openai")
    },
  })
  expect(result.status).toBe("unavailable")
  expect(events.some((event) => event === "select" || event === "read" || event === "issue" || event === "put")).toBe(false)
  expect(events.join("\n")).toContain("unavailable")
  expect(events.join("\n")).not.toContain("sk-live-secret")
})

test("provider entry lists providers and models, reads a masked key, and submits only the opaque handle", async () => {
  const events: string[] = []
  let selected: readonly ProviderCatalogEntry[] = []
  let issued: { bytes: Uint8Array; providerId: string; operation: string; idempotencyKey: string } | undefined
  let submitted: SecretBrokerV1.PutRequestV1 | undefined
  const key = encoder.encode("sk-live-secret")
  const result = await runProviderCredentialEntry({
    catalog,
    io: {
      write: (text) => events.push(text),
      selectProvider: async (entries) => {
        selected = entries
        return "openai"
      },
      readSecureInput: async () => key,
    },
    mutationAvailable: true,
    issueHandle: async (input) => {
      issued = input
      input.bytes.fill(0)
      return "opaque-handle-not-secret-content"
    },
    putCredential: async (request) => {
      submitted = request
      return metadata("openai")
    },
    newIdempotencyKey: () => "put_test",
  })

  expect(result.status).toBe("written")
  expect(selected.map((entry) => entry.id)).toEqual(["anthropic", "openai"])
  expect(events.join("\n")).toContain("Anthropic")
  expect(events.join("\n")).toContain("claude-sonnet")
  expect(events.join("\n")).toContain("gpt-5")
  expect(issued).toMatchObject({
    providerId: "openai",
    operation: "put",
    idempotencyKey: "put_test",
  })
  expect(issued!.bytes.every((byte) => byte === 0)).toBe(true)
  expect(submitted).toEqual({
    schemaVersion: 1,
    providerId: "openai",
    secureInputHandle: "opaque-handle-not-secret-content",
    idempotencyKey: "put_test",
  })
  expect(JSON.stringify(submitted)).not.toContain("sk-live-secret")
  expect(events.join("\n")).not.toContain("sk-live-secret")
})

test("provider entry refuses unknown providers and cancelled input without writing", async () => {
  for (const [selection, read] of [
    ["unknown", false],
    [undefined, false],
    ["openai", true],
  ] as const) {
    const events: string[] = []
    let reads = 0
    const result = await runProviderCredentialEntry({
      catalog,
      io: {
        write: (text) => events.push(text),
        selectProvider: async () => selection,
        readSecureInput: async () => {
          reads++
          if (read) throw new SecureInputError("UNAVAILABLE", "Credential entry cancelled")
          return encoder.encode("sk-live-secret")
        },
      },
      mutationAvailable: true,
      issueHandle: async () => "opaque-handle",
      putCredential: async () => {
        throw new Error("write must not run")
      },
    })
    expect(result.status).not.toBe("written")
    if (read) expect(reads).toBe(1)
    else expect(reads).toBe(0)
    expect(events.join("\n")).not.toContain("sk-live-secret")
  }
})

test("rejected provider entry never echoes the key, writes a file, or mutates the environment", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "horizon-provider-entry-"))
  const previousAuthContent = process.env.OPENCODE_AUTH_CONTENT
  const previousConfigDir = process.env.OPENCODE_CONFIG_DIR
  const previousDataHome = process.env.XDG_DATA_HOME
  process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({ legacy: { type: "api", key: "legacy-value" } })
  process.env.OPENCODE_CONFIG_DIR = directory
  process.env.XDG_DATA_HOME = directory
  const events: string[] = []
  try {
    const result = await runProviderCredentialEntry({
      catalog: { openai: catalog.openai },
      io: {
        write: (text) => events.push(text),
        selectProvider: async () => "openai",
        readSecureInput: async () => encoder.encode("sk-live-secret"),
      },
      mutationAvailable: true,
      issueHandle: async (input) => {
        input.bytes.fill(0)
        return "opaque-handle-not-secret-content"
      },
      putCredential: async () => {
        throw new Error("HostKernel rejected sk-live-secret")
      },
      newIdempotencyKey: () => "put_test",
    })
    expect(result.status).toBe("denied")
    expect(events.join("\n")).not.toContain("sk-live-secret")
    expect(await readdir(directory, { recursive: true })).toEqual([])
    expect(process.env.OPENCODE_AUTH_CONTENT).toBe(JSON.stringify({ legacy: { type: "api", key: "legacy-value" } }))
    expect(process.env.OPENCODE_CONFIG_DIR).toBe(directory)
    expect(process.env.XDG_DATA_HOME).toBe(directory)
  } finally {
    if (previousAuthContent === undefined) delete process.env.OPENCODE_AUTH_CONTENT
    else process.env.OPENCODE_AUTH_CONTENT = previousAuthContent
    if (previousConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
    else process.env.OPENCODE_CONFIG_DIR = previousConfigDir
    if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = previousDataHome
    await rm(directory, { recursive: true, force: true })
  }
})
