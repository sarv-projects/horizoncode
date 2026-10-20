import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { Schema } from "effect"
import * as Composition from "../src/composition-v1"
import * as AgentProfile from "../src/agent-profile-v2"

const digest = Schema.decodeUnknownSync(Composition.Digest)(
  "blake3:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
)
const artifact = { artifactId: "instructions", digest, byteLength: "0", mediaType: "text/plain", classification: "workspace" } as const

const profile = {
  schemaVersion: 2,
  profileId: "specialist.reader",
  revision: 1,
  name: "Reader",
  description: "Read-only specialist",
  source: "user",
  roles: ["subagent"],
  purpose: "Inspect code",
  whenToUse: "When exploring",
  whenNotToUse: "When editing",
  adapter: { kind: "native", adapterId: "horizon.native" },
  model: { providerId: "local", modelId: "small", reasoningEffort: "low" },
  harness: "native-minimal",
  reasoning: "low",
  variants: [],
  instructions: { extraRefs: [artifact], maxCompiledTokens: 4096 },
  tools: [{ effect: "allow", toolPattern: "files.read" }, { effect: "deny", toolPattern: "files.write" }],
  allowedSkillIds: [],
  deniedSkillIds: [],
  allowedMcpServers: [],
  allowedMcpToolPatterns: [],
  allowedSubagentIds: [],
  deniedSubagentIds: [],
  pathRules: [{ effect: "allow", operation: "read", glob: "src/**" }],
  context: { isolation: "fresh", allowImages: false, allowDocuments: false, allowArtifacts: true },
  inputMode: "read_only",
  memoryPolicy: "none",
  isolation: "read_only",
  lifecycleHooks: [],
  capabilityCeiling: [],
  permissionCeilingDigest: digest,
  limits: { maxDepth: 1, maxActiveChildren: 1, maxTotalChildren: 2, maxPendingMessages: 4, maxMessageBytes: 4096, tokenBudget: 8192, wallTimeMs: 60000 },
  maxParallelChildren: 1,
  enabled: true,
  definitionDigest: digest,
} as const

const rules = (allow: string[], deny: string[] = []) => ({
  tools: [
    ...allow.map((toolPattern) => ({ effect: "allow" as const, toolPattern })),
    ...deny.map((toolPattern) => ({ effect: "deny" as const, toolPattern })),
  ],
  paths: [],
  skills: [],
  mcpServers: [],
  mcpToolPatterns: [],
  subagentIds: [],
})

