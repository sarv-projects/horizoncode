import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  BUDGET_DIMENSION_WIRE,
  RESERVATION_STATUS_WIRE,
  RESERVATION_WIRE_VOCABULARY,
  RESOURCE_PRESSURE_WIRE,
  parseBudgetDimension,
  parseReservationStatus,
  parseResourcePressureState,
} from "@horizoncode/core/v1/resource-reservation-wire"

/**
 * JC-RES-012.I cross-language roundtrip: the TypeScript consumer must agree with the
 * exact frozen fixture that the Rust canonical decoder is tested against. This proves
 * vocabulary agreement only — it is not reservation, admission or capacity authority.
 */
const fixturePath = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "kernel",
  "tests",
  "fixtures",
  "reservation-wire-v1.json",
)
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
  schema: string
  consumers: { rust: string | null; typescript: string | null }
  reservationStatus: { canonical: string[]; forbidden: string[] }
  pressureState: { canonical: string[]; forbidden: string[] }
  dimension: { canonical: string[]; forbidden: string[] }
}

const sections: ReadonlyArray<{
  name: keyof typeof RESERVATION_WIRE_VOCABULARY
  wire: readonly string[]
  parse: (value: unknown) => string | undefined
}> = [
  {
    name: "reservationStatus",
    wire: RESERVATION_STATUS_WIRE,
    parse: parseReservationStatus,
  },
  {
    name: "pressureState",
    wire: RESOURCE_PRESSURE_WIRE,
    parse: parseResourcePressureState,
  },
  {
    name: "dimension",
    wire: BUDGET_DIMENSION_WIRE,
    parse: parseBudgetDimension,
  },
]

describe("reservation wire vocabulary (JC-RES-012.I)", () => {
  test("the frozen fixture records this TypeScript consumer", () => {
    expect(fixture.schema).toBe("horizon.worker-resource-reservation-wire.v1")
    expect(fixture.consumers.rust).toBe("kernel/src/resource_budget.rs")
    expect(fixture.consumers.typescript).toBe(
      "packages/core/src/v1/resource-reservation-wire.ts",
    )
  })

  for (const section of sections) {
    test(`${section.name} canonical names roundtrip exactly`, () => {
      const canonical = fixture[section.name].canonical
      expect([...section.wire]).toEqual(canonical)
      const vocabulary: readonly string[] = RESERVATION_WIRE_VOCABULARY[section.name]
      expect(vocabulary).toEqual(canonical)
      expect(new Set(canonical).size).toBe(canonical.length)
      for (const name of canonical) {
        expect(section.parse(name)).toBe(name)
      }
    })

    test(`${section.name} forbidden aliases are rejected, never normalized`, () => {
      const forbidden = fixture[section.name].forbidden
      expect(forbidden.length).toBeGreaterThan(0)
      for (const name of forbidden) {
        expect(section.parse(name)).toBeUndefined()
      }
    })
  }

  test("obsolete reservation and pressure aliases stay out of the vocabulary", () => {
    expect(parseReservationStatus("ACTIVE")).toBeUndefined()
    expect(parseReservationStatus("UNKNOWN")).toBeUndefined()
    expect(parseReservationStatus("proposed")).toBeUndefined()
    expect(RESERVATION_STATUS_WIRE as readonly string[]).not.toContain("ACTIVE")
    expect(RESOURCE_PRESSURE_WIRE as readonly string[]).not.toContain("SOFT")
    expect(parseResourcePressureState("SOFT")).toBeUndefined()
    expect(parseResourcePressureState("HARD")).toBeUndefined()
    expect(parseResourcePressureState("soft_pressure")).toBeUndefined()
    expect(parseBudgetDimension("memory_bytes")).toBeUndefined()
    expect(parseBudgetDimension("ProviderCostMicros")).toBeUndefined()
    expect(parseBudgetDimension("")).toBeUndefined()
  })

  test("non-string wire values are rejected without coercion", () => {
    for (const parse of [parseReservationStatus, parseResourcePressureState, parseBudgetDimension]) {
      for (const value of [undefined, null, 0, 1, true, {}, [], ["RESERVED"]]) {
        expect(parse(value)).toBeUndefined()
      }
    }
  })
})
