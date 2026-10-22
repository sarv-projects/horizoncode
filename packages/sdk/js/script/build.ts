#!/usr/bin/env bun
import { fileURLToPath } from "url"

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)

import { $ } from "bun"
import path from "path"

import { createClient } from "@hey-api/openapi-ts"

const opencode = path.resolve(dir, "../../opencode")

await $`bun dev generate > ${dir}/openapi.json`.cwd(opencode)

const document = (await Bun.file("./openapi.json").json()) as {
  components?: { schemas?: Record<string, unknown> }
  [key: string]: unknown
}
const schemas = document.components?.schemas
if (schemas) {
  // HorizonCode's durable assistant usage provenance is an additive V2
  // projection over the OpenCode-derived AssistantMessage contract. Keep this
  // exact with packages/schema/src/session-message.ts: unknown is represented
  // by status alone, and measured cost requires billing evidence.
  const nonNegativeNumber = { type: "number", minimum: 0 }
  const nonNegativeInteger = { type: "integer", minimum: 0 }
  const strictObject = (properties: Record<string, unknown>, required: string[]) => ({
    type: "object",
    properties,
    required,
    additionalProperties: false,
  })
  const usageMetric = {
    oneOf: [
      ...["provider-reported", "measured", "estimated"].map((status) =>
        strictObject({ status: { const: status }, value: nonNegativeInteger }, ["status", "value"]),
      ),
      strictObject({ status: { const: "unknown" } }, ["status"]),
    ],
  }
  schemas.UsageProvenanceMetricV1 = usageMetric
  schemas.UsageProvenanceCostV1 = {
    oneOf: [
      strictObject({ status: { const: "provider-reported" }, value: nonNegativeNumber }, ["status", "value"]),
      strictObject({
        status: { const: "measured" },
        value: nonNegativeNumber,
        measurementSource: { const: "provider-billing-receipt-v1" },
        evidenceRef: { type: "string", minLength: 1, maxLength: 512 },
      }, ["status", "value", "measurementSource", "evidenceRef"]),
      strictObject({
        status: { const: "estimated" },
        value: nonNegativeNumber,
        priceSource: { type: "string" },
        pricingRevision: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
        pricing: strictObject({
          input: nonNegativeNumber,
          output: nonNegativeNumber,
          cacheRead: nonNegativeNumber,
          cacheWrite: nonNegativeNumber,
        }, ["input", "output", "cacheRead", "cacheWrite"]),
        algorithm: { const: "per-million-linear-v1" },
        tokenInputs: strictObject({
          input: nonNegativeInteger,
          output: nonNegativeInteger,
          reasoning: nonNegativeInteger,
          cacheRead: nonNegativeInteger,
          cacheWrite: nonNegativeInteger,
        }, ["input", "output", "reasoning", "cacheRead", "cacheWrite"]),
      }, ["status", "value", "priceSource", "pricingRevision", "pricing", "algorithm", "tokenInputs"]),
      strictObject({ status: { const: "unknown" } }, ["status"]),
    ],
  }
  schemas.UsageProvenanceV1 = strictObject({
    providerID: { type: "string" },
    modelID: { type: "string" },
    operationID: { type: "string" },
    requestID: { type: "string" },
    cost: { $ref: "#/components/schemas/UsageProvenanceCostV1" },
    tokens: strictObject({
      input: { $ref: "#/components/schemas/UsageProvenanceMetricV1" },
      output: { $ref: "#/components/schemas/UsageProvenanceMetricV1" },
      reasoning: { $ref: "#/components/schemas/UsageProvenanceMetricV1" },
      cache: strictObject({
        read: { $ref: "#/components/schemas/UsageProvenanceMetricV1" },
        write: { $ref: "#/components/schemas/UsageProvenanceMetricV1" },
      }, ["read", "write"]),
    }, ["input", "output", "reasoning", "cache"]),
  }, ["providerID", "modelID", "cost", "tokens"])
  const assistantMessage = schemas.AssistantMessage as
    | { properties?: Record<string, unknown> }
    | undefined
  if (!assistantMessage?.properties) throw new Error("Generated AssistantMessage schema is missing")
  assistantMessage.properties.usageProvenance = { $ref: "#/components/schemas/UsageProvenanceV1" }

  const reachable = new Set<string>()
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }
    if (typeof value !== "object" || value === null) return
    for (const [key, child] of Object.entries(value)) {
      if (key === "$ref" && typeof child === "string" && child.startsWith("#/components/schemas/")) {
        const name = child.slice("#/components/schemas/".length)
        if (reachable.has(name)) continue
        reachable.add(name)
        visit(schemas[name])
      } else {
        visit(child)
      }
    }
  }
  visit({ ...document, components: { ...document.components, schemas: undefined } })
  for (const name of Object.keys(schemas)) {
    if (/^SessionNext\w+1$/.test(name) && !reachable.has(name)) delete schemas[name]
  }
  await Bun.write("./openapi.json", JSON.stringify(document))
}

