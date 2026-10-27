import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Effect, Layer, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner, make as makeChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { CrossSpawnSpawner } from "../src/cross-spawn-spawner"
import { makeGlobalNode } from "../src/effect/app-node"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppProcess, collectStream, pinCodeModeHelperRoot, pinSupervisorExecutable, pinSupervisorSource } from "@opencode-ai/core/process"
import { testEffect } from "./lib/effect"

const { effect: it } = testEffect(LayerNode.compile(AppProcess.node))
const { effect: itWithInterceptedSpawner } = testEffect(
  LayerNode.compile(AppProcess.node, [[
    CrossSpawnSpawner.node,
    makeGlobalNode({
      service: ChildProcessSpawner,
      layer: Layer.succeed(ChildProcessSpawner)(
        makeChildProcessSpawner((command) =>
          Effect.sync(() => {
            interceptedCommand = command
            throw new Error("spawn intercepted by process-guard test")
          }),
        ),
      ),
      deps: [],
    }),
  ]]),
)
let interceptedCommand: ChildProcess.Command | undefined
const getInterceptedCommand = (): ChildProcess.Command | undefined => interceptedCommand

test("collectStream keeps malformed and omitted caps within the fixed collection bound", async () => {
  const chunk = new Uint8Array(2048).fill(120)
  const malformed = await Effect.runPromise(collectStream(Stream.make(chunk), Number.NaN))
  const nonNumeric = await Effect.runPromise(
    collectStream(Stream.make(chunk), "not-a-number" as unknown as number),
  )
  const omitted = await Effect.runPromise(collectStream(Stream.make(chunk), undefined))

  expect(malformed.buffer.length).toBe(0)
  expect(malformed.truncated).toBe(true)
  expect(nonNumeric.buffer.length).toBe(0)
  expect(nonNumeric.truncated).toBe(true)
  expect(omitted.buffer.length).toBe(1024)
  expect(omitted.truncated).toBe(true)
})

itWithInterceptedSpawner("denies generic process run, stream, and spawn before dispatch", () =>
  Effect.gen(function* () {
    interceptedCommand = undefined
    const process = yield* AppProcess.Service
    const secret = "horizoncode-private-token-fixture"
    const command = ChildProcess.make("/workspace/private-runner", [`--token=${secret}`], { stdin: "ignore" })

    const run = yield* Effect.exit(process.run(command))
    const stream = yield* Effect.exit(Stream.runCollect(process.runStream(command)))
    const spawn = yield* Effect.scoped(Effect.exit(process.spawn(command)))

    expect(run._tag).toBe("Failure")
    expect(stream._tag).toBe("Failure")
    expect(spawn._tag).toBe("Failure")
    expect(getInterceptedCommand()).toBeUndefined()
    expect(JSON.stringify(run)).not.toContain(secret)
    expect(JSON.stringify(stream)).not.toContain(secret)
    expect(JSON.stringify(spawn)).not.toContain(secret)
  }),
)

it("does not expose piped command arguments when stdin is rejected", () =>
  Effect.gen(function* () {
    const process = yield* AppProcess.Service
    const secret = "horizoncode-piped-private-token"
    const command = {
      _tag: "PipedCommand",
      left: ChildProcess.make("/workspace/private-left", [`--token=${secret}`], { stdin: "ignore" }),
      right: ChildProcess.make("/workspace/private-right", [], { stdin: "ignore" }),
    } as ChildProcess.Command

    const result = yield* Effect.exit(process.run(command, { stdin: "input" }))

    expect(result._tag).toBe("Failure")
    expect(JSON.stringify(result)).not.toContain(secret)
  }),
)

