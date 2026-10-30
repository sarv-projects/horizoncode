import { LayerNode } from "@horizoncode/core/effect/layer-node"
import { httpClient } from "@horizoncode/core/effect/app-node-platform"
import path from "path"
import { SessionV1 } from "@horizoncode/core/v1/session"
import { Effect, Layer, Context } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Flag } from "@horizoncode/core/flag/flag"
import { FSUtil } from "@horizoncode/core/fs-util"
import { withTransientReadRetry } from "@/util/effect-http-client"
import { Global } from "@horizoncode/core/global"
import {
  DEFAULT_PROJECT_INSTRUCTION_RESOLVER_V1,
  isExcludedProjectInstructionPathV1,
} from "@horizoncode/core/session/project-instruction"
import type { MessageV2 } from "./message-v2"
import type { MessageID } from "./schema"

const MAX_COMPILED_INSTRUCTION_BYTES = DEFAULT_PROJECT_INSTRUCTION_RESOLVER_V1.maxCompiledBytes
const MAX_SUBDIRECTORY_INSTRUCTION_BYTES = 32 * 1024
const TRUNCATION_MARKER = "[project instructions truncated: middle content omitted; re-read specific files on demand]"

function extract(messages: SessionV1.WithParts[]) {
  const paths = new Set<string>()
  for (const msg of messages) {
    for (const part of msg.parts) {
      if (part.type === "tool" && part.tool === "read" && part.state.status === "completed") {
        if (part.state.time.compacted) continue
        const loaded = part.state.metadata?.loaded
        if (!loaded || !Array.isArray(loaded)) continue
        for (const p of loaded) {
          if (typeof p === "string") paths.add(p)
        }
      }
    }
  }
  return paths
}

export interface Interface {
  readonly clear: (messageID: MessageID) => Effect.Effect<void>
  readonly systemPaths: () => Effect.Effect<Set<string>, FSUtil.Error>
  readonly system: () => Effect.Effect<string[], FSUtil.Error>
  readonly find: (dir: string) => Effect.Effect<string | undefined, FSUtil.Error>
  readonly resolve: (
    messages: SessionV1.WithParts[],
    filepath: string,
    messageID: MessageID,
  ) => Effect.Effect<{ filepath: string; content: string }[], FSUtil.Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Instruction") {}

const layer: Layer.Layer<
  Service,
  never,
  FSUtil.Service | Config.Service | Global.Service | HttpClient.HttpClient | RuntimeFlags.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const cfg = yield* Config.Service
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const flags = yield* RuntimeFlags.Service
    const http = HttpClient.filterStatusOk(withTransientReadRetry(yield* HttpClient.HttpClient))
    const globalFiles = [
      path.join(global.config, "AGENTS.md"),
      ...(!flags.disableClaudeCodePrompt ? [path.join(global.home, ".claude", "CLAUDE.md")] : []),
    ]
    const instructionFiles = [
      "AGENTS.md",
      ...(!flags.disableClaudeCodePrompt ? ["CLAUDE.md"] : []),
      "CONTEXT.md", // deprecated
    ]

    const state = yield* InstanceState.make(
      Effect.fn("Instruction.state")(() =>
        Effect.succeed({
          // Track which instruction files have already been attached for a given assistant message.
          claims: new Map<MessageID, Set<string>>(),
        }),
      ),
    )

    const relative = Effect.fnUntraced(function* (instruction: string) {
      const ctx = yield* InstanceState.context
      if (!Flag.OPENCODE_DISABLE_PROJECT_CONFIG) {
        return yield* fs
          .globUp(instruction, ctx.directory, ctx.worktree)
          .pipe(Effect.catch(() => Effect.succeed([] as string[])))
      }
      return yield* fs
        .globUp(instruction, global.config, global.config)
        .pipe(Effect.catch(() => Effect.succeed([] as string[])))
    })

    const read = Effect.fnUntraced(function* (filepath: string) {
      return yield* fs.readFileString(filepath).pipe(Effect.catch(() => Effect.succeed("")))
    })

