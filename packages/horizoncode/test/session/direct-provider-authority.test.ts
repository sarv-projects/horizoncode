import { describe, expect, test } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import { AgentProfileService } from "@horizoncode/core/config"
import { TrustedPrincipalContext } from "@horizoncode/core/trusted-principal"
import {
  SessionSupervisorError,
  type DirectSessionPermissionModeV1,
  type Interface as SessionSupervisorInterface,
} from "@horizoncode/core/session/supervisor"
import { Location } from "@horizoncode/core/location"
import { AbsolutePath } from "@horizoncode/core/schema"
import { WorkspaceV2 } from "@horizoncode/core/workspace"
import { builtinHarnessProfileV1 } from "@horizoncode/core/harness-profile"
import type * as AgentProfileV2 from "@horizoncode/schema/agent-profile-v2"
import { HorizonCodingProfile } from "@horizoncode/core/config/coding-profile"
import { blake3 } from "@noble/hashes/blake3.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import {
  DIRECT_FREE_MODEL_ID,
  DIRECT_FREE_PROVIDER_ID,
  finalizeDirectProviderAuthorityV1,
  resolveDirectProviderAuthorityPinsV1,
  validateDirectProviderAuthorityV1,
  type DirectProviderAuthorityV1,
  type DirectProviderAuthorityPinsV1,
} from "@/session/llm"

/**
 * §15.2 direct-provider authority: pins may only come from the authenticated
 * Core Config profile, the HostKernel permission-mode snapshot and the trusted
 * harness profile. These tests pin the fail-closed behaviour for missing,
 * untrusted and stale projections before any provider route can be pinned.
 */

const sessionID = "ses_0123456789abcdef0123456789abcdef"
const providerID = "opencode"
const modelID = "gpt-5-nano"

const locationRef = Location.Ref.make({
  directory: AbsolutePath.make("/home/sarvesh/business_Dev/agentx"),
  workspaceID: WorkspaceV2.ID.make("wrk_p7_authority_test"),
})

const profile = (overrides: Partial<AgentProfileV2.AgentProfileDefinitionV2> = {}) =>
  ({
    schemaVersion: 2,
    profileId: "user.runner",
    revision: 3,
    name: "Runner",
    description: "Direct authority test profile",
    source: "user",
    roles: ["main"],
    purpose: "Exercise the direct authority seam",
    whenToUse: "In tests",
    whenNotToUse: "Never",
    adapter: { kind: "native", adapterId: "horizon.native" },
    model: { providerId: providerID, modelId: modelID },
    harness: "native-minimal",
    reasoning: "low",
    variants: [],
    instructions: { extraRefs: [], maxCompiledTokens: 4096 },
    tools: [],
    allowedSkillIds: [],
    deniedSkillIds: [],
    allowedMcpServers: [],
    allowedMcpToolPatterns: [],
    allowedSubagentIds: [],
    deniedSubagentIds: [],
    pathRules: [],
    context: { isolation: "fresh", allowImages: false, allowDocuments: false, allowArtifacts: false },
    inputMode: "read_only",
    memoryPolicy: "none",
    isolation: "read_only",
    lifecycleHooks: [],
    capabilityCeiling: [],
    limits: { maxDepth: 1, maxActiveChildren: 1, maxTotalChildren: 1, maxPendingMessages: 1, maxMessageBytes: 4096 },
    maxParallelChildren: 1,
    enabled: true,
    ...overrides,
  }) as AgentProfileV2.AgentProfileDefinitionV2

const mode = (overrides: Partial<DirectSessionPermissionModeV1> = {}): DirectSessionPermissionModeV1 => ({
  schemaVersion: 1,
  sessionId: sessionID,
  ownerEpoch: "1",
  locationId: "loc_test",
  workspaceId: "wrk_p7_authority_test",
  workspaceRootDigest: `blake3:${"a".repeat(64)}`,
  executionBackendId: "horizon.host",
  policyDigest: `sha256:${"c".repeat(64)}`,
  sandboxMode: "read-only",
  approvalPolicy: "on-request",
  source: "default",
  revision: "7",
  digest: `blake3:${"b".repeat(64)}`,
  ...overrides,
})

const supervisorWith = (
  snapshot: SessionSupervisorInterface["directSessionPermissionModeSnapshot"],
): Pick<SessionSupervisorInterface, "directSessionPermissionModeSnapshot"> => ({
  directSessionPermissionModeSnapshot: snapshot,
})

