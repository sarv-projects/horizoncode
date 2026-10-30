import { describe, expect, test } from "bun:test"
import { ConfigV1 } from "@horizoncode/core/v1/config/config"
import { Effect, Schema } from "effect"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { MCP } from "@/mcp"
import { MCP_TRUST_FILE, bindingDigest, readTrustApprovals } from "@/mcp/trust"
import { createMcpHarness, markerCommand, testDirectory, unavailableMessage, withMcpInstance } from "./unavailable"

const projectDirectory = testDirectory()
const projectData = path.join(projectDirectory, "trust-data")
const projectMarker = path.join(projectDirectory, "project-started")
const projectCommand = markerCommand(projectMarker)
const projectHarness = createMcpHarness(
  { mcp: { project: { type: "local", command: projectCommand } } } as ConfigV1.Info,
  { global: { mcp: {} } as ConfigV1.Info, dataDirectory: projectData },
)

describe("MCP consent for project configuration", () => {
  projectHarness.it.effect(
    "a project MCP server is not started and reports the typed mcp_untrusted state",
    withMcpInstance(
      projectDirectory,
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        const status = (yield* mcp.status()).project
        expect(status?.status).toBe("mcp_untrusted")
        expect(status?.status === "mcp_untrusted" ? status.reason : "").toContain("project configuration introduced")
        expect(status?.status === "mcp_untrusted" ? status.approval : "").toContain("/trust")
        // The typed state is a first-class wire status, not an ad hoc string.
        expect(Schema.decodeUnknownSync(MCP.Status)(status)).toBeDefined()

        const failure = yield* mcp.connect("project").pipe(Effect.flip)
        expect(failure).toBeInstanceOf(MCP.UntrustedError)
        expect((yield* mcp.status()).project?.status).toBe("mcp_untrusted")
        expect(yield* Effect.promise(() => Bun.file(projectMarker).exists())).toBe(false)
        expect(yield* mcp.clients()).toEqual({})
      }),
    ),
  )

  projectHarness.it.effect(
    "approval records the exact identity and revocation restores the typed refusal",
    withMcpInstance(
      projectDirectory,
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        const approved = yield* mcp.approve("project")
        expect(approved.status).toBe("failed")
        expect(approved.status === "failed" ? approved.error : "").toBe(unavailableMessage)

        const approvals = yield* Effect.promise(() => readTrustApprovals(path.join(projectData, MCP_TRUST_FILE)))
        expect(approvals.filter((entry) => entry.server === "project")).toHaveLength(1)
        expect(approvals.find((entry) => entry.server === "project")?.directory).toBe(projectDirectory)

        // Approved servers reach the (unavailable) transport gate, never a
        // local process, and never a permission-check bypass.
        const transportRefusal = yield* mcp.connect("project").pipe(Effect.flip)
        expect(MCP.Failed.isInstance(transportRefusal)).toBe(true)
        expect(yield* Effect.promise(() => Bun.file(projectMarker).exists())).toBe(false)

        const revoked = yield* mcp.revokeApproval("project")
        expect(revoked.status).toBe("mcp_untrusted")
        const afterRevoke = yield* mcp.connect("project").pipe(Effect.flip)
        expect(afterRevoke).toBeInstanceOf(MCP.UntrustedError)
      }),
    ),
  )
})

const globalDirectory = testDirectory()
const sharedCommand = markerCommand(path.join(globalDirectory, "shared-started"))
const globalHarness = createMcpHarness(
  { mcp: { shared: { type: "local", command: sharedCommand } } } as ConfigV1.Info,
  {
    global: { mcp: { shared: { type: "local", command: sharedCommand } } } as ConfigV1.Info,
    dataDirectory: path.join(globalDirectory, "trust-data"),
  },
)

describe("MCP trust for user-global configuration", () => {
  globalHarness.it.effect(
    "a server defined identically in global config is trusted without an approval",
    withMcpInstance(
      globalDirectory,
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        const status = (yield* mcp.status()).shared
        expect(status?.status).toBe("failed")
        expect(status?.status === "failed" ? status.error : "").toBe(unavailableMessage)
      }),
    ),
  )
})

