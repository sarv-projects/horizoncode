import { describe, expect, test } from "bun:test"
import * as Model from "../../src/util/model"
import { sortModelOptions } from "../../src/component/dialog-model"
import { parse } from "../../src/util/model"

describe("util.model", () => {
  test("splits provider from a nested model identifier", () => {
    expect(parse("provider/org/model")).toEqual({ providerID: "provider", modelID: "org/model" })
    expect(parse("invalid")).toEqual({ providerID: "invalid", modelID: "" })
  })

  test("provider connected state uses configured provider IDs, not prices", () => {
    const hasConnectedProvider = (Model as typeof Model & { hasConnectedProvider?: (ids: readonly string[]) => boolean })
      .hasConnectedProvider
    expect(hasConnectedProvider).toBeFunction()
    expect(hasConnectedProvider!([])).toBe(false)
    expect(hasConnectedProvider!(["opencode"])).toBe(true)
  })

  test("only complete explicitly zero pricing receives a zero-price label", () => {
    const explicitZeroPriceLabel = (
      Model as typeof Model & {
        explicitZeroPriceLabel?: (cost: {
          input?: number
          output?: number
          cache?: { read?: number; write?: number }
        }) => string | undefined
      }
    ).explicitZeroPriceLabel
    expect(explicitZeroPriceLabel).toBeFunction()
    expect(explicitZeroPriceLabel!({ input: 0, output: 0, cache: { read: 0, write: 0 } })).toBe("Listed $0")
    expect(explicitZeroPriceLabel!({ input: 0, output: 0, cache: { read: 0 } })).toBeUndefined()
    expect(explicitZeroPriceLabel!({ input: 0, output: 0, cache: {} })).toBeUndefined()
    expect(explicitZeroPriceLabel!({ input: 0, output: 0 })).toBeUndefined()
  })

  test("sorts explicitly listed zero-price models ahead of unknown-price models", () => {
    const options = [
      { title: "A unknown", releaseDate: "2026-01-01", footer: undefined },
      { title: "Z listed zero", releaseDate: "2026-01-01", footer: "Listed $0" },
    ]
    expect(sortModelOptions(options, false).map((option) => option.title)).toEqual(["Z listed zero", "A unknown"])
  })
})
