export * as Ripgrep from "./ripgrep"

import path from "path"
import { Context, Effect, Layer, Schema } from "effect"
import { Entry, Match } from "@horizoncode/schema/filesystem"
import { Fff } from "#fff"
import { makeGlobalNode } from "./effect/app-node"
import { FSUtil } from "./fs-util"
import { waitForAbort } from "./process"
import { RelativePath } from "./schema"

/**
 * In-process search adapter for find / glob / grep.
 *
 * Search used to shell out to the ripgrep binary. A spawn is a raw process
 * origin that only an authenticated HostKernel Guard lease may authorize, so
 * that route was hard-gated closed and every grep/glob call failed with
 * "Ripgrep is unavailable".
 *
 * The same capability is already available in-process: the native fff index
 * (the backend `FileSystemSearch.fffLayer` reads) greps with a regex engine
 * under a bounded time budget and globs with the same syntax, and it never
 * spawns anything. This adapter serves the Ripgrep interface from that index,
 * so availability now reflects whether a backend can actually answer a query.
 *
 * Only the engine is replaced: results stay workspace-relative and containment
 * is delegated to `FSUtil.contains` rather than reimplemented here.
 */

const SCAN_TIMEOUT_MS = 15_000
const GREP_TIME_BUDGET_MS = 1_500
const MAX_LINE_LENGTH = 2_000
/** Page size used when a negated pattern forces a full scan before filtering. */
const NEGATED_SCAN_PAGE = 4_096

