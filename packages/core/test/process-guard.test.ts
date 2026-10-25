import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Effect, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppProcess, pinCodeModeHelperRoot, pinSupervisorExecutable } from "@opencode-ai/core/process"
import { testEffect } from "./lib/effect"

const { effect: it } = testEffect(LayerNode.compile(AppProcess.node))

it("denies generic process run, stream, and spawn before dispatch", () =>
  Effect.gen(function* () {
    const process = yield* AppProcess.Service
    const secret = "horizoncode-private-token-fixture"
    const command = ChildProcess.make("/workspace/private-runner", [`--token=${secret}`], { stdin: "ignore" })

    const run = yield* Effect.exit(process.run(command))
    const stream = yield* Effect.exit(Stream.runCollect(process.runStream(command)))
    const spawn = yield* Effect.scoped(Effect.exit(process.spawn(command)))

    expect(run._tag).toBe("Failure")
    expect(stream._tag).toBe("Failure")
    expect(spawn._tag).toBe("Failure")
    expect(JSON.stringify(run)).not.toContain(secret)
    expect(JSON.stringify(stream)).not.toContain(secret)
    expect(JSON.stringify(spawn)).not.toContain(secret)
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

test("rejects raw platform PTY adapters before invoking a native PTY library", async () => {
  const [bun, node] = await Promise.all([
    import("../src/pty/pty.bun"),
    import("../src/pty/pty.node"),
  ])
  const options = { name: "xterm", cwd: "/", env: {} }
  expect(() => bun.spawn("/bin/sh", ["-c", "exit 0"], options)).toThrow("Guarded HostKernel terminal service")
  expect(() => node.spawn("/bin/sh", ["-c", "exit 0"], options)).toThrow("Guarded HostKernel terminal service")
})
