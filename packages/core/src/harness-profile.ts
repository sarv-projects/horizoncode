/** Core-owned built-in HarnessProfileV1 catalog. Selection never changes routing. */

import { blake3 } from "@noble/hashes/blake3.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import { Schema } from "effect"
import * as HarnessProfileSchema from "@opencode-ai/schema/harness-profile-v1"

const definitions = {
  "native-rich": {
    harnessId: "native-rich",
    displayName: "Native rich",
    toolProjection: "native_rich",
    notes: "Expose the complete currently authorized native toolset.",
  },
  "native-minimal": {
    harnessId: "native-minimal",
    displayName: "Native minimal",
    toolProjection: "minimal",
    notes: "Start with compact read/context tools and discover additional authorized tools on demand.",
  },
  "bash-only": {
    harnessId: "bash-only",
    displayName: "Bash only",
    toolProjection: "bash_only",
    notes: "Start with guarded terminal plus bounded read tools; discovery never broadens authority.",
  },
} as const

const systemPrompts: Readonly<Record<keyof typeof definitions, string>> = {
  "native-rich": "Use HorizonCode's exposed tools to inspect and change the active workspace. Keep each tool action within its advertised inputs and authority.",
  "native-minimal": "Use the compact tools first. Call tools_search to discover additional authorized tools when needed; discovered tools become available at the next provider request. Discovery does not grant permission.",
  "bash-only": "Use the exposed read tools and guarded terminal tool. Do not assume unavailable tools or alternate execution paths exist.",
}

function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value)
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (typeof value === "object") {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).toSorted().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`
  }
  throw new TypeError("HarnessProfileV1 contains a non-canonical value")
}

function hash(domain: string, value: string) {
  return `blake3:${bytesToHex(blake3(new TextEncoder().encode(`${domain}\0${value}`)))}`
}

function systemPromptRef(id: string) {
  const prompt = systemPrompts[id as keyof typeof definitions]
  return {
    artifactId: `builtin.harness.${id}.system.v1`,
    digest: `blake3:${bytesToHex(blake3(new TextEncoder().encode(prompt)))}`,
    byteLength: String(Buffer.byteLength(prompt, "utf8")),
    mediaType: "text.plain",
    classification: "public" as const,
  }
}

/** Resolve an opaque built-in prompt ArtifactRef to its retained immutable payload. */
export function builtinHarnessSystemPromptV1(id: string): string | undefined {
  return Object.hasOwn(systemPrompts, id) ? systemPrompts[id as keyof typeof definitions] : undefined
}

export function builtinHarnessProfileV1(id: string): HarnessProfileSchema.HarnessProfileV1 | undefined {
  if (!Object.hasOwn(definitions, id)) return undefined
  const definition = definitions[id as keyof typeof definitions]
  const body = {
    ...definition,
    revision: 1,
    source: "builtin" as const,
    supportedWireApis: ["responses", "chat_completions", "anthropic_messages", "custom"] as const,
    systemPromptRef: systemPromptRef(id),
    messageCodecId: "native.messages.v1",
    responseCodecId: "native.response.v1",
    structuredCallPolicyId: "strict.structured-call.v1",
    contextPolicyId: "bounded.context.v1",
    outputPolicyId: "bounded.output.v1",
    capabilityRequirements: [] as string[],
  }
  const digest = hash("horizon.harness-profile.v1", canonical(body))
  return Schema.decodeUnknownSync(HarnessProfileSchema.HarnessProfileV1, { onExcessProperty: "error" })({
    ...body,
    definitionDigest: digest,
  })
}

export function builtinHarnessProfileIDsV1(): readonly HarnessProfileSchema.BuiltinHarnessIdV1[] {
  return Object.keys(definitions) as HarnessProfileSchema.BuiltinHarnessIdV1[]
}

export function projectHarnessToolIDsV1(
  profile: HarnessProfileSchema.HarnessProfileV1,
  availableCapabilityIDs: readonly string[],
): { readonly starter: readonly string[]; readonly deferred: readonly string[] } {
  const available = [...new Set(availableCapabilityIDs)].toSorted()
  const starterCapabilities = profile.harnessId === "native-minimal"
    ? new Set(["files.read", "text.search", "glob.search", "tools.search", "question.ask", "symbols.search", "definitions.find", "references.find"])
    : profile.harnessId === "bash-only"
      ? new Set(["terminal.run", "files.read", "text.search", "glob.search"])
      : new Set(available)
  const starter = available.filter((id) => starterCapabilities.has(id))
  const deferred = profile.harnessId === "native-minimal"
    ? available.filter((id) => !starterCapabilities.has(id))
    : []
  return { starter, deferred }
}
