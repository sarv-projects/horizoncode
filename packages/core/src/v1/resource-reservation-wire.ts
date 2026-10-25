import { Schema } from "effect"

/**
 * Frozen §11.20 / §18.18 wire vocabulary for worker resource reservations.
 *
 * This module is the cross-language *consumer* of
 * `kernel/tests/fixtures/reservation-wire-v1.json`: Rust remains the canonical
 * authority for reservation transitions, pressure evaluation and capacity math.
 * Nothing here grants, releases or infers a reservation, and the decoders are
 * strict on purpose — an obsolete `ACTIVE`/`UNKNOWN` reservation status or a
 * `SOFT`/`HARD` pressure alias must fail rather than be normalized.
 */

export const RESERVATION_STATUS_WIRE = [
  "PROPOSED",
  "RESERVED",
  "CLAIMED",
  "RELEASE_PENDING",
  "QUARANTINED",
  "RELEASED",
  "EXPIRED",
] as const
export type ReservationStatusWire = (typeof RESERVATION_STATUS_WIRE)[number]

export const RESOURCE_PRESSURE_WIRE = [
  "NORMAL",
  "SOFT_PRESSURE",
  "HARD_PRESSURE",
  "RECOVERING",
] as const
export type ResourcePressureWire = (typeof RESOURCE_PRESSURE_WIRE)[number]

export const BUDGET_DIMENSION_WIRE = [
  "MEMORY_BYTES",
  "CPU_MILLICORES",
  "PROCESSES",
  "FILE_DESCRIPTORS",
  "DISK_BYTES",
  "TOOL_OUTPUT_BYTES",
  "ACTIVE_WORKERS",
  "TOKENS",
  "PROVIDER_COST_MICROS",
] as const
export type BudgetDimensionWire = (typeof BUDGET_DIMENSION_WIRE)[number]

/** Strict wire schemas: exactly the canonical names, no aliases or normalization. */
export const ReservationStatusV1 = Schema.Literals([...RESERVATION_STATUS_WIRE]).annotate({
  identifier: "WorkerResourceReservationStatusV1",
})
export type ReservationStatusV1 = typeof ReservationStatusV1.Type

export const ResourcePressureStateV1 = Schema.Literals([...RESOURCE_PRESSURE_WIRE]).annotate({
  identifier: "WorkerResourcePressureStateV1",
})
export type ResourcePressureStateV1 = typeof ResourcePressureStateV1.Type

export const BudgetDimensionV1 = Schema.Literals([...BUDGET_DIMENSION_WIRE]).annotate({
  identifier: "WorkerResourceBudgetDimensionV1",
})
export type BudgetDimensionV1 = typeof BudgetDimensionV1.Type

const strict = <Name extends string>(names: readonly Name[], value: unknown): Name | undefined =>
  typeof value === "string" && (names as readonly string[]).includes(value)
    ? (value as Name)
    : undefined

export function parseReservationStatus(value: unknown): ReservationStatusWire | undefined {
  return strict(RESERVATION_STATUS_WIRE, value)
}

export function parseResourcePressureState(value: unknown): ResourcePressureWire | undefined {
  return strict(RESOURCE_PRESSURE_WIRE, value)
}

export function parseBudgetDimension(value: unknown): BudgetDimensionWire | undefined {
  return strict(BUDGET_DIMENSION_WIRE, value)
}

/** Canonical arrays for the frozen cross-language fixture check (order is part of it). */
export const RESERVATION_WIRE_VOCABULARY = {
  reservationStatus: RESERVATION_STATUS_WIRE,
  pressureState: RESOURCE_PRESSURE_WIRE,
  dimension: BUDGET_DIMENSION_WIRE,
} as const
