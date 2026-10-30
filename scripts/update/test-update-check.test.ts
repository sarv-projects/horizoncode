/**
 * Offline tests for the HorizonCode update-check logic
 * (packages/horizoncode/src/cli/cmd/update.ts). No network: the fetch is mocked.
 *
 * Run: ~/.bun/bin/bun test scripts/update/test-update-check.test.ts
 */
import { describe, expect, test } from "bun:test"
import {
  applyAuthorization,
  checkForUpdate,
  compareSemver,
  formatUpdateNotice,
  parseLatestVersionPayload,
  parseSemver,
  planUpdate,
  type CheckResult,
} from "../../packages/horizoncode/src/cli/cmd/update"

const hex64 = "a".repeat(64)

describe("parseSemver", () => {
  test("plain release", () => {
    expect(parseSemver("1.18.35")).toEqual({ major: 1, minor: 18, patch: 35, prerelease: [] })
  })
  test("v prefix", () => {
    expect(parseSemver("v2.0.1")).toEqual({ major: 2, minor: 0, patch: 1, prerelease: [] })
  })
  test("prerelease + build metadata", () => {
    expect(parseSemver("1.2.3-rc.1+build.9")).toEqual({ major: 1, minor: 2, patch: 3, prerelease: ["rc", "1"] })
  })
  test("rejects garbage", () => {
    expect(parseSemver("latest")).toBeNull()
    expect(parseSemver("1.2")).toBeNull()
    expect(parseSemver("")).toBeNull()
  })
})

describe("compareSemver (semver precedence)", () => {
  const cases: Array<[string, string, number | null]> = [
    ["1.0.0", "1.0.1", -1],
    ["1.0.1", "1.0.0", 1],
    ["1.2.3", "1.2.3", 0],
    ["v1.2.3", "1.2.3", 0],
    ["1.10.0", "1.9.0", 1], // numeric, not lexical
    ["2.0.0", "1.99.99", 1],
    ["1.0.0-rc.1", "1.0.0", -1], // prerelease < release
    ["1.0.0", "1.0.0-rc.1", 1],
    ["1.0.0-alpha", "1.0.0-alpha.1", -1],
    ["1.0.0-alpha.1", "1.0.0-alpha.2", -1],
    ["1.0.0-alpha.beta", "1.0.0-beta", -1],
    ["1.0.0-1", "1.0.0-alpha", -1], // numeric identifiers rank lower
    ["1.0.0-rc.1", "1.0.0-rc.2", -1],
    ["1.0.0+build.1", "1.0.0+build.2", 0], // build metadata ignored
    ["nonsense", "1.0.0", null],
  ]
  for (const [a, b, expected] of cases) {
    test(`${a} vs ${b} => ${expected}`, () => {
      expect(compareSemver(a, b)).toBe(expected)
    })
  }
})

describe("planUpdate", () => {
  test("update available", () => {
    expect(planUpdate("1.18.35", "1.19.0")).toEqual({
      relation: "update-available",
      current: "1.18.35",
      latest: "1.19.0",
    })
  })
  test("up to date", () => {
    expect(planUpdate("1.19.0", "1.19.0").relation).toBe("up-to-date")
  })
  test("ahead (dev build newer than published)", () => {
    expect(planUpdate("2.0.0", "1.9.9").relation).toBe("ahead")
  })
  test("missing latest is incomparable", () => {
    expect(planUpdate("1.0.0", null).relation).toBe("incomparable")
  })
  test("invalid latest is incomparable", () => {
    expect(planUpdate("1.0.0", "nightly").relation).toBe("incomparable")
  })
})

describe("parseLatestVersionPayload", () => {
  test("github release json tag_name", () => {
    expect(parseLatestVersionPayload('{"tag_name":"v1.19.0","name":"Release"}')).toBe("v1.19.0")
  })
  test("github release json name fallback", () => {
    expect(parseLatestVersionPayload('{"url":"x","name":"1.19.1"}')).toBe("1.19.1")
  })
  test("bare text body", () => {
    expect(parseLatestVersionPayload("2.0.0\n")).toBe("2.0.0")
  })
  test("garbage rejected", () => {
    expect(parseLatestVersionPayload('{"no":"version"}')).toBeNull()
  })
})

