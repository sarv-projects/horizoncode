import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { Location } from "@opencode-ai/core/location"
import { Project } from "@opencode-ai/core/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SkillV2 } from "@opencode-ai/core/skill"
import { SkillDiscovery } from "@opencode-ai/core/skill/discovery"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const urls = new Map<string, AbsolutePath[]>()
let pulls = 0
const discovery = Layer.succeed(
  SkillDiscovery.Service,
  SkillDiscovery.Service.of({
    pull: (url) => {
      pulls++
      return Effect.succeed(urls.get(url) ?? [])
    },
  }),
)
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([SkillV2.node, AgentV2.node]), [
    [SkillDiscovery.node, discovery],
    [Global.node, Global.layerWith({ config: "/tmp/horizon-skill-test-global" })],
    [
      Location.node,
      Location.boundNode({ directory: AbsolutePath.make("/tmp/horizon-skill-test-project") }),
    ],
    [
      Project.node,
      Layer.succeed(
        Project.Service,
        Project.Service.of({
          directories: () => Effect.succeed([]),
          resolve: () =>
            Effect.succeed({ id: Project.ID.make("skill-test"), directory: AbsolutePath.make("/tmp/horizon-skill-test-project") }),
          commit: () => Effect.void,
        }),
      ),
    ],
  ]),
)

function write(directory: string, name: string, description: string) {
  const location = path.join(directory, name, "SKILL.md")
  return fs.mkdir(path.dirname(location), { recursive: true }).then(() =>
    fs.writeFile(
      location,
      `---
name: ${name}
description: ${description}
---
# ${name}`,
    ),
  )
}

describe("SkillV2", () => {
  it.live("registers sources and resolves later source precedence", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const first = path.join(tmp.path, "first")
          const second = path.join(tmp.path, "second")
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(first, "review"), { recursive: true })
            await fs.mkdir(path.join(second, "review"), { recursive: true })
            await write(first, "review", "First")
            await write(first, "horizon-docs", "Project skill cannot replace the builtin")
            await write(second, "review", "Second")
            await fs.writeFile(path.join(first, "foo.md"), "---\nslash: true\n---\n# foo")
          })

          const skill = yield* SkillV2.Service
          yield* skill.transform((editor) => {
            editor.source({ type: "directory", path: AbsolutePath.make(first) })
            editor.source({ type: "directory", path: AbsolutePath.make(first) })
            editor.source({ type: "directory", path: AbsolutePath.make(second) })
            expect(editor.list()).toEqual([
              { type: "directory", path: AbsolutePath.make(first) },
              { type: "directory", path: AbsolutePath.make(second) },
            ])
          })

          expect(yield* skill.sources()).toEqual([
            { type: "directory", path: AbsolutePath.make(first) },
            { type: "directory", path: AbsolutePath.make(second) },
          ])
          const loaded = yield* skill.list()
          const docs = loaded.filter((item) => item.identity.alias === "horizon-docs")
          const reviews = loaded.filter((item) => item.identity.alias === "review")
          expect(docs.map((item) => [item.identity.source, item.identity.trust])).toEqual([
            ["builtin", "sealed_builtin"],
            ["project", "untrusted"],
          ])
          expect(docs[0]?.identity.id).toBe("builtin.horizon-docs")
          expect(docs[1]?.identity.id).not.toBe("builtin.horizon-docs")
          expect(reviews).toHaveLength(2)
          expect(reviews[0]?.identity.id).not.toBe(reviews[1]?.identity.id)
          expect(SkillV2.resolveSelection(loaded, "horizon-docs")).toBeUndefined()
          expect(SkillV2.resolveSelection(loaded, "builtin.horizon-docs")?.identity.trust).toBe("sealed_builtin")
          expect(SkillV2.resolveSelection(loaded, "review")).toBeUndefined()
        }),
      ),
    ),
  )

  it.live("loads URL sources and filters skills for agents", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(tmp.path, "deploy"), { recursive: true })
            await write(tmp.path, "deploy", "Deploy production")
          })
          pulls = 0
          urls.set("https://example.test/skills/", [AbsolutePath.make(tmp.path)])

          const agents = yield* AgentV2.Service
          yield* agents.transform((editor) =>
            editor.update(AgentV2.ID.make("reviewer"), (agent) => {
              agent.permissions.push({ action: "skill", resource: "deploy", effect: "deny" })
            }),
          )

          const skill = yield* SkillV2.Service
          yield* skill.transform((editor) => editor.source({ type: "url", url: "https://example.test/skills/" }))

          const listed = yield* skill.list()
          expect(listed.map((item) => item.name)).toEqual(["horizoncode", "horizon-docs", "deploy"])
          expect((yield* skill.list()).map((item) => item.identity.id)).toEqual(listed.map((item) => item.identity.id))
          expect(pulls).toBe(1)
          const loadedDeploy = listed.find((item) => item.identity.alias === "deploy")!
          const aliasDenied = (yield* agents.get(AgentV2.ID.make("reviewer")))!
          expect(SkillV2.available([loadedDeploy], aliasDenied)).toHaveLength(1)
          expect(
            SkillV2.available(
              [loadedDeploy],
              AgentV2.Info.make({
                ...aliasDenied,
                permissions: [{ action: "skill", resource: loadedDeploy.identity.id, effect: "deny" }],
              }),
            ),
          ).toEqual([])
        }),
      ),
    ),
  )
})
