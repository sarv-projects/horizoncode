import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { ConfigResourcePolicyV1 } from "../../src/v1/config/config"

describe("Config ResourcePolicyV1 projection", () => {
  test("preserves exact requested decimal strings and leaves unverified limits unsupported", () => {
    const projection = ConfigResourcePolicyV1.project({
      requested: {
        limits: {
          memoryBytes: { soft: "900719925474099312345", hard: "900719925474099312346" },
        },
      },
      origins: {
        memoryBytes: { configurationSource: "user", policyLock: "unlocked" },
      },
    })
    expect(projection.limits.find((item) => item.dimension === "memoryBytes")).toEqual({
      dimension: "memoryBytes",
      requested: { soft: "900719925474099312345", hard: "900719925474099312346" },
      configurationSource: "user",
      policyLock: "unlocked",
      enforcement: "UNSUPPORTED",
      reason: expect.any(String),
    })
    expect(projection.limits.find((item) => item.dimension === "cpuMillicores")).toMatchObject({
      configurationSource: "default",
      policyLock: "unknown",
      enforcement: "UNSUPPORTED",
    })
    expect(Schema.decodeUnknownSync(ConfigResourcePolicyV1.ResourcePolicyProjectionV1)(projection)).toEqual(projection)
  })

  test("rejects imprecise, negative and inverted requested bounds", () => {
    const decode = Schema.decodeUnknownSync(ConfigResourcePolicyV1.ConfigV1)
    expect(() => decode({
      limits: { memoryBytes: { soft: "5", hard: "4" } },
    })).toThrow()
    expect(() => decode({
      limits: { memoryBytes: { hard: "01" } },
    })).toThrow()
    expect(() => decode({
      limits: { memoryBytes: { hard: "-1" } },
    })).toThrow()
  })
})
