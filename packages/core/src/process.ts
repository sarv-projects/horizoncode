import { Context, Duration, Effect, Fiber, Layer, Schema, Stream } from "effect"
import { createHash } from "node:crypto"
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs"
import { dirname } from "node:path"
import { systemError } from "effect/PlatformError"
import type { PlatformError } from "effect/PlatformError"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { CrossSpawnSpawner } from "./cross-spawn-spawner"
import { makeGlobalNode } from "./effect/app-node"

export class AppProcessError extends Schema.TaggedErrorClass<AppProcessError>()("AppProcessError", {
  command: Schema.String,
  exitCode: Schema.optional(Schema.Number),
  stderr: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    const detail =
      this.stderr?.trim() || (this.cause instanceof Error ? this.cause.message : this.cause && String(this.cause))
    const status = this.exitCode === undefined ? "" : ` (exit ${this.exitCode})`
    return `Command failed${status}: ${this.command}${detail ? `: ${detail}` : ""}`
  }
}

export interface RunOptions {
  readonly combineOutput?: boolean
  readonly maxOutputBytes?: number
  readonly maxErrorBytes?: number
  readonly signal?: AbortSignal
  readonly timeout?: Duration.Input
  readonly stdin?: string | Uint8Array | Stream.Stream<Uint8Array, PlatformError>
}

export interface RunStreamOptions {
  readonly signal?: AbortSignal
  readonly includeStderr?: boolean
  readonly okExitCodes?: ReadonlyArray<number>
  readonly maxErrorBytes?: number
}

export interface RunResult {
  readonly command: string
  readonly exitCode: number
  readonly output?: Buffer
  readonly stdout: Buffer
  readonly stderr: Buffer
  readonly outputTruncated?: boolean
  readonly stdoutTruncated: boolean
  readonly stderrTruncated: boolean
}

