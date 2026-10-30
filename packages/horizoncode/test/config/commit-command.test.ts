import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { ConfigMarkdown as ConfigMarkdownCore } from "@horizoncode/core/config/markdown"
import { ConfigMarkdown } from "../../src/config/markdown"

/**
 * `/commit` must not expand `!`…`` shell blocks during SessionPrompt.command:
 * that path uses unmediated terminal.run and returns 503 in Guarded serve mode.
 */
describe("commit slash command template", () => {
  test("uses no shell interpolation blocks", () => {
    const repoRoot = resolve(import.meta.dir, "../../../..")
    const path = resolve(repoRoot, ".opencode/command/commit.md")
    const parsed = ConfigMarkdownCore.parse(readFileSync(path, "utf8"))
    const blocks = ConfigMarkdown.shell(String(parsed.content))
    expect(blocks.length).toBe(0)
    expect(String(parsed.content)).toContain("git_status")
    expect(String(parsed.content)).toContain("git_diff")
  })
})