export class Error extends Schema.TaggedErrorClass<Error>()("Ripgrep.Error", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export class InvalidPatternError extends Schema.TaggedErrorClass<InvalidPatternError>()("Ripgrep.InvalidPatternError", {
  pattern: Schema.String,
  message: Schema.String,
}) {}

export interface FindInput {
  readonly cwd: string
  readonly pattern: string
  readonly limit: number
  readonly hidden?: boolean
  readonly follow?: boolean
  readonly signal?: AbortSignal
  readonly onEntry?: (entry: Entry) => Effect.Effect<void>
}

export interface GlobInput {
  readonly cwd: string
  readonly pattern: string
  readonly limit: number
  readonly hidden?: boolean
  readonly follow?: boolean
  readonly signal?: AbortSignal
}

export interface GrepInput {
  readonly cwd: string
  readonly pattern: string
  readonly file?: string
  readonly include?: string
  readonly limit: number
  readonly signal?: AbortSignal
}

export interface Interface {
  readonly find: (input: FindInput) => Effect.Effect<readonly Entry[], Error>
  readonly glob: (input: GlobInput) => Effect.Effect<readonly Entry[], Error>
  readonly grep: (input: GrepInput) => Effect.Effect<readonly Match[], Error | InvalidPatternError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Ripgrep") {}

const failure = (message: string, cause?: unknown) => new Error({ message, cause })

/**
 * Availability of the search backend. True only when the in-process index can
 * actually serve a query in this runtime (`#fff` binds to a no-op under Node or
 * when the native addon is missing), so callers still fail closed instead of
 * silently returning empty results.
 */
export function searchBackendAvailable(): boolean {
  return Fff.available()
}

/**
 * Historical name kept for the callers that still probe the old process gate.
 * There is no process route left to probe: the answer mirrors the in-process
 * backend, so it is never an unconditional `false`.
 */
export function ripgrepProcessRouteAvailable(): boolean {
  return searchBackendAvailable()
}

const unavailable = () => failure("Search is unavailable: the in-process file index (fff) is not present in this runtime")

/** Normalise a backend path to a workspace-relative POSIX path. */
const posix = (value: string) =>
  value
    .replaceAll("\\", "/")
    .replace(/^(?:\.\/)+/u, "")
    .replace(/^\/+/u, "")

/** Reuse the filesystem layer's containment rule; never resolve outside `root`. */
const contained = (root: string, relative: string) =>
  relative.length > 0 && !path.isAbsolute(relative) && FSUtil.contains(root, path.resolve(root, relative))

const gitPath = (relative: string) => relative.split("/").includes(".git")

const dotPath = (relative: string) => relative.split("/").some((segment) => segment.startsWith("."))

/**
 * Minimal glob matcher, used only to honour ripgrep's negated `--glob` form
 * (`!**\/SKILL.md`) that the index cannot express as an exclusion. Supports
 * `*`, `**`, `?` and `{a,b}`; no dependency is added for this.
 */
const globMatcher = (pattern: string) => {
  let source = ""
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern.charAt(index)
    if (char === "*") {
      if (pattern.charAt(index + 1) === "*") {
        index++
        if (pattern.charAt(index + 1) === "/") {
          index++
          source += "(?:.*/)?"
        } else {
          source += ".*"
        }
      } else {
        source += "[^/]*"
      }
      continue
    }
    if (char === "?") {
      source += "[^/]"
      continue
    }
    if (char === "{") {
      const close = pattern.indexOf("}", index)
      if (close > index) {
        const alternatives = pattern
          .slice(index + 1, close)
          .split(",")
          .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
          .join("|")
        source += `(?:${alternatives})`
        index = close
        continue
      }
    }
    source += char.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
  }
  return new RegExp(`^${source}$`, "u")
}

/**
 * The index answers unparseable patterns with an empty result, so reject them
 * up front instead. Inline flags such as `(?i)` are Rust-regex syntax that JS
 * cannot compile but the backend does honour, so strip them before deciding.
 */
const invalidPattern = (pattern: string) => {
  try {
    new RegExp(pattern)
    return false
  } catch {}
  try {
    new RegExp(pattern.replace(/^\(\?[a-zA-Z]+\)/u, ""))
    return false
  } catch {
    return true
  }
}

const toMatch = (hit: Fff.Hit, relative: RelativePath): Match => {
  const bytes = Buffer.from(hit.lineContent)
  return Match.make({
    entry: Entry.make({ path: relative, type: "file" }),
    line: hit.lineNumber,
    offset: hit.byteOffset,
    text:
      hit.lineContent.length > MAX_LINE_LENGTH
        ? hit.lineContent.slice(0, MAX_LINE_LENGTH).replace(/[\uD800-\uDBFF]$/u, "") + "..."
        : hit.lineContent,
    submatches: hit.matchRanges.map(([start, end]) => ({
      text: bytes.subarray(start, end).toString("utf8"),
      start,
      end,
    })),
  })
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // One index per searched root; the backend watches the tree after the first
    // scan, so repeat queries in the same run are served from memory.
    const pickers = new Map<string, Fff.Picker>()

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const picker of pickers.values()) picker.destroy()
        pickers.clear()
      }),
    )

    const picker = (cwd: string): Effect.Effect<Fff.Picker, Error> =>
      Effect.suspend(() => {
        if (!searchBackendAvailable()) return Effect.fail(unavailable())
        const cached = pickers.get(cwd)
        if (cached) return Effect.succeed(cached)
        return Effect.try({
          try: () =>
            Fff.create({ basePath: cwd, aiMode: true, disableMmapCache: true, disableContentIndexing: true }),
          catch: (cause) => failure("Unable to open the in-process search index", cause),
        }).pipe(
          Effect.flatMap((made) => {
            if (!made.ok) return Effect.fail(failure(`Unable to open the in-process search index: ${made.error}`))
            pickers.set(cwd, made.value)
            return Effect.succeed(made.value)
          }),
        )
      })

    /**
     * The index scans asynchronously. Wait for that first scan (bounded) so the
     * first query is not silently empty. A scan that only times out still answers
     * from the partial index instead of failing the tool.
     */
    const ready = (cwd: string): Effect.Effect<Fff.Picker, Error> =>
      picker(cwd).pipe(
        Effect.flatMap((instance) =>
          Effect.tryPromise({
            try: () => instance.waitForScan(SCAN_TIMEOUT_MS),
            catch: (cause) => failure("Search index scan failed", cause),
          }).pipe(
            Effect.flatMap((scanned) =>
              scanned.ok ? Effect.succeed(instance) : Effect.fail(failure(`Search index unavailable: ${scanned.error}`)),
            ),
          ),
        ),
      )

    const query = <A>(label: string, signal: AbortSignal | undefined, run: () => A): Effect.Effect<A, Error> => {
      const effect = Effect.suspend(() =>
        Effect.try({ try: run, catch: (cause) => failure(`${label} failed`, cause) }),
      )
      if (!signal) return effect
      // Aborts surface the platform `Error`, which is a different value from the
      // adapter's tagged error; fold it in so callers keep a single error type.
      return effect.pipe(
        Effect.raceFirst(waitForAbort(signal)),
        Effect.mapError((cause) => (cause instanceof Error ? cause : failure(`${label} aborted`, cause))),
      )
    }

    const entries = (
      root: string,
      items: readonly { readonly relativePath: string }[],
      hidden: boolean | undefined,
      limit: number,
      exclude?: RegExp,
    ) =>
      items
        .map((item) => posix(item.relativePath))
        .filter((relative) => contained(root, relative))
        .filter((relative) => !gitPath(relative))
        .filter((relative) => hidden === true || !dotPath(relative))
        .filter((relative) => exclude === undefined || !exclude.test(relative))
        .slice(0, limit)
        .map((relative) => Entry.make({ path: RelativePath.make(relative), type: "file" }))

    return Service.of({
      find: (input) =>
        Effect.gen(function* () {
          const cwd = path.resolve(input.cwd)
          const instance = yield* ready(cwd)
          const negated = input.pattern.startsWith("!")
          const wanted = negated ? input.pattern.slice(1) : input.pattern
          const pattern = negated || wanted.trim().length === 0 || wanted.trim() === "*" ? "**/*" : wanted
          const page = negated ? Math.max(input.limit * 8, NEGATED_SCAN_PAGE) : input.limit
          const found = yield* query("find", input.signal, () =>
            instance.glob(pattern, { pageIndex: 0, pageSize: page }),
          )
          if (!found.ok) return yield* Effect.fail(failure(`Search failed: ${found.error}`))
          const limit = Math.max(input.limit, 1)
          const result = entries(cwd, found.value.items, input.hidden, limit, negated ? globMatcher(posix(wanted)) : undefined)
          for (const entry of result) if (input.onEntry) yield* input.onEntry(entry)
          return result
        }),
      glob: (input) =>
        Effect.gen(function* () {
          const cwd = path.resolve(input.cwd)
          if (!input.pattern) return yield* Effect.fail(failure("glob pattern is required"))
          const instance = yield* ready(cwd)
          const found = yield* query("glob", input.signal, () =>
            instance.glob(input.pattern, { pageIndex: 0, pageSize: input.limit }),
          )
          if (!found.ok) return yield* Effect.fail(failure(`Search failed: ${found.error}`))
          return entries(cwd, found.value.items, input.hidden, Math.max(input.limit, 1))
        }),
      grep: (input) =>
        Effect.gen(function* () {
          if (!input.pattern) return yield* Effect.fail(failure("pattern is required"))
          if (invalidPattern(input.pattern))
            return yield* Effect.fail(
              new InvalidPatternError({ pattern: input.pattern, message: `Invalid regular expression: ${input.pattern}` }),
            )
          const cwd = path.resolve(input.cwd)
          const instance = yield* ready(cwd)
          // The index takes "<glob filters> <pattern>" as one query, the same
          // shape FileSystemSearch.fffLayer builds for its include filter.
          const text = [input.file, input.include, input.pattern]
            .filter((part): part is string => part !== undefined && part.trim().length > 0)
            .join(" ")
          const found = yield* query("grep", input.signal, () =>
            instance.grep(text, { mode: "regex", pageSize: input.limit, timeBudgetMs: GREP_TIME_BUDGET_MS }),
          )
          if (!found.ok) return yield* Effect.fail(failure(`Search failed: ${found.error}`))
          return found.value.items
            .map((hit) => ({ hit, relative: posix(hit.relativePath) }))
            .filter(({ relative }) => contained(cwd, relative))
            .filter(({ relative }) => !gitPath(relative))
            .slice(0, Math.max(input.limit, 1))
            .map(({ hit, relative }) => toMatch(hit, RelativePath.make(relative)))
        }),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer: layer, deps: [] })
