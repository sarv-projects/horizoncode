import { LayerNode } from "@horizoncode/core/effect/layer-node"
import path from "path"
import { createHash } from "node:crypto"
import horizonCodeContent from "../../../core/src/horizon/skills/horizoncode/SKILL.md" with { type: "text" }
import horizonDocsContent from "../../../core/src/horizon/skills/horizon-docs/SKILL.md" with { type: "text" }
import repoOnboardingContent from "../../../core/src/horizon/skills/repo-onboarding/SKILL.md" with { type: "text" }
import planChangeContent from "../../../core/src/horizon/skills/plan-change/SKILL.md" with { type: "text" }
import reviewChangeContent from "../../../core/src/horizon/skills/review-change/SKILL.md" with { type: "text" }
import testDebugContent from "../../../core/src/horizon/skills/test-debug/SKILL.md" with { type: "text" }
import refactorSafelyContent from "../../../core/src/horizon/skills/refactor-safely/SKILL.md" with { type: "text" }
import dependencyMigrationContent from "../../../core/src/horizon/skills/dependency-migration/SKILL.md" with { type: "text" }
import browserSmokeTestContent from "../../../core/src/horizon/skills/browser-smoke-test/SKILL.md" with { type: "text" }
import performanceProfileContent from "../../../core/src/horizon/skills/performance-profile/SKILL.md" with { type: "text" }
import securityReviewContent from "../../../core/src/horizon/skills/security-review/SKILL.md" with { type: "text" }
import releaseReadinessContent from "../../../core/src/horizon/skills/release-readiness/SKILL.md" with { type: "text" }
import commitPrContent from "../../../core/src/horizon/skills/commit-pr/SKILL.md" with { type: "text" }
import contextRecoveryContent from "../../../core/src/horizon/skills/context-recovery/SKILL.md" with { type: "text" }
import pluginAuditContent from "../../../core/src/horizon/skills/plugin-audit/SKILL.md" with { type: "text" }
import worktreeHygieneContent from "../../../core/src/horizon/skills/worktree-hygiene/SKILL.md" with { type: "text" }
import { Effect, Layer, Context, Schema } from "effect"
import { NamedError } from "@horizoncode/core/util/error"
import type { Agent } from "@/agent/agent"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceState } from "@/effect/instance-state"
import { Global } from "@horizoncode/core/global"
import { SkillPlugin } from "@horizoncode/core/plugin/skill"
import { Permission } from "@/permission"
import { FSUtil } from "@horizoncode/core/fs-util"
import { Config } from "@/config/config"
import { FrontmatterError } from "@horizoncode/core/v1/config/error"
import { ConfigMarkdown } from "@/config/markdown"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Glob } from "@horizoncode/core/util/glob"
import { Discovery } from "./discovery"
import { isRecord } from "@/util/record"
import { escapeHtml } from "@/util/html"

const CLAUDE_EXTERNAL_DIR = ".claude"
const AGENTS_EXTERNAL_DIR = ".agents"
const EXTERNAL_SKILL_PATTERN = "skills/**/SKILL.md"
const OPENCODE_SKILL_PATTERN = "{skill,skills}/**/SKILL.md"
const SKILL_PATTERN = "**/SKILL.md"

// Built-in skill that ships with opencode. The model's intuition for what an
// opencode.json should look like is often wrong, and opencode hard-fails on
// invalid config, so users hit cryptic startup errors. Loading this skill
// when the model is asked to touch opencode's own config files gives it the
// actual schemas instead of guesses.
const CUSTOMIZE_OPENCODE_SKILL_NAME = "customize-opencode"
const CUSTOMIZE_OPENCODE_SKILL_DESCRIPTION =
  "Use ONLY when the user is editing or creating opencode's own configuration: opencode.json, opencode.jsonc, files under .opencode/, or files under ~/.config/opencode/. Also use when creating or fixing opencode agents, subagents, skills, plugins, MCP servers, or permission rules. Do not use for the user's own application code, or for any project that is not configuring opencode itself."
