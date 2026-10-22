export * as SkillV2 from "./skill"

import { makeLocationNode } from "./effect/app-node"
import path from "path"
import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"
import horizonCodeContent from "./horizon/skills/horizoncode/SKILL.md" with { type: "text" }
import horizonDocsContent from "./horizon/skills/horizon-docs/SKILL.md" with { type: "text" }
import { Context, Effect, Layer, Schema, Types } from "effect"
import { Skill } from "@opencode-ai/schema/skill"
import { AgentV2 } from "./agent"
import { ConfigMarkdown } from "./config/markdown"
import { FSUtil } from "./fs-util"
import { Global } from "./global"
import { Location } from "./location"
import { PermissionV2 } from "./permission"
import { AbsolutePath } from "./schema"
import { SkillDiscovery } from "./skill/discovery"
import { State } from "./state"

export const DirectorySource = Skill.DirectorySource
export type DirectorySource = Skill.DirectorySource

export const UrlSource = Skill.UrlSource
export type UrlSource = Skill.UrlSource

export const EmbeddedSource = Skill.EmbeddedSource
export type EmbeddedSource = Skill.EmbeddedSource

export const Source = Skill.Source
export type Source = typeof Source.Type

export const Info = Skill.Info
export type Info = Skill.Info
export const Identity = Skill.Identity
export type Identity = Skill.Identity

const HORIZON_CODE_IDENTITY = Skill.HorizonCodeIdentityV1
const HORIZON_DOCS_IDENTITY = Skill.HorizonDocsIdentityV1

const sha256 = (content: string) => createHash("sha256").update(content).digest("hex")

function verifySealedBuiltinRevision(
  identity: typeof HORIZON_DOCS_IDENTITY | typeof HORIZON_CODE_IDENTITY,
  content: string,
  expectedRevision?: string,
) {
  const actual = `sha256:${sha256(content)}`
  const expected = expectedRevision ?? identity.revision
  if (expected !== identity.revision || actual !== identity.revision) {
    throw new Error(`canonical ${identity.alias} skill digest mismatch`)
  }
  return actual
}

export function identityFor(input: {
  source: "project" | "user" | "remote"
  sourcePath: string
  content: string
  alias: string
}): Identity {
  const sourceIdentity = input.source === "remote" ? new URL(input.sourcePath).href : path.resolve(input.sourcePath)
  return {
    schemaVersion: 1,
    id: `${input.source}.${sha256(sourceIdentity)}`,
    alias: input.alias,
    source: input.source,
    trust: "untrusted",
    revision: `sha256:${sha256(input.content)}`,
  }
}

export function verifyCanonicalBuiltin(content: string, expectedRevision: string) {
  return verifySealedBuiltinRevision(HORIZON_DOCS_IDENTITY, content, expectedRevision)
}

export function horizonCode(input?: { content: string; expectedRevision?: string }): Info {
  const content = input?.content ?? horizonCodeContent
  const revision = verifySealedBuiltinRevision(HORIZON_CODE_IDENTITY, content, input?.expectedRevision)
  return Info.make({
    name: HORIZON_CODE_IDENTITY.alias,
    description:
      "Deep integration map for HorizonCode — built-in tools, skills, capability tiers, Guard lanes, and product surface.",
    location: AbsolutePath.make(fileURLToPath(new URL("./horizon/skills/horizoncode/SKILL.md", import.meta.url))),
    content,
    identity: {
      schemaVersion: 1,
      id: HORIZON_CODE_IDENTITY.id,
      alias: HORIZON_CODE_IDENTITY.alias,
      source: "builtin",
      trust: "sealed_builtin",
      revision,
    },
  })
}

export function horizonDocs(input?: { content: string; expectedRevision?: string }): Info {
  const content = input?.content ?? horizonDocsContent
  const revision = verifySealedBuiltinRevision(HORIZON_DOCS_IDENTITY, content, input?.expectedRevision)
  return Info.make({
    name: HORIZON_DOCS_IDENTITY.alias,
    description: "Retrieve installed HorizonCode architecture, contracts and implementation status.",
    location: AbsolutePath.make(fileURLToPath(new URL("./horizon/skills/horizon-docs/SKILL.md", import.meta.url))),
    content,
    identity: {
      schemaVersion: 1,
      id: HORIZON_DOCS_IDENTITY.id,
      alias: HORIZON_DOCS_IDENTITY.alias,
      source: "builtin",
      trust: "sealed_builtin",
      revision,
    },
  })
}

