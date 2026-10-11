/**
 * Display formatting for scaled integers. Uses bigint so products such as units × NAV stay
 * exact; floating point is only used to render, never to compute.
 */

/** "₹1,23,45,678.90" (Indian digit grouping). */
export function formatPaise(paise: number | bigint | null): string {
  if (paise === null) return '—';
  const value = BigInt(paise);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const rupees = (abs / 100n).toString();
  const fraction = (abs % 100n).toString().padStart(2, '0');
  const last3 = rupees.slice(-3);
  const rest = rupees.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}` : last3;
  return `${negative ? '-' : ''}₹${grouped}.${fraction}`;
}

/** Units stored as millionths → "123.456" (trailing zeros beyond 3 places trimmed). */
export function formatUnits(micro: number | null): string {
  if (micro === null) return '—';
  const value = BigInt(micro);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  let fraction = (abs % 1_000_000n).toString().padStart(6, '0');
  fraction = fraction.replace(/0+$/, '').padEnd(3, '0');
  return `${negative ? '-' : ''}${(abs / 1_000_000n).toString()}.${fraction}`;
}

/** units (×1e6) × price (×1e6) → paise, rounded half-up. Exact for any realistic holding. */
export function valueInPaise(unitsMicro: number, priceMicro: number): number {
  const product = BigInt(unitsMicro) * BigInt(priceMicro); // ×1e12 rupees
  const divisor = 10_000_000_000n; // → paise (×1e2)
  const negative = product < 0n;
  const abs = negative ? -product : product;
  const rounded = (abs + divisor / 2n) / divisor;
  return Number(negative ? -rounded : rounded);
}
