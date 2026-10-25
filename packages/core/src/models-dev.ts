import path from "path"
import { Context, Duration, Effect, Layer, Option, Schedule, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { ModelsDev } from "@opencode-ai/schema/models-dev"
import { Global } from "./global"
import { Flag } from "./flag/flag"
import { Flock } from "./util/flock"
import { Hash } from "./util/hash"
import { FSUtil } from "./fs-util"
import { InstallationChannel, InstallationVersion } from "./installation/version"
import { EventV2 } from "./event"
import { makeGlobalNode } from "./effect/app-node"
import { httpClient } from "./effect/app-node-platform"

export const CatalogModelStatus = Schema.Literals(["alpha", "beta", "deprecated"])
export type CatalogModelStatus = typeof CatalogModelStatus.Type

const InterleavedField = Schema.Union([
  Schema.Literals(["reasoning", "reasoning_content", "reasoning_text"]),
  Schema.String,
])

const USER_AGENT = `opencode/${InstallationChannel}/${InstallationVersion}/${Flag.OPENCODE_CLIENT}`
const DEFAULT_SOURCE = "https://models.opencode.ai"
const MAX_CATALOG_BYTES = 16 * 1024 * 1024

const SnapshotMetadata = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  sourceURL: Schema.String,
  retrievedAt: Schema.Finite,
  contentDigest: Schema.String,
  license: Schema.optional(Schema.String),
  attribution: Schema.optional(Schema.String),
})
type SnapshotMetadata = Schema.Schema.Type<typeof SnapshotMetadata>
const decodeMetadata = Schema.decodeUnknownOption(SnapshotMetadata)

const CostTier = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  cache_read: Schema.optional(Schema.Finite),
  cache_write: Schema.optional(Schema.Finite),
  tier: Schema.Struct({
    type: Schema.Literal("context"),
    size: Schema.Finite,
  }),
})

const Cost = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  cache_read: Schema.optional(Schema.Finite),
  cache_write: Schema.optional(Schema.Finite),
  tiers: Schema.optional(Schema.Array(CostTier)),
  context_over_200k: Schema.optional(
    Schema.Struct({
      input: Schema.Finite,
      output: Schema.Finite,
      cache_read: Schema.optional(Schema.Finite),
      cache_write: Schema.optional(Schema.Finite),
    }),
  ),
})

const ReasoningOption = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("effort"),
    values: Schema.Array(Schema.NullOr(Schema.String)),
  }),
  Schema.Struct({
    type: Schema.Literal("toggle"),
  }),
  Schema.Struct({
    type: Schema.Literal("budget_tokens"),
    min: Schema.optional(Schema.Finite),
    max: Schema.optional(Schema.Finite),
  }),
])

export const Model = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  family: Schema.optional(Schema.String),
  release_date: Schema.String,
  attachment: Schema.Boolean,
  reasoning: Schema.Boolean,
  temperature: Schema.Boolean,
  tool_call: Schema.Boolean,
  reasoning_options: Schema.optional(Schema.Array(ReasoningOption)),
  interleaved: Schema.optional(
    Schema.Union([
      Schema.Boolean,
      InterleavedField,
      Schema.Struct({
        field: InterleavedField,
      }),
    ]),
  ),
  cost: Schema.optional(Cost),
  limit: Schema.Struct({
    context: Schema.Finite,
    input: Schema.optional(Schema.Finite),
    output: Schema.Finite,
  }),
  modalities: Schema.optional(
    Schema.Struct({
      input: Schema.Array(Schema.Literals(["text", "audio", "image", "video", "pdf"])),
      output: Schema.Array(Schema.Literals(["text", "audio", "image", "video", "pdf"])),
    }),
  ),
  experimental: Schema.optional(
    Schema.Struct({
      modes: Schema.optional(
        Schema.Record(
          Schema.String,
          Schema.Struct({
            cost: Schema.optional(Cost),
            provider: Schema.optional(
              Schema.Struct({
                body: Schema.optional(Schema.Record(Schema.String, Schema.MutableJson)),
                headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
              }),
            ),
          }),
        ),
      ),
    }),
  ),
  status: Schema.optional(CatalogModelStatus),
  provider: Schema.optional(
    Schema.Struct({ npm: Schema.optional(Schema.String), api: Schema.optional(Schema.String) }),
  ),
})
export type Model = Schema.Schema.Type<typeof Model>

export const Provider = Schema.Struct({
  api: Schema.optional(Schema.String),
  name: Schema.String,
  env: Schema.Array(Schema.String),
  id: Schema.String,
  npm: Schema.optional(Schema.String),
  models: Schema.Record(Schema.String, Model),
})

export type Provider = Schema.Schema.Type<typeof Provider>

export const Event = ModelsDev.Event

declare const OPENCODE_MODELS_DEV: Record<string, Provider> | undefined