describe("AgentProfileV2 schema and safe resolution", () => {
  test("decodes and encodes a valid immutable profile", () => {
    const decoded = Schema.decodeUnknownSync(AgentProfile.AgentProfileV2)(profile as unknown)
    expect(Schema.encodeSync(AgentProfile.AgentProfileV2)(decoded)).toEqual(profile)
  })

  test("Core definition omits Rust-minted digests and rejects caller-supplied digest fields", () => {
    const definition = Object.fromEntries(
      Object.entries(profile).filter(([key]) => key !== "definitionDigest" && key !== "permissionCeilingDigest"),
    )
    const decoded = Schema.decodeUnknownSync(AgentProfile.AgentProfileDefinitionV2)(definition as unknown)
    expect(decoded.profileId).toBe("specialist.reader")
    const callerWithDigest = Schema.decodeUnknownSync(AgentProfile.AgentProfileDefinitionV2)(profile as unknown)
    expect(callerWithDigest).not.toHaveProperty("definitionDigest")
    expect(callerWithDigest).not.toHaveProperty("permissionCeilingDigest")
    expect(() => Schema.decodeUnknownSync(AgentProfile.AgentProfileDefinitionV2)(profile as unknown, { onExcessProperty: "error" })).toThrow()
  })

  test("shares the exact digest-free profile bytes fixture with Rust", () => {
    const fixture = JSON.parse(readFileSync(new URL("../../../kernel/tests/fixtures/agent-profile-definition-v2.json", import.meta.url), "utf8"))
    const definition = Schema.decodeUnknownSync(AgentProfile.AgentProfileDefinitionV2)(fixture.definition)
    expect(Schema.encodeSync(AgentProfile.AgentProfileDefinitionV2)(definition)).toEqual(fixture.definition)
    expect(definition.capabilityCeiling).toEqual(["files.read"])
    expect(fixture.definition).not.toHaveProperty("definitionDigest")
    expect(fixture.definition).not.toHaveProperty("permissionCeilingDigest")
  })

  test("publishes the definition and Rust-resolved projections in one strict JSON contract", () => {
    const contract = AgentProfile.jsonSchemaDocument()
    const published = JSON.parse(readFileSync(new URL("../../../arch_V1/contracts-v2/agent-profile-v2.schema.json", import.meta.url), "utf8"))
    expect(published).toEqual(contract)
    expect(contract.$ref).toBe("#/$defs/AgentProfileDefinitionV2")
    const definition = contract.$defs.AgentProfileDefinitionV2 as { properties: Record<string, unknown>; additionalProperties: boolean }
    expect(definition.additionalProperties).toBe(false)
    expect(definition.properties).not.toHaveProperty("definitionDigest")
    expect(definition.properties).not.toHaveProperty("permissionCeilingDigest")
    expect(Object.keys(definition.properties).sort()).toEqual([
      "adapter", "allowedMcpServers", "allowedMcpToolPatterns", "allowedSkillIds", "allowedSubagentIds",
      "capabilityCeiling", "context", "deniedSkillIds", "deniedSubagentIds", "description", "enabled",
      "harness", "inputMode", "instructions", "isolation", "lifecycleHooks", "limits", "maxParallelChildren",
      "memoryPolicy", "model", "name", "pathRules", "profileId", "purpose", "reasoning", "revision", "roles",
      "schemaVersion", "source", "tools", "variants", "whenNotToUse", "whenToUse",
    ].sort())
    const resolved = contract.$defs.AgentProfileV2 as { properties: Record<string, unknown> }
    expect(resolved.properties).toHaveProperty("definitionDigest")
    expect(resolved.properties).toHaveProperty("permissionCeilingDigest")
    expect(contract.$defs.ProfileRevisionRef).toBeDefined()
  })

  test("rejects malformed IDs, revisions, limits, and digests", () => {
    const decode = Schema.decodeUnknownSync(AgentProfile.AgentProfileV2)
    expect(() => decode({ ...profile, profileId: "bad id" } as unknown)).toThrow()
    expect(() => decode({ ...profile, adapter: { kind: "unknown", adapterId: "adapter.unknown" } } as unknown)).toThrow()
    expect(() => decode({ ...profile, revision: 0 } as unknown)).toThrow()
    expect(() => decode({ ...profile, maxParallelChildren: -1 } as unknown)).toThrow()
    expect(() => decode({ ...profile, limits: { ...profile.limits, tokenBudget: 0 } } as unknown)).toThrow()
    expect(() => decode({ ...profile, definitionDigest: "sha256:bad" } as unknown)).toThrow()
    expect(() => decode({ ...profile, capabilityCeiling: ["files.read", "files.patch"] } as unknown)).toThrow()
    expect(() => decode({ ...profile, capabilityCeiling: ["files.patch", "files.patch"] } as unknown)).toThrow()
    expect(() => Schema.decodeUnknownSync(Composition.Digest)("sha256:bad")).toThrow()
  })

  test("resolves only the pinned revision and exact provider, model, harness, and supported wire", () => {
    const decoded = Schema.decodeUnknownSync(AgentProfile.AgentProfileV2)(profile as unknown)
    const selected = { providerId: "local", modelId: "small", harness: "native-minimal", wireApi: "chat_completions" as const }
    const expected = { profileId: decoded.profileId, revision: decoded.revision, definitionDigest: digest }
    const options = {
      profile: decoded,
      trustedRevision: expected,
      selected,
      supportedWireApis: ["chat_completions"] as const,
      supportedAdapters: [{ kind: "native" as const, adapterId: "horizon.native" }],
      sandboxEnforced: false,
    }
    const resolved = AgentProfile.resolveProfile(options)
    expect(resolved.status).toBe("available")
    if (resolved.status === "available") expect(resolved.selection).toEqual(selected)
    expect(AgentProfile.resolveProfile({ ...options, trustedRevision: { ...expected, revision: Schema.decodeUnknownSync(AgentProfile.Revision)(2) } })).toMatchObject({ status: "unavailable", reason: "revision_mismatch" })
    expect(AgentProfile.resolveProfile({ ...options, selected: { ...selected, modelId: "other" } })).toMatchObject({ status: "unavailable", reason: "selection_mismatch" })
    expect(AgentProfile.resolveProfile({ ...options, selected: { ...selected, wireApi: "responses" } })).toMatchObject({ status: "unavailable", reason: "wire_unsupported" })
    const alteredDigest = Schema.decodeUnknownSync(Composition.Digest)(`blake3:${"a".repeat(64)}`)
    expect(AgentProfile.resolveProfile({ ...options, trustedRevision: { ...expected, definitionDigest: alteredDigest } })).toMatchObject({ status: "unavailable", reason: "digest_mismatch" })
    const unsupportedAdapter = Schema.decodeUnknownSync(AgentProfile.AgentProfileV2)({
      ...profile,
      adapter: { kind: "acp", adapterId: "external.acp" },
    } as unknown)
    expect(AgentProfile.resolveProfile({ ...options, profile: unsupportedAdapter })).toMatchObject({ status: "unavailable", reason: "adapter_unavailable" })
    expect(AgentProfile.resolveProfile({ ...options, supportedAdapters: [{ kind: "native", adapterId: "another.native" }] })).toMatchObject({ status: "unavailable", reason: "adapter_unavailable" })
  })

  test("sandbox_auto is unavailable unless the runtime enforces a sandbox", () => {
    const decoded = Schema.decodeUnknownSync(AgentProfile.AgentProfileV2)({ ...profile, inputMode: "sandbox_auto" } as unknown)
    const trustedRevision = { profileId: decoded.profileId, revision: decoded.revision, definitionDigest: digest }
    expect(AgentProfile.resolveProfile({ profile: decoded, trustedRevision, selected: { providerId: "local", modelId: "small", harness: "native-minimal", wireApi: "chat_completions" }, supportedWireApis: ["chat_completions"], supportedAdapters: [{ kind: "native", adapterId: "horizon.native" }], sandboxEnforced: false })).toMatchObject({ status: "unavailable", reason: "sandbox_unavailable" })
  })

  test("authority candidates stay non-authoritative and are narrowed across profile families", () => {
    const decoded = Schema.decodeUnknownSync(AgentProfile.AgentProfileV2)(profile as unknown)
    const parent = rules(["files.read", "files.write"])
    const current = rules(["files.read", "files.write"])
    const result = AgentProfile.deriveAuthorityCandidates(decoded, parent, current)
    expect(result.status).toBe("candidate_exposure")
    expect(result.toolCandidates).toMatchObject([{ toolPattern: "files.read" }])
    expect(result.toolCandidates[0]).not.toHaveProperty("effect")

    const broaderProfile = Schema.decodeUnknownSync(AgentProfile.AgentProfileV2)({
      ...profile,
      tools: [{ effect: "allow", toolPattern: "files.read" }, { effect: "allow", toolPattern: "files.write" }],
    } as unknown)
    expect(AgentProfile.deriveAuthorityCandidates(broaderProfile, parent, rules(["files.read"])).toolCandidates).toMatchObject([
      { toolPattern: "files.read" },
    ])
    const broadDenyPolicy = {
      ...rules(["files.read"]),
      tools: [
        { effect: "allow" as const, toolPattern: "files.read" },
        { effect: "deny" as const, toolPattern: "files.*" },
      ],
    }
    const overlappingDeny = AgentProfile.deriveAuthorityCandidates(decoded, parent, broadDenyPolicy)
    expect(overlappingDeny.status).toBe("candidate_exposure")
    expect(overlappingDeny.toolCandidates).toMatchObject([{ toolPattern: "files.read" }])
    expect(overlappingDeny.toolCandidates[0]).not.toHaveProperty("effect", "allow")

    const pathParent = { ...parent, paths: [{ effect: "allow" as const, operation: "read" as const, glob: "src/**" }, { effect: "allow" as const, operation: "write" as const, glob: "src/**" }] }
    const pathPolicy = { ...pathParent }
    expect(AgentProfile.deriveAuthorityCandidates(decoded, pathParent, pathPolicy).pathCandidates).toMatchObject([
      { operation: "read", glob: "src/**" },
    ])
    const broadPathDeny = {
      ...pathParent,
      paths: [
        ...pathParent.paths,
        { effect: "deny" as const, operation: "read" as const, glob: "src/**/private/**" },
      ],
    }
    expect(AgentProfile.deriveAuthorityCandidates(decoded, pathParent, broadPathDeny).status).toBe("candidate_exposure")
    const overlappingPathDeny = AgentProfile.deriveAuthorityCandidates(decoded, pathParent, broadPathDeny)
    expect(overlappingPathDeny.pathCandidates).toMatchObject([{ operation: "read", glob: "src/**" }])
    expect(overlappingPathDeny.pathCandidates[0]).not.toHaveProperty("effect", "allow")

    const constrainedProfile = Schema.decodeUnknownSync(AgentProfile.AgentProfileV2)({
      ...profile,
      allowedSkillIds: ["skill.read", "skill.denied"],
      deniedSkillIds: ["skill.denied"],
      allowedMcpServers: ["mcp.allowed", "mcp.denied"],
      allowedMcpToolPatterns: ["mcp.read", "mcp.denied"],
      allowedSubagentIds: ["child.allowed", "child.denied"],
      deniedSubagentIds: ["child.denied"],
    } as unknown)
    const inherited = {
      ...parent,
      skills: ["skill.read", "skill.denied"],
      mcpServers: ["mcp.allowed", "mcp.denied"],
      mcpToolPatterns: ["mcp.read", "mcp.denied"],
      subagentIds: ["child.allowed", "child.denied"],
    }
    const currentPolicy = {
      ...inherited,
      mcpServers: ["mcp.allowed"],
      mcpToolPatterns: ["mcp.read"],
    }
    const candidates = AgentProfile.deriveAuthorityCandidates(constrainedProfile, inherited, currentPolicy)
    expect(candidates.skillCandidates).toEqual(["skill.read"])
    expect(candidates.mcpServerCandidates).toEqual(["mcp.allowed"])
    expect(candidates.mcpToolPatternCandidates).toEqual(["mcp.read"])
    expect(candidates.subagentCandidates).toEqual(["child.allowed"])
  })
})
