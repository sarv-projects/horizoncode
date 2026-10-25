import { describe, expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import { Effect } from "effect"
import { tmpdir } from "../fixture/fixture"
import { it } from "../lib/effect"
import {
  Broker,
  StaleRefError,
  UnavailableError,
  availability,
  controlAllowed,
  executableOf,
  identityKey,
  identityOf as makeIdentity,
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
const supervised = (
  serverName = "typescript",
  executionId = "exec-1",
  generation = "1",
  executableDigest = "blake3:" + "e".repeat(64),
): Extract<Source, { kind: "supervised" }> => ({
  kind: "supervised",
  processRef: {
    executionID: executionId,
    generation,
    ownerEpoch: "7",
    kind: "language_server",
    profileID: `lsp-${serverName}`,
    profileRevision: "1",
    profileDigest: "blake3:" + "b".repeat(64),
    executableDigest,
  },
  launchProfileRef: { profileId: `lsp-${serverName}`, revision: "1", profileDigest: "blake3:" + "b".repeat(64) },
  serverName,
})

const TEST_AUTHORITY_SCOPE = {
  sessionID: "session-1",
  locationID: "location-1",
  workspaceRevision: "blake3:" + "1".repeat(64),
  ownerEpoch: "7",
  principalId: "principal-1",
  readScopeDigest: "read-scope-1",
  policyGeneration: "policy-1",
  sandboxProfileDigest: "profile-1",
}

const TEST_AUTHORITY = {
  workspaceId: "ws-1",
  ...TEST_AUTHORITY_SCOPE,
}

function identityOf(
  input: Omit<Parameters<typeof makeIdentity>[0], keyof typeof TEST_AUTHORITY_SCOPE> &
    Partial<typeof TEST_AUTHORITY_SCOPE>,
) {
  return makeIdentity({ ...TEST_AUTHORITY_SCOPE, ...input })
}

function input(over: Partial<SnapshotInput> = {}): SnapshotInput {
  return {
    source: supervised(),
    workspaceId: "ws-1",
    languageId: "typescript",
    rootUri: "file:///workspace",
    configurationDigest: "cfg-1",
    ...TEST_AUTHORITY_SCOPE,
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
    expect(executableOf({ kind: "external", adapterId: "adapter-1", serverName: "clangd" })).toBe(
      "external:adapter-1:clangd",
    )
  })

  test("identityKey separates workspace, language, root, config digest and owner", () => {
    const base = identityOf({
      source: supervised(),
      workspaceId: "ws-1",
      languageId: "typescript",
      rootUri: "file:///a",
      configurationDigest: "cfg-1",
    })
    const same = identityOf({
      source: supervised(),
      workspaceId: "ws-1",
      languageId: "typescript",
      rootUri: "file:///a",
      configurationDigest: "cfg-1",
    })
    expect(identityKey(base)).toBe(identityKey(same))

    const changedConfig = identityOf({
      source: supervised(),
      workspaceId: "ws-1",
      languageId: "typescript",
      rootUri: "file:///a",
      configurationDigest: "cfg-2",
    })
    expect(identityKey(changedConfig)).not.toBe(identityKey(base))

    const editorOwned = identityOf({
      source: editor("typescript"),
      workspaceId: "ws-1",
      languageId: "typescript",
      rootUri: "file:///a",
      configurationDigest: "cfg-1",
    })
    expect(identityKey(editorOwned)).not.toBe(identityKey(base))

    expect(identityKey(identityOf({
      source: supervised(),
      workspaceId: "ws-1",
      languageId: "typescript",
      rootUri: "file:///a",
      configurationDigest: "cfg-1",
      sessionID: "session-2",
    }))).not.toBe(identityKey(base))
    expect(identityKey(identityOf({
      source: supervised(),
      workspaceId: "ws-1",
      languageId: "typescript",
      rootUri: "file:///a",
      configurationDigest: "cfg-1",
      locationID: "location-2",
    }))).not.toBe(identityKey(base))
  })

  test("identityKey keeps distinct editor client IDs isolated", () => {
    const first = identityOf({
      source: editor("typescript", "editor-1"),
      workspaceId: "ws-1",
      languageId: "typescript",
      rootUri: "file:///a",
      configurationDigest: "cfg-1",
    })
    const second = identityOf({
      source: editor("typescript", "editor-2"),
      workspaceId: "ws-1",
      languageId: "typescript",
      rootUri: "file:///a",
      configurationDigest: "cfg-1",
    })

    expect(identityKey(first)).not.toBe(identityKey(second))
  })

  test("identityKey keeps distinct supervised execution generations isolated", () => {
    const first = identityOf({
      source: supervised("typescript", "execution-1"),
      workspaceId: "ws-1",
      languageId: "typescript",
      rootUri: "file:///a",
      configurationDigest: "cfg-1",
    })
    const second = identityOf({
      source: supervised("typescript", "execution-2"),
      workspaceId: "ws-1",
      languageId: "typescript",
      rootUri: "file:///a",
      configurationDigest: "cfg-1",
    })

    expect(identityKey(first)).not.toBe(identityKey(second))
  })

  test("identityKey binds the HostKernel process generation separately", () => {
    const first = identityOf({
      source: supervised("typescript", "execution-1", "3"),
      workspaceId: "ws-1",
      languageId: "typescript",
      rootUri: "file:///a",
      configurationDigest: "cfg-1",
    })
    const second = identityOf({
      source: supervised("typescript", "execution-1", "4"),
      workspaceId: "ws-1",
      languageId: "typescript",
      rootUri: "file:///a",
      configurationDigest: "cfg-1",
    })
    expect(first.processGeneration).toBe("3")
    expect(identityKey(first)).not.toBe(identityKey(second))
  })

  test("identityKey binds the immutable launch profile revision and digest", () => {
    const first = identityOf({ source: supervised(), workspaceId: "ws-1", languageId: "typescript", rootUri: "file:///a", configurationDigest: "cfg-1" })
    const changedSource = supervised()
    const changed = identityOf({
      source: {
        ...changedSource,
        processRef: {
          ...changedSource.processRef,
          profileRevision: "2",
          profileDigest: "blake3:" + "c".repeat(64),
        },
        launchProfileRef: { profileId: "lsp-typescript", revision: "2", profileDigest: "blake3:" + "c".repeat(64) },
      },
      workspaceId: "ws-1",
      languageId: "typescript",
      rootUri: "file:///a",
      configurationDigest: "cfg-1",
    })
    expect(first.launchProfileId).toBe("lsp-typescript")
    expect(first.launchProfileRevision).toBe("1")
    expect(identityKey(first)).not.toBe(identityKey(changed))
  })

  test("identityKey separates server versions for the same source and workspace", () => {
    const first = identityOf({
      source: supervised(),
      workspaceId: "ws-1",
      languageId: "typescript",
      rootUri: "file:///a",
      configurationDigest: "cfg-1",
      serverVersion: "5.0.0",
    })
    const second = identityOf({
      source: supervised(),
      workspaceId: "ws-1",
      languageId: "typescript",
      rootUri: "file:///a",
      configurationDigest: "cfg-1",
      serverVersion: "5.1.0",
    })

    expect(identityKey(first)).not.toBe(identityKey(second))
  })

  test("identityKey separates HostKernel executable digests for the same profile and workspace", () => {
    const first = identityOf({
      source: supervised(),
      workspaceId: "ws-1",
      languageId: "typescript",
      rootUri: "file:///a",
      configurationDigest: "cfg-1",
    })
    const second = identityOf({
      source: supervised("typescript", "exec-1", "1", "blake3:" + "f".repeat(64)),
      workspaceId: "ws-1",
      languageId: "typescript",
      rootUri: "file:///a",
      configurationDigest: "cfg-1",
    })

    expect(identityKey(first)).not.toBe(identityKey(second))
  })

  test("identityKey separates principal, read scope, policy generation and sandbox profile", () => {
    const base = {
      source: supervised(),
      workspaceId: "ws-1",
      languageId: "typescript",
      rootUri: "file:///a",
      configurationDigest: "cfg-1",
      principalId: "principal-1",
      readScopeDigest: "read-scope-1",
      policyGeneration: "policy-1",
      sandboxProfileDigest: "profile-1",
    }
    const identity = identityOf(base)
    for (const change of [
      { principalId: "principal-2" },
      { readScopeDigest: "read-scope-2" },
      { policyGeneration: "policy-2" },
      { sandboxProfileDigest: "profile-2" },
    ]) {
      expect(identityKey(identityOf({ ...base, ...change }))).not.toBe(identityKey(identity))
    }
  })

  test("identity construction rejects missing authority bindings", () => {
    expect(() =>
      identityOf({
        source: supervised(),
        workspaceId: "ws-1",
        languageId: "typescript",
        rootUri: "file:///a",
        configurationDigest: "cfg-1",
        principalId: " ",
      }),
    ).toThrow("language-service identity principalId must be non-empty")
  })
})

