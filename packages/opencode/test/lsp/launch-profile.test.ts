import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Location } from "@opencode-ai/schema"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import {
  projectGlobalDapConfigProfileV1,
  projectGlobalLspConfigProfileV1,
  projectTrustedGlobalDapProfileV1,
  projectTrustedReplProfileV1,
  resolveExecutionLaunchProfileV1,
  resolveTrustedGlobalLaunchProfileV1,
} from "../../src/lsp/launch-profile"
import { createHostKernelLspProtocolAdapterV1 } from "../../src/lsp/protocol"
import { createSupervisedLspClientV1 } from "../../src/lsp/supervised"
import { createSupervisedDapClientV1 } from "../../src/dap/supervised"
import { hostProtocolRouteAvailable, languageServiceProcessRouteAvailable } from "../../src/lsp/launch"

describe("trusted global execution launch profiles", () => {
  test("Core Config accepts only the typed DAP adapter profile shape", () => {
    const decode = Schema.decodeUnknownSync(ConfigV1.Info)
    expect(decode({ dap: { debugpy: { command: ["debugpy"] } } }).dap).toEqual({
      debugpy: { command: ["debugpy"] },
    })
    expect(decode({ dap: { debugpy: { command: ["debugpy"], dapPolicy: { allowEvaluate: true } } } }).dap)
      .toMatchObject({ debugpy: { dapPolicy: { allowEvaluate: true } } })
    expect(() => decode({ dap: { debugpy: { command: ["debugpy"], dapPolicy: { allowEvaluate: "yes" } } } })).toThrow()
    expect(() => decode({ dap: { debugpy: { command: "debugpy" } } })).toThrow()
  })

  test("projects exact trusted DAP selectors into content-pinned profiles", () => {
    const profile = projectGlobalDapConfigProfileV1({
      adapterID: "debugpy",
      configEntry: { command: ["debugpy", "--host", "127.0.0.1"] },
    })
    expect(profile).toMatchObject({
      kind: "dap",
      executableSelector: "horizoncode:dap:debugpy-adapter",
      argv: ["--host", "127.0.0.1"],
      revision: "1",
      dapPolicy: { allowEvaluate: false },
    })
    const evaluateProfile = projectGlobalDapConfigProfileV1({
      adapterID: "debugpy",
      configEntry: { command: ["debugpy", "--host", "127.0.0.1"], dapPolicy: { allowEvaluate: true } },
    })
    expect(evaluateProfile).toMatchObject({ dapPolicy: { allowEvaluate: true } })
    expect(evaluateProfile?.profileId).not.toBe(profile?.profileId)
    expect(projectGlobalDapConfigProfileV1({
      adapterID: "lldb",
      configEntry: { command: ["debugpy"] },
    })).toBeUndefined()
    expect(projectGlobalDapConfigProfileV1({
      adapterID: "debugpy",
      configEntry: { command: ["debugpy"], env: { TOKEN: "secret" } },
    })).toBeUndefined()
    expect(projectTrustedGlobalDapProfileV1({
      adapterID: "debugpy",
      config: { dap: { debugpy: { command: ["debugpy"] } } },
    })).toMatchObject({ kind: "dap", executableSelector: "horizoncode:dap:debugpy-adapter" })
  })

  test("rejects project-selected executable paths and preserves the existing LSP projection", () => {
    expect(projectGlobalDapConfigProfileV1({
      adapterID: "debugpy",
      configEntry: { command: ["/usr/bin/debugpy"] },
    })).toBeUndefined()
    expect(projectGlobalLspConfigProfileV1({
      serverID: "typescript",
      configEntry: { command: ["typescript-language-server", "--stdio"] },
    })).toMatchObject({ kind: "lsp", executableSelector: "horizoncode:lsp:typescript-language-server" })
  })

  test("keeps HostKernel protocol IO disabled until P1 dispatcher acceptance", async () => {
    expect(hostProtocolRouteAvailable()).toBe(false)
    let dispatched = false
    const adapter = createHostKernelLspProtocolAdapterV1(async () => {
      dispatched = true
      return {}
    })
    await expect(adapter.protocolOp({})).rejects.toMatchObject({ _tag: "HostProtocolUnavailableError" })
    expect(dispatched).toBe(false)
  })

  test("keeps both supervised product compositions before HostKernel until process acceptance", async () => {
    expect(languageServiceProcessRouteAvailable()).toBe(false)
    let dispatched = false
    const requestHostKernel = async () => {
      dispatched = true
      return {}
    }
    const locationRef = Location.Ref.make({
      directory: AbsolutePath.make("/workspace"),
      workspaceID: WorkspaceV2.ID.make("wrk_editor_test"),
    })
    const workspaceRevision = `blake3:${"b".repeat(64)}`

    await expect(createSupervisedLspClientV1({
      config: {},
      serverID: "typescript",
      sessionID: "ses_lsp_test",
      locationID: "loc_lsp_test",
      locationRef,
      workspaceRevision,
      workspaceID: "wrk_editor_test",
      root: "/workspace",
      directory: "/workspace",
      instance: { directory: "/workspace", worktree: "/workspace", project: {} },
      supervisor: {},
      runTrustedEffect: async () => undefined,
      requestHostKernel,
    } as never)).rejects.toMatchObject({ _tag: "LanguageServiceProcessError", operation: "server.spawn" })
    await expect(createSupervisedDapClientV1({
      config: {},
      adapterID: "debugpy",
      sessionID: "ses_dap_test",
      locationID: "loc_dap_test",
      locationRef,
      userActionID: "action_dap_test",
      callID: "call_dap_test",
      workspaceRevision,
      workspaceID: "wrk_editor_test",
      supervisor: {},
      runTrustedEffect: async () => undefined,
      requestHostKernel,
    } as never)).rejects.toMatchObject({ _tag: "LanguageServiceProcessError", operation: "debug.start" })
    expect(dispatched).toBe(false)
  })

  test("resolves only a global trusted profile and never falls back when absent", async () => {
    let calls = 0
    const requestHostKernel = async (_service: "execution.v1", operation: "resolve_launch_profile", body: Readonly<Record<string, unknown>>) => {
      calls++
      expect(operation).toBe("resolve_launch_profile")
      expect(body.profileDefinition).toMatchObject({
        kind: "lsp",
        executableSelector: "horizoncode:lsp:typescript-language-server",
      })
      return {
        status: "needs_approval",
        challengeID: "challenge_1",
        effectID: "effect_1",
        capabilityID: "language.start",
        locationID: "loc_1",
        sessionID: "ses_1",
        profileRef: {
          profileId: projectGlobalLspConfigProfileV1({
            serverID: "typescript",
            configEntry: { command: ["typescript-language-server", "--stdio"] },
          })!.profileId,
          revision: "1",
          profileDigest: `blake3:${"a".repeat(64)}`,
        },
        inputDigest: `blake3:${"b".repeat(64)}`,
        expiresAtUnixMs: Date.now() + 60_000,
        normalizedTargets: [{ kind: "registered_location_root" }],
        targets: [{ kind: "registered_location_root" }],
        policySummary: "Start the configured TypeScript language server",
        allowEnabled: true,
        argumentSummary: { status: "available", text: "Start TypeScript language server" },
        guaranteeAssessment: { status: "assessed", residual: [] },
        noResponse: "deny_and_expire",
        normalizedAction: "language.start",
        origin: "user_action",
        policyDigest: `blake3:${"c".repeat(64)}`,
        policyID: "editor.launch",
        requestedGuarantees: ["process_supervision"],
        source: "authenticated.user_action",
      }
    }
    const approved = await resolveTrustedGlobalLaunchProfileV1({
      kind: "lsp",
      selectorID: "typescript",
      config: { lsp: { typescript: { command: ["typescript-language-server", "--stdio"] } } },
      scope: { locationID: "loc_1", sessionID: "ses_1", userActionID: "action_1", callID: "call_1" },
      requestHostKernel,
    })
    expect(approved).toMatchObject({ status: "needs_approval", capabilityID: "language.start" })
    expect(calls).toBe(1)

    const absent = await resolveTrustedGlobalLaunchProfileV1({
      kind: "dap",
      selectorID: "debugpy",
      config: { dap: { debugpy: { command: ["/workspace/debugpy"] } } },
      scope: { locationID: "loc_1", sessionID: "ses_1", userActionID: "action_2", callID: "call_2" },
      requestHostKernel,
    })
    expect(absent).toBeUndefined()
    expect(calls).toBe(1)
  })

  test("rejects mismatched Attempt scope before HostKernel dispatch", async () => {
    let dispatched = false
    await expect(resolveTrustedGlobalLaunchProfileV1({
      kind: "lsp",
      selectorID: "typescript",
      config: { lsp: { typescript: { command: ["typescript-language-server"] } } },
      scope: {
        locationID: "loc_1",
        sessionID: "ses_wrong",
        userActionID: "action_1",
        callID: "call_1",
        managedAttempt: {
          goalID: "goal_1",
          runID: "run_1",
          taskID: "task_1",
          attemptID: "attempt_1",
          ownerEpoch: "1",
          expectedManagedRevision: "1",
          requestSequence: "1",
          requestID: "request_1",
          contextSelectionDigest: `blake3:${"9".repeat(64)}`,
          locationID: "loc_1",
          sessionID: "ses_1",
          workspaceRevision: `blake3:${"b".repeat(64)}`,
          effectiveMaxTokens: "100000",
          remainingTokens: "100000",
          delegationBindingDigest: `blake3:${"c".repeat(64)}`,
          permissionScopeDigest: `blake3:${"a".repeat(64)}`,
          worktreeTarget: {
            worktreeID: "worktree_1",
            worktreeBaseRevision: `blake3:${"5".repeat(64)}`,
            worktreePoolRevision: "3",
            locationID: "loc_1",
            workspaceID: "wrk_editor_test",
            workspaceRef: "worktree_1",
            canonicalRoot: "/workspace",
            workspaceRevision: `blake3:${"b".repeat(64)}`,
          },
        },
      },
      requestHostKernel: async () => { dispatched = true; return {} },
    })).rejects.toThrow(/authenticated Session\/Location/)
    expect(dispatched).toBe(false)
  })

  test("admits the current managed Attempt scope contract up to the HostKernel approval boundary", async () => {
    let dispatched = false
    await expect(resolveTrustedGlobalLaunchProfileV1({
      kind: "lsp",
      selectorID: "typescript",
      config: { lsp: { typescript: { command: ["typescript-language-server"] } } },
      scope: {
        locationID: "loc_1",
        sessionID: "ses_1",
        userActionID: "action_1",
        callID: "call_1",
        managedAttempt: {
          goalID: "goal_1",
          runID: "run_1",
          taskID: "task_1",
          attemptID: "attempt_1",
          ownerEpoch: "1",
          expectedManagedRevision: "1",
          requestSequence: "1",
          requestID: "request_1",
          contextSelectionDigest: `blake3:${"9".repeat(64)}`,
          locationID: "loc_1",
          sessionID: "ses_1",
          workspaceRevision: `blake3:${"b".repeat(64)}`,
          effectiveMaxTokens: "100000",
          remainingTokens: "100000",
          delegationBindingDigest: `blake3:${"c".repeat(64)}`,
          permissionScopeDigest: `blake3:${"a".repeat(64)}`,
          worktreeTarget: {
            worktreeID: "worktree_1",
            worktreeBaseRevision: `blake3:${"5".repeat(64)}`,
            worktreePoolRevision: "3",
            locationID: "loc_1",
            workspaceID: "wrk_managed",
            workspaceRef: "worktree_1",
            canonicalRoot: "/workspace/managed",
            workspaceRevision: `blake3:${"b".repeat(64)}`,
          },
        },
      },
      requestHostKernel: async () => {
        dispatched = true
        return {}
      },
    })).rejects.toThrow(/HostKernel did not return a Guard approval challenge/)
    expect(dispatched).toBe(true)
  })

  test("rejects a managed LSP root outside the Attempt worktree target before HostKernel dispatch", async () => {
    let dispatched = false
    await expect(createSupervisedLspClientV1({
      config: {},
      serverID: "typescript",
      sessionID: "ses_managed",
      locationID: "loc_1",
      locationRef: Location.Ref.make({
        directory: AbsolutePath.make("/workspace"),
        workspaceID: WorkspaceV2.ID.make("wrk_managed"),
      }),
      workspaceRevision: `blake3:${"b".repeat(64)}`,
      managedAttempt: {
        goalID: "goal_1",
        runID: "run_1",
        taskID: "task_1",
        attemptID: "attempt_1",
        ownerEpoch: "1",
        expectedManagedRevision: "1",
        requestSequence: "1",
        requestID: "request_1",
        contextSelectionDigest: `blake3:${"9".repeat(64)}`,
        locationID: "loc_1",
        sessionID: "ses_managed",
        workspaceRevision: `blake3:${"b".repeat(64)}`,
        effectiveMaxTokens: "100000",
        remainingTokens: "100000",
        delegationBindingDigest: `blake3:${"c".repeat(64)}`,
        permissionScopeDigest: `blake3:${"a".repeat(64)}`,
        worktreeTarget: {
          worktreeID: "worktree_1",
          worktreeBaseRevision: `blake3:${"5".repeat(64)}`,
          worktreePoolRevision: "3",
          locationID: "loc_1",
          workspaceID: "wrk_managed",
          workspaceRef: "worktree_1",
          canonicalRoot: "/workspace/managed",
          workspaceRevision: `blake3:${"b".repeat(64)}`,
        },
      },
      root: "/workspace",
      directory: "/workspace",
      instance: { directory: "/workspace", worktree: "/workspace", project: {} },
      supervisor: {},
      runTrustedEffect: async () => undefined,
      requestHostKernel: async () => {
        dispatched = true
        return {}
      },
    } as never)).rejects.toThrow("supervised LSP scope does not match the managed Attempt worktree target")
    expect(dispatched).toBe(false)
  })

  test("rejects a DAP root Session scope without the authenticated workspace pin", async () => {
    let dispatched = false
    const locationRef = Location.Ref.make({
      directory: AbsolutePath.make("/workspace"),
      workspaceID: WorkspaceV2.ID.make("wrk_editor_test"),
    })
    await expect(createSupervisedDapClientV1({
      config: {},
      adapterID: "debugpy",
      sessionID: "ses_dap_root",
      locationID: "loc_dap_root",
      locationRef,
      userActionID: "action_dap_root",
      callID: "call_dap_root",
      workspaceRevision: `blake3:${"b".repeat(64)}`,
      supervisor: {},
      runTrustedEffect: async () => undefined,
      requestHostKernel: async () => {
        dispatched = true
        return {}
      },
    } as never)).rejects.toThrow("supervised DAP root Session scope is malformed")
    expect(dispatched).toBe(false)
  })

  test("rejects a DAP managed LocationRef outside the Attempt worktree target before dispatch", async () => {
    let dispatched = false
    await expect(createSupervisedDapClientV1({
      config: {},
      adapterID: "debugpy",
      sessionID: "ses_dap_managed",
      locationID: "loc_1",
      locationRef: Location.Ref.make({
        directory: AbsolutePath.make("/workspace"),
        workspaceID: WorkspaceV2.ID.make("wrk_managed"),
      }),
      userActionID: "action_dap_managed",
      callID: "call_dap_managed",
      workspaceRevision: `blake3:${"b".repeat(64)}`,
      managedAttempt: {
        goalID: "goal_1",
        runID: "run_1",
        taskID: "task_1",
        attemptID: "attempt_1",
        ownerEpoch: "1",
        expectedManagedRevision: "1",
        requestSequence: "1",
        requestID: "request_1",
        contextSelectionDigest: `blake3:${"9".repeat(64)}`,
        locationID: "loc_1",
        sessionID: "ses_dap_managed",
        workspaceRevision: `blake3:${"b".repeat(64)}`,
        effectiveMaxTokens: "100000",
        remainingTokens: "100000",
        delegationBindingDigest: `blake3:${"c".repeat(64)}`,
        permissionScopeDigest: `blake3:${"a".repeat(64)}`,
        worktreeTarget: {
          worktreeID: "worktree_1",
          worktreeBaseRevision: `blake3:${"5".repeat(64)}`,
          worktreePoolRevision: "3",
          locationID: "loc_1",
          workspaceID: "wrk_managed",
          workspaceRef: "worktree_1",
          canonicalRoot: "/workspace/managed",
          workspaceRevision: `blake3:${"b".repeat(64)}`,
        },
      },
      supervisor: {},
      runTrustedEffect: async () => undefined,
      requestHostKernel: async () => {
        dispatched = true
        return {}
      },
    } as never)).rejects.toThrow("supervised DAP scope does not match the managed Attempt worktree target")
    expect(dispatched).toBe(false)
  })

  test("projects only fixed built-in REPL selectors", () => {
    expect(projectTrustedReplProfileV1({ language: "python" })).toMatchObject({
      kind: "repl",
      executableSelector: "horizoncode:repl:python3",
      argv: ["-I", "-u", "-i"],
    })
    expect(projectTrustedReplProfileV1({ language: "javascript" })).toMatchObject({
      kind: "repl",
      executableSelector: "horizoncode:repl:node",
      argv: ["--interactive"],
    })
  })

  test("uses the HostKernel approval boundary for REPL profiles", async () => {
    let dispatched = false
    let body: Readonly<Record<string, unknown>> | undefined
    await expect(resolveExecutionLaunchProfileV1({
      definition: {
        schemaVersion: 1,
        profileId: "repl_python",
        revision: "1",
        kind: "repl",
        executableSelector: "horizoncode:repl:python3",
        argv: [],
        workingDirectoryPolicy: "registered_location_root",
        environmentPolicy: "sanitized_host",
      },
      scope: { locationID: "loc_1", sessionID: "ses_1", userActionID: "action_1", callID: "call_1" },
      requestHostKernel: async (_service, _operation, request) => { dispatched = true; body = request; return {} },
    })).rejects.toThrow(/HostKernel did not return a Guard approval challenge/)
    expect(dispatched).toBe(true)
    expect(body?.profileDefinition).toMatchObject({ kind: "repl", executableSelector: "horizoncode:repl:python3" })
  })
})