it("denies basename spoofing and executable replacement before dispatch", () =>
  Effect.gen(function* () {
    const process = yield* AppProcess.Service
    const args = [
      "--state-dir=/workspace/state",
      "--socket=/workspace/state/control.sock",
      "--host-exe=/opt/horizoncode/runtime",
      "--nonce=nonce_fixture",
      "--incarnation=incarnation_fixture",
    ]
    const fake = yield* Effect.scoped(
      Effect.exit(process.spawn(ChildProcess.make("/workspace/hz-kernel", args, {
        stdin: "ignore", stdout: "ignore", stderr: "ignore", extendEnv: false,
      }))),
    )
    expect(fake._tag).toBe("Failure")

    const directory = mkdtempSync(join(import.meta.dir, ".process-guard-"))
    try {
      const bytes = Buffer.from("test-only pinned executable identity")
      const digest = createHash("sha256").update(bytes).digest("hex")
      const binary = join(directory, `hz-kernel-${digest}`)
      const replacement = join(directory, "replacement")
      writeFileSync(binary, bytes, { mode: 0o700 })
      writeFileSync(replacement, bytes, { mode: 0o700 })
      pinSupervisorExecutable({ path: binary, binaryName: "hz-kernel", sha256: digest })
      unlinkSync(binary)
      symlinkSync(replacement, binary)
      const replaced = yield* Effect.scoped(
        Effect.exit(process.spawn(ChildProcess.make(binary, args, {
          stdin: "ignore", stdout: "ignore", stderr: "ignore", extendEnv: false,
        }))),
      )
      expect(replaced._tag).toBe("Failure")
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }),
)

itWithInterceptedSpawner("allows a manifest-pinned HostKernel control launch to pipe stderr for startup diagnostics", () =>
  Effect.gen(function* () {
    interceptedCommand = undefined
    const process = yield* AppProcess.Service
    const directory = mkdtempSync(join(import.meta.dir, ".process-guard-host-launch-"))
    try {
      const bytes = Buffer.from("test-only pinned HostKernel identity for stderr-pipe admission")
      const digest = createHash("sha256").update(bytes).digest("hex")
      const binary = join(directory, `hz-kernel-${digest}`)
      writeFileSync(binary, bytes, { mode: 0o700 })
      pinSupervisorExecutable({ path: binary, binaryName: "hz-kernel", sha256: digest })
      const args = [
        `--state-dir=${directory}`,
        `--socket=${join(directory, "host.sock")}`,
        "--host-exe=/usr/bin/bun",
        "--nonce=nonce_fixture",
        "--incarnation=incarnation_fixture",
      ]

      const command = ChildProcess.make(binary, args, {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
        extendEnv: false,
      })
      const result = yield* Effect.scoped(Effect.exit(process.spawn(command)))

      expect(result._tag).toBe("Failure")
      const captured: ChildProcess.Command | undefined = getInterceptedCommand()
      expect(captured).toBe(command)
      expect(captured?._tag === "StandardCommand" ? captured.options.stderr : undefined).toBe("pipe")
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }),
)

itWithInterceptedSpawner("admits only a pinned Session supervisor with an exact owner epoch", () =>
  Effect.gen(function* () {
    interceptedCommand = undefined
    const process = yield* AppProcess.Service
    const directory = mkdtempSync(join(import.meta.dir, ".process-guard-session-supervisor-"))
    try {
      const binaryBytes = Buffer.from("test-only pinned Session supervisor identity")
      const binaryDigest = createHash("sha256").update(binaryBytes).digest("hex")
      const binary = join(directory, `session_supervisor-${binaryDigest}`)
      const source = join(directory, "session-supervisor.ts")
      writeFileSync(binary, binaryBytes, { mode: 0o700 })
      writeFileSync(source, "export const readOnlyObserver = true\n", { mode: 0o600 })
      pinSupervisorExecutable({ path: binary, binaryName: "session_supervisor", sha256: binaryDigest })
      pinSupervisorSource(source)

      const args = [
        `--source=${source}`,
        `--state-dir=${directory}`,
        `--socket=${join(directory, "session.sock")}`,
        "--host-exe=/usr/bin/bun",
        "--session=ses_fixture",
        "--nonce=nonce_fixture",
        "--incarnation=incarnation_fixture",
        "--owner-epoch=1",
      ]
      const options = { stdin: "ignore" as const, stdout: "ignore" as const, stderr: "pipe" as const, extendEnv: false }
      const malformed = ChildProcess.make(binary, [...args.slice(0, -1), "--owner-epoch=01"], options)
      const denied = yield* Effect.scoped(Effect.exit(process.spawn(malformed)))
      expect(denied._tag).toBe("Failure")
      expect(getInterceptedCommand()).toBeUndefined()

      const valid = ChildProcess.make(binary, args, options)
      const admitted = yield* Effect.scoped(Effect.exit(process.spawn(valid)))
      expect(admitted._tag).toBe("Failure") // The test spawner intercepts instead of launching a child.
      expect(getInterceptedCommand()).toBe(valid)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }),
)

it("allows only a manifest-pinned versioned supervisor path to answer the host digest probe", () =>
  Effect.gen(function* () {
    const process = yield* AppProcess.Service
    const directory = mkdtempSync(join(import.meta.dir, ".process-guard-digest-"))
    try {
      const hostDigest = `blake3:${"0".repeat(64)}`
      const bytes = Buffer.from(`#!/bin/sh\nprintf '%s\\n' '${hostDigest}'\n`)
      const digest = createHash("sha256").update(bytes).digest("hex")
      const binary = join(directory, `hz-kernel-${digest}`)
      writeFileSync(binary, bytes, { mode: 0o700 })
      const probe = () =>
        ChildProcess.make(binary, ["--digest-host-executable=/usr/bin/bun"], {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          extendEnv: false,
        })
      const unpinned = yield* Effect.exit(process.run(probe()))
      expect(unpinned._tag).toBe("Failure")

      pinSupervisorExecutable({ path: binary, binaryName: "hz-kernel", sha256: digest })

      const result = yield* process.run(probe())
      expect(result.exitCode).toBe(0)
      expect(result.stdout.toString("utf8").trim()).toBe(hostDigest)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }),
)

it("normalizes NaN, negative, and fractional output caps", () =>
  Effect.gen(function* () {
    const process = yield* AppProcess.Service
    const directory = mkdtempSync(join(import.meta.dir, ".process-guard-output-nan-"))
    try {
      const bytes = Buffer.from("#!/bin/sh\nprintf 'output\n'\n")
      const digest = createHash("sha256").update(bytes).digest("hex")
      const binary = join(directory, `hz-kernel-${digest}`)
      writeFileSync(binary, bytes, { mode: 0o700 })
      pinSupervisorExecutable({ path: binary, binaryName: "hz-kernel", sha256: digest })

      for (const { cap, expectedBytes } of [
        { cap: Number.NaN, expectedBytes: 0 },
        { cap: -4, expectedBytes: 0 },
        { cap: 2.9, expectedBytes: 2 },
      ]) {
        const result = yield* process.run(
          ChildProcess.make(binary, ["--digest-host-executable=/usr/bin/bun"], {
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
            extendEnv: false,
          }),
          { maxOutputBytes: cap },
        )

        expect(result.stdout.length).toBe(expectedBytes)
        expect(result.stdoutTruncated).toBe(true)
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }),
)

it("hard-bounds streamed output from the pinned host digest probe", () =>
  Effect.gen(function* () {
    const process = yield* AppProcess.Service
    const directory = mkdtempSync(join(import.meta.dir, ".process-guard-stream-bound-"))
    try {
      const bytes = Buffer.from("#!/bin/sh\ni=0; while [ \"$i\" -lt 1000 ]; do printf x; printf y >&2; i=$((i + 1)); done; printf '\\n'\n")
      const digest = createHash("sha256").update(bytes).digest("hex")
      const binary = join(directory, `hz-kernel-${digest}`)
      writeFileSync(binary, bytes, { mode: 0o700 })
      pinSupervisorExecutable({ path: binary, binaryName: "hz-kernel", sha256: digest })

      const lines = yield* Stream.runCollect(
        process.runStream(ChildProcess.make(binary, ["--digest-host-executable=/usr/bin/bun"], {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          extendEnv: false,
        })),
      )

      expect(Array.from(lines).join("").length).toBe(128)

      const combinedLines = yield* Stream.runCollect(
        process.runStream(ChildProcess.make(binary, ["--digest-host-executable=/usr/bin/bun"], {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          extendEnv: false,
        }), { includeStderr: true }),
      )
      expect(Array.from(combinedLines).join("").length).toBe(128)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }),
)

it("hard-bounds output from the pinned host digest probe", () =>
  Effect.gen(function* () {
    const process = yield* AppProcess.Service
    const directory = mkdtempSync(join(import.meta.dir, ".process-guard-output-bound-"))
    try {
      const bytes = Buffer.from("#!/bin/sh\ni=0; while [ \"$i\" -lt 1000 ]; do printf x; i=$((i + 1)); done; printf '\\n'\n")
      const digest = createHash("sha256").update(bytes).digest("hex")
      const binary = join(directory, `hz-kernel-${digest}`)
      writeFileSync(binary, bytes, { mode: 0o700 })
      pinSupervisorExecutable({ path: binary, binaryName: "hz-kernel", sha256: digest })

      const result = yield* process.run(
        ChildProcess.make(binary, ["--digest-host-executable=/usr/bin/bun"], {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          extendEnv: false,
        }),
        { maxOutputBytes: Number.POSITIVE_INFINITY },
      )

      expect(result.stdout.length).toBe(128)
      expect(result.stdoutTruncated).toBe(true)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }),
)

test("pins only the fixed private CodeMode helper package and exact asset digest", () => {
  const directory = mkdtempSync(join(import.meta.dir, ".process-guard-codemode-"))
  try {
    const helperRoot = join(directory, "codemode-helper")
    mkdirSync(helperRoot, { mode: 0o700 })
    chmodSync(helperRoot, 0o700)
    const helperPath = join(helperRoot, "codemode-helper.js")
    const helperBytes = Buffer.from("// fixed helper package fixture\n")
    const helperDigest = createHash("sha256").update(helperBytes).digest("hex")
    writeFileSync(helperPath, helperBytes, { mode: 0o600 })
    const manifest = {
      schemaVersion: 1,
      status: "available",
      helperSelector: "horizoncode:codemode:bun",
      relativeEntrypoint: "codemode-helper.js",
      sha256: `sha256:${helperDigest}`,
      target: `linux-${process.arch}-gnu`,
    }
    writeFileSync(join(helperRoot, "codemode-helper.manifest.json"), JSON.stringify(manifest), { mode: 0o600 })

    expect(() => pinCodeModeHelperRoot({ path: helperRoot, sha256: `sha256:${"0".repeat(64)}` }))
      .toThrow("manifest or asset differs")
    expect(() => pinCodeModeHelperRoot({ path: helperRoot, sha256: `sha256:${helperDigest}` })).not.toThrow()

    writeFileSync(join(helperRoot, "codemode-helper.manifest.json"), JSON.stringify({ ...manifest, helperSelector: "node" }), { mode: 0o600 })
    expect(() => pinCodeModeHelperRoot({ path: helperRoot, sha256: `sha256:${helperDigest}` }))
      .toThrow("manifest or asset differs")
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("rejects an oversized CodeMode helper manifest before pinning it", () => {
  const directory = mkdtempSync(join(import.meta.dir, ".process-guard-codemode-manifest-bound-"))
  try {
    const helperRoot = join(directory, "codemode-helper")
    mkdirSync(helperRoot, { mode: 0o700 })
    chmodSync(helperRoot, 0o700)
    const helperPath = join(helperRoot, "codemode-helper.js")
    const helperBytes = Buffer.from("// bounded helper fixture\n")
    const helperDigest = createHash("sha256").update(helperBytes).digest("hex")
    writeFileSync(helperPath, helperBytes, { mode: 0o600 })
    const manifest = JSON.stringify({
      schemaVersion: 1,
      status: "available",
      helperSelector: "horizoncode:codemode:bun",
      relativeEntrypoint: "codemode-helper.js",
      sha256: `sha256:${helperDigest}`,
      target: `linux-${process.arch}-gnu`,
    })
    writeFileSync(join(helperRoot, "codemode-helper.manifest.json"), `${manifest}${" ".repeat(4096)}`, {
      mode: 0o600,
    })

    expect(() => pinCodeModeHelperRoot({ path: helperRoot, sha256: `sha256:${helperDigest}` })).toThrow(
      "CodeMode helper manifest exceeds its bound",
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("rejects a CodeMode helper asset larger than the installer bound before hashing it", () => {
  const directory = mkdtempSync(join(import.meta.dir, ".process-guard-codemode-asset-bound-"))
  try {
    const helperRoot = join(directory, "codemode-helper")
    mkdirSync(helperRoot, { mode: 0o700 })
    chmodSync(helperRoot, 0o700)
    const helperBytes = Buffer.alloc(16 * 1024 * 1024 + 1, 0x61)
    const helperDigest = createHash("sha256").update(helperBytes).digest("hex")
    writeFileSync(join(helperRoot, "codemode-helper.js"), helperBytes, { mode: 0o600 })
    writeFileSync(
      join(helperRoot, "codemode-helper.manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        status: "available",
        helperSelector: "horizoncode:codemode:bun",
        relativeEntrypoint: "codemode-helper.js",
        sha256: `sha256:${helperDigest}`,
        target: `linux-${process.arch}-gnu`,
      }),
      { mode: 0o600 },
    )

    expect(() => pinCodeModeHelperRoot({ path: helperRoot, sha256: `sha256:${helperDigest}` })).toThrow(
      "CodeMode helper asset is empty or exceeds its bound",
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("rejects raw platform PTY adapters before invoking a native PTY library", async () => {
  const [bun, node] = await Promise.all([
    import("../src/pty/pty.bun"),
    import("../src/pty/pty.node"),
  ])
  const options = { name: "xterm", cwd: "/", env: {} }
  expect(() => bun.spawn("/bin/sh", ["-c", "exit 0"], options)).toThrow("Guarded HostKernel terminal service")
  expect(() => node.spawn("/bin/sh", ["-c", "exit 0"], options)).toThrow("Guarded HostKernel terminal service")
})