const CUSTOMIZE_OPENCODE_SKILL_BODY = SkillPlugin.CustomizeOpencodeContent

export const Info = Schema.Struct({
  id: Schema.optional(Schema.String),
  sealed: Schema.optional(Schema.Boolean),
  definitionDigest: Schema.optional(Schema.String),
  name: Schema.String,
  description: Schema.optional(Schema.String),
  location: Schema.String,
  content: Schema.String,
})
export type Info = Schema.Schema.Type<typeof Info>

const Issue = Schema.StructWithRest(
  Schema.Struct({
    message: Schema.String,
    path: Schema.Array(Schema.String),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
)

function isSkillFrontmatter(data: unknown): data is { name: string; description?: string } {
  return (
    isRecord(data) &&
    typeof data.name === "string" &&
    (data.description === undefined || typeof data.description === "string")
  )
}

export class InvalidError extends Schema.TaggedErrorClass<InvalidError>()("SkillInvalidError", {
  path: Schema.String,
  message: Schema.optional(Schema.String),
  issues: Schema.optional(Schema.Array(Issue)),
}) {}

export class NameMismatchError extends Schema.TaggedErrorClass<NameMismatchError>()("SkillNameMismatchError", {
  path: Schema.String,
  expected: Schema.String,
  actual: Schema.String,
}) {}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Skill.NotFoundError", {
  name: Schema.String,
  available: Schema.Array(Schema.String),
}) {
  override get message() {
    return `Skill "${this.name}" not found. Available skills: ${this.available.join(", ") || "none"}`
  }
}

type State = {
  skills: Record<string, Info>
  dirs: Set<string>
}

function resolveSkill(state: State, input: string): Info | undefined {
  const exact = state.skills[input]
  if (exact) return exact
  // A disk-provided alias cannot impersonate a reserved product identity.
  if (input.startsWith("builtin.")) return undefined
  const aliases = Object.values(state.skills).filter((skill) => skill.name === input)
  const builtin = aliases.find((skill) => skill.sealed)
  return builtin ?? (aliases.length === 1 ? aliases[0] : undefined)
}

type DiscoveryState = {
  matches: string[]
  dirs: string[]
}

type ScanState = {
  matches: Set<string>
  dirs: Set<string>
}

export interface Interface {
  readonly get: (name: string) => Effect.Effect<Info | undefined>
  readonly require: (name: string) => Effect.Effect<Info, NotFoundError>
  readonly all: () => Effect.Effect<Info[]>
  readonly dirs: () => Effect.Effect<string[]>
  readonly available: (agent?: Agent.Info) => Effect.Effect<Info[]>
}

const add = Effect.fnUntraced(function* (state: State, match: string, events: EventV2Bridge.Service["Service"]) {
  const md = yield* Effect.tryPromise({
    try: () => ConfigMarkdown.parse(match),
    catch: (err) => err,
  }).pipe(
    Effect.catch(
      Effect.fnUntraced(function* (err) {
        const message = FrontmatterError.isInstance(err) ? err.data.message : `Failed to parse skill ${match}`
        const { Session } = yield* Effect.promise(() => import("@/session/session"))
        yield* events.publish(Session.Event.Error, { error: new NamedError.Unknown({ message }).toObject() })
        yield* Effect.logError("failed to load skill", { skill: match, error: err })
        return undefined
      }),
    ),
  )

  if (!md) return

  if (!isSkillFrontmatter(md.data)) return

  const id = `external.${createHash("sha256").update(path.resolve(match)).digest("hex")}`
  if (Object.values(state.skills).some((skill) => skill.name === md.data.name)) {
    yield* Effect.logWarning("duplicate skill name", {
      name: md.data.name,
      duplicate: match,
    })
  }

  state.dirs.add(path.dirname(match))
  state.skills[id] = {
    id,
    sealed: false,
    definitionDigest: createHash("sha256").update(md.content).digest("hex"),
    name: md.data.name,
    description: md.data.description,
    location: match,
    content: md.content,
  }
})

