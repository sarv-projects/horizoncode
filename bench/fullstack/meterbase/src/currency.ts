/**
 * Meterbase — ISO 4217 currency exponents.
 *
 * Money is always integer minor units. The exponent (number of decimal places
 * in the minor unit) is per currency and is not always 2: USD 2, JPY 0, KWD 3,
 * etc. Values here follow ISO 4217 minor-unit exponents; currencies absent from
 * the map default to 2 decimals.
 */
export const CURRENCY_EXPONENTS: Record<string, number> = {
  // Zero decimal places
  JPY: 0, KRW: 0, VND: 0, IDR: 0, CLP: 0, ISK: 0, CVE: 0, DJF: 0, GNF: 0,
  KMF: 0, MGA: 0, PYG: 0, RWF: 0, UGX: 0, XAF: 0, XOF: 0, XPF: 0,
  // Three decimal places
  KWD: 3, BHD: 3, OMR: 3, TND: 3, JOD: 3, LYD: 3,
};

/** Minor-unit exponent for an ISO 4217 currency code (defaults to 2). */
export function currencyExponent(currency: string): number {
  return CURRENCY_EXPONENTS[(currency ?? '').toUpperCase()] ?? 2;
}

/** Format an integer minor-unit amount for display, e.g. USD 6000 -> "$60.00", JPY 6000 -> "¥6000". */
export function formatMinorUnits(currency: string, minorUnits: number): string {
  const exp = currencyExponent(currency);
  const major = minorUnits / Math.pow(10, exp);
  const symbols: Record<string, string> = {
    USD: '$', JPY: '¥', EUR: '€', GBP: '£', KWD: 'KWD', BHD: 'BHD', OMR: 'OMR', TND: 'TND',
  };
  const symbol = symbols[(currency ?? '').toUpperCase()] ?? currency;
  return `${symbol}${major.toFixed(exp)}`;
}
