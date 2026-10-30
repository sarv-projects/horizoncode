import path from "path"
import fs from "fs/promises"
import { Filesystem } from "@/util/filesystem"
import type { InstanceContext } from "../project/instance-context"
import { refuseLanguageServiceProcess } from "./launch"
import type { RuntimeFlags } from "@/effect/runtime-flags"
import type { ExecutionLaunchProfileRefV1, HostProcessRefV1 } from "./process-scope"

export interface Handle {
  /** Opaque HostKernel-issued identity; never a PID or caller-selected process path. */
  processRef?: HostProcessRefV1
  /** Immutable profile pin that produced the process; never contains launch argv/path. */
  launchProfileRef?: ExecutionLaunchProfileRefV1
  initialization?: Record<string, unknown>
}

type RootFunction = (file: string, ctx: InstanceContext) => Promise<string | undefined>

const NearestRoot = (includePatterns: string[], excludePatterns?: string[]): RootFunction => {
  return async (file, ctx) => {
    if (excludePatterns) {
      const excludedFiles = Filesystem.up({
        targets: excludePatterns,
        start: path.dirname(file),
        stop: ctx.directory,
      })
      const excluded = await excludedFiles.next()
      await excludedFiles.return()
      if (excluded.value) return undefined
    }
    const files = Filesystem.up({
      targets: includePatterns,
      start: path.dirname(file),
      stop: ctx.directory,
    })
    const first = await files.next()
    await files.return()
    if (!first.value) return ctx.directory
    return path.dirname(first.value)
  }
}

const StrictNearestRoot = (includePatterns: string[], excludePatterns?: string[]): RootFunction => {
  return async (file, ctx) => {
    if (excludePatterns) {
      const excludedFiles = Filesystem.up({
        targets: excludePatterns,
        start: path.dirname(file),
        stop: ctx.directory,
      })
      const excluded = await excludedFiles.next()
      await excludedFiles.return()
      if (excluded.value) return undefined
    }
    const files = Filesystem.up({
      targets: includePatterns,
      start: path.dirname(file),
      stop: ctx.directory,
    })
    const first = await files.next()
    await files.return()
    if (!first.value) return undefined
    return path.dirname(first.value)
  }
}

export interface Info {
  id: string
  extensions: string[]
  global?: boolean
  root: RootFunction
  spawn(root: string, ctx: InstanceContext, flags: RuntimeFlags.Info): Promise<Handle | undefined>
}

export const Deno: Info = {
  id: "deno",
  root: async (file, ctx) => {
    const files = Filesystem.up({
      targets: ["deno.json", "deno.jsonc"],
      start: path.dirname(file),
      stop: ctx.directory,
    })
    const first = await files.next()
    await files.return()
    if (!first.value) return undefined
    return path.dirname(first.value)
  },
  extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs"],
  async spawn() {
    return refuseLanguageServiceProcess("server.spawn")
  },
}

export const Typescript: Info = {
  id: "typescript",
  root: NearestRoot(
    ["package-lock.json", "bun.lockb", "bun.lock", "pnpm-lock.yaml", "yarn.lock"],
    ["deno.json", "deno.jsonc"],
  ),
  extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"],
  async spawn() {
    return refuseLanguageServiceProcess("server.spawn")
  },
}

export const Vue: Info = {
  id: "vue",
  extensions: [".vue"],
  root: NearestRoot(["package-lock.json", "bun.lockb", "bun.lock", "pnpm-lock.yaml", "yarn.lock"]),
  async spawn() {
    return refuseLanguageServiceProcess("server.spawn")
  },
}

export const ESLint: Info = {
  id: "eslint",
  root: NearestRoot(["package-lock.json", "bun.lockb", "bun.lock", "pnpm-lock.yaml", "yarn.lock"]),
  extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".vue"],
  async spawn() {
    return refuseLanguageServiceProcess("server.spawn")
  },
}

export const Oxlint: Info = {
  id: "oxlint",
  root: NearestRoot([
    ".oxlintrc.json",
    "package-lock.json",
    "bun.lockb",
    "bun.lock",
    "pnpm-lock.yaml",
    "yarn.lock",
    "package.json",
  ]),
  extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".vue", ".astro", ".svelte"],
  async spawn() {
    return refuseLanguageServiceProcess("server.spawn")
  },
}

export const Biome: Info = {
  id: "biome",
  root: NearestRoot([
    "biome.json",
    "biome.jsonc",
    "package-lock.json",
    "bun.lockb",
    "bun.lock",
    "pnpm-lock.yaml",
    "yarn.lock",
  ]),
  extensions: [
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".mts",
    ".cts",
    ".json",
    ".jsonc",
    ".vue",
    ".astro",
    ".svelte",
    ".css",
    ".graphql",
    ".gql",
    ".html",
  ],
  async spawn() {
    return refuseLanguageServiceProcess("server.spawn")
  },
}

