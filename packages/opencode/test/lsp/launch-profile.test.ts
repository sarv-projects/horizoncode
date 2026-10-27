import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Location } from "@opencode-ai/schema"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import {
  decodeExecutionLaunchProfileApprovalV1,
  projectGlobalDapConfigProfileV1,
  projectGlobalLspConfigProfileV1,
  projectTrustedGlobalDapProfileV1,
  projectTrustedReplProfileV1,
  resolveExecutionLaunchProfileV1,
  resolveTrustedGlobalLaunchProfileV1,
  validateExecutionLaunchProfileDefinitionV1,
  type ExecutionLaunchProfileDefinitionV1,
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

const digest = (digit: string) => `blake3:${digit.repeat(64)}`

const DEFINITION: ExecutionLaunchProfileDefinitionV1 = {
  schemaVersion: 1,
  profileId: "lsp_typescript_test",
  revision: "1",
  kind: "lsp",
  executableSelector: "horizoncode:lsp:typescript-language-server",
  argv: ["--stdio"],
  workingDirectoryPolicy: "registered_location_root",
  environmentPolicy: "sanitized_host",
}

const SCOPE = { locationID: "loc_1", sessionID: "ses_1", userActionID: "action_1", callID: "call_1" }

const challenge = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  status: "needs_approval",
  challengeID: "challenge_1",
  effectID: "effect_1",
  capabilityID: "language.start",
  locationID: "loc_1",
  sessionID: "ses_1",
  profileRef: {
    profileId: DEFINITION.profileId,
    revision: DEFINITION.revision,
    profileDigest: digest("a"),
  },
  inputDigest: digest("b"),
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
  policyDigest: digest("c"),
  policyID: "editor.launch",
  requestedGuarantees: ["process_supervision"],
  source: "authenticated.user_action",
  ...over,
})

describe("launch profile definition validation", () => {
  test("admits and freezes one exact trusted definition", () => {
    const result = validateExecutionLaunchProfileDefinitionV1(DEFINITION)
    expect(result).toEqual(DEFINITION)
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.argv)).toBe(true)
  })

  test("rejects unknown, missing and wrong-version definition fields", () => {
    expect(() => validateExecutionLaunchProfileDefinitionV1({ ...DEFINITION, extra: 1 })).toThrow(
      "unknown or missing fields",
    )
    const { argv: _argv, ...withoutArgv } = DEFINITION
    expect(() => validateExecutionLaunchProfileDefinitionV1(withoutArgv)).toThrow("unknown or missing fields")
    expect(() => validateExecutionLaunchProfileDefinitionV1({ ...DEFINITION, schemaVersion: 2 })).toThrow(
      "unsupported launch profile schema version",
    )
    expect(() => validateExecutionLaunchProfileDefinitionV1(null)).toThrow("unknown or missing fields")
    expect(() => validateExecutionLaunchProfileDefinitionV1([DEFINITION])).toThrow("unknown or missing fields")
  })

  test("rejects profile IDs and revisions outside their canonical bounds", () => {
    for (const profileId of ["", "with space", "a".repeat(129), "sla/sh"]) {
      expect(() => validateExecutionLaunchProfileDefinitionV1({ ...DEFINITION, profileId }), profileId).toThrow(
        "launch profile ID is invalid",
      )
    }
    for (const revision of ["0", "01", "1.0", "99999999999999999999"]) {
      expect(() => validateExecutionLaunchProfileDefinitionV1({ ...DEFINITION, revision }), revision).toThrow(
        "launch profile revision must be a positive canonical u64 decimal string",
      )
    }
  })

  test("rejects a kind outside the fixed process kinds", () => {
    expect(() => validateExecutionLaunchProfileDefinitionV1({ ...DEFINITION, kind: "editor" })).toThrow(
      "launch profile kind is invalid",
    )
  })

  test("rejects an executable selector that is not approved for the profile kind", () => {
    for (const [kind, executableSelector] of [
      ["lsp", "horizoncode:repl:python3"],
      ["lsp", "/usr/bin/rust-analyzer"],
      ["dap", "horizoncode:lsp:typescript-language-server"],
      ["repl", "horizoncode:dap:debugpy-adapter"],
    ] as const) {
      expect(
        () => validateExecutionLaunchProfileDefinitionV1({ ...DEFINITION, kind, executableSelector }),
        `${kind}/${executableSelector}`,
      ).toThrow("launch profile executable selector is not approved for its process kind")
    }
    expect(() => validateExecutionLaunchProfileDefinitionV1({
      ...DEFINITION,
      executableSelector: "horizoncode:lsp:typescript-language-server\u0000",
    })).toThrow("launch profile executable selector is invalid")
    expect(() => validateExecutionLaunchProfileDefinitionV1({
      ...DEFINITION,
      executableSelector: "a".repeat(4097),
    })).toThrow("launch profile executable selector is invalid")
  })

  test("rejects interpolation, control characters and oversized argv vectors", () => {
    for (const arg of ["${HOME}", "{{cmd}}", "%PATH%", "line\nbreak", "nul\u0000byte"]) {
      expect(() => validateExecutionLaunchProfileDefinitionV1({ ...DEFINITION, argv: [arg] }), arg).toThrow(
        "launch profile argv[0] is invalid",
      )
    }
    expect(() => validateExecutionLaunchProfileDefinitionV1({
      ...DEFINITION,
      argv: ["--stdio", 42 as never],
    })).toThrow("launch profile argv[1] is invalid")
    expect(() => validateExecutionLaunchProfileDefinitionV1({
      ...DEFINITION,
      argv: ["a".repeat(4097)],
    })).toThrow("launch profile argv[0] is invalid")
    expect(() => validateExecutionLaunchProfileDefinitionV1({
      ...DEFINITION,
      argv: "--stdio" as never,
    })).toThrow("launch profile argv exceeds its bound")
    expect(() => validateExecutionLaunchProfileDefinitionV1({
      ...DEFINITION,
      argv: Array.from({ length: 129 }, () => "--flag"),
    })).toThrow("launch profile argv exceeds its bound")
    expect(() => validateExecutionLaunchProfileDefinitionV1({
      ...DEFINITION,
      argv: Array.from({ length: 20 }, () => "x".repeat(4096)),
    })).toThrow("launch profile argv exceeds its total byte bound")
  })

  test("rejects process policies outside the fixed HostKernel contract", () => {
    expect(() => validateExecutionLaunchProfileDefinitionV1({
      ...DEFINITION,
      workingDirectoryPolicy: "argv_cwd",
    })).toThrow("launch profile process policies are not supported")
    expect(() => validateExecutionLaunchProfileDefinitionV1({
      ...DEFINITION,
      environmentPolicy: "inherit_host",
    })).toThrow("launch profile process policies are not supported")
  })

  test("accepts a DAP policy only on a DAP profile with an exact boolean", () => {
    expect(validateExecutionLaunchProfileDefinitionV1({
      ...DEFINITION,
      kind: "dap",
      executableSelector: "horizoncode:dap:debugpy-adapter",
      dapPolicy: { allowEvaluate: true },
    }).dapPolicy).toEqual({ allowEvaluate: true })

    expect(() => validateExecutionLaunchProfileDefinitionV1({
      ...DEFINITION,
      dapPolicy: { allowEvaluate: true },
    })).toThrow("launch profile DAP policy is invalid or attached to a non-DAP profile")
    expect(() => validateExecutionLaunchProfileDefinitionV1({
      ...DEFINITION,
      kind: "dap",
      executableSelector: "horizoncode:dap:debugpy-adapter",
      dapPolicy: { allowEvaluate: "yes" },
    })).toThrow("launch profile DAP policy is invalid or attached to a non-DAP profile")
    expect(() => validateExecutionLaunchProfileDefinitionV1({
      ...DEFINITION,
      kind: "dap",
      executableSelector: "horizoncode:dap:debugpy-adapter",
      dapPolicy: { allowEvaluate: true, always: false },
    })).toThrow("launch profile DAP policy is invalid or attached to a non-DAP profile")
  })
})