export interface CatalogSnapshotV1 {
  providers: Record<string, Provider>
  source: "cache" | "bundled" | "override" | "unavailable"
  freshness: "fresh" | "stale" | "unknown"
  updatedAt?: number
  /** Bound provenance for imported catalog data; absence is UNKNOWN, never "current". */
  provenance?: {
    sourceURL?: string
    project: "models.dev" | "custom"
    retrievedAt?: number
    contentDigest?: string
    license?: string
    attribution?: string
  }
}

export interface Interface {
  readonly get: () => Effect.Effect<Record<string, Provider>>
  /** Read-only source/freshness/provenance for consumers that must not guess from stale rows. */
  readonly getSnapshot: () => Effect.Effect<CatalogSnapshotV1>
  /** Fetches only when an explicit refresh action invokes it. */
  readonly refresh: (force?: boolean) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ModelsDev") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const events = yield* EventV2.Service
    const global = yield* Global.Service
    const http = HttpClient.filterStatusOk(
      (yield* HttpClient.HttpClient).pipe(
        HttpClient.retryTransient({
          retryOn: "errors-and-responses",
          times: 2,
          schedule: Schedule.exponential(200).pipe(Schedule.jittered),
        }),
      ),
    )

    const source = Flag.OPENCODE_MODELS_URL || DEFAULT_SOURCE
    const filepath = path.join(
      global.cache,
      source === DEFAULT_SOURCE ? "models.json" : `models-${Hash.fast(source)}.json`,
    )
    const metadataPath = `${filepath}.meta.json`
    const provenanceProject = source === DEFAULT_SOURCE ? "models.dev" : "custom"
    const defaultProvenance: {
      project: "models.dev" | "custom"
      license?: string
      attribution?: string
    } = {
      project: provenanceProject,
      ...(source === DEFAULT_SOURCE
        ? { license: "MIT", attribution: "Models.dev (https://models.dev)" }
        : {}),
    }
    const ttl = Duration.minutes(5)
    const lockKey = `models-dev:${filepath}`
    const loadMetadata = fs.readJson(metadataPath).pipe(
      Effect.catch(() => Effect.succeed(undefined)),
      Effect.map((value) => {
        if (value === undefined) return undefined
        return Option.getOrUndefined(decodeMetadata(value))
      }),
    )

