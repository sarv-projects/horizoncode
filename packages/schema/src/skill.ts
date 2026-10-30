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

export const BuiltinSkillIdentitiesV1 = {
  "builtin.repo-onboarding": { id: "builtin.repo-onboarding", alias: "repo-onboarding", revision: "sha256:d338c2c1b7509242aa12cd7db85a2a8179f5b813e1a769aac3333def3925f51f" },
  "builtin.plan-change": { id: "builtin.plan-change", alias: "plan-change", revision: "sha256:a40f9dbfb29f8d99d45f7ee5c6e6f604d33724c65daa16927552e3ebe912a3f9" },
  "builtin.review-change": { id: "builtin.review-change", alias: "review-change", revision: "sha256:7327141f77781292d7b5c40a5d7541cd4c7f18203cfbe39bdd49825b317d3062" },
  "builtin.test-debug": { id: "builtin.test-debug", alias: "test-debug", revision: "sha256:0cd75dc75696117294c61480727e899eabd9ee1f9b71624dc9bf5c4fd4ae3f48" },
  "builtin.refactor-safely": { id: "builtin.refactor-safely", alias: "refactor-safely", revision: "sha256:6593dc17791283c2a012ee6616dbdfd16e4a2fe273a7fef39934f0fd8593effd" },
  "builtin.dependency-migration": { id: "builtin.dependency-migration", alias: "dependency-migration", revision: "sha256:2de71ba87b699f720a21fed1769eb0b5a2309b62825eeecab467b16662972171" },
  "builtin.browser-smoke-test": { id: "builtin.browser-smoke-test", alias: "browser-smoke-test", revision: "sha256:88ce846c744fea3798b1fccb9b20937eccdc125535fe85c0ddea988855247119" },
  "builtin.performance-profile": { id: "builtin.performance-profile", alias: "performance-profile", revision: "sha256:1d8af5459ed13b887b5b26102cde983a6bc286d9b6e889cee49ca0b31bfeeae3" },
  "builtin.security-review": { id: "builtin.security-review", alias: "security-review", revision: "sha256:e86631d1a0cf5fbd590af783ba4db65287e258e46b4d65ff783aee4625312eec" },
  "builtin.release-readiness": { id: "builtin.release-readiness", alias: "release-readiness", revision: "sha256:60efad0a68b188d54f89b79a9306e5556c255488f76e702f9c5c7cf31d8c99b5" },
  "builtin.commit-pr": { id: "builtin.commit-pr", alias: "commit-pr", revision: "sha256:8ccaedd8dda93eeb5a75dfae501154794c03ba52454647cb39887b5237cc3249" },
  "builtin.context-recovery": { id: "builtin.context-recovery", alias: "context-recovery", revision: "sha256:a264d04071911f7b67982ca3d89d840a027ec1fe597aae43f99edd0246e8429e" },
  "builtin.plugin-audit": { id: "builtin.plugin-audit", alias: "plugin-audit", revision: "sha256:24f3d8927ed185a622b569af104a51e562112d4f535759d10e155d09bfafaa40" },
  "builtin.worktree-hygiene": { id: "builtin.worktree-hygiene", alias: "worktree-hygiene", revision: "sha256:067ca44f6a8b6d5791ba6de9c7e314ee425890d555bbaf969c90566305106af1" },
} as const

export const SealedBuiltinIdentitiesV1 = {
  [HorizonDocsIdentityV1.id]: HorizonDocsIdentityV1,
  [HorizonCodeIdentityV1.id]: HorizonCodeIdentityV1,
  ...BuiltinSkillIdentitiesV1,
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
    Schema.isPattern(/^(?:builtin\.[a-z0-9][a-z0-9.-]*|(?:project|user|remote)\.[a-f0-9]{64})$/),
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
