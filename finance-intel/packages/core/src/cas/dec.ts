/**
 * Exact decimal arithmetic for statement figures (a minimal analogue of Python's Decimal,
 * which casparser uses). Values are bigint coefficients with a decimal scale, so sums of
 * units and rupee amounts never touch binary floating point.
 */
export class Dec {
  private constructor(
    readonly coefficient: bigint,
    readonly scale: number,
  ) {}

  static readonly ZERO = new Dec(0n, 0);

  static of(coefficient: bigint, scale: number): Dec {
    return new Dec(coefficient, scale);
  }

  /** Parses "1,23,456.78", "-0.5", ".196", "(12.5)" (negative). Returns null if not a number. */
  static parse(input: string | null | undefined): Dec | null {
    if (input == null) return null;
    let s = input.trim();
    if (!s) return null;
    let negative = false;
    if (s.startsWith('(') && s.endsWith(')')) {
      negative = true;
      s = s.slice(1, -1).trim();
    }
    if (s.startsWith('-')) {
      negative = !negative;
      s = s.slice(1);
    } else if (s.startsWith('+')) {
      s = s.slice(1);
    }
    s = s.replace(/,/g, '');
    const match = /^(\d*)(?:\.(\d*))?$/.exec(s);
    if (!match || (!match[1] && !match[2])) return null;
    const whole = match[1] ?? '';
    const frac = match[2] ?? '';
    const coefficient = BigInt(`${whole}${frac}` || '0');
    return new Dec(negative ? -coefficient : coefficient, frac.length);
  }

  private aligned(other: Dec): [bigint, bigint, number] {
    const scale = Math.max(this.scale, other.scale);
    return [this.coefficient * 10n ** BigInt(scale - this.scale), other.coefficient * 10n ** BigInt(scale - other.scale), scale];
  }

  add(other: Dec): Dec {
    const [a, b, scale] = this.aligned(other);
    return new Dec(a + b, scale);
  }

  sub(other: Dec): Dec {
    const [a, b, scale] = this.aligned(other);
    return new Dec(a - b, scale);
  }

  mul(other: Dec): Dec {
    return new Dec(this.coefficient * other.coefficient, this.scale + other.scale);
  }

  neg(): Dec {
    return new Dec(-this.coefficient, this.scale);
  }

  abs(): Dec {
    return this.coefficient < 0n ? this.neg() : this;
  }

  cmp(other: Dec): number {
    const [a, b] = this.aligned(other);
    return a === b ? 0 : a < b ? -1 : 1;
  }

  isZero(): boolean {
    return this.coefficient === 0n;
  }

  sign(): number {
    return this.coefficient === 0n ? 0 : this.coefficient < 0n ? -1 : 1;
  }

  /** Rounds to `scale` places, half-to-even (Python's default). */
  quantize(scale: number): Dec {
    if (scale >= this.scale) return new Dec(this.coefficient * 10n ** BigInt(scale - this.scale), scale);
    return new Dec(roundHalfEven(this.coefficient, 10n ** BigInt(this.scale - scale)), scale);
  }

  /** this / other rounded half-to-even to `scale` places. */
  div(other: Dec, scale: number): Dec {
    if (other.coefficient === 0n) throw new RangeError('division by zero');
    // value = (c1 / 10^s1) / (c2 / 10^s2); scaled result = c1 * 10^(s2 + scale - s1) / c2
    const shift = other.scale + scale - this.scale;
    let numerator = this.coefficient;
    let denominator = other.coefficient;
    if (shift >= 0) numerator *= 10n ** BigInt(shift);
    else denominator *= 10n ** BigInt(-shift);
    if (denominator < 0n) {
      numerator = -numerator;
      denominator = -denominator;
    }
    return new Dec(roundHalfEven(numerator, denominator), scale);
  }

  toString(): string {
    const negative = this.coefficient < 0n;
    const digits = (negative ? -this.coefficient : this.coefficient).toString().padStart(this.scale + 1, '0');
    const whole = digits.slice(0, digits.length - this.scale);
    const frac = this.scale > 0 ? `.${digits.slice(digits.length - this.scale)}` : '';
    return `${negative ? '-' : ''}${whole}${frac}`;
  }

  /** Integer scaled by 10^scale (e.g. paise for scale 2). Throws rather than lose precision. */
  toScaledInt(scale: number): number {
    const q = this.quantize(scale);
    if (q.cmp(this) !== 0) throw new RangeError(`${this.toString()} has more than ${scale} decimal places`);
    const n = Number(q.coefficient);
    if (!Number.isSafeInteger(n)) throw new RangeError(`${this.toString()} is out of safe integer range`);
    return n;
  }

  toJSON(): string {
    return this.toString();
  }
}

function roundHalfEven(numerator: bigint, denominator: bigint): bigint {
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  let q = n / d;
  const r = n % d;
  if (r * 2n > d || (r * 2n === d && q % 2n === 1n)) q += 1n;
  return negative ? -q : q;
}

const MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

/** "15-Jan-2021", "15 Jan 2021", "15Jan2021" or "30-09-2026" → "2021-01-15". Null if invalid. */
export function parseCasDate(text: string): string | null {
  const s = text.trim();
  let day: string | undefined;
  let month: string | undefined;
  let year: string | undefined;
  const named = /^(\d{1,2})[-\s/]*([A-Za-z]{3})[-\s/]*(\d{4})$/.exec(s);
  const numeric = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(s);
  if (named) {
    day = named[1];
    month = MONTHS[(named[2] ?? '').toLowerCase()];
    year = named[3];
  } else if (numeric) {
    day = numeric[1];
    month = numeric[2]?.padStart(2, '0');
    year = numeric[3];
  }
  if (!day || !month || !year) return null;
  const iso = `${year}-${month}-${day.padStart(2, '0')}`;
  const date = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== iso ? null : iso;
}