function mockFetch(body: string, status = 200): typeof fetch {
  return (async () =>
    new Response(body, { status })) as unknown as typeof fetch
}

describe("checkForUpdate (mocked endpoint)", () => {
  test("newer remote version => update-available", async () => {
    const result = await checkForUpdate({
      currentVersion: "1.18.35",
      endpoint: "https://example.invalid/latest",
      fetchImpl: mockFetch('{"tag_name":"v1.19.0"}'),
    })
    expect(result.relation).toBe("update-available")
    expect(result.latest).toBe("v1.19.0")
    expect(result.error).toBeNull()
  })
  test("same version => up-to-date", async () => {
    const result = await checkForUpdate({
      currentVersion: "1.18.35",
      fetchImpl: mockFetch('{"tag_name":"v1.18.35"}'),
    })
    expect(result.relation).toBe("up-to-date")
  })
  test("older remote => ahead", async () => {
    const result = await checkForUpdate({
      currentVersion: "2.0.0",
      fetchImpl: mockFetch('{"tag_name":"v1.0.0"}'),
    })
    expect(result.relation).toBe("ahead")
  })
  test("network failure is soft (error result, never throws)", async () => {
    const result = await checkForUpdate({
      currentVersion: "1.0.0",
      fetchImpl: (async () => {
        throw new Error("offline")
      }) as unknown as typeof fetch,
    })
    expect(result.relation).toBe("incomparable")
    expect(result.error).toBe("offline")
  })
  test("http error status is soft", async () => {
    const result = await checkForUpdate({
      currentVersion: "1.0.0",
      fetchImpl: mockFetch("nope", 500),
    })
    expect(result.relation).toBe("incomparable")
    expect(result.error).toBe("HTTP 500")
  })
  test("local dev build short-circuits", async () => {
    const result = await checkForUpdate({ currentVersion: "local", fetchImpl: mockFetch('{"tag_name":"v9.9.9"}') })
    expect(result.relation).toBe("incomparable")
    expect(result.error).toBe("local build")
  })
})

describe("formatUpdateNotice", () => {
  const available: CheckResult = {
    relation: "update-available",
    current: "1.18.35",
    latest: "1.19.0",
    endpoint: "https://example.invalid/latest",
    error: null,
  }
  test("notices only when an update exists and labels the policy", () => {
    const notice = formatUpdateNotice(available)
    expect(notice).toContain("1.19.0")
    expect(notice).toContain("1.18.35")
    expect(notice).toContain("DEC-V1-12")
  })
  test("silent when up to date", () => {
    expect(formatUpdateNotice({ ...available, relation: "up-to-date" })).toBeNull()
  })
  test("silent on check failure", () => {
    expect(formatUpdateNotice({ ...available, relation: "incomparable", error: "offline" })).toBeNull()
  })
})

describe("applyAuthorization (DEC-V1-12 opt-in gate)", () => {
  test("refuses without the explicit unsigned ack", () => {
    const result = applyAuthorization({}, hex64)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain("DEC-V1-12")
  })
  test("refuses with ack but no digest pin", () => {
    expect(applyAuthorization({ HORIZONCODE_ALLOW_UNSIGNED_UPDATE: "1" }).ok).toBe(false)
  })
  test("refuses ack with malformed pin", () => {
    expect(applyAuthorization({ HORIZONCODE_ALLOW_UNSIGNED_UPDATE: "1" }, "deadbeef").ok).toBe(false)
  })
  test("allows ack + valid pin (explicit opt-in)", () => {
    expect(applyAuthorization({ HORIZONCODE_ALLOW_UNSIGNED_UPDATE: "1" }, hex64).ok).toBe(true)
  })
  test("pin may come from env", () => {
    expect(
      applyAuthorization({ HORIZONCODE_ALLOW_UNSIGNED_UPDATE: "1", HORIZONCODE_UPDATE_SHA256: hex64 }).ok,
    ).toBe(true)
  })
  test("ack value other than '1' does not unlock", () => {
    expect(applyAuthorization({ HORIZONCODE_ALLOW_UNSIGNED_UPDATE: "true" }, hex64).ok).toBe(false)
  })
})