export type Interface = ChildProcessSpawner["Service"] & {
  readonly run: (command: ChildProcess.Command, options?: RunOptions) => Effect.Effect<RunResult, AppProcessError>
  readonly runStream: (
    command: ChildProcess.Command,
    options?: RunStreamOptions,
  ) => Stream.Stream<string, AppProcessError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/AppProcess") {}

export const requireSuccess = (result: RunResult): Effect.Effect<RunResult, AppProcessError> =>
  result.exitCode === 0
    ? Effect.succeed(result)
    : Effect.fail(
        new AppProcessError({
          command: result.command,
          exitCode: result.exitCode,
          stderr: result.stderr.toString("utf8"),
        }),
      )

export const requireExitIn =
  (codes: ReadonlyArray<number>) =>
  (result: RunResult): Effect.Effect<RunResult, AppProcessError> =>
    codes.includes(result.exitCode)
      ? Effect.succeed(result)
      : Effect.fail(
          new AppProcessError({
            command: result.command,
            exitCode: result.exitCode,
            stderr: result.stderr.toString("utf8"),
          }),
        )

const describeCommand = (command: ChildProcess.Command): string => {
  if (command._tag === "StandardCommand") {
    return command.args.length ? `${command.command} ${command.args.join(" ")}` : command.command
  }
  return `${describeCommand(command.left)} | ${describeCommand(command.right)}`
}

const standardCommand = (command: ChildProcess.Command) =>
  command._tag === "StandardCommand" ? command : undefined

const absoluteOption = (argument: string, key: string) =>
  argument.startsWith(`--${key}=`) && argument.slice(key.length + 3).startsWith("/")

type PinnedSupervisorExecutable = {
  readonly binaryName: "hz-kernel" | "session_supervisor"
  readonly sha256: string
  readonly device: number
  readonly inode: number
  readonly size: number
  readonly modifiedAt: number
  readonly changedAt: number
}

type PinnedSupervisorSource = {
  readonly device: number
  readonly inode: number
  readonly size: number
  readonly modifiedAt: number
  readonly changedAt: number
}

type PinnedCodeModeHelperRoot = {
  readonly helperSha256: string
  readonly manifestSha256: string
  readonly directoryDevice: number
  readonly directoryInode: number
  readonly helper: ReturnType<typeof secureRegularFile>
  readonly manifest: ReturnType<typeof secureRegularFile>
}

const pinnedSupervisorExecutables = new Map<string, PinnedSupervisorExecutable>()
const pinnedSupervisorSources = new Map<string, PinnedSupervisorSource>()
const pinnedCodeModeHelperRoots = new Map<string, PinnedCodeModeHelperRoot>()

function secureRegularFile(path: string, executable: boolean, privateInstall = true) {
  if (!path.startsWith("/")) throw new Error("control process path must be absolute")
  const canonical = realpathSync(path)
  const link = lstatSync(path)
  const file = statSync(path)
  const directoryPath = dirname(canonical)
  const directoryLink = lstatSync(directoryPath)
  const directory = statSync(directoryPath)
  const uid = process.getuid?.()
  if (
    canonical !== path ||
    link.isSymbolicLink() ||
    !link.isFile() ||
    link.nlink !== 1 ||
    (uid !== undefined && link.uid !== uid) ||
    (privateInstall ? (link.mode & 0o077) !== 0 : (link.mode & 0o022) !== 0) ||
    (executable && (link.mode & 0o100) === 0) ||
    directoryLink.isSymbolicLink() ||
    !directory.isDirectory() ||
    realpathSync(directoryPath) !== directoryPath ||
    (uid !== undefined && directory.uid !== uid) ||
    (privateInstall ? (directory.mode & 0o077) !== 0 : (directory.mode & 0o022) !== 0) ||
    file.dev !== link.dev ||
    file.ino !== link.ino
  ) {
    throw new Error("control process file identity is not private and stable")
  }
  return {
    device: link.dev,
    inode: link.ino,
    size: link.size,
    modifiedAt: link.mtimeMs,
    changedAt: link.ctimeMs,
  }
}

/**
 * Pin only the manifest-verified, owner-only binary returned by
 * `installBundledBinary`. A basename alone is never executable authority.
 */
export function pinSupervisorExecutable(input: {
  readonly path: string
  readonly binaryName: "hz-kernel" | "session_supervisor"
  readonly sha256: string
}) {
  if (!/^[0-9a-f]{64}$/.test(input.sha256) || !input.path.endsWith(`/${input.binaryName}-${input.sha256}`)) {
    throw new Error("control process executable does not match its pinned manifest identity")
  }
  const identity = secureRegularFile(input.path, true)
  const actual = createHash("sha256").update(readFileSync(input.path)).digest("hex")
  if (actual !== input.sha256) throw new Error("control process executable digest differs from its manifest")
  pinnedSupervisorExecutables.set(input.path, { ...identity, binaryName: input.binaryName, sha256: input.sha256 })
}

/** Bind the observer's read-only source file to one exact, canonical inode. */
export function pinSupervisorSource(path: string) {
  const identity = secureRegularFile(path, false, false)
  pinnedSupervisorSources.set(path, identity)
}

/** Pin the private, fixed CodeMode helper install consumed only by HostKernel. */
export function pinCodeModeHelperRoot(input: { readonly path: string; readonly sha256: string }) {
  if (!/^sha256:[0-9a-f]{64}$/.test(input.sha256) || !input.path.endsWith("/codemode-helper")) {
    throw new Error("CodeMode helper root does not match its fixed bundled identity")
  }
  const directory = lstatSync(input.path)
  if (!directory.isDirectory() || directory.isSymbolicLink() || realpathSync(input.path) !== input.path ||
    (process.getuid && directory.uid !== process.getuid()) || (directory.mode & 0o077) !== 0) {
    throw new Error("CodeMode helper root is not a private canonical directory")
  }
  const helperPath = `${input.path}/codemode-helper.js`
  const manifestPath = `${input.path}/codemode-helper.manifest.json`
  const helper = secureRegularFile(helperPath, false)
  const manifest = secureRegularFile(manifestPath, false)
  const manifestBytes = readFileSync(manifestPath)
  const parsed = JSON.parse(manifestBytes.toString("utf8")) as Record<string, unknown>
  if (parsed.schemaVersion !== 1 || parsed.status !== "available" || parsed.helperSelector !== "horizoncode:codemode:bun" ||
    parsed.relativeEntrypoint !== "codemode-helper.js" || parsed.sha256 !== input.sha256 ||
    parsed.target !== `linux-${process.arch}-gnu` || createHash("sha256").update(readFileSync(helperPath)).digest("hex") !== input.sha256.slice("sha256:".length)) {
    throw new Error("CodeMode helper manifest or asset differs from its fixed build pin")
  }
  pinnedCodeModeHelperRoots.set(input.path, {
    helperSha256: input.sha256.slice("sha256:".length),
    manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
    directoryDevice: directory.dev,
    directoryInode: directory.ino,
    helper,
    manifest,
  })
}

function isPinnedCodeModeHelperRoot(path: string) {
  const pin = pinnedCodeModeHelperRoots.get(path)
  if (!pin) return false
  try {
    const directory = lstatSync(path)
    if (!directory.isDirectory() || directory.isSymbolicLink() || realpathSync(path) !== path ||
      directory.dev !== pin.directoryDevice || directory.ino !== pin.directoryInode ||
      (process.getuid && directory.uid !== process.getuid()) || (directory.mode & 0o077) !== 0) return false
    const helperPath = `${path}/codemode-helper.js`
    const manifestPath = `${path}/codemode-helper.manifest.json`
    const helper = secureRegularFile(helperPath, false)
    const manifest = secureRegularFile(manifestPath, false)
    const same = (left: ReturnType<typeof secureRegularFile>, right: ReturnType<typeof secureRegularFile>) =>
      left.device === right.device && left.inode === right.inode && left.size === right.size &&
      left.modifiedAt === right.modifiedAt && left.changedAt === right.changedAt
    if (!same(helper, pin.helper) || !same(manifest, pin.manifest)) return false
    const manifestBytes = readFileSync(manifestPath)
    const parsed = JSON.parse(manifestBytes.toString("utf8")) as Record<string, unknown>
    return createHash("sha256").update(manifestBytes).digest("hex") === pin.manifestSha256 &&
      parsed.schemaVersion === 1 && parsed.status === "available" &&
      parsed.helperSelector === "horizoncode:codemode:bun" && parsed.relativeEntrypoint === "codemode-helper.js" &&
      parsed.sha256 === `sha256:${pin.helperSha256}` && parsed.target === `linux-${process.arch}-gnu` &&
      createHash("sha256").update(readFileSync(helperPath)).digest("hex") === pin.helperSha256
  } catch {
    return false
  }
}

function isPinnedSupervisorExecutable(path: string, binaryName: "hz-kernel" | "session_supervisor") {
  const pin = pinnedSupervisorExecutables.get(path)
  if (!pin || pin.binaryName !== binaryName) return false
  try {
    const current = secureRegularFile(path, true)
    if (
      current.device !== pin.device || current.inode !== pin.inode || current.size !== pin.size ||
      current.modifiedAt !== pin.modifiedAt || current.changedAt !== pin.changedAt
    ) return false
    return createHash("sha256").update(readFileSync(path)).digest("hex") === pin.sha256
  } catch {
    return false
  }
}

function pinnedSupervisorBinaryName(path: string) {
  const pin = pinnedSupervisorExecutables.get(path)
  if (!pin || !isPinnedSupervisorExecutable(path, pin.binaryName)) return undefined
  return pin.binaryName
}

function isPinnedSupervisorSource(path: string) {
  const pin = pinnedSupervisorSources.get(path)
  if (!pin) return false
  try {
    const current = secureRegularFile(path, false, false)
    return current.device === pin.device && current.inode === pin.inode && current.size === pin.size &&
      current.modifiedAt === pin.modifiedAt && current.changedAt === pin.changedAt
  } catch {
    return false
  }
}

/**
 * The only processes that Core may start directly are the fixed HostKernel and
 * read-only Session observer control children. User/model/tool commands must use
 * Rust Guard/ExecutionHost. This is a structural allowlist, not a shell parser:
 * piped commands and every other executable are rejected before the spawner.
 */
const isSupervisorControlLaunch = (command: ChildProcess.Command) => {
  const standard = standardCommand(command)
  if (!standard || !standard.command.startsWith("/")) return false
  const { args, options } = standard
  if (options.extendEnv !== false || options.stdin !== "ignore" || options.stdout !== "ignore" || options.stderr !== "ignore")
    return false
  const binaryName = pinnedSupervisorBinaryName(standard.command)
  if (binaryName === "hz-kernel") {
    const helperArg = args.length === 6 ? args[5] : undefined
    const helperRoot = helperArg?.slice("--codemode-helper-root=".length)
    return isPinnedSupervisorExecutable(standard.command, "hz-kernel") && (args.length === 5 || args.length === 6)
      && absoluteOption(args[0]!, "state-dir")
      && absoluteOption(args[1]!, "socket")
      && absoluteOption(args[2]!, "host-exe")
      && /^--nonce=[A-Za-z0-9_-]{1,128}$/.test(args[3]!)
      && /^--incarnation=[A-Za-z0-9_-]{1,128}$/.test(args[4]!)
      && (args.length === 5 || (helperArg !== undefined && absoluteOption(helperArg, "codemode-helper-root") &&
        helperRoot !== undefined && isPinnedCodeModeHelperRoot(helperRoot)))
  }
  if (binaryName === "session_supervisor") {
    const source = args[0]?.slice("--source=".length)
    return isPinnedSupervisorExecutable(standard.command, "session_supervisor") &&
      source !== undefined && isPinnedSupervisorSource(source) && args.length === 8
      && absoluteOption(args[0]!, "source")
      && absoluteOption(args[1]!, "state-dir")
      && absoluteOption(args[2]!, "socket")
      && absoluteOption(args[3]!, "host-exe")
      && /^--session=ses_[A-Za-z0-9_-]{1,128}$/.test(args[4]!)
      && /^--nonce=[A-Za-z0-9_-]{1,128}$/.test(args[5]!)
      && /^--incarnation=[A-Za-z0-9_-]{1,128}$/.test(args[6]!)
      && /^--owner-epoch=[1-9][0-9]*$/.test(args[7]!)
  }
  return false
}

/** Safe, metadata-only handshake probe accepted for the two trusted control binaries. */
const isHostDigestProbe = (command: ChildProcess.Command) => {
  const standard = standardCommand(command)
  if (!standard || !standard.command.startsWith("/")) return false
  const options = standard.options
  const binaryName = pinnedSupervisorBinaryName(standard.command)
  return binaryName !== undefined
    && standard.args.length === 1
    && absoluteOption(standard.args[0]!, "digest-host-executable")
    && options.extendEnv === false
    && options.stdin === "ignore"
    && options.stdout === "pipe"
    && options.stderr === "pipe"
}

const processUnavailable = () =>
  new AppProcessError({
    // A denied command can contain credentials or private prompt/tool data in its
    // arguments. Do not copy it into a user-visible error or diagnostic field.
    command: "Guarded HostKernel capability",
    cause: new Error("Direct process execution is unavailable; use a Guarded HostKernel capability"),
  })

const spawnUnavailable = () =>
  systemError({
    _tag: "PermissionDenied",
    module: "ChildProcess",
    method: "spawn",
    // PlatformError fields are commonly logged by callers. A denied process
    // descriptor can contain secrets, so report only the denied authority class.
    pathOrDescriptor: "Guarded HostKernel capability",
    cause: new Error("Direct process execution is unavailable; use a Guarded HostKernel capability"),
  })

const wrapError = (description: string, cause: unknown): AppProcessError =>
  cause instanceof AppProcessError ? cause : new AppProcessError({ command: description, cause })

export const abortError = (signal: AbortSignal): Error => {
  const reason = signal.reason
  if (reason instanceof Error) return reason
  const err = new Error("Aborted")
  err.name = "AbortError"
  return err
}

export const waitForAbort = (signal: AbortSignal) =>
  Effect.callback<never, Error>((resume) => {
    if (signal.aborted) {
      resume(Effect.fail(abortError(signal)))
      return
    }
    const onabort = () => resume(Effect.fail(abortError(signal)))
    signal.addEventListener("abort", onabort, { once: true })
    return Effect.sync(() => signal.removeEventListener("abort", onabort))
  })

const normalizeStdin = (
  input: string | Uint8Array | Stream.Stream<Uint8Array, PlatformError>,
): Stream.Stream<Uint8Array, PlatformError> =>
  typeof input === "string"
    ? Stream.make(new TextEncoder().encode(input))
    : input instanceof Uint8Array
      ? Stream.make(input)
      : input

export const collectStream = (stream: Stream.Stream<Uint8Array, PlatformError>, maxOutputBytes: number | undefined) =>
  Stream.runFold(
    stream,
    () => ({ chunks: [] as Uint8Array[], bytes: 0, truncated: false }),
    (acc, chunk) => {
      if (maxOutputBytes === undefined) {
        acc.chunks.push(chunk)
        acc.bytes += chunk.length
        return acc
      }
      const remaining = maxOutputBytes - acc.bytes
      if (remaining > 0) acc.chunks.push(remaining >= chunk.length ? chunk : chunk.slice(0, remaining))
      acc.bytes += chunk.length
      acc.truncated = acc.truncated || acc.bytes > maxOutputBytes
      return acc
    },
  ).pipe(Effect.map((x) => ({ buffer: Buffer.concat(x.chunks), truncated: x.truncated })))

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner

    const runCommand = (command: ChildProcess.Command, options?: RunOptions) => {
      if (!isHostDigestProbe(command)) return Effect.fail(processUnavailable())
      const description = describeCommand(command)
      const collect = Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* spawner.spawn(command)
          if (options?.combineOutput) {
            const [output, exitCode] = yield* Effect.all(
              [collectStream(handle.all, options.maxOutputBytes), handle.exitCode],
              { concurrency: "unbounded" },
            )
            return {
              command: description,
              exitCode,
              output: output.buffer,
              stdout: Buffer.alloc(0),
              stderr: Buffer.alloc(0),
              outputTruncated: output.truncated,
              stdoutTruncated: false,
              stderrTruncated: false,
            } satisfies RunResult
          }
          const [stdout, stderr, exitCode] = yield* Effect.all(
            [
              collectStream(handle.stdout, options?.maxOutputBytes),
              collectStream(handle.stderr, options?.maxErrorBytes),
              handle.exitCode,
            ],
            { concurrency: "unbounded" },
          )
          return {
            command: description,
            exitCode,
            stdout: stdout.buffer,
            stderr: stderr.buffer,
            stdoutTruncated: stdout.truncated,
            stderrTruncated: stderr.truncated,
          } satisfies RunResult
        }),
      )
      const timed = options?.timeout
        ? Effect.timeoutOrElse(collect, {
            duration: options.timeout,
            orElse: () => Effect.fail(new AppProcessError({ command: description, cause: new Error("Timed out") })),
          })
        : collect
      const aborted = options?.signal
        ? timed.pipe(
            Effect.raceFirst(
              waitForAbort(options.signal).pipe(Effect.mapError((cause) => wrapError(description, cause))),
            ),
          )
        : timed
      return aborted.pipe(Effect.catch((cause) => Effect.fail(wrapError(description, cause))))
    }

    const run = Effect.fn("AppProcess.run")(function* (command: ChildProcess.Command, options?: RunOptions) {
      if (options?.stdin === undefined) return yield* runCommand(command, options)
      if (command._tag !== "StandardCommand") {
        return yield* new AppProcessError({
          command: describeCommand(command),
          cause: new Error("stdin option only supports StandardCommand; received PipedCommand"),
        })
      }
      const next = ChildProcess.make(command.command, command.args, {
        ...command.options,
        stdin: normalizeStdin(options.stdin),
      })
      return yield* runCommand(next, options)
    })

    const runStream = (
      command: ChildProcess.Command,
      options?: RunStreamOptions,
    ): Stream.Stream<string, AppProcessError> => {
      const description = describeCommand(command)
      // Streaming process output can carry arbitrary user code/effects. There is
      // no admitted direct process stream in V1.
      if (!isHostDigestProbe(command)) return Stream.fail(processUnavailable())
      const okExitCodes = options?.okExitCodes
      const built: Stream.Stream<string, AppProcessError | PlatformError> = Stream.unwrap(
        Effect.gen(function* () {
          const handle = yield* spawner.spawn(command)
          const stderrFiber = yield* Effect.forkScoped(
            collectStream(handle.stderr, options?.maxErrorBytes).pipe(Effect.map((x) => x.buffer.toString("utf8"))),
          )
          const source = options?.includeStderr === true ? handle.all : handle.stdout
          const lines = source.pipe(
            Stream.decodeText,
            Stream.splitLines,
            Stream.filter((line) => line.length > 0),
          )
          const tail = Stream.unwrap(
            Effect.gen(function* () {
              const code = yield* handle.exitCode
              if (okExitCodes && okExitCodes.length > 0 && !okExitCodes.includes(code)) {
                const stderr = yield* Fiber.join(stderrFiber)
                return Stream.fail(new AppProcessError({ command: description, exitCode: code, stderr }))
              }
              return Stream.empty
            }),
          )
          return Stream.concat(lines, tail) as Stream.Stream<string, AppProcessError | PlatformError>
        }),
      )
      const mapped = built.pipe(
        Stream.catch((cause): Stream.Stream<string, AppProcessError> => Stream.fail(wrapError(description, cause))),
      )
      if (!options?.signal) return mapped
      const signal = options.signal
      return mapped.pipe(
        Stream.interruptWhen(waitForAbort(signal).pipe(Effect.mapError((cause) => wrapError(description, cause)))),
      )
    }

    return Service.of({
      ...spawner,
      spawn: (command) => isSupervisorControlLaunch(command)
        ? spawner.spawn(command)
        : Effect.fail(spawnUnavailable()),
      run,
      runStream,
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer: layer, deps: [CrossSpawnSpawner.node] })

export * as AppProcess from "./process"
