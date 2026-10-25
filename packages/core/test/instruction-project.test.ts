import { describe, expect, test } from "bun:test"
import { blake3 } from "@noble/hashes/blake3.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import {
  DEFAULT_PROJECT_INSTRUCTION_RESOLVER_V1,
  compileProjectInstructionsV1,
  projectInstructionLedgerEntriesV1,
  projectInstructionSelectionSourcesV1,
  projectInstructionSourceIDV1,
  resolveProjectInstructionFilesV1,
  type ProjectInstructionFileV1,
} from "@opencode-ai/core/session/project-instruction"

const digest = (text: string) => `blake3:${bytesToHex(blake3(new TextEncoder().encode(text)))}`

const file = (input: {
  path: string
  relativePath?: string
  kind?: ProjectInstructionFileV1["kind"]
  scope?: ProjectInstructionFileV1["scope"]
  content: string
}): ProjectInstructionFileV1 => ({
  filepath: `/repo/${input.path}`,
  relativePath: input.relativePath ?? input.path,
  kind: input.kind ?? "agents",
  scope: input.scope ?? "project",
  digest: digest(input.content),
  content: input.content,
})

const root = "/repo"

describe("§29.23 project instruction resolver", () => {
  test("loads only root→cwd project ancestors and never sibling packages (CX-022, INST-001)", () => {
    const result = resolveProjectInstructionFilesV1({
      workspaceRoot: root,
      cwd: "/repo/packages/core",
      candidates: [
        file({ path: "AGENTS.md", content: "root" }),
        file({ path: "packages/AGENTS.md", content: "packages" }),
        file({ path: "packages/core/AGENTS.md", content: "core" }),
        file({ path: "packages/opencode/AGENTS.md", content: "sibling" }),
      ],
    })
    expect(result.ancestor.map((slice) => slice.file.relativePath)).toEqual([
      "AGENTS.md",
      "packages/AGENTS.md",
      "packages/core/AGENTS.md",
    ])
    expect(result.ancestor.some((slice) => slice.file.content === "sibling")).toBe(false)
  })

  test("prefer_agents_md chooses AGENTS over CLAUDE per directory (INST-002)", () => {
    const result = resolveProjectInstructionFilesV1({
      workspaceRoot: root,
      cwd: "/repo/packages/core",
      resolver: { mode: "prefer_agents_md" },
      candidates: [
        file({ path: "AGENTS.md", content: "agents-root" }),
        file({ path: "CLAUDE.md", kind: "claude", content: "claude-root" }),
        file({ path: "packages/core/CLAUDE.md", kind: "claude", content: "claude-core" }),
      ],
    })
    expect(result.ancestor.map((slice) => slice.file.content)).toEqual(["agents-root", "claude-core"])
  })

  test("merge_both keeps a deterministic AGENTS then CLAUDE order", () => {
    const result = resolveProjectInstructionFilesV1({
      workspaceRoot: root,
      cwd: "/repo",
      resolver: { mode: "merge_both" },
      candidates: [
        file({ path: "CLAUDE.md", kind: "claude", content: "claude" }),
        file({ path: "AGENTS.md", content: "agents" }),
        file({ path: "CLAUDE.local.md", kind: "claude_local", content: "local" }),
      ],
    })
    expect(result.ancestor.map((slice) => slice.file.content)).toEqual(["agents", "claude", "local"])
  })

  test("config_only includes explicit config files only (INST-005)", () => {
    const result = resolveProjectInstructionFilesV1({
      workspaceRoot: root,
      cwd: "/repo",
      resolver: { mode: "config_only" },
      candidates: [
        file({ path: "AGENTS.md", content: "agents" }),
        file({ path: ".opencode/rules.md", kind: "config", content: "config" }),
      ],
    })
    expect(result.ancestor.map((slice) => slice.file.kind)).toEqual(["config"])
    expect(result.ancestor.map((slice) => slice.file.content)).toEqual(["config"])
  })

  test("exclude globs keep vendor and repo_take out of the union (INST-006)", () => {
    const result = resolveProjectInstructionFilesV1({
      workspaceRoot: root,
      cwd: "/repo",
      candidates: [
        file({ path: "AGENTS.md", content: "root" }),
        file({ path: "vendor/AGENTS.md", content: "vendor" }),
        file({ path: "repo_take/AGENTS.md", content: "reference" }),
        file({ path: "node_modules/pkg/AGENTS.md", content: "dependency" }),
      ],
    })
    expect(result.ancestor.map((slice) => slice.file.relativePath)).toEqual(["AGENTS.md"])
    expect(result.excluded.map((entry) => entry.relativePath).sort()).toEqual([
      "node_modules/pkg/AGENTS.md",
      "repo_take/AGENTS.md",
      "vendor/AGENTS.md",
    ])
    expect(result.excluded.every((entry) => entry.reason === "exclude_glob")).toBe(true)
  })

  test("user scope loads before project slices, including files outside the workspace (INST-007)", () => {
    const result = resolveProjectInstructionFilesV1({
      workspaceRoot: root,
      cwd: "/repo/packages/core",
      candidates: [
        {
          filepath: "/home/user/.claude/CLAUDE.md",
          relativePath: "~/.claude/CLAUDE.md",
          kind: "claude",
          scope: "user",
          digest: digest("personal"),
          content: "personal",
        },
        file({ path: "AGENTS.md", content: "project" }),
        file({ path: "packages/core/AGENTS.md", content: "package" }),
      ],
    })
    expect(result.ancestor.map((slice) => slice.file.content)).toEqual(["personal", "project", "package"])
  })

  test("on-demand subdirectory instructions load once and only after a guarded target (CX-023, INST-008)", () => {
    const candidates = [
      file({ path: "AGENTS.md", content: "root" }),
      file({ path: "packages/foo/AGENTS.md", content: "foo" }),
    ]
    const sessionStart = resolveProjectInstructionFilesV1({ workspaceRoot: root, cwd: "/repo", candidates })
    expect(sessionStart.onDemand).toHaveLength(0)

    const firstTouch = resolveProjectInstructionFilesV1({
      workspaceRoot: root,
      cwd: "/repo",
      candidates,
      targetPath: "/repo/packages/foo/src/index.ts",
      alreadyLoaded: sessionStart.ancestor.map((slice) => ({
        relativePath: slice.file.relativePath,
        digest: slice.file.digest,
      })),
    })
    expect(firstTouch.onDemand.map((slice) => slice.file.content)).toEqual(["foo"])

    const secondTouch = resolveProjectInstructionFilesV1({
      workspaceRoot: root,
      cwd: "/repo",
      candidates,
      targetPath: "/repo/packages/foo/src/other.ts",
      alreadyLoaded: [
        { relativePath: "AGENTS.md", digest: candidates[0]!.digest },
        { relativePath: "packages/foo/AGENTS.md", digest: candidates[1]!.digest },
      ],
    })
    expect(secondTouch.onDemand).toHaveLength(0)
  })

  test("a changed instruction digest at an already-loaded path is eligible again", () => {
    const updated = file({ path: "packages/foo/AGENTS.md", content: "updated foo rules" })
    const result = resolveProjectInstructionFilesV1({
      workspaceRoot: root,
      cwd: "/repo",
      candidates: [file({ path: "AGENTS.md", content: "root" }), updated],
      targetPath: "/repo/packages/foo/src/index.ts",
      alreadyLoaded: [{ relativePath: updated.relativePath, digest: digest("previous foo rules") }],
    })

    expect(result.onDemand.map((slice) => slice.file.content)).toEqual(["updated foo rules"])
  })

  test("a target outside the workspace is refused rather than resolved (path isolation)", () => {
    const result = resolveProjectInstructionFilesV1({
      workspaceRoot: root,
      cwd: "/repo",
      candidates: [file({ path: "AGENTS.md", content: "root" })],
      targetPath: "/etc/passwd",
    })
    expect(result.onDemand).toHaveLength(0)
    expect(result.excluded).toContainEqual({ relativePath: "/etc/passwd", reason: "outside_workspace" })
  })

  test("traversal, absolute, control and bidi candidate paths are excluded", () => {
    const result = resolveProjectInstructionFilesV1({
      workspaceRoot: root,
      cwd: "/repo",
      candidates: [
        file({ path: "AGENTS.md", content: "root" }),
        { ...file({ path: "AGENTS.md", content: "escape" }), relativePath: "../AGENTS.md" },
        { ...file({ path: "AGENTS.md", content: "absolute" }), relativePath: "/etc/AGENTS.md" },
        { ...file({ path: "AGENTS.md", content: "control" }), relativePath: "packages/\u0000/AGENTS.md" },
        { ...file({ path: "AGENTS.md", content: "bidi" }), relativePath: "packages/\u202e/AGENTS.md" },
      ],
    })
    expect(result.ancestor).toHaveLength(1)
    expect(result.excluded.filter((entry) => entry.reason === "invalid_path").length).toBe(4)
  })

  test("a project candidate cannot claim a relative path different from its absolute path", () => {
    const result = resolveProjectInstructionFilesV1({
      workspaceRoot: root,
      cwd: "/repo",
      candidates: [
        {
          ...file({ path: "actual/AGENTS.md", content: "actual location" }),
          relativePath: "claimed/AGENTS.md",
        },
      ],
    })

    expect(result.ancestor).toHaveLength(0)
    expect(result.excluded).toContainEqual({ relativePath: "claimed/AGENTS.md", reason: "invalid_path" })
  })

  test("a candidate with a digest for different bytes is excluded from prompt selection", () => {
    const mismatched = {
      ...file({ path: "AGENTS.md", content: "untrusted current bytes" }),
      digest: digest("different previously observed bytes"),
    }
    const result = resolveProjectInstructionFilesV1({
      workspaceRoot: root,
      cwd: "/repo",
      candidates: [mismatched],
    })

    expect(result.ancestor).toHaveLength(0)
    expect(result.excluded).toContainEqual({ relativePath: "AGENTS.md", reason: "digest_mismatch" })
    expect(compileProjectInstructionsV1({ blueprint: result }).included).toHaveLength(0)
  })

  test("compiled output is bounded with an explicit head/tail marker (INST-003)", () => {
    const candidates = [
      file({ path: "AGENTS.md", content: `root:${"a".repeat(140)}` }),
      file({ path: "packages/AGENTS.md", content: `middle:${"b".repeat(140)}` }),
      file({ path: "packages/core/AGENTS.md", content: `tail:${"c".repeat(140)}` }),
    ]
    const blueprint = resolveProjectInstructionFilesV1({ workspaceRoot: root, cwd: "/repo/packages/core", candidates })
    const compiled = compileProjectInstructionsV1({ blueprint, maxCompiledBytes: 500 })
    expect(compiled.truncated).toBe(true)
    expect(compiled.bytes).toBeLessThanOrEqual(500)
    expect(compiled.marker).toContain("project instructions truncated")
    expect(compiled.text).toContain("Instructions from: AGENTS.md")
    expect(compiled.text).toContain("Instructions from: packages/core/AGENTS.md")
    expect(compiled.text).toContain(compiled.marker!)
  })

  test("instruction digests and compiled digest are stable across restart unless content changes (INST-008)", () => {
    const candidates = [file({ path: "AGENTS.md", content: "root" })]
    const first = compileProjectInstructionsV1({
      blueprint: resolveProjectInstructionFilesV1({ workspaceRoot: root, cwd: "/repo", candidates }),
    })
    const restarted = compileProjectInstructionsV1({
      blueprint: resolveProjectInstructionFilesV1({ workspaceRoot: root, cwd: "/repo", candidates }),
    })
    const changed = compileProjectInstructionsV1({
      blueprint: resolveProjectInstructionFilesV1({
        workspaceRoot: root,
        cwd: "/repo",
        candidates: [file({ path: "AGENTS.md", content: "root v2" })],
      }),
    })
    expect(first.digest).toBe(restarted.digest)
    expect(changed.digest).not.toBe(first.digest)
  })
})