const scan = Effect.fnUntraced(function* (
  state: ScanState,
  root: string,
  pattern: string,
  opts?: { dot?: boolean; scope?: string },
) {
  const matches = yield* Effect.tryPromise({
    try: () =>
      Glob.scan(pattern, {
        cwd: root,
        absolute: true,
        include: "file",
        symlink: true,
        dot: opts?.dot,
      }),
    catch: (error) => error,
  }).pipe(
    Effect.catch((error) => {
      if (!opts?.scope) return Effect.die(error)
      return Effect.logError(`failed to scan ${opts.scope} skills`, { dir: root, error: error }).pipe(
        Effect.as([] as string[]),
      )
    }),
  )

  for (const match of matches) {
    state.matches.add(match)
    state.dirs.add(path.dirname(match))
  }
})

const discoverSkills = Effect.fnUntraced(function* (
  config: Config.Interface,
  discovery: Discovery.Interface,
  fsys: FSUtil.Interface,
  global: Global.Interface,
  disableExternalSkills: boolean,
  disableClaudeCodeSkills: boolean,
  directory: string,
  worktree: string,
) {
  const state: ScanState = { matches: new Set(), dirs: new Set() }

  const externalDirs: string[] = []
  if (!disableExternalSkills) {
    if (!disableClaudeCodeSkills) externalDirs.push(CLAUDE_EXTERNAL_DIR)
    externalDirs.push(AGENTS_EXTERNAL_DIR)

    for (const dir of externalDirs) {
      const root = path.join(global.home, dir)
      if (!(yield* fsys.isDir(root))) continue
      yield* scan(state, root, EXTERNAL_SKILL_PATTERN, { dot: true, scope: "global" })
    }

    const upDirs = yield* fsys
      .up({ targets: externalDirs, start: directory, stop: worktree })
      .pipe(Effect.catch(() => Effect.succeed([] as string[])))

    for (const root of upDirs) {
      yield* scan(state, root, EXTERNAL_SKILL_PATTERN, { dot: true, scope: "project" })
    }
  }

  const configDirs = yield* config.directories()
  for (const dir of configDirs) {
    yield* scan(state, dir, OPENCODE_SKILL_PATTERN)
  }

  const cfg = yield* config.get()
  for (const item of cfg.skills?.paths ?? []) {
    const expanded = item.startsWith("~/") ? path.join(global.home, item.slice(2)) : item
    const dir = path.isAbsolute(expanded) ? expanded : path.join(directory, expanded)
    if (!(yield* fsys.isDir(dir))) {
      yield* Effect.logWarning("skill path not found", { path: dir })
      continue
    }

    yield* scan(state, dir, SKILL_PATTERN)
  }

  for (const url of cfg.skills?.urls ?? []) {
    const pulledDirs = yield* discovery.pull(url)
    for (const dir of pulledDirs) {
      yield* scan(state, dir, SKILL_PATTERN)
    }
  }

  return {
    matches: Array.from(state.matches),
    dirs: Array.from(state.dirs),
  }
})

const loadSkills = Effect.fnUntraced(function* (
  state: State,
  discovered: DiscoveryState,
  events: EventV2Bridge.Service["Service"],
) {
  yield* Effect.forEach(discovered.matches, (match) => add(state, match, events), {
    concurrency: "unbounded",
    discard: true,
  })

  yield* Effect.logInfo("init", { count: Object.keys(state.skills).length })
})

