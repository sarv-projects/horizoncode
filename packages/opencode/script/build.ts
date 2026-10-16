#!/usr/bin/env bun

import { $ } from "bun"
import { createHash } from "node:crypto"
import path from "path"
import { fileURLToPath } from "url"
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")

process.chdir(dir)

const generated = await import("./generate.ts")

import { Script } from "@opencode-ai/script"
import pkg from "../package.json"

const singleFlag = process.argv.includes("--single")
const baselineFlag = process.argv.includes("--baseline")
const skipInstall = process.argv.includes("--skip-install")
const sourcemapsFlag = process.argv.includes("--sourcemaps")
const plugin = createSolidTransformPlugin()
const skipEmbedWebUi = process.argv.includes("--skip-embed-web-ui")

const createEmbeddedWebUIBundle = async () => {
  console.log(`Building Web UI to embed in the binary`)
  const appDir = path.join(import.meta.dirname, "../../app")
  const dist = path.join(appDir, "dist")
  await $`OPENCODE_CHANNEL=${Script.channel} bun run --cwd ${appDir} build`
  const files = (await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: dist })))
    .map((file) => file.replaceAll("\\", "/"))
    .filter((file) => !file.endsWith(".map"))
    .sort()
  const imports = files.map((file, i) => {
    const spec = path.relative(dir, path.join(dist, file)).replaceAll("\\", "/")
    return `import file_${i} from ${JSON.stringify(spec.startsWith(".") ? spec : `./${spec}`)} with { type: "file" };`
  })
  const entries = files.map((file, i) => `  ${JSON.stringify(file)}: file_${i},`)
  return [
    `// Import all files as file_$i with type: "file"`,
    ...imports,
    `// Export with original mappings`,
    `export default {`,
    ...entries,
    `}`,
  ].join("\n")
}

const embeddedFileMap = skipEmbedWebUi ? null : await createEmbeddedWebUIBundle()
const treeSitterWorker = await Bun.file(fileURLToPath(import.meta.resolve("@opentui/core/parser.worker"))).text()

const allTargets: {
  os: string
  arch: "arm64" | "x64"
  abi?: "musl"
  avx2?: false
}[] = [
  {
    os: "linux",
    arch: "arm64",
  },
  {
    os: "linux",
    arch: "x64",
  },
  {
    os: "linux",
    arch: "x64",
    avx2: false,
  },
  {
    os: "linux",
    arch: "arm64",
    abi: "musl",
  },
  {
    os: "linux",
    arch: "x64",
    abi: "musl",
  },
  {
    os: "linux",
    arch: "x64",
    abi: "musl",
    avx2: false,
  },
  {
    os: "darwin",
    arch: "arm64",
  },
  {
    os: "darwin",
    arch: "x64",
  },
  {
    os: "darwin",
    arch: "x64",
    avx2: false,
  },
  {
    os: "win32",
    arch: "arm64",
  },
  {
    os: "win32",
    arch: "x64",
  },
  {
    os: "win32",
    arch: "x64",
    avx2: false,
  },
]

const targets = singleFlag
  ? allTargets.filter((item) => {
      if (item.os !== process.platform || item.arch !== process.arch) {
        return false
      }

      // When building for the current platform, prefer a single native binary by default.
      // Baseline binaries require additional Bun artifacts and can be flaky to download.
      if (item.avx2 === false) {
        return baselineFlag
      }

      // also skip abi-specific builds for the same reason
      if (item.abi !== undefined) {
        return false
      }

      return true
    })
  : allTargets

await $`rm -rf dist`

const binaries: Record<string, string> = {}
const hasNativeLinuxTarget = targets.some(
  (item) => process.platform === "linux" && item.os === "linux" && item.arch === process.arch && item.abi === undefined,
)
let observerAsset: { readonly bytes: Uint8Array; readonly sha256: string } | undefined
let observerAssetSource: string | undefined
if (hasNativeLinuxTarget) {
  const kernelRoot = path.resolve(dir, "../../kernel")
  await $`cargo build --manifest-path ${path.join(kernelRoot, "Cargo.toml")} --locked --offline --release --bin session_supervisor`
  observerAssetSource = path.join(kernelRoot, "target/release/session_supervisor")
  const bytes = await Bun.file(observerAssetSource).bytes()
  if (bytes.length === 0) throw new Error("Rust Session observer build produced an empty executable")
  observerAsset = {
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  }
}

