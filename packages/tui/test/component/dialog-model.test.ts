import { describe, expect, test } from "bun:test"
import { isZeroPricedModel, sortModelOptions } from "../../src/component/dialog-model"

describe("isZeroPricedModel (AN-002/AN-003)", () => {
  test("declared zero primary rates are free, even when secondary rates are omitted", () => {
    expect(isZeroPricedModel({ cost: { input: 0, output: 0 } })).toBe(true)
    expect(isZeroPricedModel({ cost: { input: 0, output: 0, cache: {} } })).toBe(true)
    expect(
      isZeroPricedModel({ cost: { input: 0, output: 0, cache: { read: 0, write: 0 } } }),
    ).toBe(true)
  })

  test("missing pricing is unknown, not free", () => {
    expect(isZeroPricedModel({})).toBe(false)
    expect(isZeroPricedModel({ cost: {} })).toBe(false)
    expect(isZeroPricedModel({ cost: { input: 0 } })).toBe(false)
    expect(isZeroPricedModel({ cost: { output: 0 } })).toBe(false)
  })

  test("zero input with priced output is not free", () => {
    expect(isZeroPricedModel({ cost: { input: 0, output: 9 } })).toBe(false)
  })

  test("declared non-zero cache rate is not free", () => {
    expect(isZeroPricedModel({ cost: { input: 0, output: 0, cache: { read: 1 } } })).toBe(false)
    expect(isZeroPricedModel({ cost: { input: 0, output: 0, cache: { write: 1 } } })).toBe(false)
  })

  test("non-zero tier or long-context rate is not free", () => {
    expect(
      isZeroPricedModel({
        cost: {
          input: 0,
          output: 0,
          tiers: [{ input: 2, output: 0 }],
        },
      }),
    ).toBe(false)
    expect(
      isZeroPricedModel({
        cost: {
          input: 0,
          output: 0,
          experimentalOver200K: { input: 0, output: 4 },
        },
      }),
    ).toBe(false)
  })

  test("all-zero tier and long-context rates stay free", () => {
    expect(
      isZeroPricedModel({
        cost: {
          input: 0,
          output: 0,
          tiers: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
          experimentalOver200K: { input: 0, output: 0, cache: { read: 0, write: 0 } },
        },
      }),
    ).toBe(true)
  })
})

describe("sortModelOptions", () => {
  const options: Array<{ title: string; releaseDate: number; footer?: string }> = [
    { title: "b-model", releaseDate: 10 },
    { title: "free-new", releaseDate: 5, footer: "Free" },
    { title: "a-model", releaseDate: 10 },
    { title: "free-old", releaseDate: 1, footer: "Free" },
  ]

  test("free models sort first, then newest, then title", () => {
    expect(sortModelOptions(options, false).map((option) => option.title)).toEqual([
      "free-new",
      "free-old",
      "a-model",
      "b-model",
    ])
  })

  test("provider-scoped lists sort by newest then title only", () => {
    expect(sortModelOptions(options, true).map((option) => option.title)).toEqual([
      "a-model",
      "b-model",
      "free-new",
      "free-old",
    ])
  })
})