    const fresh = Effect.fnUntraced(function* () {
      const stat = yield* fs.stat(filepath).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!stat) return false
      const mtime = Option.getOrElse(stat.mtime, () => new Date(0)).getTime()
      return Date.now() - mtime < Duration.toMillis(ttl)
    })

    const fetchApi = Effect.fn("ModelsDev.fetchApi")(function* () {
      return yield* HttpClientRequest.get(`${source}/api.json`).pipe(
        HttpClientRequest.setHeader("User-Agent", USER_AGENT),
        http.execute,
        Effect.flatMap((res) => res.text),
        Effect.timeout("10 seconds"),
      )
    })

    const readCatalogText = fs.readFileStringSafe(Flag.OPENCODE_MODELS_PATH ?? filepath).pipe(
      Effect.catch(() => {
        // Reads never delete cache state. Repair and refresh remain explicit.
        return Effect.succeed(undefined)
      }),
    )
    const loadFromDisk = readCatalogText.pipe(
      Effect.flatMap((text) => {
        if (text === undefined) return Effect.succeed(undefined)
        return Effect.try({
          try: () => JSON.parse(text) as Record<string, Provider>,
          catch: () => undefined,
        })
      }),
      Effect.catch(() => Effect.succeed(undefined)),
    )

    const loadSnapshot = Effect.sync(() =>
      typeof OPENCODE_MODELS_DEV === "undefined" ? undefined : OPENCODE_MODELS_DEV,
    )

    const fetchAndWrite = Effect.fn("ModelsDev.fetchAndWrite")(function* () {
      const text = yield* fetchApi()
      if (Buffer.byteLength(text, "utf8") > MAX_CATALOG_BYTES) {
        return yield* Effect.fail(new Error("Models.dev catalog response exceeds the bounded snapshot size"))
      }
      const retrievedAt = Date.now()
      const contentDigest = `sha256:${Hash.sha256(text)}`
      const atomicWrite = (target: string, body: string) => {
        const temporary = `${target}.${process.pid}.${Date.now()}.tmp`
        return fs.writeWithDirs(temporary, body).pipe(
          Effect.andThen(fs.rename(temporary, target)),
          Effect.catch((error) =>
            Effect.gen(function* () {
              yield* fs.remove(temporary, { force: true }).pipe(Effect.ignore)
              return yield* Effect.fail(error)
            }),
          ),
        )
      }
      yield* atomicWrite(filepath, text)
      // Provenance is written separately and must never make a successfully
      // fetched catalog unusable. A missing/corrupt sidecar stays UNKNOWN.
      yield* atomicWrite(metadataPath, JSON.stringify({
        schemaVersion: 1,
        sourceURL: source,
        retrievedAt,
        contentDigest,
        ...(source === DEFAULT_SOURCE
          ? { license: "MIT", attribution: "Models.dev (https://models.dev)" }
          : {}),
      } satisfies SnapshotMetadata)).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Failed to persist Models.dev provenance", { error }),
        ),
      )
      return text
    })

    const populate = Effect.gen(function* () {
      const fromDisk = yield* loadFromDisk
      if (fromDisk) return fromDisk
      const snapshot = yield* loadSnapshot
      if (snapshot) return snapshot
      return {}
    }).pipe(Effect.withSpan("ModelsDev.populate"), Effect.orDie)

    const [cachedGet, invalidate] = yield* Effect.cachedInvalidateWithTTL(populate, Duration.infinity)

    const get = (): Effect.Effect<Record<string, Provider>> => cachedGet

    const getSnapshot = Effect.fn("ModelsDev.getSnapshot")(function* () {
      const metadata = yield* loadMetadata
      const text = yield* readCatalogText
      const fromDisk = text === undefined
        ? undefined
        : yield* Effect.try({
            try: () => JSON.parse(text) as Record<string, Provider>,
            catch: () => undefined,
          }).pipe(Effect.catch(() => Effect.succeed(undefined)))
      const contentDigest = text === undefined ? undefined : `sha256:${Hash.sha256(text)}`
      const verifiedMetadata = metadata !== undefined && contentDigest !== undefined && metadata.contentDigest === contentDigest
        ? metadata
        : undefined
      const provenance = (allowRetrieval: boolean) => ({
        ...defaultProvenance,
        ...(contentDigest !== undefined ? { contentDigest } : {}),
        ...(allowRetrieval && verifiedMetadata?.sourceURL !== undefined ? { sourceURL: verifiedMetadata.sourceURL } : {}),
        ...(allowRetrieval && verifiedMetadata?.retrievedAt !== undefined ? { retrievedAt: verifiedMetadata.retrievedAt } : {}),
        ...(verifiedMetadata?.license !== undefined ? { license: verifiedMetadata.license } : {}),
        ...(verifiedMetadata?.attribution !== undefined ? { attribution: verifiedMetadata.attribution } : {}),
      })
      if (fromDisk) {
        if (Flag.OPENCODE_MODELS_PATH) {
          return { providers: fromDisk, source: "override" as const, freshness: "unknown" as const, provenance: provenance(false) }
        }
        const stat = yield* fs.stat(filepath).pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (!stat) {
          return { providers: fromDisk, source: "cache" as const, freshness: "unknown" as const, provenance: provenance(false) }
        }
        const mtime = Option.getOrElse(stat.mtime, () => new Date(0)).getTime()
        // Provenance is usable only when the sidecar digest matches the bytes
        // actually read. A hand-edited or replaced cache file must not inherit
        // an older snapshot's retrieval time.
        const updatedAt = verifiedMetadata ? Math.min(verifiedMetadata.retrievedAt, mtime) : mtime
        return {
          providers: fromDisk,
          source: "cache" as const,
          freshness: verifiedMetadata
            ? Date.now() - updatedAt < Duration.toMillis(ttl) ? ("fresh" as const) : ("stale" as const)
            : ("unknown" as const),
          updatedAt,
          provenance: provenance(true),
        }
      }
      const bundled = yield* loadSnapshot
      // A build-time embedded snapshot has no signed upstream revision or
      // retrieval timestamp in this contract. Its availability is known, but
      // catalog and pricing freshness are not. Do not turn "bundled" into a
      // false assertion that the provider metadata is current.
      if (bundled) {
        return { providers: bundled, source: "bundled" as const, freshness: "unknown" as const, provenance: provenance(false) }
      }
      return { providers: {}, source: "unavailable" as const, freshness: "unknown" as const, provenance: provenance(false) }
    })

    const refresh = Effect.fn("ModelsDev.refresh")(function* (force = false) {
      if (Flag.OPENCODE_DISABLE_MODELS_FETCH) return
      if (!force && (yield* fresh())) return
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Flock.effect(lockKey)
          // Re-check under the lock: another process may have refreshed between
          // our outer check and lock acquisition.
          if (!force && (yield* fresh())) return
          yield* fetchAndWrite()
          yield* invalidate
          yield* events.publish(Event.Refreshed, {})
        }),
      ).pipe(
        Effect.tapCause((cause) => Effect.logError("Failed to fetch models.dev", { cause: cause })),
        Effect.ignore,
      )
    })

    return Service.of({ get, getSnapshot, refresh })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer: layer,
  deps: [FSUtil.node, EventV2.node, Global.node, httpClient],
})

export * as ModelsDev from "./models-dev"
