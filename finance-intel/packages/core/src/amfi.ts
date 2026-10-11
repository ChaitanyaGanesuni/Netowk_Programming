import { DecimalParseError, parseDecimalToScaled } from './decimal';

/** NAVs are stored as integers scaled by 10^NAV_SCALE (AMFI publishes up to 4 decimals). */
export const NAV_SCALE = 6;

export interface NavQuote {
  schemeCode: string;
  isinGrowthOrPayout: string | null;
  isinReinvestment: string | null;
  schemeName: string;
  /** NAV × 10^NAV_SCALE. */
  navScaled: number;
  /** ISO date (YYYY-MM-DD) the NAV applies to. */
  navDate: string;
}

export interface NavParseResult {
  quotes: NavQuote[];
  /** Data-shaped lines that could not be parsed; reported, never guessed. */
  rejected: Array<{ line: number; reason: string }>;
  /** Lines with NAV "N.A." or similar: present in the file but unpriced. */
  unpriced: number;
}

const MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

/** Converts AMFI's "10-Oct-2026" into "2026-10-10". Returns null for anything else. */
export function parseAmfiDate(text: string): string | null {
  const match = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(text.trim());
  if (!match) return null;
  const [, day = '', mon = '', year = ''] = match;
  const month = MONTHS[mon.toLowerCase()];
  if (!month) return null;
  const iso = `${year}-${month}-${day.padStart(2, '0')}`;
  const parsed = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== iso ? null : iso;
}

function isin(value: string): string | null {
  const trimmed = value.trim();
  return /^IN[A-Z0-9]{10}$/.test(trimmed) ? trimmed : null;
}

/**
 * Parses AMFI's NAVAll.txt: semicolon-separated rows of
 * `Scheme Code;ISIN Div Payout/ISIN Growth;ISIN Div Reinvestment;Scheme Name;Net Asset Value;Date`,
 * interleaved with blank lines, category headings and AMC names (which have no semicolons).
 */
export function parseNavAll(text: string): NavParseResult {
  const result: NavParseResult = { quotes: [], rejected: [], unpriced: 0 };
  const lines = text.split(/\r?\n/);
  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (!line.includes(';') || line.toLowerCase().startsWith('scheme code')) return;
    const lineNo = index + 1;
    const fields = line.split(';');
    if (fields.length !== 6) {
      result.rejected.push({ line: lineNo, reason: `expected 6 fields, got ${fields.length}` });
      return;
    }
    const [code = '', isinA = '', isinB = '', name = '', navText = '', dateText = ''] = fields;
    if (!/^\d+$/.test(code.trim())) {
      result.rejected.push({ line: lineNo, reason: 'scheme code is not numeric' });
      return;
    }
    const navDate = parseAmfiDate(dateText);
    if (!navDate) {
      result.rejected.push({ line: lineNo, reason: 'unrecognised date' });
      return;
    }
    if (!/^\d/.test(navText.trim())) {
      result.unpriced++;
      return;
    }
    try {
      result.quotes.push({
        schemeCode: code.trim(),
        isinGrowthOrPayout: isin(isinA),
        isinReinvestment: isin(isinB),
        schemeName: name.trim(),
        navScaled: parseDecimalToScaled(navText, NAV_SCALE),
        navDate,
      });
    } catch (error) {
      if (!(error instanceof DecimalParseError)) throw error;
      result.rejected.push({ line: lineNo, reason: error.message });
    }
  });
  return result;
}
