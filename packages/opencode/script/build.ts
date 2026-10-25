#!/usr/bin/env bun

import { $ } from "bun"
import { createHash } from "node:crypto"
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs"
import path from "path"
import { fileURLToPath } from "url"
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")
const productName = "horizoncode"

const clearBuildOutput = async (relative: string) => {
  const p9BuildRoot = process.env.HORIZONCODE_P9_BUILD_ROOT
  const p9BuildMarker = process.env.HORIZONCODE_P9_BUILD_MARKER
  if (!p9BuildRoot && !p9BuildMarker) {
    await $`rm -rf ${path.resolve(dir, relative)}`
    return
  }
  if (!p9BuildRoot || !p9BuildMarker || typeof process.getuid !== "function") {
    throw new Error("P9 build output cleanup requires its task-owned isolated build copy")
  }

  const root = path.resolve(p9BuildRoot)
  const expectedMarker = path.join(path.dirname(root), `.${path.basename(root)}.p9-build-marker.json`)
  if (path.resolve(p9BuildMarker) !== expectedMarker) {
    throw new Error("P9 build marker is not the task-owned sibling of the isolated source copy")
  }
  const rootStat = lstatSync(root)
  const markerStat = lstatSync(p9BuildMarker)
  const currentUid = process.getuid()
  if (
    realpathSync(root) !== root ||
    !rootStat.isDirectory() ||
    rootStat.isSymbolicLink() ||
    rootStat.uid !== currentUid ||
    (rootStat.mode & 0o022) !== 0 ||
    !markerStat.isFile() ||
    markerStat.uid !== currentUid ||
    (markerStat.mode & 0o022) !== 0
  ) {
    throw new Error("P9 build root or marker is not a regular task-owned path")
  }
  const marker = JSON.parse(readFileSync(p9BuildMarker, "utf8")) as { buildRoot?: string }
  if (marker.buildRoot !== root) throw new Error("P9 build marker does not match the isolated copy")

  const outputRoot = path.resolve(root, "packages/opencode/dist")
  const target = path.resolve(dir, relative)
  if (target !== outputRoot && !target.startsWith(`${outputRoot}${path.sep}`)) {
    throw new Error("P9 build cleanup target escaped the isolated package output directory")
  }
  let cursor = root
  for (const part of path.relative(root, target).split(path.sep)) {
    cursor = path.join(cursor, part)
    try {
      if (lstatSync(cursor).isSymbolicLink()) throw new Error("P9 build cleanup target contains a symlink")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
  }
  const assertOwnedTree = (entry: string) => {
    const metadata = lstatSync(entry)
    if (metadata.uid !== currentUid || (metadata.mode & 0o022) !== 0) {
      throw new Error("P9 build cleanup refused a path not owned and protected by the current user")
    }
    if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
      for (const child of readdirSync(entry)) assertOwnedTree(path.join(entry, child))
    }
  }
  try {
    assertOwnedTree(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  await $`rm -rf ${target}`
}

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

// P9 distribution evidence: carry the HorizonCode first-party license and its
// separate attribution/third-party-closure notice into every candidate.
const candidateLicense = await Bun.file(path.resolve(dir, "../../LICENSE")).text()
const candidateNotice = await Bun.file(path.resolve(dir, "../../NOTICE")).text()
if (candidateLicense.trim().length === 0 || candidateNotice.trim().length === 0) {
  throw new Error("HorizonCode LICENSE or NOTICE is empty; refusing to package an unlicensed candidate")
}

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

await clearBuildOutput("dist")

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
    productName,
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
  const codeModeHelperRelativeEntrypoint = "codemode-helper.js"
  const codeModeHelperAssetName = "codemode-helper.js"
  let codeModeHelperAssetPath: string | undefined
  let codeModeHelperManifest: Record<string, unknown>
  if (includeHostKernel) {
    const helperPath = path.join(dir, "dist", name, "bin", codeModeHelperAssetName)
    const helperBuild = await Bun.build({
      entrypoints: ["./src/cli/codemode-helper.ts"],
      outdir: path.dirname(helperPath),
      naming: path.basename(helperPath),
      target: "bun",
      format: "esm",
      minify: true,
      splitting: false,
      tsconfig: "./tsconfig.json",
    })
    if (!helperBuild.success) {
      throw new Error(`HorizonCode CodeMode helper build failed: ${helperBuild.logs.map((entry) => entry.message).join("; ")}`)
    }
    const helperBytes = await Bun.file(helperPath).bytes()
    if (helperBytes.length === 0 || helperBytes.length > 16 * 1024 * 1024) {
      throw new Error("HorizonCode CodeMode helper asset is empty or exceeds its 16 MiB package bound")
    }
    codeModeHelperAssetPath = helperPath
    codeModeHelperManifest = {
      schemaVersion: 1,
      status: "available",
      helperSelector: "horizoncode:codemode:bun",
      relativeEntrypoint: codeModeHelperRelativeEntrypoint,
      sha256: `sha256:${createHash("sha256").update(helperBytes).digest("hex")}`,
      target: `linux-${item.arch}-gnu`,
    }
  } else {
    codeModeHelperManifest = {
      schemaVersion: 1,
      status: "unavailable",
      helperSelector: "horizoncode:codemode:bun",
      relativeEntrypoint: codeModeHelperRelativeEntrypoint,
      sha256: null,
      target: name,
      reason: `CodeMode helper packaging requires the native Linux GNU HostKernel target; ${name} does not provide it.`,
    }
  }
  await Bun.file(`dist/${name}/bin/codemode-helper.manifest.json`).write(`${JSON.stringify(codeModeHelperManifest, null, 2)}\n`)
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
      target: name.replace(productName, "bun") as any,
      ...(includeObserver || includeHostKernel
        ? {
            assets: [
              ...(includeObserver ? [observerAssetSource!] : []),
              ...(includeHostKernel ? [hostKernelAsset!.source] : []),
              ...(codeModeHelperAssetPath ? [codeModeHelperAssetPath] : []),
            ],
          }
        : {}),
      outfile: `dist/${name}/bin/horizoncode`,
      execArgv: [`--user-agent=horizoncode/${Script.version}`, "--use-system-ca", "--"],
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
      OPENCODE_CODE_MODE_HELPER_MANIFEST: JSON.stringify(JSON.stringify(codeModeHelperManifest)),
      OPENCODE_CODE_MODE_HELPER_ASSET: JSON.stringify(codeModeHelperAssetPath ? bunfsRoot + codeModeHelperAssetName : ""),
      OPENCODE_CHANNEL: `'${Script.channel}'`,
      OPENCODE_LIBC: item.os === "linux" ? `'${item.abi ?? "glibc"}'` : "",
      ...(item.os === "linux" ? { "process.env.OPENTUI_LIBC": JSON.stringify(item.abi ?? "glibc") } : {}),
    },
  })

  // Attribution/notice files must be part of the inspected artifact inventory,
  // not only the source checkout. The distribution audit requires both.
  await Bun.write(`dist/${name}/bin/LICENSE`, candidateLicense)
  await Bun.write(`dist/${name}/bin/NOTICE`, candidateNotice)

  // Embedding the bundle invalidates the linker's ad-hoc signature, and macOS 27+
  // SIGKILLs binaries with invalid pages. Re-sign ad-hoc; release CI re-signs with Developer ID.
  if (item.os === "darwin" && process.platform === "darwin") {
    await $`codesign --force --sign - dist/${name}/bin/horizoncode`
  }

  // Smoke test: only run if binary is for current platform
  if (item.os === process.platform && item.arch === process.arch && !item.abi) {
    const binaryPath = `dist/${name}/bin/horizoncode`
    console.log(`Running smoke test: ${binaryPath} --version`)
    try {
      const versionOutput = await $`${binaryPath} --version`.text()
      console.log(`Smoke test passed: ${versionOutput.trim()}`)
    } catch (e) {
      console.error(`Smoke test failed for ${name}:`, e)
      process.exit(1)
    }
  }

  await clearBuildOutput(`dist/${name}/bin/tui`)
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
  throw new Error(
    "HorizonCode release upload is unavailable while exact third-party notices, signing/update policy, and release acceptance remain incomplete. Local archives were prepared without publication.",
  )
}

export { binaries }
