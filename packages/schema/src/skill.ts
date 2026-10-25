export * as Skill from "./skill"

import { Schema } from "effect"
import { optional } from "./schema"
import { AbsolutePath } from "./schema"

export interface DirectorySource extends Schema.Schema.Type<typeof DirectorySource> {}
export const DirectorySource = Schema.Struct({
  type: Schema.Literal("directory"),
  path: AbsolutePath,
}).annotate({ identifier: "SkillV2.DirectorySource" })

export interface UrlSource extends Schema.Schema.Type<typeof UrlSource> {}
export const UrlSource = Schema.Struct({
  type: Schema.Literal("url"),
  url: Schema.String,
}).annotate({ identifier: "SkillV2.UrlSource" })

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const HorizonDocsIdentityV1 = {
  id: "builtin.horizon-docs",
  alias: "horizon-docs",
  revision: "sha256:28fb74ebf91729f5f62f6342bcd0c21f25fbb72487afdaba239317d215526fee",
} as const

export const HorizonCodeIdentityV1 = {
  id: "builtin.horizoncode",
  alias: "horizoncode",
  revision: "sha256:b784cb02d1655c7606bfc6548d17de2b237ca28e02c7e58b0f57c1c5ffece90f",
} as const

export const SealedBuiltinIdentitiesV1 = {
  [HorizonDocsIdentityV1.id]: HorizonDocsIdentityV1,
  [HorizonCodeIdentityV1.id]: HorizonCodeIdentityV1,
} as const

/**
 * Registry entry for the cross-field skill identity filter below.
 *
 * Effect asks consumers to extend `Annotations.MetaDefinitions` rather than
 * `BuiltInMetaDefinitions` when a custom filter needs portable metadata
 * (httpapi-codegen's `checksPortable` requires `meta` plus
 * `arbitrary.constraint` on every filter it reflects).
 */
declare module "effect/Schema" {
  namespace Annotations {
    interface MetaDefinitions {
      readonly isSkillIdentity: { readonly _tag: "isSkillIdentity" }
    }
  }
}

export interface Identity extends Schema.Schema.Type<typeof Identity> {}
export const Identity = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  id: Schema.String.check(
    Schema.isPattern(/^(?:builtin\.horizon-docs|builtin\.horizoncode|(?:project|user|remote)\.[a-f0-9]{64})$/),
  ),
  alias: Schema.String.check(Schema.isNonEmpty()),
  source: Schema.Literals(["builtin", "project", "user", "remote"]),
  trust: Schema.Literals(["sealed_builtin", "untrusted"]),
  revision: Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/)),
})
  .annotate({ identifier: "SkillV2.Identity" })
  .check(
    Schema.makeFilter(
      (identity) => {
        if (identity.source === "builtin") {
          const canonical = SealedBuiltinIdentitiesV1[identity.id as keyof typeof SealedBuiltinIdentitiesV1]
          return canonical &&
            identity.alias === canonical.alias &&
            identity.trust === "sealed_builtin" &&
            identity.revision === canonical.revision
            ? undefined
            : "the sealed builtin identity must match a canonical built-in skill"
        }
        if (identity.trust !== "untrusted" || identity.id.startsWith("builtin."))
          return "project, user, and remote skills must be untrusted and cannot use reserved builtin IDs"
        if (!identity.id.startsWith(`${identity.source}.`))
          return "skill identity namespace must match its source"
        return undefined
      },
      {
        meta: { _tag: "isSkillIdentity" },
        // Node-local generation hint: this cross-field predicate constrains no
        // property of the object itself, so the constraint stays empty and
        // generated values are still validated by the filter predicate.
        arbitrary: { constraint: {} },
      },
    ),
  )

export const Info = Schema.Struct({
  name: Schema.String,
  description: Schema.String.pipe(optional),
  slash: Schema.Boolean.pipe(optional),
  location: AbsolutePath,
  content: Schema.String,
  identity: Identity,
}).annotate({ identifier: "SkillV2.Info" })

export interface EmbeddedSource extends Schema.Schema.Type<typeof EmbeddedSource> {}
export const EmbeddedSource = Schema.Struct({
  type: Schema.Literal("embedded"),
  skill: Schema.suspend(() => Info),
}).annotate({ identifier: "SkillV2.EmbeddedSource" })

export type Source = DirectorySource | UrlSource | EmbeddedSource
export const Source = Object.assign(
  Schema.Union([DirectorySource, UrlSource, EmbeddedSource]).pipe(
    Schema.toTaggedUnion("type"),
    Schema.annotate({ identifier: "SkillV2.Source" }),
  ),
  {
    equals: (a: Source, b: Source) => {
      if (a.type !== b.type) return false
      if (a.type === "directory" && b.type === "directory") return a.path === b.path
      if (a.type === "url" && b.type === "url") return a.url === b.url
      if (a.type === "embedded" && b.type === "embedded") return a.skill.name === b.skill.name
      return false
    },
    key: (source: Source) =>
      source.type === "directory"
        ? `directory:${source.path}`
        : source.type === "url"
          ? `url:${source.url}`
          : `embedded:${source.skill.name}`,
  },
)
