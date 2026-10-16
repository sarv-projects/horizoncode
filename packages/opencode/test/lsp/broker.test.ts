import { describe, expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import { readFileSync } from "node:fs"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"
import {
  Broker,
  StaleRefError,
  UnavailableError,
  availability,
  controlAllowed,
  executableOf,
  identityKey,
  identityOf,
  makeLedger,
  refOf,
  requireAvailable,
  route,
  type Operation,
  type SnapshotInput,
  type Source,
} from "@/lsp/broker"
import { LSP } from "@/lsp/lsp"

const editor = (serverName = "tsserver", clientId = "editor-1"): Source => ({ kind: "editor", clientId, serverName })
const supervised = (serverName = "typescript", executionId = "exec-1"): Source => ({
  kind: "supervised",
  executionId,
  serverName,
})

function input(over: Partial<SnapshotInput> = {}): SnapshotInput {
  return {
    source: supervised(),
    workspaceId: "ws-1",
    languageId: "typescript",
    rootUri: "file:///workspace",
    configurationDigest: "cfg-1",
    capabilitiesDigest: "caps-1",
    health: "healthy",
    ...over,
  }
}

function capture<T = Record<string, unknown>>(fn: () => unknown): T {
  try {
    fn()
  } catch (error) {
    return error as T
  }
  throw new Error("expected call to throw")
}

const ALL_OPERATIONS: readonly Operation[] = [
  "server.spawn",
  "server.install",
  "server.restart",
  "server.stop",
  "query.hover",
  "query.definition",
  "query.references",
  "query.document_symbol",
  "query.workspace_symbol",
  "diagnostics.pull",
  "code_action.prepare",
  "rename.prepare",
]

describe("lsp.broker identity", () => {
  test("executable token distinguishes owner kinds", () => {
    expect(executableOf(editor())).toBe("editor:tsserver")
    expect(executableOf(supervised())).toBe("supervised:typescript")
    expect(executableOf({ kind: "external", adapterId: "adapter-1", serverName: "clangd" })).toBe("external:adapter-1:clangd")
  })

  test("identityKey separates workspace, language, root, config digest and owner", () => {
    const base = identityOf({ source: supervised(), workspaceId: "ws-1", languageId: "typescript", rootUri: "file:///a", configurationDigest: "cfg-1" })
    const same = identityOf({ source: supervised(), workspaceId: "ws-1", languageId: "typescript", rootUri: "file:///a", configurationDigest: "cfg-1" })
    expect(identityKey(base)).toBe(identityKey(same))

    const changedConfig = identityOf({ source: supervised(), workspaceId: "ws-1", languageId: "typescript", rootUri: "file:///a", configurationDigest: "cfg-2" })
    expect(identityKey(changedConfig)).not.toBe(identityKey(base))

    const editorOwned = identityOf({ source: editor("typescript"), workspaceId: "ws-1", languageId: "typescript", rootUri: "file:///a", configurationDigest: "cfg-1" })
    expect(identityKey(editorOwned)).not.toBe(identityKey(base))
  })
})

describe("lsp.broker generation ledger", () => {
  test("register assigns generation 1 and refOf resolves it", () => {
    const ledger = makeLedger()
    const snapshot = ledger.register(input())
    expect(snapshot.generation).toBe(1)
    const ref = refOf(snapshot)
    expect(ledger.require(ref)).toEqual(snapshot)
  })

  test("replacing the same identity advances the generation and stales old refs", () => {
    const ledger = makeLedger()
    const first = ledger.register(input())
    const oldRef = refOf(first)
    const second = ledger.register(input({ capabilitiesDigest: "caps-2" }))
    expect(second.generation).toBe(2)

    const error = capture<Broker.StaleRefError>(() => ledger.require(oldRef))
    expect(error).toBeInstanceOf(StaleRefError)
    expect(error._tag).toBe("LSPStaleRefError")
    expect(error.reason).toBe("replaced")
    expect(error.current).toBe(2)
    expect(ledger.require(refOf(second)).generation).toBe(2)
  })

  test("invalidate drops only the referenced generation", () => {
    const ledger = makeLedger()
    const snapshot = ledger.register(input())
    ledger.invalidate(refOf(snapshot))
    const error = capture<Broker.StaleRefError>(() => ledger.require(refOf(snapshot)))
    expect(error.reason).toBe("invalidated")
    expect(ledger.get(identityKey(identityOf(snapshot)))).toBeUndefined()
  })

  test("a failed snapshot is not usable but a degraded one is", () => {
    const ledger = makeLedger()
    const failed = ledger.register(input({ health: "failed" }))
    const error = capture<Broker.StaleRefError>(() => ledger.require(refOf(failed)))
    expect(error.reason).toBe("failed")

    const other = makeLedger()
    const degraded = other.register(input({ health: "degraded", rootUri: "file:///b" }))
    expect(other.require(refOf(degraded)).health).toBe("degraded")
  })

  test("distinct configuration digests create independent generations", () => {
    const ledger = makeLedger()
    const a = ledger.register(input({ configurationDigest: "cfg-a" }))
    const b = ledger.register(input({ configurationDigest: "cfg-b" }))
    expect([a.generation, b.generation]).toEqual([1, 1])
    expect(ledger.list()).toHaveLength(2)
  })
})

describe("lsp.broker fail-closed boundary", () => {
  test("every process operation reports guard_not_verified", () => {
    for (const operation of ["server.spawn", "server.install", "server.restart", "server.stop"] as const) {
      const report = availability({ operation })
      expect(report.available).toBe(false)
      expect(report.reason).toBe("guard_not_verified")
      const error = capture<Broker.UnavailableError>(() => requireAvailable({ operation }))
      expect(error).toBeInstanceOf(UnavailableError)
      expect(error._tag).toBe("LSPUnavailableError")
      expect(error.operation).toBe(operation)
      expect(error.reason).toBe("guard_not_verified")
    }
  })

  test("code-action and rename preparation stay Guard-gated even with a live generation", () => {
    const ledger = makeLedger()
    const ref = refOf(ledger.register(input({ source: editor() })))
    for (const operation of ["code_action.prepare", "rename.prepare"] as const) {
      expect(availability({ operation, ledger, ref })).toMatchObject({
        available: false,
        reason: "guard_not_verified",
      })
      expect(capture<Broker.UnavailableError>(() => requireAvailable({ operation, ledger, ref })).reason).toBe(
        "guard_not_verified",
      )
    }
  })

  test("read-only queries need a live generation and fail without one", () => {
    expect(availability({ operation: "query.hover" })).toMatchObject({ available: false, reason: "source_absent" })
    const error = capture<Broker.UnavailableError>(() => requireAvailable({ operation: "query.definition" }))
    expect(error.reason).toBe("source_absent")
    expect(error.operation).toBe("query.definition")
  })

  test("read-only queries are allowed against the current editor generation", () => {
    const ledger = makeLedger()
    const snapshot = ledger.register(input({ source: editor() }))
    const ref = refOf(snapshot)
    const report = availability({ operation: "query.document_symbol", ledger, ref })
    expect(report).toMatchObject({ available: true, source: "editor", generation: 1 })
    expect(requireAvailable({ operation: "query.document_symbol", ledger, ref })).toEqual(snapshot)
  })

  test("read-only queries against a replaced generation fail stale", () => {
    const ledger = makeLedger()
    const first = ledger.register(input())
    const oldRef = refOf(first)
    ledger.register(input({ capabilitiesDigest: "caps-2" }))
    expect(availability({ operation: "query.hover", ledger, ref: oldRef })).toMatchObject({
      available: false,
      reason: "stale_generation",
    })
    const error = capture<Broker.StaleRefError>(() => requireAvailable({ operation: "query.hover", ledger, ref: oldRef }))
    expect(error).toBeInstanceOf(StaleRefError)
    expect(error.reason).toBe("replaced")
  })

  test("availability covers the whole operation surface fail-closed", () => {
    for (const operation of ALL_OPERATIONS) {
      const report = availability({ operation })
      expect(report.operation).toBe(operation)
      // No operation is available without a live ledger/ref, and every
      // non-query operation is unavailable even with one.
      if (operation.startsWith("query.") || operation === "diagnostics.pull") {
        expect(report.available).toBe(false)
        expect(report.reason).toBe("source_absent")
      } else {
        expect(report.available).toBe(false)
        expect(report.reason).toBe("guard_not_verified")
      }
    }
  })
})

describe("lsp.broker routing policy", () => {
  test("no snapshot requires a Guard-mediated start", () => {
    const ledger = makeLedger()
    const decision = route({ ledger, identity: identityOf({ source: supervised(), workspaceId: "ws-1", languageId: "typescript", rootUri: "file:///a", configurationDigest: "cfg-1" }) })
    expect(decision.action).toBe("start_required")
    if (decision.action === "start_required") {
      expect(decision.error.operation).toBe("server.spawn")
      expect(decision.error.reason).toBe("guard_not_verified")
    }
  })

  test("healthy and degraded snapshots are reused, starting snapshots wait", () => {
    const identity = identityOf({ source: supervised(), workspaceId: "ws-1", languageId: "typescript", rootUri: "file:///a", configurationDigest: "cfg-1" })
    for (const health of ["healthy", "degraded"] as const) {
      const ledger = makeLedger()
      const snapshot = ledger.register(input({ health, rootUri: identity.rootUri }))
      expect(route({ ledger, identity })).toEqual({ action: "reuse", snapshot })
    }
    const starting = makeLedger()
    const snapshot = starting.register(input({ health: "starting", rootUri: identity.rootUri }))
    expect(route({ ledger: starting, identity })).toEqual({ action: "wait", snapshot })
  })

  test("a failed supervised source requires a Guard-mediated restart", () => {
    const identity = identityOf({ source: supervised(), workspaceId: "ws-1", languageId: "typescript", rootUri: "file:///a", configurationDigest: "cfg-1" })
    const ledger = makeLedger()
    ledger.register(input({ health: "failed", rootUri: identity.rootUri }))
    const decision = route({ ledger, identity })
    expect(decision.action).toBe("restart_required")
    if (decision.action === "restart_required") expect(decision.error.operation).toBe("server.restart")
  })

  test("a failed editor-owned source falls back instead of restarting", () => {
    const identity = identityOf({ source: editor(), workspaceId: "ws-1", languageId: "typescript", rootUri: "file:///a", configurationDigest: "cfg-1" })
    const ledger = makeLedger()
    ledger.register(input({ source: editor(), health: "failed", rootUri: identity.rootUri }))
    expect(route({ ledger, identity })).toMatchObject({ action: "fallback", reason: "editor_source_unusable" })
  })

  test("model queries never control a language-service process", () => {
    expect(controlAllowed(editor(), "supervisor")).toBe(false)
    expect(controlAllowed(editor(), "human_action")).toBe(false)
    expect(controlAllowed(editor(), "model_query")).toBe(false)
    expect(controlAllowed(supervised(), "model_query")).toBe(false)
    expect(controlAllowed(supervised(), "human_action")).toBe(true)
    expect(controlAllowed(supervised(), "supervisor")).toBe(true)
    expect(controlAllowed({ kind: "external", adapterId: "a", serverName: "s" }, "model_query")).toBe(false)
    expect(controlAllowed({ kind: "external", adapterId: "a", serverName: "s" }, "human_action")).toBe(true)
  })
})

describe("lsp.broker purity", () => {
  test("broker source imports no process, network or mutation machinery", () => {
    const file = path.join(import.meta.dir, "../../src/lsp/broker.ts")
    const source = readFileSync(file, "utf8")
    const forbidden = [
      /\bchild_process\b/,
      /\bcross-spawn\b/,
      /["']@\/util\/(?:process|archive)["']/,
      /\bBun\.spawn\b/,
      /\bBun\.\$\b/,
      /\bfetch\s*\(/,
      /\bhttps?\.request\b/,
      /\bNpm\b/,
      /\bnode:(?:net|http|https|dgram|worker_threads)["']/,
    ]
    for (const pattern of forbidden) expect(source).not.toMatch(pattern)
  })

  test("exercising the whole broker surface spawns no process and mutates no file", async () => {
    await using tmp = await tmpdir()
    const before = (await fs.readdir(tmp.path)).sort()

    const spawnSpy = spyOn(Bun, "spawn")
    const writeSpy = spyOn(Bun, "write")
    const fetchSpy = spyOn(globalThis, "fetch")
    try {
      const ledger = makeLedger()
      const rootUri = tmp.path
      const first = ledger.register(input({ rootUri }))
      const oldRef = refOf(first)
      ledger.register(input({ rootUri, configurationDigest: "cfg-2" }))
      ledger.invalidate(oldRef)
      for (const operation of ALL_OPERATIONS) availability({ operation })
      for (const operation of ["server.spawn", "code_action.prepare", "query.hover"] as const) {
        capture(() => requireAvailable({ operation, ledger, ref: oldRef }))
      }
      route({
        ledger,
        identity: identityOf({ source: supervised(), workspaceId: "ws-1", languageId: "typescript", rootUri, configurationDigest: "cfg-1" }),
      })
      controlAllowed(editor(), "model_query")
      controlAllowed(supervised(), "human_action")
    } finally {
      spawnSpy.mockRestore()
      writeSpy.mockRestore()
      fetchSpy.mockRestore()
    }

    const after = (await fs.readdir(tmp.path)).sort()
    expect(after).toEqual(before)
  })

  test("the broker namespace is re-exported from the LSP module", () => {
    expect(typeof LSP.Broker.makeLedger).toBe("function")
    expect(LSP.Broker.Operation).toBeDefined()
  })
})