await createClient({
  input: "./openapi.json",
  output: {
    path: "./src/v2/gen",
    tsConfigPath: path.join(dir, "tsconfig.json"),
    clean: true,
  },
  plugins: [
    {
      name: "@hey-api/typescript",
      exportFromIndex: false,
    },
    {
      name: "@hey-api/sdk",
      instance: "OpencodeClient",
      exportFromIndex: false,
      auth: false,
      paramsStructure: "flat",
    },
    {
      name: "@hey-api/client-fetch",
      exportFromIndex: false,
      baseUrl: "http://localhost:4096",
    },
  ],
})

const generatedTypes = await Bun.file("./src/v2/gen/types.gen.ts").text()
if (/export type SessionNext\w+1 =/.test(generatedTypes)) {
  throw new Error("Session history generated duplicate Session event variants")
}
const historyTypesPatched = generatedTypes.replace(
  /(export type V2SessionHistoryData = \{[\s\S]*?query\?: \{\s*limit\?: )string([;,]\s*after\?: )string/,
  "$1number$2number",
)
if (historyTypesPatched === generatedTypes) {
  throw new Error("Session history numeric query patch did not apply")
}

// @hey-api currently drops OpenAPI nullable unions emitted by Schema.NullOr.
// Keep the Goal-review SDK contract truthful for nullable durable fields and
// the optional page cursor. Scope replacements to the two response sections
// and fail generation if the upstream shape changes unexpectedly.
function patchGoalReviewNullability(source: string, typeName: string, replacements: Record<string, number>) {
  const start = source.indexOf(`export type ${typeName} = {`)
  const end = source.indexOf("\nexport type ", start + 1)
  if (start < 0 || end < 0) throw new Error(`Goal-review generated type section is missing: ${typeName}`)
  let section = source.slice(start, end)
  for (const [field, expectedCount] of Object.entries(replacements)) {
    const needle = `${field}: string`
    const count = section.split(needle).length - 1
    if (count !== expectedCount) {
      throw new Error(`Goal-review nullable patch expected ${expectedCount} ${field} fields, found ${count}`)
    }
    section = section.replaceAll(needle, `${field}: string | null`)
  }
  return source.slice(0, start) + section + source.slice(end)
}

let goalReviewTypesPatched = patchGoalReviewNullability(historyTypesPatched, "ExperimentalGoalReviewGoalReviewResponses", {
  parentVersionId: 1,
  maxMemoryBytes: 1,
  maxDiskBytes: 1,
  maxTokens: 1,
  maxCostMicros: 1,
})
goalReviewTypesPatched = patchGoalReviewNullability(
  goalReviewTypesPatched,
  "ExperimentalGoalReviewGoalReviewsResponses",
  {
    parentVersionId: 1,
    maxMemoryBytes: 1,
    maxDiskBytes: 1,
    maxTokens: 1,
    maxCostMicros: 1,
    nextAfterGoalID: 1,
  },
)
await Bun.write("./src/v2/gen/types.gen.ts", goalReviewTypesPatched)

const generatedSdk = await Bun.file("./src/v2/gen/sdk.gen.ts").text()
const historySdkPatched = generatedSdk.replace(
  /(Get session history[\s\S]*?parameters: \{\s*sessionID: string[;,]\s*limit\?: )string([;,]\s*after\?: )string/,
  "$1number$2number",
)
if (historySdkPatched === generatedSdk) {
  throw new Error("Session history numeric SDK patch did not apply")
}
await Bun.write("./src/v2/gen/sdk.gen.ts", historySdkPatched)

// Patch a @hey-api/openapi-ts codegen bug: SseFn incorrectly passes the
// endpoint's TError into the second generic of ServerSentEventsResult, which
// is the AsyncGenerator's TReturn slot. Iterator return values have nothing
// to do with HTTP errors, and any consumer that calls `.return()` or returns
// from a mock generator gets type-checked against the wrong shape. Drop the
// arg so TReturn defaults to void.
const sseTypesPath = "./src/v2/gen/client/types.gen.ts"
const sseTypesFile = Bun.file(sseTypesPath)
const sseTypesSource = await sseTypesFile.text()
const sseTypesPatched = sseTypesSource.replace(
  "=> Promise<ServerSentEventsResult<TData, TError>>",
  "=> Promise<ServerSentEventsResult<TData>>",
)
if (sseTypesPatched === sseTypesSource) {
  throw new Error(`SseFn patch did not apply; @hey-api/openapi-ts output may have changed (${sseTypesPath})`)
}
await Bun.write(sseTypesPath, sseTypesPatched)

await $`bun prettier --write src/gen`
await $`bun prettier --write src/v2`
await $`rm -rf dist`
await $`bun tsc`
await $`rm openapi.json`
