#!/usr/bin/env bun
import { $ } from "bun"
import path from "path"
import { fileURLToPath } from "url"

// Refuse publication before reading package metadata or starting Docker.
if (process.argv.includes("--push") || process.env.PUSH === "1") {
  throw new Error("HorizonCode container publication is disabled pending release authorization.")
}

const rootDir = fileURLToPath(new URL("../../..", import.meta.url))
process.chdir(rootDir)

// Build the dependency chain from the preceding local image by default. An
// upstream registry must never be contacted implicitly as a source of
// HorizonCode build containers.
const reg = process.env.REGISTRY ?? "localhost/horizoncode"
const tag = process.env.TAG ?? "24.04"
const root = path.join(rootDir, "package.json")
const pkg = await Bun.file(root).json()
const manager = pkg.packageManager ?? ""
const bun = manager.startsWith("bun@") ? manager.slice(4) : ""
if (!bun) throw new Error("packageManager must be bun@<version>")

const images = ["base", "bun-node", "rust", "tauri-linux", "publish"]
const platform = process.arch === "arm64" ? "linux/arm64" : "linux/amd64"

for (const name of images) {
  const image = `localhost/horizoncode/build/${name}:${tag}`
  const file = `packages/containers/${name}/Dockerfile`
  const buildArgs = [`--build-arg`, `REGISTRY=${reg}`, `--build-arg`, `IMAGE_TAG=${tag}`]
  if (name === "bun-node") buildArgs.push("--build-arg", `BUN_VERSION=${bun}`)

  // Local builds may pull Dockerfile base images, but never push or configure a
  // registry. Publication uses a separate, currently unavailable workflow.
  await $`docker build --platform ${platform} -f ${file} -t ${image} ${buildArgs} .`
}