describe("lsp.broker generation ledger", () => {
  test("register assigns generation 1 and refOf resolves it", () => {
    const ledger = makeLedger()
    const snapshot = ledger.register(input())
    expect(snapshot.generation).toBe(1)
    const ref = refOf(snapshot)
    expect(ledger.require(ref, TEST_AUTHORITY)).toEqual(snapshot)
  })

  test("registered snapshots and their source identity cannot be mutated by callers", () => {
    const ledger = makeLedger()
    const snapshot = ledger.register(input({ source: editor() }))
    const ref = refOf(snapshot)

    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.source)).toBe(true)
    expect(Reflect.set(snapshot, "health", "failed")).toBe(false)
    expect(ledger.require(ref, TEST_AUTHORITY).health).toBe("healthy")
  })

  test("copies and freezes the managed Attempt scope retained by a generation", () => {
    const ledger = makeLedger()
    const managedAttemptScope = {
      goalID: "goal-1",
      runID: "run-1",
      taskID: "task-1",
      attemptID: "attempt-1",
      ownerEpoch: "7",
      expectedManagedRevision: "9",
      requestSequence: "1",
      requestID: "request-1",
      contextSelectionDigest: "blake3:" + "9".repeat(64),
      locationID: "location-1",
      sessionID: "session-1",
      workspaceRevision: "blake3:" + "1".repeat(64),
      effectiveMaxTokens: "100000",
      remainingTokens: "100000",
      delegationBindingDigest: "blake3:" + "e".repeat(64),
      permissionScopeDigest: "blake3:" + "a".repeat(64),
      worktreeTarget: {
        worktreeID: "worktree-1",
        worktreeBaseRevision: "blake3:" + "5".repeat(64),
        worktreePoolRevision: "3",
        locationID: "location-1",
        workspaceID: "ws-1",
        workspaceRef: "worktree-1",
        canonicalRoot: "/workspace/ws-1",
        workspaceRevision: "blake3:" + "1".repeat(64),
      },
    }
    const snapshot = ledger.register(input({ managedAttemptScope }))
    expect(snapshot.managedAttemptScope).toEqual(managedAttemptScope)
    expect(snapshot.managedAttemptScope).not.toBe(managedAttemptScope)
    expect(Object.isFrozen(snapshot.managedAttemptScope)).toBe(true)
  })

  test("replacing the same identity advances the generation and stales old refs", () => {
    const ledger = makeLedger()
    const first = ledger.register(input())
    const oldRef = refOf(first)
    const second = ledger.register(input({ capabilitiesDigest: "caps-2" }))
    expect(second.generation).toBe(2)

    const error = capture<Broker.StaleRefError>(() => ledger.require(oldRef, TEST_AUTHORITY))
    expect(error).toBeInstanceOf(StaleRefError)
    expect(error._tag).toBe("LSPStaleRefError")
    expect(error.reason).toBe("replaced")
    expect(error.current).toBe(2)
    expect(ledger.require(refOf(second), TEST_AUTHORITY).generation).toBe(2)
  })

  test("invalidate drops only the referenced generation", () => {
    const ledger = makeLedger()
    const snapshot = ledger.register(input())
    ledger.invalidate(refOf(snapshot))
    const error = capture<Broker.StaleRefError>(() => ledger.require(refOf(snapshot), TEST_AUTHORITY))
    expect(error.reason).toBe("invalidated")
    expect(ledger.get(identityKey(identityOf(snapshot)))).toBeUndefined()
  })

  test("a failed snapshot is not usable but a degraded one is", () => {
    const ledger = makeLedger()
    const failed = ledger.register(input({ health: "failed" }))
    const error = capture<Broker.StaleRefError>(() => ledger.require(refOf(failed), TEST_AUTHORITY))
    expect(error.reason).toBe("failed")

    const other = makeLedger()
    const degraded = other.register(input({ health: "degraded", rootUri: "file:///b" }))
    expect(other.require(refOf(degraded), TEST_AUTHORITY).health).toBe("degraded")
  })

  test("distinct configuration digests create independent generations", () => {
    const ledger = makeLedger()
    const a = ledger.register(input({ configurationDigest: "cfg-a" }))
    const b = ledger.register(input({ configurationDigest: "cfg-b" }))
    expect([a.generation, b.generation]).toEqual([1, 1])
    expect(ledger.list()).toHaveLength(2)
  })

  test("a query pin holds its exact generation until the query settles", async () => {
    const ledger = makeLedger()
    const snapshot = ledger.register(input())
    const ref = refOf(snapshot)
    let finish!: () => void
    let started!: () => void
    const queryStarted = new Promise<void>((resolve) => {
      started = resolve
    })

    const query = ledger.withQueryPin(ref, TEST_AUTHORITY, async (pinned) => {
      expect(pinned).toBe(snapshot)
      started()
      await new Promise<void>((resolve) => {
        finish = resolve
      })
      return { generation: pinned.generation }
    })

    await queryStarted
    expect(ledger.queryPinCount(ref)).toBe(1)
    ledger.invalidate(ref)
    expect(ledger.queryPinCount(ref)).toBe(1)
    // A lifecycle owner must not evict the exact server generation while a
    // query is still using it. Cancellation alone is not proof that it drained.
    expect(ledger.require(ref, TEST_AUTHORITY)).toBe(snapshot)
    finish()

    await expect(query).resolves.toEqual({ generation: 1 })
    expect(ledger.queryPinCount(ref)).toBe(0)
    ledger.invalidate(ref)
    expect(() => ledger.require(ref, TEST_AUTHORITY)).toThrow(StaleRefError)
  })

  test("a query pin releases after cancellation or deadline rejection", async () => {
    const ledger = makeLedger()
    const snapshot = ledger.register(input())
    const ref = refOf(snapshot)
    const controller = new AbortController()
    let started!: () => void
    const queryStarted = new Promise<void>((resolve) => {
      started = resolve
    })

    const query = ledger.withQueryPin(
      ref,
      TEST_AUTHORITY,
      async (_pinned, signal) => {
        await new Promise<never>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true })
          started()
        })
      },
      controller.signal,
    )

    await queryStarted
    expect(ledger.queryPinCount(ref)).toBe(1)
    controller.abort(new Error("query deadline exceeded"))

    await expect(query).rejects.toThrow("query deadline exceeded")
    expect(ledger.queryPinCount(ref)).toBe(0)
  })

  test("a replaced generation keeps its own query pin until the old query settles", async () => {
    const ledger = makeLedger()
    const first = ledger.register(input())
    const oldRef = refOf(first)
    let finish!: () => void
    let started!: () => void
    const queryStarted = new Promise<void>((resolve) => {
      started = resolve
    })

    const query = ledger.withQueryPin(oldRef, TEST_AUTHORITY, async (pinned) => {
      started()
      await new Promise<void>((resolve) => {
        finish = resolve
      })
      return pinned.generation
    })

    await queryStarted
    const replacement = ledger.register(input({ capabilitiesDigest: "caps-replaced" }))
    const newRef = refOf(replacement)
    expect(replacement.generation).toBe(2)
    expect(ledger.queryPinCount(oldRef)).toBe(1)
    expect(ledger.queryPinCount(newRef)).toBe(0)

    finish()
    await expect(query).resolves.toBe(1)
    expect(ledger.queryPinCount(oldRef)).toBe(0)
  })

  test("an abort request alone does not release a query pin before the query settles", async () => {
    const ledger = makeLedger()
    const snapshot = ledger.register(input())
    const ref = refOf(snapshot)
    const controller = new AbortController()
    let finish!: () => void
    let started!: () => void
    const queryStarted = new Promise<void>((resolve) => {
      started = resolve
    })

    const query = ledger.withQueryPin(
      ref,
      TEST_AUTHORITY,
      async (_pinned, signal) => {
        expect(signal).toBe(controller.signal)
        started()
        await new Promise<void>((resolve) => {
          finish = resolve
        })
        return "settled"
      },
      controller.signal,
    )

    await queryStarted
    controller.abort(new Error("cancel requested"))
    expect(ledger.queryPinCount(ref)).toBe(1)

    finish()
    await expect(query).resolves.toBe("settled")
    expect(ledger.queryPinCount(ref)).toBe(0)
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
    const report = availability({ operation: "query.document_symbol", ledger, ref, authority: TEST_AUTHORITY })
    expect(report).toMatchObject({ available: true, source: "editor", generation: 1 })
    expect(requireAvailable({ operation: "query.document_symbol", ledger, ref, authority: TEST_AUTHORITY })).toEqual(
      snapshot,
    )
  })

  test("read-only queries reject owner, workspace revision, read scope, policy, or sandbox mismatch", () => {
    const ledger = makeLedger()
    const snapshot = ledger.register(input({ source: editor() }))
    const ref = refOf(snapshot)
    for (const authority of [
      { ...TEST_AUTHORITY, principalId: "principal-2" },
      { ...TEST_AUTHORITY, sessionID: "session-2" },
      { ...TEST_AUTHORITY, locationID: "location-2" },
      { ...TEST_AUTHORITY, workspaceId: "ws-2" },
      { ...TEST_AUTHORITY, workspaceRevision: "blake3:" + "2".repeat(64) },
      { ...TEST_AUTHORITY, readScopeDigest: "read-scope-2" },
      { ...TEST_AUTHORITY, policyGeneration: "policy-2" },
      { ...TEST_AUTHORITY, sandboxProfileDigest: "profile-2" },
    ]) {
      expect(availability({ operation: "query.document_symbol", ledger, ref, authority })).toMatchObject({
        available: false,
        reason: "owner_scope_mismatch",
      })
      expect(
        capture<Broker.UnavailableError>(() =>
          requireAvailable({ operation: "query.document_symbol", ledger, ref, authority }),
        ).reason,
      ).toBe("owner_scope_mismatch")
    }
  })

  test("snapshot registration requires a trusted non-empty workspace revision", () => {
    expect(() => makeLedger().register(input({ workspaceRevision: " " }))).toThrow(
      "language-service snapshot workspaceRevision must be non-empty",
    )
  })

  test("starting generations are waitable but unavailable to queries until healthy or degraded", () => {
    const identity = identityOf({
      source: editor(),
      workspaceId: "ws-1",
      languageId: "typescript",
      rootUri: "file:///workspace",
      configurationDigest: "cfg-1",
    })
    const ledger = makeLedger()
    const starting = ledger.register(input({ source: editor(), health: "starting" }))
    const ref = refOf(starting)

    expect(route({ ledger, identity })).toEqual({ action: "wait", snapshot: starting })
    expect(availability({ operation: "query.hover", ledger, ref })).toMatchObject({
      available: false,
      reason: "source_starting",
    })
    expect(
      capture<Broker.UnavailableError>(() => requireAvailable({ operation: "diagnostics.pull", ledger, ref })),
    ).toMatchObject({
      _tag: "LSPUnavailableError",
      operation: "diagnostics.pull",
      reason: "source_starting",
    })
    expect(
      capture<{ _tag: string; key: string; generation: number; health: string }>(() =>
        ledger.require(ref, TEST_AUTHORITY),
      ),
    ).toMatchObject({ _tag: "LSPGenerationNotReadyError", generation: starting.generation, health: "starting" })

    for (const health of ["healthy", "degraded"] as const) {
      const readyLedger = makeLedger()
      const ready = readyLedger.register(input({ source: editor(), health }))
      const readyRef = refOf(ready)
      expect(
        availability({ operation: "query.hover", ledger: readyLedger, ref: readyRef, authority: TEST_AUTHORITY }),
      ).toMatchObject({
        available: true,
        source: "editor",
      })
      expect(
        requireAvailable({ operation: "query.hover", ledger: readyLedger, ref: readyRef, authority: TEST_AUTHORITY }),
      ).toEqual(ready)
    }
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
    const error = capture<Broker.StaleRefError>(() =>
      requireAvailable({ operation: "query.hover", ledger, ref: oldRef }),
    )
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
    const decision = route({
      ledger,
      identity: identityOf({
        source: supervised(),
        workspaceId: "ws-1",
        languageId: "typescript",
        rootUri: "file:///a",
        configurationDigest: "cfg-1",
      }),
    })
    expect(decision.action).toBe("start_required")
    if (decision.action === "start_required") {
      expect(decision.error.operation).toBe("server.spawn")
      expect(decision.error.reason).toBe("guard_not_verified")
    }
  })

  test("healthy and degraded snapshots are reused, starting snapshots wait", () => {
    const identity = identityOf({
      source: supervised(),
      workspaceId: "ws-1",
      languageId: "typescript",
      rootUri: "file:///a",
      configurationDigest: "cfg-1",
    })
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
    const identity = identityOf({
      source: supervised(),
      workspaceId: "ws-1",
      languageId: "typescript",
      rootUri: "file:///a",
      configurationDigest: "cfg-1",
    })
    const ledger = makeLedger()
    ledger.register(input({ health: "failed", rootUri: identity.rootUri }))
    const decision = route({ ledger, identity })
    expect(decision.action).toBe("restart_required")
    if (decision.action === "restart_required") expect(decision.error.operation).toBe("server.restart")
  })

  test("a failed editor-owned source falls back instead of restarting", () => {
    const identity = identityOf({
      source: editor(),
      workspaceId: "ws-1",
      languageId: "typescript",
      rootUri: "file:///a",
      configurationDigest: "cfg-1",
    })
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
  it.live("exercising the whole broker surface spawns no process and mutates no file", () =>
    Effect.promise(async () => {
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
          identity: identityOf({
            source: supervised(),
            workspaceId: "ws-1",
            languageId: "typescript",
            rootUri,
            configurationDigest: "cfg-1",
          }),
        })
        controlAllowed(editor(), "model_query")
        controlAllowed(supervised(), "human_action")
      } finally {
        spawnSpy.mockRestore()
        writeSpy.mockRestore()
        fetchSpy.mockRestore()
      }

      const after = (await fs.readdir(tmp.path)).sort()
      expect(spawnSpy).not.toHaveBeenCalled()
      expect(writeSpy).not.toHaveBeenCalled()
      expect(fetchSpy).not.toHaveBeenCalled()
      expect(after).toEqual(before)
    }),
  )

  test("the broker namespace is re-exported from the LSP module", () => {
    expect(typeof LSP.Broker.makeLedger).toBe("function")
    expect(LSP.Broker.Operation).toBeDefined()
  })
})