    const fetch = Effect.fnUntraced(function* (url: string) {
      const res = yield* http.execute(HttpClientRequest.get(url)).pipe(
        Effect.timeout(5000),
        Effect.catch(() => Effect.succeed(null)),
      )
      if (!res) return ""
      const body = yield* res.arrayBuffer.pipe(Effect.catch(() => Effect.succeed(new ArrayBuffer(0))))
      return new TextDecoder().decode(body)
    })

    const clear = Effect.fn("Instruction.clear")(function* (messageID: MessageID) {
      const s = yield* InstanceState.get(state)
      s.claims.delete(messageID)
    })

    const systemPaths = Effect.fn("Instruction.systemPaths")(function* () {
      const config = yield* cfg.get()
      const ctx = yield* InstanceState.context
      const paths = new Set<string>()

      for (const file of globalFiles) {
        if (yield* fs.existsSafe(file)) {
          paths.add(path.resolve(file))
          break
        }
      }

      // §29.23 loads the whole root→cwd ancestor chain, not only the nearest file.
      // Sibling package instructions stay out unless a Guarded read enters them.
      if (!Flag.OPENCODE_DISABLE_PROJECT_CONFIG) {
        const root = path.resolve(ctx.worktree)
        const cwd = path.resolve(ctx.directory)
        const inside = cwd === root || cwd.startsWith(`${root}${path.sep}`)
        if (inside) {
          const relative = path.relative(root, cwd)
          const parts = relative === "" ? [] : relative.split(path.sep)
          let current = root
          for (let index = 0; index <= parts.length; index += 1) {
            const found = yield* find(current)
            if (found) {
              const relativePath = path.relative(root, found)
              if (!isExcludedProjectInstructionPathV1(relativePath.split(path.sep).join("/"))) {
                paths.add(path.resolve(found))
              }
            }
            if (index < parts.length) current = path.join(current, parts[index]!)
          }
        } else {
          // A directory outside the bound project root has no ancestor union; keep
          // the old nearest-file behavior rather than walking arbitrary parents.
          for (const file of instructionFiles) {
            const matches = yield* fs
              .findUp(file, ctx.directory, ctx.worktree)
              .pipe(Effect.catch(() => Effect.succeed([])))
            if (matches.length > 0) {
              matches.forEach((item) => paths.add(path.resolve(item)))
              break
            }
          }
        }
      }

      if (config.instructions) {
        for (const raw of config.instructions) {
          if (raw.startsWith("https://") || raw.startsWith("http://")) continue
          const instruction = raw.startsWith("~/") ? path.join(global.home, raw.slice(2)) : raw
          const matches = yield* (
            path.isAbsolute(instruction)
              ? fs.glob(path.basename(instruction), {
                  cwd: path.dirname(instruction),
                  absolute: true,
                  include: "file",
                })
              : relative(instruction)
          ).pipe(Effect.catch(() => Effect.succeed([] as string[])))
          matches.forEach((item) => paths.add(path.resolve(item)))
        }
      }

      return paths
    })

    const boundedRules = (input: string[]) => {
      const encoder = new TextEncoder()
      const total = input.reduce((sum, item) => sum + encoder.encode(item).byteLength + 2, 0)
      if (total <= MAX_COMPILED_INSTRUCTION_BYTES) return input
      const limit = MAX_COMPILED_INSTRUCTION_BYTES - encoder.encode(TRUNCATION_MARKER).byteLength - 2
      const clip = (value: string, maxBytes: number, fromEnd: boolean) => {
        if (encoder.encode(value).byteLength <= maxBytes) return value
        const points = Array.from(value)
        let result = ""
        const ordered = fromEnd ? [...points].reverse() : points
        for (const point of ordered) {
          if (encoder.encode(result + point).byteLength > maxBytes) break
          result += point
        }
        return fromEnd ? `…${[...result].reverse().join("")}` : `${result}…`
      }
      const budget = Math.max(0, Math.floor(limit / 2))
      const head: string[] = []
      let headBytes = 0
      for (const rule of input) {
        const size = encoder.encode(rule).byteLength + 2
        if (headBytes + size > budget) break
        head.push(rule)
        headBytes += size
      }
      // A single oversized rule is sampled inside the rule rather than dropped.
      if (head.length === 0 && input.length > 0) {
        head.push(clip(input[0]!, limit, false))
        headBytes = encoder.encode(head[0]!).byteLength + 2
      }
      const tail: string[] = []
      let tailBytes = 0
      for (let index = input.length - 1; index >= head.length; index -= 1) {
        const rule = input[index]!
        const size = encoder.encode(rule).byteLength + 2
        if (tailBytes + size > limit - headBytes) break
        tail.unshift(rule)
        tailBytes += size
      }
      if (tail.length === 0 && input.length > head.length) {
        const candidate = clip(input[input.length - 1]!, Math.max(0, limit - headBytes), true)
        if (candidate.length > 0) tail.push(candidate)
      }
      return [...head, TRUNCATION_MARKER, ...tail]
    }

