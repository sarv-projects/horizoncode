import { afterEach, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import path from "node:path"
import { normalizePromptContent, openEditor, workspaceEditorOpenRequest } from "../src/editor"
import { tmpdir } from "./fixture/fixture"

const editor = process.env.EDITOR
const visual = process.env.VISUAL

afterEach(() => {
  process.env.EDITOR = editor
  process.env.VISUAL = visual
})

test("does not launch a configured external editor", async () => {
  delete process.env.VISUAL
  process.env.EDITOR = "opencode-editor-that-does-not-exist"
  const renderer = {
    suspend() {},
    resume() {},
    requestRender() {},
    currentRenderBuffer: { clear() {} },
  }

  await expect(openEditor({ value: "original", renderer: renderer as never })).resolves.toBeUndefined()
})

// EDITOR-003: a shell string with flags and command substitution in $EDITOR
// must never be parsed, split or executed — only an explicitly saved profile
// plus explicit user action may ever reach a launch boundary. The canary file
// proves no shell evaluation happened at all.
test("never parses or executes a shell-string $EDITOR with flags or substitution", async () => {
  await using tmp = await tmpdir()
  const canary = path.join(tmp.path, "editor-shell-canary")
  delete process.env.VISUAL
  process.env.EDITOR = `sh -c "touch ${canary}" --wait $(touch ${canary}) >${canary}`
  const renderer = {
    suspend() {},
    resume() {},
    requestRender() {},
    currentRenderBuffer: { clear() {} },
  }

  await expect(openEditor({ value: "prompt", renderer: renderer as never })).resolves.toBeUndefined()
  expect(existsSync(canary)).toBe(false)
})

test("normalizes a single trailing editor newline for one-line prompts", () => {
  expect(normalizePromptContent("hello\n")).toBe("hello")
  expect(normalizePromptContent("hello\r\n")).toBe("hello")
})

test("preserves multiline prompts that end with a newline", () => {
  expect(normalizePromptContent("hello\nworld\n")).toBe("hello\nworld\n")
})

const selected = {
  profileId: "code",
  revision: "3",
  profileDigest: "blake3:" + "a".repeat(64),
}
const revision = "blake3:" + "b".repeat(64)
const digest = "blake3:" + "c".repeat(64)

test("requires an explicitly saved editor profile before opening a workspace file", () => {
  expect(workspaceEditorOpenRequest({
    selection: null,
    profiles: [],
    pathRef: "src/main.ts",
    sourceRevision: revision,
    contentDigest: digest,
  })).toMatchObject({ status: "unavailable", reason: "no_profile" })
})

test("fails closed with a truthful unavailable outcome instead of launching a process", () => {
  const outcome = workspaceEditorOpenRequest({
    selection: selected,
    profiles: [selected],
    pathRef: "src/main.ts",
    sourceRevision: revision,
    contentDigest: digest,
  })
  expect(outcome).toMatchObject({ status: "unavailable", reason: "host_route_unavailable" })
  expect(outcome.message).toContain("No process was started")
})

test("rejects traversal, absolute paths, separator variants and stale digests", () => {
  const base = { selection: selected, profiles: [selected], pathRef: "src/main.ts", sourceRevision: revision, contentDigest: digest }
  for (const pathRef of ["../outside.ts", "/etc/passwd", "src\\main.ts", "src//main.ts", "src/./main.ts", ""]) {
    expect(workspaceEditorOpenRequest({ ...base, pathRef })).toMatchObject({ status: "rejected", reason: "invalid_target" })
  }
  expect(workspaceEditorOpenRequest({ ...base, sourceRevision: "sha256:x" })).toMatchObject({ status: "rejected" })
  expect(workspaceEditorOpenRequest({ ...base, contentDigest: "" })).toMatchObject({ status: "rejected" })
})

test("rejects a malformed saved profile instead of trusting it", () => {
  const base = { profiles: [selected], pathRef: "src/main.ts", sourceRevision: revision, contentDigest: digest }
  expect(workspaceEditorOpenRequest({ ...base, selection: { ...selected, profileDigest: "nope" } }))
    .toMatchObject({ status: "rejected", reason: "invalid_profile" })
  expect(workspaceEditorOpenRequest({ ...base, selection: { ...selected, revision: "01" } }))
    .toMatchObject({ status: "rejected", reason: "invalid_profile" })
})

test("rejects a selected editor profile that is absent from saved Core Config", () => {
  expect(workspaceEditorOpenRequest({
    selection: selected,
    profiles: [],
    pathRef: "src/main.ts",
    sourceRevision: revision,
    contentDigest: digest,
  })).toMatchObject({ status: "rejected", reason: "invalid_profile" })
})

test("rejects a valid-looking profile ref when its saved revision or digest differs", () => {
  const base = { pathRef: "src/main.ts", sourceRevision: revision, contentDigest: digest }
  const staleRevision = { ...selected, revision: "4" }
  expect(workspaceEditorOpenRequest({
    ...base,
    selection: staleRevision,
    profiles: [selected],
  })).toMatchObject({ status: "rejected", reason: "invalid_profile" })

  const staleDigest = { ...selected, profileDigest: "blake3:" + "f".repeat(64) }
  expect(workspaceEditorOpenRequest({
    ...base,
    selection: staleDigest,
    profiles: [selected],
  })).toMatchObject({ status: "rejected", reason: "invalid_profile" })
})

test("rejects profile identifiers and revisions outside the canonical schema bounds", () => {
  const base = { pathRef: "src/main.ts", sourceRevision: revision, contentDigest: digest }
  const invalidID = { ...selected, profileId: "not a valid profile id" }
  expect(workspaceEditorOpenRequest({ ...base, selection: invalidID, profiles: [invalidID] }))
    .toMatchObject({ status: "rejected", reason: "invalid_profile" })

  const zeroRevision = { ...selected, revision: "0" }
  expect(workspaceEditorOpenRequest({ ...base, selection: zeroRevision, profiles: [zeroRevision] }))
    .toMatchObject({ status: "rejected", reason: "invalid_profile" })

  const oversizedRevision = { ...selected, revision: "18446744073709551616" }
  expect(workspaceEditorOpenRequest({ ...base, selection: oversizedRevision, profiles: [oversizedRevision] }))
    .toMatchObject({ status: "rejected", reason: "invalid_profile" })
})