const serverAuth = { principal: { kind: "server_auth" as const, subject: "core-test-user" } }
const hostOs = { principal: { kind: "host_os" as const } }

const withProfiles = (primary: AgentProfileV2.AgentProfileDefinitionV2 | undefined) =>
  Effect.provideService(
    AgentProfileService,
    AgentProfileService.of({
      agentProfiles: () => Effect.die("unused"),
      agentProfileSelectors: () => Effect.die("unused"),
      agentProfile: () => Effect.die("unused"),
      agentProfileSelector: () => Effect.die("unused"),
      primaryAgentProfile: () => Effect.succeed(primary),
    }),
  )

const resolve = (input: {
  readonly principal?: typeof serverAuth | typeof hostOs | undefined
  readonly profiles?: AgentProfileV2.AgentProfileDefinitionV2 | "missing" | "none"
  readonly snapshot?: SessionSupervisorInterface["directSessionPermissionModeSnapshot"]
  readonly model?: { readonly providerID: string; readonly id: string }
}) => {
  const model = input.model ?? { providerID, id: modelID }
  const supervisor = supervisorWith(
    input.snapshot ??
      ((snapshotInput: Parameters<SessionSupervisorInterface["directSessionPermissionModeSnapshot"]>[0]) =>
        Effect.succeed(mode({ sessionId: snapshotInput.sessionID }))),
  )
  const base = resolveDirectProviderAuthorityPinsV1({
    sessionID,
    model,
    locationRef,
    supervisor,
  })
  const withPrincipal =
    input.principal === undefined ? base : base.pipe(Effect.provideService(TrustedPrincipalContext, input.principal))
  if (input.profiles === "missing") return withPrincipal
  const primary = input.profiles === "none" ? undefined : input.profiles ?? profile()
  return withPrincipal.pipe(withProfiles(primary))
}

const failureReason = (exit: Exit.Exit<unknown, unknown>): string => {
  if (!Exit.isFailure(exit)) throw new Error("expected a typed failure")
  const error = Cause.squash(exit.cause)
  if (error instanceof Error) return `${error.message}`
  const reason = (error as { reason?: unknown }).reason
  return typeof reason === "string" ? reason : JSON.stringify(error)
}

const runExit = (effect: Effect.Effect<unknown, unknown, never>) => Effect.runPromise(Effect.exit(effect))

describe("direct provider authority pins (§15.2)", () => {
  test("missing principal fails closed", async () => {
    const exit = await runExit(resolve({ principal: undefined }))
    expect(failureReason(exit)).toContain("authenticated ServerAuth principal")
  })

  test("host-os principal is untrusted and fails closed", async () => {
    const exit = await runExit(resolve({ principal: hostOs }))
    expect(failureReason(exit)).toContain("authenticated ServerAuth principal")
  })

  test("missing AgentProfileV2 service fails closed", async () => {
    const exit = await runExit(resolve({ principal: serverAuth, profiles: "missing" }))
    expect(failureReason(exit)).toContain("AgentProfileV2 service")
  })

  test("absent primary AgentProfileV2 fails closed", async () => {
    const exit = await runExit(resolve({ principal: serverAuth, profiles: "none" }))
    expect(failureReason(exit)).toContain("configured primary AgentProfileV2")
  })

  test("plugin profile source cannot pin a direct turn", async () => {
    const exit = await runExit(
      resolve({ principal: serverAuth, profiles: profile({ source: "plugin" }) }),
    )
    expect(failureReason(exit)).toContain("only Core Config AgentProfileV2 sources")
  })

  test("profile selection must equal the requested provider/model", async () => {
    const exit = await runExit(
      resolve({ principal: serverAuth, profiles: profile({ model: { providerId: "other", modelId: "other" } }) }),
    )
    expect(failureReason(exit)).toContain("not the authenticated AgentProfileV2 selection")
  })

  test("unknown harness profile fails closed", async () => {
    const exit = await runExit(resolve({ principal: serverAuth, profiles: profile({ harness: "not-a-harness" }) }))
    expect(failureReason(exit)).toContain("harness profile is unavailable")
  })

  test("HostKernel snapshot failure fails closed with its stage", async () => {
    const exit = await runExit(
      resolve({
        principal: serverAuth,
        snapshot: () =>
          Effect.fail(
            new SessionSupervisorError({
              stage: "authorization",
              reason: "direct Session permission mode requires authenticated ServerAuth",
            }),
          ),
      }),
    )
    expect(failureReason(exit)).toContain("permission-mode snapshot is unavailable")
  })

  test("snapshot from another Session is rejected", async () => {
    const exit = await runExit(
      resolve({ principal: serverAuth, snapshot: () => Effect.succeed(mode({ sessionId: "ses_other" })) }),
    )
    expect(failureReason(exit)).toContain("different Session")
  })

  test("trusted sources produce the exact §15.2 pin set", async () => {
    const pins = await Effect.runPromise(resolve({ principal: serverAuth }))
    expect(pins.profileID).toBe("user.runner")
    expect(pins.revision).toBe("3")
    expect(pins.profileDigest).toMatch(/^blake3:[0-9a-f]{64}$/)
    expect(pins.trust).toBe("user")
    expect(pins.permissionScopeDigest).toBe(`blake3:${"b".repeat(64)}`)
    expect(pins.policyRevision).toBe("7")
    expect(pins.policyDigest).toBe(`sha256:${"c".repeat(64)}`)
    expect(pins.harnessID).toBe("native-minimal")
    expect(pins.harnessRevision).toBe("1")
  })

  test("builtin profile source projects system trust", async () => {
    const pins = await Effect.runPromise(resolve({ principal: serverAuth, profiles: profile({ source: "builtin" }) }))
    expect(pins.trust).toBe("system")
  })
})