    const system = Effect.fn("Instruction.system")(function* () {
      const config = yield* cfg.get()
      const paths = yield* systemPaths()
      const urls = (config.instructions ?? []).filter(
        (item) => item.startsWith("https://") || item.startsWith("http://"),
      )

      const files = yield* Effect.forEach(Array.from(paths), read, { concurrency: 8 })
      const remote = yield* Effect.forEach(urls, fetch, { concurrency: 4 })

      return boundedRules([
        ...Array.from(paths).flatMap((item, i) => (files[i] ? [`Instructions from: ${item}\n${files[i]}`] : [])),
        ...urls.flatMap((item, i) => (remote[i] ? [`Instructions from: ${item}\n${remote[i]}`] : [])),
      ])
    })

    const find = Effect.fn("Instruction.find")(function* (dir: string) {
      for (const file of instructionFiles) {
        const filepath = path.resolve(path.join(dir, file))
        if (yield* fs.existsSafe(filepath)) return filepath
      }
      return undefined
    })

    const resolve = Effect.fn("Instruction.resolve")(function* (
      messages: SessionV1.WithParts[],
      filepath: string,
      messageID: MessageID,
    ) {
      const sys = yield* systemPaths()
      const already = extract(messages)
      const results: { filepath: string; content: string }[] = []
      const s = yield* InstanceState.get(state)
      const root = path.resolve(yield* InstanceState.directory)
      const encoder = new TextEncoder()

      const target = path.resolve(filepath)
      let current = path.dirname(target)
      let remainingBytes = MAX_SUBDIRECTORY_INSTRUCTION_BYTES

      // Walk upward from the file being read and attach nearby instruction files once per message.
      while (current.startsWith(root) && current !== root) {
        const found = yield* find(current)
        if (!found || found === target || sys.has(found) || already.has(found)) {
          current = path.dirname(current)
          continue
        }
        if (isExcludedProjectInstructionPathV1(path.relative(root, found).split(path.sep).join("/"))) {
          current = path.dirname(current)
          continue
        }

        let set = s.claims.get(messageID)
        if (!set) {
          set = new Set()
          s.claims.set(messageID, set)
        }
        if (set.has(found)) {
          current = path.dirname(current)
          continue
        }

        set.add(found)
        const raw = yield* read(found)
        if (raw) {
          const header = `Instructions from: ${found}\n`
          const headerBytes = encoder.encode(header).byteLength
          if (headerBytes >= remainingBytes) break
          const available = remainingBytes - headerBytes - 3
          let content = raw
          if (encoder.encode(content).byteLength > available) {
            content = ""
            for (const point of raw) {
              if (encoder.encode(content + point).byteLength > Math.max(0, available)) break
              content += point
            }
            content = `${content}…`
          }
          remainingBytes -= headerBytes + encoder.encode(content).byteLength
          results.push({ filepath: found, content: `${header}${content}` })
          if (remainingBytes <= 0) break
        }

        current = path.dirname(current)
      }

      return results
    })

    return Service.of({ clear, systemPaths, system, find, resolve })
  }),
)

export function loaded(messages: SessionV1.WithParts[]) {
  return extract(messages)
}

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Config.node, FSUtil.node, Global.node, RuntimeFlags.node, httpClient],
})

export * as Instruction from "./instruction"