describe("project instruction imports and ledger provenance", () => {
  test("an outside-workspace @import stays blocked until explicitly approved (CX-025)", () => {
    const rootFile = file({ path: "AGENTS.md", content: "root\n@../shared/rules.md" })
    const shared: ProjectInstructionFileV1 = {
      filepath: "/shared/rules.md",
      relativePath: "../shared/rules.md",
      kind: "claude",
      scope: "project",
      digest: digest("shared rules"),
      content: "shared rules",
    }
    const blueprint = resolveProjectInstructionFilesV1({
      workspaceRoot: root,
      cwd: "/repo",
      candidates: [rootFile],
      importCandidates: [shared],
    })
    expect(blueprint.blockedImports).toContainEqual({
      from: "AGENTS.md",
      target: "../shared/rules.md",
      reason: "outside_workspace_requires_approval",
    })
    expect(blueprint.ancestor.map((slice) => slice.file.content)).toEqual(["root\n@../shared/rules.md"])

    const approved = resolveProjectInstructionFilesV1({
      workspaceRoot: root,
      cwd: "/repo",
      candidates: [rootFile],
      importCandidates: [shared],
      approvedExternalImports: ["/shared/rules.md"],
    })
    expect(approved.blockedImports).toHaveLength(0)
    expect(approved.ancestor.map((slice) => slice.file.content)).toEqual(["root\n@../shared/rules.md", "shared rules"])
  })

  test("a missing import is reported, never partially invented", () => {
    const blueprint = resolveProjectInstructionFilesV1({
      workspaceRoot: root,
      cwd: "/repo",
      candidates: [file({ path: "AGENTS.md", content: "@missing.md" })],
    })
    expect(blueprint.blockedImports).toEqual([{ from: "AGENTS.md", target: "missing.md", reason: "missing" }])
  })

  test("an import beyond the bounded expansion depth is recorded as blocked", () => {
    const imported = Array.from({ length: 9 }, (_, index) => {
      const path = `rules-${index + 1}.md`
      const next = index < 8 ? `@rules-${index + 2}.md` : "terminal rules"
      return file({ path, kind: "import", content: next })
    })
    const blueprint = resolveProjectInstructionFilesV1({
      workspaceRoot: root,
      cwd: "/repo",
      candidates: [file({ path: "AGENTS.md", content: "@rules-1.md" })],
      importCandidates: imported,
    })

    expect(blueprint.blockedImports).toContainEqual({
      from: "rules-8.md",
      target: "rules-9.md",
      reason: "depth_limit",
    })
    expect(blueprint.ancestor.some((slice) => slice.file.relativePath === "rules-9.md")).toBe(false)
  })

  test("an import beyond the per-file expansion bound is recorded as blocked", () => {
    const targets = Array.from({ length: 33 }, (_, index) => `@rules-${index + 1}.md`)
    const blueprint = resolveProjectInstructionFilesV1({
      workspaceRoot: root,
      cwd: "/repo",
      candidates: [file({ path: "AGENTS.md", content: targets.join("\n") })],
      importCandidates: Array.from({ length: 33 }, (_, index) =>
        file({ path: `rules-${index + 1}.md`, kind: "import", content: `rule ${index + 1}` }),
      ),
    })

    expect(blueprint.blockedImports).toContainEqual({
      from: "AGENTS.md",
      target: "rules-33.md",
      reason: "import_limit",
    })
    expect(blueprint.ancestor.some((slice) => slice.file.relativePath === "rules-33.md")).toBe(false)
  })

  test("an import whose digest does not match its bytes stays blocked", () => {
    const blueprint = resolveProjectInstructionFilesV1({
      workspaceRoot: root,
      cwd: "/repo",
      candidates: [file({ path: "AGENTS.md", content: "@rules.md" })],
      importCandidates: [
        {
          ...file({ path: "rules.md", content: "changed imported bytes" }),
          digest: digest("different observed bytes"),
        },
      ],
    })

    expect(blueprint.blockedImports).toEqual([{ from: "AGENTS.md", target: "rules.md", reason: "invalid" }])
    expect(blueprint.ancestor.map((slice) => slice.file.relativePath)).toEqual(["AGENTS.md"])
  })

  test("an import candidate must resolve to the requested absolute file path", () => {
    const blueprint = resolveProjectInstructionFilesV1({
      workspaceRoot: root,
      cwd: "/repo",
      candidates: [file({ path: "AGENTS.md", content: "@rules.md" })],
      importCandidates: [file({ path: "elsewhere/rules.md", relativePath: "rules.md", content: "misbound" })],
    })

    expect(blueprint.blockedImports).toEqual([{ from: "AGENTS.md", target: "rules.md", reason: "invalid" }])
    expect(blueprint.ancestor.map((slice) => slice.file.relativePath)).toEqual(["AGENTS.md"])
  })

  test("instruction sources and ledger entries carry exact digests and project_instruction provenance", () => {
    const candidates = [
      file({ path: "AGENTS.md", content: "root" }),
      file({ path: "packages/core/AGENTS.md", content: "core" }),
    ]
    const blueprint = resolveProjectInstructionFilesV1({ workspaceRoot: root, cwd: "/repo/packages/core", candidates })
    const compiled = compileProjectInstructionsV1({ blueprint })
    const sources = projectInstructionSelectionSourcesV1(blueprint)
    expect(sources).toHaveLength(2)
    for (const source of sources) {
      expect(source.kind).toBe("instruction")
      expect(source.sourceAuthority).toBe("instruction-resolver")
      expect(source.inclusionReason).toBe("instruction")
      expect(source.sourceID).toMatch(/^ins_[0-9a-f]{32}$/)
      expect(source.sourceRevision).toBe(source.contentDigest)
    }
    expect(new Set(sources.map((source) => source.sourceID)).size).toBe(2)
    expect(projectInstructionSourceIDV1("AGENTS.md")).toBe(projectInstructionSourceIDV1("AGENTS.md"))

    const entries = projectInstructionLedgerEntriesV1({ blueprint, compiled })
    expect(entries.map((entry) => entry.sourceRef).sort()).toEqual(
      sources.map((source) => `instruction:${source.sourceID}`).sort(),
    )
    for (const entry of entries) {
      expect(entry.inclusionReason).toBe("project_instruction")
      expect(entry.kind).toBe("system")
      expect(entry.bytesKind).toBe("exact")
      expect(entry.tokens.kind).toBe("unknown")
      expect(entry.cacheClass).toBe("static")
    }
  })

  test("defaults match the §29.23 safety budget", () => {
    expect(DEFAULT_PROJECT_INSTRUCTION_RESOLVER_V1).toMatchObject({
      mode: "prefer_agents_md",
      maxCompiledBytes: 131_072,
      maxAncestorFiles: 32,
      onDemandSubdir: true,
    })
    expect(DEFAULT_PROJECT_INSTRUCTION_RESOLVER_V1.excludeGlobs).toContain("vendor/")
  })
})