describe("direct provider authority finalization", () => {
  const pins: DirectProviderAuthorityPinsV1 = {
    profileID: "user.runner",
    revision: "3",
    profileDigest: `blake3:${"d".repeat(64)}`,
    trust: "user",
    permissionScopeDigest: `blake3:${"b".repeat(64)}`,
    policyRevision: "7",
    policyDigest: `sha256:${"c".repeat(64)}`,
    harnessID: "native-minimal",
    harnessRevision: "1",
  }
  const route = {
    providerID,
    modelID,
    harnessID: "native-minimal",
    routeRevision: `llm_${"e".repeat(64)}`,
    endpointRevision: `blake3:${"f".repeat(64)}`,
  }
  const expected = { providerID, modelID }

  test("route pins bind to the authenticated projection", () => {
    const authority = finalizeDirectProviderAuthorityV1({ pins, route, expected })
    expect(authority.route.routeRevision).toBe(route.routeRevision)
    expect(authority.route.endpointRevision).toBe(route.endpointRevision)
    expect(authority.profile.profileID).toBe("user.runner")
    expect(builtinHarnessProfileV1(authority.harnessID)?.revision).toBe(1)
  })

  test("caller pins that diverge from the projection are rejected", () => {
    const stale: DirectProviderAuthorityV1 = {
      ...finalizeDirectProviderAuthorityV1({ pins, route, expected }),
      policyRevision: "6",
    }
    expect(() => finalizeDirectProviderAuthorityV1({ pins, route, expected, provided: stale })).toThrow(
      "differ from the authenticated projection",
    )
  })

  test("caller pins with a stale profile revision are rejected", () => {
    const stale = {
      ...finalizeDirectProviderAuthorityV1({ pins, route, expected }),
      profile: {
        profileID: "user.runner",
        revision: "2",
        profileDigest: `blake3:${"d".repeat(64)}`,
        trust: "user" as const,
      },
    }
    expect(() => finalizeDirectProviderAuthorityV1({ pins, route, expected, provided: stale })).toThrow(
      "differ from the authenticated projection",
    )
  })

  test("route harness that differs from the profile harness is rejected", () => {
    expect(() =>
      finalizeDirectProviderAuthorityV1({ pins, route: { ...route, harnessID: "bash-only" }, expected }),
    ).toThrow("route harness differs")
  })

  test("route for a different model is rejected before transport", () => {
    expect(() =>
      finalizeDirectProviderAuthorityV1({ pins, route: { ...route, modelID: "other-model" }, expected }),
    ).toThrow("stale or malformed")
  })

  test("caller pins for another route are rejected", () => {
    const provided = {
      ...finalizeDirectProviderAuthorityV1({ pins, route, expected }),
      route: {
        providerID,
        modelID,
        routeRevision: `llm_${"0".repeat(64)}`,
        endpointRevision: `blake3:${"f".repeat(64)}`,
      },
    }
    expect(() => finalizeDirectProviderAuthorityV1({ pins, route, expected, provided })).toThrow(
      "differ from the authenticated projection",
    )
  })
})


