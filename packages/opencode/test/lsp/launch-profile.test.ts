import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
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

    await expect(createSupervisedLspClientV1({
      requestHostKernel,
    } as never)).rejects.toMatchObject({ _tag: "LanguageServiceProcessError" })
    await expect(createSupervisedDapClientV1({
      requestHostKernel,
    } as never)).rejects.toMatchObject({ _tag: "LanguageServiceProcessError" })
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
          locationID: "loc_1",
          sessionID: "ses_1",
          workspaceRevision: `blake3:${"b".repeat(64)}`,
          effectiveMaxTokens: "100000",
          remainingTokens: "100000",
          delegationBindingDigest: `blake3:${"c".repeat(64)}`,
        },
      },
      requestHostKernel: async () => { dispatched = true; return {} },
    })).rejects.toThrow(/authenticated Session\/Location/)
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
