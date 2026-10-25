import { describe, expect, test } from "bun:test"
import { builtinHarnessProfileV1, projectHarnessToolIDsV1 } from "../src/harness-profile"

/**
 * CX-008 — "context overflow from tool schemas: tool search / lazy exposure
 * reduces the catalog."
 *
 * The row is the projection decision itself: for the `minimal` harness the
 * authorized catalog is split into a bounded starter set plus deferred
 * members that only `tools_search` can surface, and no authorized capability
 * may be dropped or invented by the split. Everything here is pure and
 * offline — no provider, HostKernel route or terminal is involved.
 */
const CATALOG: readonly string[] = [
  "files.read",
  "files.write",
  "files.patch",
  "terminal.run",
  "glob.search",
  "text.search",
  "repo.tree",
  "repo.detect",
  "symbols.search",
  "definitions.find",
  "references.find",
  "question.ask",
  "tools.search",
  "mcp.read",
  "web.fetch",
  "web.search",
]

const profile = (id: string) => {
  const built = builtinHarnessProfileV1(id)
  expect(built).toBeDefined()
  return built!
}

describe("CX-008 tool-catalog lazy exposure", () => {
  test("minimal projection shrinks the exposed catalog and defers the rest", () => {
    const projected = projectHarnessToolIDsV1(profile("native-minimal"), CATALOG)

    // The row's whole point: the exposed (starter) set is strictly smaller
    // than the authorized catalog, so the shipped schemas no longer overflow.
    expect(projected.starter.length).toBeLessThan(CATALOG.length)
    expect(projected.deferred.length).toBeGreaterThan(0)

    // Discovery-capable tools stay reachable from the first request.
    expect(projected.starter).toContain("tools.search")
    expect(projected.starter).toContain("files.read")

    // Authoritative tools are the ones that had to be deferred.
    expect(projected.deferred).toContain("files.write")
    expect(projected.deferred).toContain("terminal.run")
  })

  test("the split partitions the catalog exactly: nothing dropped, nothing invented", () => {
    const projected = projectHarnessToolIDsV1(profile("native-minimal"), CATALOG)
    const union = [...projected.starter, ...projected.deferred].toSorted()

    expect(union).toEqual([...CATALOG].toSorted())
    expect(new Set(union).size).toBe(union.length)
    expect(projected.starter.filter((id) => projected.deferred.includes(id))).toEqual([])
  })

  test("duplicate capability ids are deduplicated and the projection is deterministic", () => {
    const withDuplicates = [...CATALOG, "files.read", "web.fetch", "files.read"]
    const first = projectHarnessToolIDsV1(profile("native-minimal"), withDuplicates)
    const second = projectHarnessToolIDsV1(profile("native-minimal"), withDuplicates)

    expect(first).toEqual(second)
    expect(new Set([...first.starter, ...first.deferred]).size).toBe(
      first.starter.length + first.deferred.length,
    )
    expect(first.starter).toEqual([...first.starter].toSorted())
    expect(first.deferred).toEqual([...first.deferred].toSorted())
    expect(first.starter.length + first.deferred.length).toBe(new Set(CATALOG).size)
  })

  test("only the minimal harness defers: rich and bash-only expose their whole authorized set", () => {
    const rich = projectHarnessToolIDsV1(profile("native-rich"), CATALOG)
    expect(rich.deferred).toEqual([])
    expect(rich.starter).toEqual([...CATALOG].toSorted())

    const bashOnly = projectHarnessToolIDsV1(profile("bash-only"), CATALOG)
    expect(bashOnly.deferred).toEqual([])
    expect(bashOnly.starter).toEqual(["files.read", "glob.search", "terminal.run", "text.search"].toSorted())
    // Discovery never broadens authority on bash-only: `tools.search` is not
    // part of its starter set, and nothing is deferred for it to reveal.
    expect(bashOnly.starter).not.toContain("tools.search")
  })

  test("an unauthorized capability never appears in either half", () => {
    const authorized = ["files.read", "glob.search", "tools.search"]
    const projected = projectHarnessToolIDsV1(profile("native-minimal"), authorized)

    expect(projected.starter).toEqual(["files.read", "glob.search", "tools.search"].toSorted())
    expect(projected.deferred).toEqual([])
    expect([...projected.starter, ...projected.deferred].some((id) => id.startsWith("mcp."))).toBe(false)
  })
})