const overrideDirectory = testDirectory()
const overrideHarness = createMcpHarness(
  { mcp: { shared: { type: "local", command: markerCommand(path.join(overrideDirectory, "override-started")) } } } as ConfigV1.Info,
  {
    global: { mcp: { shared: { type: "local", command: sharedCommand } } } as ConfigV1.Info,
    dataDirectory: path.join(overrideDirectory, "trust-data"),
  },
)

describe("MCP trust for project overrides", () => {
  overrideHarness.it.effect(
    "a project override of a global server is untrusted until the exact definition is approved",
    withMcpInstance(
      overrideDirectory,
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        const status = (yield* mcp.status()).shared
        expect(status?.status).toBe("mcp_untrusted")
        expect(status?.status === "mcp_untrusted" ? status.reason : "").toContain("overrides")
      }),
    ),
  )
})

const ruleDirectory = testDirectory()
const ruledCommand = markerCommand(path.join(ruleDirectory, "ruled-started"))
const ruleHarness = createMcpHarness(
  { mcp: { ruled: { type: "local", command: ruledCommand } } } as ConfigV1.Info,
  {
    // Only the user-global ruleset may pre-approve; a project document that
    // tries to allow its own server must not be trusted.
    global: { mcp: {}, permission: { mcp: { ruled: "allow" } } } as unknown as ConfigV1.Info,
    dataDirectory: path.join(ruleDirectory, "trust-data"),
  },
)

describe("MCP trust permission rule", () => {
  ruleHarness.it.effect(
    "an explicit user-global allow rule pre-approves the server without a trust record",
    withMcpInstance(
      ruleDirectory,
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        const status = (yield* mcp.status()).ruled
        expect(status?.status).toBe("failed")
        expect(yield* Effect.promise(() => readTrustApprovals(path.join(ruleDirectory, "trust-data", MCP_TRUST_FILE)))).toEqual([])
      }),
    ),
  )
})

const projectRuleDirectory = testDirectory()
const projectRuledCommand = markerCommand(path.join(projectRuleDirectory, "project-ruled-started"))
const projectRuleHarness = createMcpHarness(
  {
    mcp: { selfApproved: { type: "local", command: projectRuledCommand } },
    permission: { mcp: { selfApproved: "allow" } },
  } as unknown as ConfigV1.Info,
  { global: { mcp: {} } as ConfigV1.Info, dataDirectory: path.join(projectRuleDirectory, "trust-data") },
)

describe("MCP trust cannot be self-granted by a project", () => {
  projectRuleHarness.it.effect(
    "a project permission rule does not approve the project server it names",
    withMcpInstance(
      projectRuleDirectory,
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        const status = (yield* mcp.status()).selfApproved
        expect(status?.status).toBe("mcp_untrusted")
        const failure = yield* mcp.connect("selfApproved").pipe(Effect.flip)
        expect(failure).toBeInstanceOf(MCP.UntrustedError)
        expect(yield* Effect.promise(() => Bun.file(path.join(projectRuleDirectory, "project-ruled-started")).exists())).toBe(false)
      }),
    ),
  )
})

describe("MCP trust record", () => {
  test("the identity digest binds command, environment, URL and headers", () => {
    const base = { type: "local" as const, command: ["a", "b"], environment: { TOKEN: "one" } }
    expect(bindingDigest(base)).not.toBe(bindingDigest({ ...base, command: ["a", "c"] }))
    expect(bindingDigest(base)).not.toBe(bindingDigest({ ...base, environment: { TOKEN: "two" } }))
    expect(bindingDigest(base)).not.toBe(bindingDigest({ ...base, cwd: "/tmp" }))
    expect(bindingDigest({ type: "remote", url: "https://example.test/mcp" }))
      .not.toBe(bindingDigest({ type: "remote", url: "https://example.test/mcp", headers: { "x-a": "b" } }))
  })

  test("a corrupt trust record fails closed", async () => {
    const directory = testDirectory()
    await mkdir(directory, { recursive: true })
    await writeFile(path.join(directory, MCP_TRUST_FILE), "{not json")
    expect(await readTrustApprovals(path.join(directory, MCP_TRUST_FILE))).toEqual([])
  })
})