export function resolveSelection(skills: ReadonlyArray<Info>, input: string): Info | undefined {
  const exact = skills.find((skill) => skill.identity.id === input)
  if (exact) return exact
  const aliases = skills.filter((skill) => skill.identity.alias === input)
  return aliases.length === 1 ? aliases[0] : undefined
}

export const available = (skills: ReadonlyArray<Info>, agent: AgentV2.Info) =>
  skills.filter(
    (skill) => PermissionV2.evaluate("skill", skill.identity.id, agent.permissions).effect !== "deny",
  )

const Frontmatter = Schema.Struct({
  name: Schema.String.pipe(Schema.optional),
  description: Schema.String.pipe(Schema.optional),
  slash: Schema.Boolean.pipe(Schema.optional),
})
const decodeFrontmatter = Schema.decodeUnknownOption(Frontmatter)

export type Data = {
  sources: Types.DeepMutable<Source>[]
}

export type Draft = {
  source: (source: Source) => void
  list: () => readonly Source[]
}

export interface Interface extends State.Transformable<Draft> {
  readonly sources: () => Effect.Effect<Source[]>
  readonly list: () => Effect.Effect<Info[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Skill") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const discovery = yield* SkillDiscovery.Service
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const location = yield* Location.Service

    const state = State.create<Data, Draft>({
      initial: () => ({ sources: [] }),
      draft: (draft) => ({
        source: (source) => {
          if (draft.sources.some((item) => Source.equals(item, source))) return
          draft.sources.push(source as Types.DeepMutable<Source>)
        },
        list: () => draft.sources as Source[],
      }),
    })

    const load = Effect.fn("SkillV2.load")(function* (source: Source) {
      const skills: Info[] = []
      if (source.type === "embedded") {
        return [
          Info.make({
            ...source.skill,
            identity: identityFor({
              source: "project",
              sourcePath: source.skill.location,
              content: source.skill.content,
              alias: source.skill.name,
            }),
          }),
        ]
      }
      const directories = source.type === "directory" ? [source.path] : yield* discovery.pull(source.url)
      for (const directory of directories) {
        const files = yield* fs
          .glob("{*.md,**/SKILL.md}", { cwd: directory, absolute: true, include: "file", symlink: true, dot: true })
          .pipe(Effect.catch(() => Effect.succeed([] as string[])))
        for (const filepath of files.toSorted()) {
          const content = yield* fs.readFileStringSafe(filepath).pipe(Effect.catch(() => Effect.succeed(undefined)))
          if (!content) continue
          const markdown = ConfigMarkdown.parseOption(content)
          if (!markdown) continue
          const frontmatter = decodeFrontmatter(markdown.data).valueOrUndefined
          if (!frontmatter) continue
          const name =
            frontmatter.name !== undefined
              ? frontmatter.name
              : path.dirname(filepath) === directory
                ? path.basename(filepath, ".md")
                : undefined
          if (!name) continue
          const resolvedPath = path.resolve(filepath)
          const scope =
            source.type === "url"
              ? "remote"
              : FSUtil.contains(location.project.directory, resolvedPath)
                ? "project"
                : FSUtil.contains(global.config, resolvedPath)
                  ? "user"
                  : "project"
          skills.push(
            Info.make({
              name,
              description: frontmatter.description,
              slash: frontmatter.slash,
              location: AbsolutePath.make(filepath),
              content: markdown.content,
              identity: identityFor({
                source: scope,
                sourcePath: source.type === "url" ? `${source.url.replace(/\/$/, "")}/${path.relative(directory, filepath).split(path.sep).join("/")}` : resolvedPath,
                content: markdown.content,
                alias: name,
              }),
            }),
          )
        }
      }
      return skills
    })

    // QUESTION(Dax): Should local skill sources invalidate on filesystem watch
    // events, following the reload policy chosen for other context sources?
    const cache = new Map<string, Info[]>()
    const list = Effect.fn("SkillV2.list")(function* () {
      const skills: Info[] = [horizonCode(), horizonDocs()]
      for (const source of state.get().sources) {
        const key = Source.key(source)
        const loaded = cache.get(key) ?? (yield* load(source))
        cache.set(key, loaded)
        skills.push(...loaded)
      }
      return skills
    })

    return Service.of({
      transform: state.transform,
      reload: Effect.fn("SkillV2.reload")(function* () {
        cache.clear()
        yield* state.reload()
      }),
      sources: Effect.fn("SkillV2.sources")(function* () {
        return state.get().sources
      }),
      list,
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [SkillDiscovery.node, FSUtil.node, Global.node, Location.node] })