export class Service extends Context.Service<Service, Interface>()("@horizoncode/Skill") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const discovery = yield* Discovery.Service
    const config = yield* Config.Service
    const events = yield* EventV2Bridge.Service
    const fsys = yield* FSUtil.Service
    const global = yield* Global.Service
    const flags = yield* RuntimeFlags.Service
    const discovered = yield* InstanceState.make(
      Effect.fn("Skill.discovery")(function* (ctx) {
        return yield* discoverSkills(
          config,
          discovery,
          fsys,
          global,
          flags.disableExternalSkills,
          flags.disableClaudeCodeSkills,
          ctx.directory,
          ctx.worktree,
        )
      }),
    )
    const state = yield* InstanceState.make(
      Effect.fn("Skill.state")(function* () {
        const s: State = { skills: {}, dirs: new Set() }
        s.skills["builtin.customize-opencode"] = {
          id: "builtin.customize-opencode",
          sealed: true,
          definitionDigest: createHash("sha256").update(CUSTOMIZE_OPENCODE_SKILL_BODY).digest("hex"),
          name: CUSTOMIZE_OPENCODE_SKILL_NAME,
          description: CUSTOMIZE_OPENCODE_SKILL_DESCRIPTION,
          location: "<built-in>",
          content: CUSTOMIZE_OPENCODE_SKILL_BODY,
        }
        s.skills["builtin.horizoncode"] = {
          id: "builtin.horizoncode",
          sealed: true,
          definitionDigest: createHash("sha256").update(horizonCodeContent).digest("hex"),
          name: "horizoncode",
          description:
            "Deep integration map for HorizonCode — built-in tools, skills, capability tiers, Guard lanes, and product surface.",
          location: "<built-in>",
          content: horizonCodeContent,
        }
        s.skills["builtin.horizon-docs"] = {
          id: "builtin.horizon-docs",
          sealed: true,
          definitionDigest: createHash("sha256").update(horizonDocsContent).digest("hex"),
          name: "horizon-docs",
          description: "Retrieve installed HorizonCode architecture, contracts and implementation status.",
          location: "<built-in>",
          content: horizonDocsContent,
        }
        const shipped: ReadonlyArray<{ id: string; name: string; description: string; content: string }> = [
          {
            id: "builtin.repo-onboarding",
            name: "repo-onboarding",
            description: "Use when starting work in an unfamiliar repository and the agent must map stack, build/test/lint commands, rules files, entrypoints, and git state before editing.",
            content: repoOnboardingContent,
          },
          {
            id: "builtin.plan-change",
            name: "plan-change",
            description: "Use when a change request must become a scoped implementation plan with acceptance criteria, touched files, risk, and test strategy before any edit.",
            content: planChangeContent,
          },
          {
            id: "builtin.review-change",
            name: "review-change",
            description: "Use when reviewing a diff or set of changed files for correctness, regressions, and architecture fit, returning prioritized findings with file:line evidence and no edits.",
            content: reviewChangeContent,
          },
          {
            id: "builtin.test-debug",
            name: "test-debug",
            description: "Use when a test fails and the agent must reproduce, classify, and fix it with a minimal repro, root cause before fix, and failing-to-passing evidence without weakening assertions.",
            content: testDebugContent,
          },
          {
            id: "builtin.refactor-safely",
            name: "refactor-safely",
            description: "Use when a behavior-preserving refactor is needed: inventory call sites, plan small verifiable steps, prove behavior with tests before and after, and never mix in feature work.",
            content: refactorSafelyContent,
          },
          {
            id: "builtin.dependency-migration",
            name: "dependency-migration",
            description: "Use when migrating a dependency or API across versions: read changelogs and migration guides, inventory usages, batch mechanical updates, and verify build and tests per batch.",
            content: dependencyMigrationContent,
          },
          {
            id: "builtin.browser-smoke-test",
            name: "browser-smoke-test",
            description: "Use when a UI change needs a real browser journey: run the available browser or CLI tooling, capture steps and console or screenshot evidence, and report pass or fail per step.",
            content: browserSmokeTestContent,
          },
          {
            id: "builtin.performance-profile",
            name: "performance-profile",
            description: "Use when performance must be measured: form a hypothesis, benchmark before and after, isolate the hotspot, change one thing per measurement, and report numbers not vibes.",
            content: performanceProfileContent,
          },
          {
            id: "builtin.security-review",
            name: "security-review",
            description: "Use when defensively reviewing code or config for secrets exposure, injection, unsafe deserialization, authz gaps, and dependency risk, returning severity-ranked findings with remediation.",
            content: securityReviewContent,
          },
          {
            id: "builtin.release-readiness",
            name: "release-readiness",
            description: "Use when a release candidate must be assessed: run build, tests, license, config, and packaging gates, check version bumps and changelog, and report GO or NO-GO with evidence.",
            content: releaseReadinessContent,
          },
          {
            id: "builtin.commit-pr",
            name: "commit-pr",
            description: "Use when preparing a bounded commit or PR: review the scoped diff, write a conventional message, attach test evidence, and avoid drive-by changes; never commit unless asked.",
            content: commitPrContent,
          },
          {
            id: "builtin.context-recovery",
            name: "context-recovery",
            description: "Use when session context is under pressure or was compacted: inspect usage, recommend trim, prune, compact, or clear actions, and list what to reload afterward without fabricating history.",
            content: contextRecoveryContent,
          },
          {
            id: "builtin.plugin-audit",
            name: "plugin-audit",
            description: "Use before enabling an extension or plugin: inspect provenance, capabilities, permissions, and supply-chain posture, then return an evidence-backed enable or block verdict.",
            content: pluginAuditContent,
          },
          {
            id: "builtin.worktree-hygiene",
            name: "worktree-hygiene",
            description: "Use when cleaning up repository state: inventory worktrees, stale locks, background processes, and dirty files, then propose safe cleanup and confirm before any destructive step.",
            content: worktreeHygieneContent,
          },
        ]
        for (const skill of shipped) {
          s.skills[skill.id] = {
            id: skill.id,
            sealed: true,
            definitionDigest: createHash("sha256").update(skill.content).digest("hex"),
            name: skill.name,
            description: skill.description,
            location: "<built-in>",
            content: skill.content,
          }
        }
        yield* loadSkills(s, yield* InstanceState.get(discovered), events)
        return s
      }),
    )

    const get = Effect.fn("Skill.get")(function* (name: string) {
      const s = yield* InstanceState.get(state)
      return resolveSkill(s, name)
    })

    const require = Effect.fn("Skill.require")(function* (name: string) {
      const s = yield* InstanceState.get(state)
      const info = resolveSkill(s, name)
      if (info) return info
      return yield* new NotFoundError({ name, available: Object.keys(s.skills).toSorted() })
    })

    const all = Effect.fn("Skill.all")(function* () {
      const s = yield* InstanceState.get(state)
      return Object.values(s.skills)
    })

    const dirs = Effect.fn("Skill.dirs")(function* () {
      return (yield* InstanceState.get(discovered)).dirs
    })

    const available = Effect.fn("Skill.available")(function* (agent?: Agent.Info) {
      const s = yield* InstanceState.get(state)
      const list = Object.values(s.skills).toSorted((a, b) => a.name.localeCompare(b.name))
      if (!agent) return list
      return list.filter((skill) =>
        Permission.evaluate("skill", skill.id ?? skill.name, agent.permission).action !== "deny" &&
        Permission.evaluate("skill", skill.name, agent.permission).action !== "deny")
    })

    return Service.of({ get, require, all, dirs, available })
  }),
)

export function fmt(list: Info[], opts: { verbose: boolean }) {
  const described = list.filter((skill) => skill.description !== undefined)
  if (described.length === 0) return "No skills are currently available."
  if (opts.verbose) {
    return [
      "<available_skills>",
      ...described
        .toSorted((a, b) => a.name.localeCompare(b.name))
        .flatMap((skill) => [
          "  <skill>",
          `    <name>${escapeHtml(skill.name)}</name>`,
          ...(skill.id ? [`    <id>${escapeHtml(skill.id)}</id>`] : []),
          `    <description>${skill.description}</description>`,
          `    <location>${escapeHtml(skill.location)}</location>`,
          "  </skill>",
        ]),
      "</available_skills>",
    ].join("\n")
  }

  return [
    "## Available Skills",
    ...described
      .toSorted((a, b) => a.name.localeCompare(b.name))
      .map((skill) => `- **${skill.name}**${skill.id ? ` (${skill.id})` : ""}: ${skill.description}`),
  ].join("\n")
}

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Discovery.node, Config.node, EventV2Bridge.node, FSUtil.node, Global.node, RuntimeFlags.node],
})

export * as Skill from "."