/**
 * The live direct route is OpenRouter, whose model IDs are namespaced
 * (`vendor/model`). This builds the §15.2 pins exactly the way Core Config, the
 * HostKernel permission-mode snapshot and `Provider.getDirectLanguage` project
 * them, then requires the published validator to accept that projection.
 */
describe("direct provider authority producer contract (§15.2)", () => {
  test("pins from the live Horizon Coding profile and its OpenRouter route validate", async () => {
    // The composed default preset is the exact Core Config profile a live
    // `horizoncode serve` Session resolves as its primary AgentProfileV2.
    const liveProfile = HorizonCodingProfile.composeHorizonCodingProfileV1({
      providerId: DIRECT_FREE_PROVIDER_ID,
      modelId: DIRECT_FREE_MODEL_ID,
      model: { toolCall: true, contextWindow: 1_000_000 },
    })
    const pins = await Effect.runPromise(
      resolveDirectProviderAuthorityPinsV1({
        sessionID,
        model: { providerID: DIRECT_FREE_PROVIDER_ID, id: DIRECT_FREE_MODEL_ID },
        locationRef,
        supervisor: supervisorWith(() =>
          // HostKernel only mints blake3 policy digests for this snapshot.
          Effect.succeed(mode({ revision: "9", policyDigest: `blake3:${"c".repeat(64)}` })),
        ),
      }).pipe(Effect.provideService(TrustedPrincipalContext, serverAuth), withProfiles(liveProfile)),
    )
    // Contract channels of the pin set itself: decimal revisions and digests.
    expect(pins.revision).toMatch(/^[1-9][0-9]{0,19}$/)
    expect(pins.policyRevision).toMatch(/^[1-9][0-9]{0,19}$/)
    expect(pins.harnessRevision).toMatch(/^[1-9][0-9]{0,19}$/)
    expect(pins.profileDigest).toMatch(/^blake3:[0-9a-f]{64}$/)
    expect(pins.permissionScopeDigest).toMatch(/^blake3:[0-9a-f]{64}$/)
    expect(pins.policyDigest).toMatch(/^blake3:[0-9a-f]{64}$/)

    // The exact route revision `Provider.getDirectLanguage` projects today.
    const routeMaterial = JSON.stringify([
      "horizoncode.direct-provider-route.v1",
      DIRECT_FREE_PROVIDER_ID,
      DIRECT_FREE_MODEL_ID,
      "@openrouter/ai-sdk-provider",
      DIRECT_FREE_MODEL_ID,
    ])
    const routeRevision = `llm_${bytesToHex(blake3(new TextEncoder().encode(routeMaterial)))}`
    const endpointRevision = `blake3:${bytesToHex(blake3(new TextEncoder().encode(JSON.stringify([
      "horizoncode.direct-provider-endpoint.v1",
      routeMaterial,
      "https://openrouter.ai/api/v1/",
    ]))))}`
    expect(routeRevision).toMatch(/^llm_[a-f0-9]{64}$/)
    expect(endpointRevision).toMatch(/^blake3:[0-9a-f]{64}$/)
    expect(liveProfile.model.modelId).toBe(DIRECT_FREE_MODEL_ID)

    const expected = { providerID: DIRECT_FREE_PROVIDER_ID, modelID: DIRECT_FREE_MODEL_ID }
    const route = {
      providerID: DIRECT_FREE_PROVIDER_ID,
      modelID: DIRECT_FREE_MODEL_ID,
      harnessID: pins.harnessID,
      routeRevision,
      endpointRevision,
    }
    const authority = finalizeDirectProviderAuthorityV1({ pins, route, expected })
    const validated = validateDirectProviderAuthorityV1(authority, expected)
    expect(validated.route.modelID).toBe(DIRECT_FREE_MODEL_ID)
    expect(validated.route.routeRevision).toBe(routeRevision)
    expect(validated.route.endpointRevision).toBe(endpointRevision)
    expect(validated.profile.profileID).toBe("builtin.horizon-coding")
    expect(validated.profile.trust).toBe("system")
    expect(validated.harnessRevision).toBe("1")
  })
})