export const Gopls: Info = {
  id: "gopls",
  root: async (file, ctx) => {
    const work = await NearestRoot(["go.work"])(file, ctx)
    if (work) return work
    return NearestRoot(["go.mod", "go.sum"])(file, ctx)
  },
  extensions: [".go"],
  async spawn() {
    return refuseLanguageServiceProcess("server.spawn")
  },
}

export const Rubocop: Info = {
  id: "ruby-lsp",
  root: NearestRoot(["Gemfile"]),
  extensions: [".rb", ".rake", ".gemspec", ".ru"],
  async spawn() {
    return refuseLanguageServiceProcess("server.spawn")
  },
}

export const Ty: Info = {
  id: "ty",
  extensions: [".py", ".pyi"],
  root: NearestRoot([
    "pyproject.toml",
    "ty.toml",
    "setup.py",
    "setup.cfg",
    "requirements.txt",
    "Pipfile",
    "pyrightconfig.json",
  ]),
  async spawn() {
    return refuseLanguageServiceProcess("server.spawn")
  },
}

export const Pyright: Info = {
  id: "pyright",
  extensions: [".py", ".pyi"],
  root: NearestRoot(["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "Pipfile", "pyrightconfig.json"]),
  async spawn() {
    return refuseLanguageServiceProcess("server.spawn")
  },
}

export const ElixirLS: Info = {
  id: "elixir-ls",
  extensions: [".ex", ".exs"],
  root: NearestRoot(["mix.exs", "mix.lock"]),
  async spawn() {
    return refuseLanguageServiceProcess("server.spawn")
  },
}

export const Zls: Info = {
  id: "zls",
  extensions: [".zig", ".zon"],
  root: NearestRoot(["build.zig"]),
  async spawn() {
    return refuseLanguageServiceProcess("server.spawn")
  },
}

export const CSharp: Info = {
  id: "csharp",
  root: NearestRoot([".slnx", ".sln", ".csproj", "global.json"]),
  extensions: [".cs", ".csx"],
  async spawn() {
    return refuseLanguageServiceProcess("server.spawn")
  },
}

export const Razor: Info = {
  id: "razor",
  root: NearestRoot([".slnx", ".sln", ".csproj", "global.json"]),
  extensions: [".razor", ".cshtml"],
  async spawn() {
    return refuseLanguageServiceProcess("server.spawn")
  },
}

export const FSharp: Info = {
  id: "fsharp",
  root: NearestRoot([".slnx", ".sln", ".fsproj", "global.json"]),
  extensions: [".fs", ".fsi", ".fsx", ".fsscript"],
  async spawn() {
    return refuseLanguageServiceProcess("server.spawn")
  },
}

export const SourceKit: Info = {
  id: "sourcekit-lsp",
  extensions: [".swift", ".objc", "objcpp"],
  root: NearestRoot(["Package.swift", "*.xcodeproj", "*.xcworkspace"]),
  async spawn() {
    return refuseLanguageServiceProcess("server.spawn")
  },
}

export const RustAnalyzer: Info = {
  id: "rust",
  root: async (file, ctx) => {
    const crateRoot = await NearestRoot(["Cargo.toml", "Cargo.lock"])(file, ctx)
    if (crateRoot === undefined) {
      return undefined
    }
    let currentDir = crateRoot

    while (currentDir !== path.dirname(currentDir)) {
      // Stop at filesystem root
      const cargoTomlPath = path.join(currentDir, "Cargo.toml")
      try {
        const cargoTomlContent = await Filesystem.readText(cargoTomlPath)
        if (cargoTomlContent.includes("[workspace]")) {
          return currentDir
        }
      } catch {
        // File doesn't exist or can't be read, continue searching up
      }

      const parentDir = path.dirname(currentDir)
      if (parentDir === currentDir) break // Reached filesystem root
      currentDir = parentDir

      // Stop if we've gone above the app root
      if (!currentDir.startsWith(ctx.worktree)) break
    }

    return crateRoot
  },
  extensions: [".rs"],
  async spawn() {
    return refuseLanguageServiceProcess("server.spawn")
  },
}

export const Clangd: Info = {
  id: "clangd",
  root: NearestRoot(["compile_commands.json", "compile_flags.txt", ".clangd"]),
  extensions: [".c", ".cpp", ".cc", ".cxx", ".c++", ".h", ".hpp", ".hh", ".hxx", ".h++"],
  async spawn() {
    return refuseLanguageServiceProcess("server.spawn")
  },
}

export const Svelte: Info = {
  id: "svelte",
  extensions: [".svelte"],
  root: NearestRoot(["package-lock.json", "bun.lockb", "bun.lock", "pnpm-lock.yaml", "yarn.lock"]),
  async spawn() {
    return refuseLanguageServiceProcess("server.spawn")
  },
}

export const Astro: Info = {
  id: "astro",
  extensions: [".astro"],
  root: NearestRoot(["package-lock.json", "bun.lockb", "bun.lock", "pnpm-lock.yaml", "yarn.lock"]),
  async spawn() {
    return refuseLanguageServiceProcess("server.spawn")
  },
}

function isModuleOf(pomContent: string, modulePath: string): boolean {
  const normalized = modulePath.replace(/\\/g, "/").replace(/\/$/, "")
  if (!normalized) return false
  const modulesBlocks = pomContent.match(/<modules>([\s\S]*?)<\/modules>/g) ?? []
  for (const block of modulesBlocks) {
    const stripped = block.replace(/<!--[\s\S]*?-->/g, "")
    for (const m of stripped.matchAll(/<module>\s*([^<]+?)\s*<\/module>/g)) {
      const decl = m[1].replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "")
      if (decl === normalized) return true
    }
  }
  return false
}

export const JDTLS: Info = {
  id: "jdtls",
  root: async (file, ctx) => {
    const settingsMarkers = ["settings.gradle", "settings.gradle.kts"]
    const gradleMarkers = ["gradlew", "gradlew.bat"]
    // 1. Gradle (unchanged from original logic)
    const [wrapperRoot, settingsRoot] = await Promise.all([
      StrictNearestRoot(gradleMarkers, settingsMarkers)(file, ctx),
      StrictNearestRoot(settingsMarkers)(file, ctx),
    ])
    if (wrapperRoot) return wrapperRoot
    if (settingsRoot) return settingsRoot

    // 2. Gradle single-project fallback (build.gradle without settings.gradle)
    const buildRoot = await StrictNearestRoot(["build.gradle", "build.gradle.kts"])(file, ctx)
    if (buildRoot) return buildRoot

    // 3. Maven: walk up pom.xml chain verifying <module> relationships
    const pomFiles = await Filesystem.findUp("pom.xml", path.dirname(file), ctx.directory)
    if (pomFiles.length > 0) {
      let root = path.dirname(pomFiles[0])
      for (let i = 1; i < pomFiles.length; i++) {
        const parentDir = path.dirname(pomFiles[i])
        const rel = path.relative(parentDir, root)
        const content = await fs.readFile(pomFiles[i], "utf-8").catch(() => null)
        if (content && isModuleOf(content, rel)) {
          root = parentDir
        } else {
          break
        }
      }
      return root
    }

    // 4. Eclipse native project fallback
    const eclipseRoot = await StrictNearestRoot([".project", ".classpath"])(file, ctx)
    if (eclipseRoot) return eclipseRoot

    return undefined
  },
  extensions: [".java"],
  async spawn() {
    return refuseLanguageServiceProcess("server.spawn")
  },
}

export const KotlinLS: Info = {
  id: "kotlin-ls",
  extensions: [".kt", ".kts"],
  root: async (file, ctx) => {
    // 1) Nearest Gradle root (multi-project or included build)
    const settingsRoot = await NearestRoot(["settings.gradle.kts", "settings.gradle"])(file, ctx)
    if (settingsRoot) return settingsRoot
    // 2) Gradle wrapper (strong root signal)
    const wrapperRoot = await NearestRoot(["gradlew", "gradlew.bat"])(file, ctx)
    if (wrapperRoot) return wrapperRoot
    // 3) Single-project or module-level build
    const buildRoot = await NearestRoot(["build.gradle.kts", "build.gradle"])(file, ctx)
    if (buildRoot) return buildRoot
    // 4) Maven fallback
    return NearestRoot(["pom.xml"])(file, ctx)
  },
  async spawn() {
    return refuseLanguageServiceProcess("server.spawn")
  },
}

export const YamlLS: Info = {
  id: "yaml-ls",
  extensions: [".yaml", ".yml"],
  root: NearestRoot(["package-lock.json", "bun.lockb", "bun.lock", "pnpm-lock.yaml", "yarn.lock"]),
  async spawn() {
    return refuseLanguageServiceProcess("server.spawn")
  },
}

export const LuaLS: Info = {
  id: "lua-ls",
  root: NearestRoot([
    ".luarc.json",
    ".luarc.jsonc",
    ".luacheckrc",
    ".stylua.toml",
    "stylua.toml",
    "selene.toml",
    "selene.yml",
  ]),
  extensions: [".lua"],
  async spawn() {
    return refuseLanguageServiceProcess("server.spawn")
  },
}

export const PHPIntelephense: Info = {
  id: "php intelephense",
  extensions: [".php"],
  root: NearestRoot(["composer.json", "composer.lock", ".php-version"]),
  async spawn() {
    return refuseLanguageServiceProcess("server.spawn")
  },
}

export const Prisma: Info = {
  id: "prisma",
  extensions: [".prisma"],
  root: NearestRoot(["schema.prisma", "prisma/schema.prisma", "prisma"], ["package.json"]),
  async spawn() {
    return refuseLanguageServiceProcess("server.spawn")
  },
}

export const Dart: Info = {
  id: "dart",
  extensions: [".dart"],
  root: NearestRoot(["pubspec.yaml", "analysis_options.yaml"]),
  async spawn() {
    return refuseLanguageServiceProcess("server.spawn")
  },
}

export const Ocaml: Info = {
  id: "ocaml-lsp",
  extensions: [".ml", ".mli"],
  root: NearestRoot(["dune-project", "dune-workspace", ".merlin", "opam"]),
  async spawn() {
    return refuseLanguageServiceProcess("server.spawn")
  },
}
export const BashLS: Info = {
  id: "bash",
  extensions: [".sh", ".bash", ".zsh", ".ksh"],
  root: async (_file, ctx) => ctx.directory,
  async spawn() {
    return refuseLanguageServiceProcess("server.spawn")
  },
}

export const TerraformLS: Info = {
  id: "terraform",
  extensions: [".tf", ".tfvars"],
  root: NearestRoot([".terraform.lock.hcl", "terraform.tfstate", "*.tf"]),
  async spawn() {
    return refuseLanguageServiceProcess("server.spawn")
  },
}

export const TexLab: Info = {
  id: "texlab",
  extensions: [".tex", ".bib"],
  root: NearestRoot([".latexmkrc", "latexmkrc", ".texlabroot", "texlabroot"]),
  async spawn() {
    return refuseLanguageServiceProcess("server.spawn")
  },
}

export const DockerfileLS: Info = {
  id: "dockerfile",
  extensions: [".dockerfile", "Dockerfile"],
  root: async (_file, ctx) => ctx.directory,
  async spawn() {
    return refuseLanguageServiceProcess("server.spawn")
  },
}

export const Gleam: Info = {
  id: "gleam",
  extensions: [".gleam"],
  root: NearestRoot(["gleam.toml"]),
  async spawn() {
    return refuseLanguageServiceProcess("server.spawn")
  },
}

export const Clojure: Info = {
  id: "clojure-lsp",
  extensions: [".clj", ".cljs", ".cljc", ".edn"],
  root: NearestRoot(["deps.edn", "project.clj", "shadow-cljs.edn", "bb.edn", "build.boot"]),
  async spawn() {
    return refuseLanguageServiceProcess("server.spawn")
  },
}

export const Nixd: Info = {
  id: "nixd",
  extensions: [".nix"],
  root: async (file, ctx) => {
    // First, look for flake.nix - the most reliable Nix project root indicator
    const flakeRoot = await NearestRoot(["flake.nix"])(file, ctx)
    if (flakeRoot && flakeRoot !== ctx.directory) return flakeRoot

    // If no flake.nix, fall back to git repository root
    if (ctx.worktree && ctx.worktree !== ctx.directory) return ctx.worktree

    // Finally, use the instance directory as fallback
    return ctx.directory
  },
  async spawn() {
    return refuseLanguageServiceProcess("server.spawn")
  },
}

export const Tinymist: Info = {
  id: "tinymist",
  extensions: [".typ", ".typc"],
  root: NearestRoot(["typst.toml"]),
  async spawn() {
    return refuseLanguageServiceProcess("server.spawn")
  },
}

export const HLS: Info = {
  id: "haskell-language-server",
  extensions: [".hs", ".lhs"],
  root: NearestRoot(["stack.yaml", "cabal.project", "hie.yaml", "*.cabal"]),
  async spawn() {
    return refuseLanguageServiceProcess("server.spawn")
  },
}

export const JuliaLS: Info = {
  id: "julials",
  extensions: [".jl"],
  root: NearestRoot(["Project.toml", "Manifest.toml", "*.jl"]),
  async spawn() {
    return refuseLanguageServiceProcess("server.spawn")
  },
}

/** Built-in definitions only; executable identity still comes from trusted global Config + HostKernel. */
export const builtins: readonly Info[] = Object.freeze([
  Deno, Typescript, Vue, ESLint, Oxlint, Biome, Gopls, Rubocop, Ty, Pyright, ElixirLS, Zls,
  CSharp, Razor, FSharp, SourceKit, RustAnalyzer, Clangd, Svelte, Astro, JDTLS, KotlinLS,
  YamlLS, LuaLS, PHPIntelephense, Prisma, Dart, Ocaml, BashLS, TerraformLS, TexLab,
  DockerfileLS, Gleam, Clojure, Nixd, Tinymist, HLS, JuliaLS,
])
