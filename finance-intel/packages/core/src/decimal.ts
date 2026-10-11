/**
 * Decimal-safe parsing. Authoritative amounts are never held in binary floating point:
 * they are parsed from their source text straight into scaled integers.
 */

const DECIMAL_RE = /^(-)?(\d+)(?:\.(\d+))?$/;

export class DecimalParseError extends Error {
  override readonly name = 'DecimalParseError';
}

/**
 * Parses a plain decimal string ("1234.5", "-0.25") into an integer scaled by 10^scale.
 * Rejects inputs with more fractional digits than `scale` rather than silently rounding.
 */
export function parseDecimalToScaled(input: string, scale: number): number {
  if (!Number.isInteger(scale) || scale < 0 || scale > 9) {
    throw new DecimalParseError(`unsupported scale ${scale}`);
  }
  const match = DECIMAL_RE.exec(input.trim());
  if (!match) throw new DecimalParseError(`not a decimal: "${input}"`);
  const [, sign, whole = '', frac = ''] = match;
  if (frac.length > scale) {
    throw new DecimalParseError(`"${input}" has more than ${scale} fractional digits`);
  }
  const digits = BigInt(whole + frac.padEnd(scale, '0'));
  const value = sign ? -digits : digits;
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new DecimalParseError(`"${input}" exceeds safe integer range at scale ${scale}`);
  }
  return Number(value);
}

/**
 * Parses an Indian-format rupee amount ("Rs. 1,23,456.78", "INR 500", "₹ 12.5") into paise.
 */
export function parseInrToPaise(input: string): number {
  const cleaned = input
    .replace(/^\s*(?:rs\.?|inr|₹)\s*/i, '')
    .replace(/,/g, '')
    .trim();
  return parseDecimalToScaled(cleaned, 2);
}

/** Formats a scaled integer back to a fixed-point string without floating point. */
export function formatScaled(value: number, scale: number): string {
  if (!Number.isSafeInteger(value)) throw new DecimalParseError('value is not a safe integer');
  const negative = value < 0;
  const digits = String(Math.abs(value)).padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale);
  const frac = scale > 0 ? `.${digits.slice(digits.length - scale)}` : '';
  return `${negative ? '-' : ''}${whole}${frac}`;
}