const kernelRoot = path.resolve(dir, "../../kernel")
const hostKernelBinaryName = "hz-kernel"
const hostKernelAssetName = process.platform === "win32" ? `${hostKernelBinaryName}.exe` : hostKernelBinaryName
let hostKernelAsset: { readonly source: string; readonly sha256: string; readonly target: string } | undefined
let hostKernelUnavailableReason = "Host-kernel packaging is supported only for native Linux GNU targets."
const hasNativeHostKernelTarget = targets.some(
  (item) =>
    process.platform === "linux" &&
    item.os === process.platform &&
    item.arch === process.arch &&
    item.abi === undefined &&
    item.avx2 === undefined,
)
if (hasNativeHostKernelTarget) {
  const metadata = JSON.parse(
    await $`cargo metadata --manifest-path ${path.join(kernelRoot, "Cargo.toml")} --locked --offline --no-deps --format-version 1`.text(),
  ) as {
    packages?: { name: string; targets: { name: string; kind: string[] }[] }[]
  }
  const kernelPackage = metadata.packages?.find((item) => item.name === "horizoncode-kernel")
  const hasHostKernelBinary = kernelPackage?.targets.some(
    (target) => target.name === hostKernelBinaryName && target.kind.includes("bin"),
  )
  if (hasHostKernelBinary) {
    const rustVersion = await $`rustc -vV`.text()
    const rustTarget = rustVersion.match(/^host: (.+)$/m)?.[1]
    const expectedRustTarget =
      process.arch === "x64" ? "x86_64-unknown-linux-gnu" : process.arch === "arm64" ? "aarch64-unknown-linux-gnu" : undefined
    if (!rustTarget || rustTarget !== expectedRustTarget) {
      hostKernelUnavailableReason = `Native Rust host target ${rustTarget ?? "unknown"} does not match the supported Linux GNU target for ${process.arch}.`
    } else {
      await $`cargo build --manifest-path ${path.join(kernelRoot, "Cargo.toml")} --locked --offline --release --target ${rustTarget} --bin ${hostKernelBinaryName}`
      const source = path.join(kernelRoot, "target", rustTarget, "release", hostKernelAssetName)
      const bytes = await Bun.file(source).bytes()
      if (bytes.length === 0) throw new Error("Rust hz-kernel build produced an empty executable")
      hostKernelAsset = {
        source,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        target: rustTarget === "x86_64-unknown-linux-gnu" ? "linux-x64-gnu" : "linux-arm64-gnu",
      }
    }
  } else {
    hostKernelUnavailableReason = "The Rust kernel package does not yet declare a hz-kernel binary target."
  }
}
if (!hasNativeHostKernelTarget) {
  hostKernelUnavailableReason =
    process.platform === "linux"
      ? `No compatible native hz-kernel target was selected for ${process.platform}-${process.arch}.`
      : `Host-kernel packaging is unavailable for ${process.platform}-${process.arch}; Core currently accepts only native Linux GNU artifacts.`
}
if (!skipInstall) {
  await $`bun install --os="*" --cpu="*" @opentui/core@${pkg.dependencies["@opentui/core"]}`
  await $`bun install --os="*" --cpu="*" @parcel/watcher@${pkg.dependencies["@parcel/watcher"]}`
  await $`bun install --os="*" --cpu="*" @ff-labs/fff-bun@${pkg.dependencies["@ff-labs/fff-bun"]}`
}
for (const item of targets) {
  const name = [
    pkg.name,
    // changing to win32 flags npm for some reason
    item.os === "win32" ? "windows" : item.os,
    item.arch,
    item.avx2 === false ? "baseline" : undefined,
    item.abi === undefined ? undefined : item.abi,
  ]
    .filter(Boolean)
    .join("-")
  console.log(`building ${name}`)
  await $`mkdir -p dist/${name}/bin`
  const includeObserver =
    observerAsset !== undefined &&
    process.platform === "linux" &&
    item.os === "linux" &&
    item.arch === process.arch &&
    item.abi === undefined
  const observerAssetPath = "session_supervisor"
  const observerManifest = includeObserver
    ? {
        schemaVersion: 1,
        status: "available",
        binaryName: "session_supervisor",
        target: `linux-${item.arch}-gnu`,
        sha256: observerAsset!.sha256,
      }
    : {
        schemaVersion: 1,
        status: "unavailable",
        target: name,
        reason: `No compatible pinned Session observer was built for ${name}; bundled support is limited to native Linux GNU targets.`,
      }
  await Bun.file(`dist/${name}/bin/session-observer.manifest.json`).write(
    `${JSON.stringify(observerManifest, null, 2)}\n`,
  )
  const includeHostKernel =
    hostKernelAsset !== undefined &&
    item.os === process.platform &&
    item.arch === process.arch &&
    item.abi === undefined &&
    item.avx2 === undefined &&
    hostKernelAsset.target === `linux-${item.arch}-gnu`
  const hostKernelAssetPath = hostKernelAssetName
  const hostKernelManifest = includeHostKernel
    ? {
        schemaVersion: 1,
        status: "available",
        binaryName: hostKernelBinaryName,
        target: hostKernelAsset!.target,
        sha256: hostKernelAsset!.sha256,
      }
    : {
        schemaVersion: 1,
        status: "unavailable",
        binaryName: hostKernelBinaryName,
        target: name,
        sha256: null,
        reason: hostKernelAsset
          ? `No compatible native hz-kernel artifact was built for ${name}; the embedded artifact is limited to ${hostKernelAsset.target}.`
          : hostKernelUnavailableReason,
      }
  await Bun.file(`dist/${name}/bin/host-kernel.manifest.json`).write(`${JSON.stringify(hostKernelManifest, null, 2)}\n`)

  const workerPath = "./src/cli/tui/worker.ts"
  const treeSitterWorkerPath = "opentui-tree-sitter-worker.js"
  const bunfsRoot = item.os === "win32" ? "B:/~BUN/root/" : "/$bunfs/root/"

  await Bun.build({
    conditions: ["bun", "node"],
    tsconfig: "./tsconfig.json",
    plugins: [plugin],
    external: ["node-gyp"],
    format: "esm",
    minify: true,
    sourcemap: sourcemapsFlag ? "linked" : "none",
    splitting: true,
    compile: {
      autoloadBunfig: false,
      autoloadDotenv: false,
      autoloadTsconfig: true,
      autoloadPackageJson: true,
      target: name.replace(pkg.name, "bun") as any,
      ...(includeObserver || includeHostKernel
        ? {
            assets: [
              ...(includeObserver ? [observerAssetSource!] : []),
              ...(includeHostKernel ? [hostKernelAsset!.source] : []),
            ],
          }
        : {}),
      outfile: `dist/${name}/bin/opencode`,
      execArgv: [`--user-agent=opencode/${Script.version}`, "--use-system-ca", "--"],
      windows: {},
    },
    files: {
      [treeSitterWorkerPath]: treeSitterWorker,
      ...(embeddedFileMap ? { "opencode-web-ui.gen.ts": embeddedFileMap } : {}),
    },
    entrypoints: [
      "./src/index.ts",
      workerPath,
      treeSitterWorkerPath,
      ...(embeddedFileMap ? ["opencode-web-ui.gen.ts"] : []),
    ],
    define: {
      FFF_LIBC: JSON.stringify(item.abi === "musl" ? "musl" : "gnu"),
      OPENCODE_VERSION: `'${Script.version}'`,
      OPENCODE_MODELS_DEV: generated.modelsData,
      OTUI_TREE_SITTER_WORKER_PATH: bunfsRoot + treeSitterWorkerPath,
      OPENCODE_WORKER_PATH: workerPath,
      OPENCODE_SESSION_OBSERVER_MANIFEST: JSON.stringify(JSON.stringify(observerManifest)),
      ...(includeObserver ? { OPENCODE_SESSION_OBSERVER_ASSET: JSON.stringify(bunfsRoot + observerAssetPath) } : {}),
      OPENCODE_HOST_KERNEL_MANIFEST: JSON.stringify(JSON.stringify(hostKernelManifest)),
      OPENCODE_HOST_KERNEL_ASSET: JSON.stringify(includeHostKernel ? bunfsRoot + hostKernelAssetPath : ""),
      OPENCODE_CHANNEL: `'${Script.channel}'`,
      OPENCODE_LIBC: item.os === "linux" ? `'${item.abi ?? "glibc"}'` : "",
      ...(item.os === "linux" ? { "process.env.OPENTUI_LIBC": JSON.stringify(item.abi ?? "glibc") } : {}),
    },
  })

  // Embedding the bundle invalidates the linker's ad-hoc signature, and macOS 27+
  // SIGKILLs binaries with invalid pages. Re-sign ad-hoc; release CI re-signs with Developer ID.
  if (item.os === "darwin" && process.platform === "darwin") {
    await $`codesign --force --sign - dist/${name}/bin/opencode`
  }

  // Smoke test: only run if binary is for current platform
  if (item.os === process.platform && item.arch === process.arch && !item.abi) {
    const binaryPath = `dist/${name}/bin/opencode`
    console.log(`Running smoke test: ${binaryPath} --version`)
    try {
      const versionOutput = await $`${binaryPath} --version`.text()
      console.log(`Smoke test passed: ${versionOutput.trim()}`)
    } catch (e) {
      console.error(`Smoke test failed for ${name}:`, e)
      process.exit(1)
    }
  }

  await $`rm -rf ./dist/${name}/bin/tui`
  await Bun.file(`dist/${name}/package.json`).write(
    JSON.stringify(
      {
        name,
        version: Script.version,
        preferUnplugged: true,
        os: [item.os],
        cpu: [item.arch],
        ...(item.abi ? { libc: [item.abi] } : {}),
      },
      null,
      2,
    ),
  )
  binaries[name] = Script.version
}

if (Script.release) {
  for (const key of Object.keys(binaries)) {
    if (key.includes("linux")) {
      await $`tar -czf ../../${key}.tar.gz *`.cwd(`dist/${key}/bin`)
    } else {
      await $`zip -r ../../${key}.zip *`.cwd(`dist/${key}/bin`)
    }
  }
  await $`gh release upload v${Script.version} ./dist/*.zip ./dist/*.tar.gz --clobber --repo ${process.env.GH_REPO}`
}

export { binaries }