describe("launch profile approval consent projection", () => {
  const decode = (response: unknown) => decodeExecutionLaunchProfileApprovalV1({
    response,
    definition: DEFINITION,
    scope: SCOPE,
  })

  test("admits an exact HostKernel consent projection", async () => {
    const approval = await decode(challenge())
    expect(approval).toMatchObject({
      status: "needs_approval",
      capabilityID: "language.start",
      locationID: "loc_1",
      sessionID: "ses_1",
    })
    expect(approval.profileRef.profileId).toBe(DEFINITION.profileId)
    expect(Object.isFrozen(approval)).toBe(true)
    expect(Object.isFrozen(approval.approval)).toBe(true)
    expect(approval.approval).toMatchObject({
      origin: "user_action",
      source: "authenticated.user_action",
      noResponse: "deny_and_expire",
      normalizedAction: "language.start",
      allowEnabled: true,
    })
  })

  test("rejects a response that is not a needs_approval challenge", async () => {
    await expect(decode(challenge({ status: "auto_approved" }))).rejects.toThrow(
      "HostKernel did not return a Guard approval challenge",
    )
    await expect(decode({ ...challenge(), smuggledField: 1 })).rejects.toThrow(
      "HostKernel did not return a Guard approval challenge",
    )
    await expect(decode(undefined)).rejects.toThrow("HostKernel did not return a Guard approval challenge")
  })

  test("rejects a capability that does not match the profile kind", async () => {
    await expect(decode(challenge({ capabilityID: "debug.start" }))).rejects.toThrow(
      "HostKernel launch approval capability does not match the profile kind",
    )
    await expect(decode(challenge({ normalizedAction: "debug.start" }))).rejects.toThrow(
      "HostKernel launch approval consent projection is invalid",
    )
  })

  test("rejects a challenge bound to another Location or Session", async () => {
    await expect(decode(challenge({ locationID: "loc_2" }))).rejects.toThrow(
      "HostKernel launch approval is bound to a different Location or Session",
    )
    await expect(decode(challenge({ sessionID: "ses_2" }))).rejects.toThrow(
      "HostKernel launch approval is bound to a different Location or Session",
    )
  })

  test("rejects a profile reference that differs from the projected Core Config profile", async () => {
    await expect(decode(challenge({
      profileRef: { profileId: "lsp_other", revision: "1", profileDigest: digest("a") },
    }))).rejects.toThrow("HostKernel launch profile reference differs from the projected Core Config revision")
    await expect(decode(challenge({
      profileRef: { profileId: DEFINITION.profileId, revision: "2", profileDigest: digest("a") },
    }))).rejects.toThrow("HostKernel launch profile reference differs from the projected Core Config revision")
    await expect(decode(challenge({
      profileRef: { profileId: DEFINITION.profileId, revision: "1", profileDigest: "sha256:x" },
    }))).rejects.toThrow("launch profile digest must be a BLAKE3 digest")
  })

  test("rejects expired, distant or non-canonical expiry and digest fields", async () => {
    for (const [label, over] of [
      ["already expired", { expiresAtUnixMs: Date.now() - 1 }],
      ["too distant", { expiresAtUnixMs: Date.now() + 6 * 60 * 1000 }],
      ["unsafe integer", { expiresAtUnixMs: 2 ** 53 }],
      ["non-canonical input digest", { inputDigest: "sha256:" + "b".repeat(64) }],
      ["non-canonical policy digest", { policyDigest: "blake3:" + "B".repeat(64) }],
      ["foreign policy ID", { policyID: "Editor.Launch" }],
    ] as const) {
      await expect(decode(challenge(over)), label).rejects.toThrow(
        "HostKernel launch approval consent projection is invalid",
      )
    }
  })

  test("rejects target, origin and summary fields that do not match the request", async () => {
    const sparseTargets = new Array(1)
    for (const [label, over] of [
      ["no targets", { normalizedTargets: [], targets: [] }],
      ["target disagreement", { targets: [{ kind: "home_directory" }] }],
      ["sparse target projections", { normalizedTargets: sparseTargets, targets: sparseTargets }],
      ["sparse requested guarantees", { requestedGuarantees: new Array(1) }],
      ["oversized targets", {
        normalizedTargets: [{ kind: "registered_location_root", pad: "x".repeat(64 * 1024) }],
        targets: [{ kind: "registered_location_root", pad: "x".repeat(64 * 1024) }],
      }],
      ["foreign origin", { origin: "automatic" }],
      ["foreign source", { source: "anonymous.user_action" }],
      ["permissive no-response", { noResponse: "auto_allow" }],
      ["empty policy summary", { policySummary: "   " }],
      ["no requested guarantees", { requestedGuarantees: [] }],
      ["duplicate guarantees", { requestedGuarantees: ["process_supervision", "process_supervision"] }],
      ["malformed guarantee id", { requestedGuarantees: ["Process Supervision"] }],
      ["non-boolean allow", { allowEnabled: "true" }],
      ["unstructured summary", { argumentSummary: "start it" }],
    ] as const) {
      await expect(decode(challenge(over)), label).rejects.toThrow(
        "HostKernel launch approval consent projection is invalid",
      )
    }
  })

  test("detaches HostKernel target objects from the returned approval", async () => {
    const targets = [{ kind: "registered_location_root" }]
    const result = await decode(challenge({ normalizedTargets: targets, targets }))

    targets[0]!.kind = "attacker_mutated"

    expect(result.approval.normalizedTargets[0]).toEqual({ kind: "registered_location_root" })
    expect(Object.isFrozen(result.approval.normalizedTargets[0])).toBe(true)
  })

  test("rejects an allow flag inconsistent with its own assessment", async () => {
    await expect(decode(challenge({
      allowEnabled: true,
      argumentSummary: { status: "unavailable", reason: "profile disabled" },
      guaranteeAssessment: { status: "assessed", residual: [] },
    }))).rejects.toThrow("HostKernel launch approval assessment is incomplete or inconsistent")

    await expect(decode(challenge({
      allowEnabled: true,
      argumentSummary: { status: "available", text: "Start TypeScript language server" },
      guaranteeAssessment: { status: "not_assessed", residual: null },
    }))).rejects.toThrow("HostKernel launch approval assessment is incomplete or inconsistent")

    await expect(decode(challenge({
      guaranteeAssessment: { status: "assessed", residual: ["unknown_guarantee"] },
    }))).rejects.toThrow("HostKernel launch approval assessment is incomplete or inconsistent")

    await expect(decode(challenge({
      guaranteeAssessment: { status: "assessed", residual: new Array(1) },
    }))).rejects.toThrow("HostKernel launch approval assessment is incomplete or inconsistent")

    // The same unavailable summary is admitted when it consistently denies.
    const denied = await decode(challenge({
      allowEnabled: false,
      argumentSummary: { status: "unavailable", reason: "profile disabled" },
      guaranteeAssessment: { status: "assessed", residual: [] },
    }))
    expect(denied.approval.allowEnabled).toBe(false)
  })
})
