/**
 * Meterbase — pricing engine.
 *
 * Meters define tiers of `{ up_to: number | null, unit_amount: number }`
 * (`up_to: null` = infinity). Money is integer minor units of the meter's
 * currency, so tier math is integer multiplication; half-up rounding is applied
 * at the line level for safety.
 *
 * Two modes:
 *  - graduated: each tier prices only the units inside its own range.
 *  - volume: the tier the total quantity lands in (inclusive boundary) prices
 *    all units.
 */
export interface Tier {
  up_to: number | null;
  unit_amount: number;
}

export interface TierRow {
  up_to: number | null;
  units: number;
  unit_amount: number;
  amount: number;
}

export interface PriceBreakdown {
  tiers: TierRow[];
  totalAmount: number;
}

/** Round half up (values here are non-negative). */
export function roundHalfUp(value: number): number {
  return Math.floor(value + 0.5);
}

/**
 * Price a quantity against a meter's tiers.
 *
 * Every tier row is emitted (even with zero units) so the API breakdown is
 * stable; `totalAmount` is the sum of the tier amounts.
 */
export function priceMeter(mode: 'graduated' | 'volume', tiers: Tier[], quantity: number): PriceBreakdown {
  const rows: TierRow[] = [];

  if (mode === 'volume') {
    // The tier the total quantity lands in (inclusive upper bound) prices all units.
    let chosen: Tier | null = null;
    for (const tier of tiers) {
      const cap = tier.up_to === null ? Infinity : tier.up_to;
      if (quantity <= cap) {
        chosen = tier;
        break;
      }
    }
    if (!chosen) chosen = tiers[tiers.length - 1] ?? { up_to: null, unit_amount: 0 };
    const chosenUnits = quantity;
    for (const tier of tiers) {
      const units = tier === chosen ? chosenUnits : 0;
      const amount = roundHalfUp(units * tier.unit_amount);
      rows.push({ up_to: tier.up_to, units, unit_amount: tier.unit_amount, amount });
    }
    return { tiers: rows, totalAmount: roundHalfUp(chosenUnits * chosen.unit_amount) };
  }

  // graduated: each tier prices only the units inside its own range.
  let remaining = quantity;
  let floor = 0;
  let totalAmount = 0;
  for (const tier of tiers) {
    const cap = tier.up_to === null ? Infinity : tier.up_to;
    const units = Math.max(0, Math.min(remaining, cap - floor));
    const amount = roundHalfUp(units * tier.unit_amount);
    rows.push({ up_to: tier.up_to, units, unit_amount: tier.unit_amount, amount });
    totalAmount += amount;
    remaining -= units;
    floor = cap;
  }
  return { tiers: rows, totalAmount: roundHalfUp(totalAmount) };
}
