/**
 * CAMS / KFintech DETAILED CAS parser — TypeScript port of casparser 1.4.1
 * `parsers/cams_detailed.py` (MIT © Sandeep Somasekharan). Control flow, regexes and
 * thresholds follow the original; see that file for the reasoning behind each rule.
 * Differences: no ISIN database lookup (the app maps ISIN → AMFI code from the AMFI NAV
 * feed), no investor-info extraction (not imported), and exact Dec arithmetic.
 */
import { extractGiftFolio, getTransactionType, parseSchemeName, type CasTransactionType } from './classify';
import { Dec, parseCasDate } from './dec';
import { lineText, renderChars, type Char, type Line, type Page } from './layout';

export interface CasTransaction {
  /** ISO date. */
  date: string;
  description: string;
  amount: Dec | null;
  units: Dec | null;
  nav: Dec | null;
  balance: Dec | null;
  type: CasTransactionType;
  dividendRate: Dec | null;
  giftFolio: string | null;
}

export interface CasScheme {
  scheme: string;
  advisor: string | null;
  rtaCode: string;
  rta: string;
  isin: string | null;
  nominees: string[];
  open: Dec;
  close: Dec;
  closeCalculated: Dec;
  valuation: { date: string; nav: Dec; cost: Dec | null; value: Dec };
  transactions: CasTransaction[];
}

export interface CasFolio {
  folio: string;
  amc: string;
  name: string | null;
  pan: string | null;
  kyc: string | null;
  panKyc: string | null;
  schemes: CasScheme[];
}

export interface RtaCasData {
  kind: 'rta_detailed';
  fileType: 'CAMS' | 'KFINTECH';
  statementPeriod: { from: string; to: string };
  folios: CasFolio[];
  warnings: string[];
}

// ---------------------------------------------------------------- columns

const TXN_HEADER_LABELS = new Set(['Date', 'Transaction', 'Amount', 'Units', 'Price', 'Unit', 'Balance', 'NAV']);
const TXN_MIN_HITS = 4;
const ALIGN: Record<string, 'left' | 'right'> = {
  Date: 'left',
  Transaction: 'left',
  Amount: 'right',
  Units: 'right',
  Price: 'right',
  'Unit Balance': 'right',
  NAV: 'right',
};

interface Column {
  label: string;
  xLo: number;
  xHi: number;
  alignment: 'left' | 'right';
}

type Word = readonly [string, number, number];

function wordsOnLine(line: Line, minGap = 1.5): Word[] {
  const cs = [...line.chars].sort((p, q) => p.x0 - q.x0);
  const words: Word[] = [];
  let cur = '';
  let curX0 = 0;
  let curX1 = 0;
  for (const c of cs) {
    if (cur && c.x0 - curX1 > minGap) {
      words.push([cur, curX0, curX1]);
      cur = '';
    }
    if (!cur) curX0 = c.x0;
    cur += c.text;
    curX1 = c.x1;
  }
  if (cur) words.push([cur, curX0, curX1]);
  return words;
}

const HEADER_WINDOW_Y = 15.0;

function detectTxnColumns(lines: Line[], startIdx: number): { first: number; last: number; columns: Column[] } | null {
  for (let i = startIdx; i < lines.length; i++) {
    const head = lines[i] as Line;
    const window: Line[] = [head];
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j] as Line;
      if (head.baseline - next.baseline > HEADER_WINDOW_Y) break;
      window.push(next);
    }
    const allWords = window.flatMap((line) => wordsOnLine(line));
    const labels = new Set(allWords.filter((w) => TXN_HEADER_LABELS.has(w[0])).map((w) => w[0]));
    if (labels.size < TXN_MIN_HITS) continue;
    return { first: i, last: i + window.length - 1, columns: buildColumns(allWords) };
  }
  return null;
}

function buildColumns(words: Word[]): Column[] {
  const cols: Column[] = [];
  const hasBalance = words.some((w) => w[0] === 'Balance');
  for (const [text, x0, x1] of words) {
    if (text === 'Unit' && hasBalance) {
      for (const [wText, wx0, wx1] of words) {
        if (wText === 'Balance' && Math.abs((wx0 + wx1) / 2 - (x0 + x1) / 2) < 30) {
          cols.push({ label: 'Unit Balance', xLo: Math.min(x0, wx0), xHi: Math.max(x1, wx1), alignment: 'right' });
          break;
        }
      }
    } else if (text in ALIGN && text !== 'Unit' && text !== 'Balance') {
      cols.push({ label: text, xLo: x0, xHi: x1, alignment: ALIGN[text] as 'left' | 'right' });
    }
  }
  return cols.sort((p, q) => p.xLo - q.xLo);
}

const NUMERIC_ZONE_WIDTH = 55.0;

function columnRanges(columns: Column[]): Array<readonly [Column, number, number]> {
  const sorted = [...columns].sort((p, q) => (p.xLo + p.xHi) / 2 - (q.xLo + q.xHi) / 2);
  return sorted.map((col, i) => {
    if (col.alignment === 'right') return [col, col.xHi - NUMERIC_ZONE_WIDTH, col.xHi + 3.0] as const;
    const next = sorted[i + 1];
    const hi = next ? (next.alignment === 'right' ? next.xHi - NUMERIC_ZONE_WIDTH : next.xLo - 3.0) : Number.POSITIVE_INFINITY;
    return [col, col.xLo - 3.0, hi] as const;
  });
}

function assignCells(line: Line, columns: Column[]): Record<string, string> {
  const ranges = columnRanges(columns);
  const cells = new Map<string, Char[]>(columns.map((c) => [c.label, []]));
  for (const ch of line.chars) {
    const xMid = (ch.x0 + ch.x1) / 2;
    for (const [col, lo, hi] of ranges) {
      if (lo <= xMid && xMid < hi) {
        cells.get(col.label)?.push(ch);
        break;
      }
    }
  }
  const out: Record<string, string> = {};
  for (const [label, chars] of cells) {
    if (chars.length) out[label] = renderChars(chars).trim();
  }
  return out;
}

// ---------------------------------------------------------------- patterns

const FOLIO_LINE_RE =
  /Folio\s+No\s*:\s*(\d+(?:\s*\/\s*\d+)?)(?:.*?PAN\s*:\s*([A-Z]{5}\d{4}[A-Z]))?(?:.*?KYC\s*:\s*(OK|NOT OK))?(?:.*?PAN\s*:\s*(OK|NOT OK))?/i;
const INLINE_ISIN_RE = /[-\s]*ISIN\s*:\s*([A-Z0-9]+)/i;
const INLINE_ADVISOR_RE = /[-\s]*\(\s*Advisor\s*:\s*([^)]+?)\)/i;
const INLINE_ADVISOR_RE_G = /[-\s]*\(\s*Advisor\s*:\s*([^)]+?)\)/gi;
const SCHEME_HEAD_RTA_RE = /Registrar\s*:\s*(\S+)/i;
const FULL_ISIN_RE = /^INF[0-9A-Z]{8}\d$/;
const ISIN_ANYWHERE_RE = /\bINF[0-9A-Z]{8}\d\b/;
const RTA_TOKEN_RE = /\b(CAMS|KFINTECH|KFIN|KARVY)\b/i;
const OPEN_BAL_RE = /Opening\s+Unit\s+Balance\s*:?\s*([\d,.]+)/i;
const CLOSE_BAL_RE = /Closing\s+Unit\s+Balance\s*:?\s*([\d,.]+)/i;
const NAV_RE = /NAV\s+on\s+(\d{2}-[A-Za-z]{3}-\d{4})\s*:\s*INR\s*([\d,.]+)/i;
const VALUATION_RE = /(?:Valuation|Market\s+Value)\s+on\s+(\d{2}-[A-Za-z]{3}-\d{4})\s*:\s*INR\s*([\d,.]+)/i;
const COST_VALUE_RE = /Total\s+Cost\s+Value\s*:?\s*([\d,.]+)/i;
const NOMINEE_RE = /Nominee\s+1\s*:\s*(?<n1>[^:]*?)\s*(?:Nominee\s+2\s*:\s*(?<n2>[^:]*?)\s*(?:Nominee\s+3\s*:\s*(?<n3>.*?))?)?$/i;
const STMT_PERIOD_RE = /(\d{2}-[A-Za-z]{3}-\d{4})\s+To\s+(\d{2}-[A-Za-z]{3}-\d{4})/i;
const AMC_RE = /^(.+?\s+(?:MF|Mutual\s*Fund|Fund\s*House))$/i;
const DATE_CELL_RE = /^\s*(\d{1,2}[-\s]*[A-Za-z]{3}[-\s]*\d{4})/;
const CONTINUATION_MAX_GAP = 10.0;

const HEADER_MARKER_RE = /Registrar\s*:|Advisor\s*:|ISIN\s*:|Nominee\s+\d|\bARN-?\d+\b|\bINA\d+\b/i;
const SCHEME_CODE_RE = /^\s*(?=[A-Z0-9 ]{0,40}[A-Z])[A-Z0-9]+(?: [A-Z0-9]+)*-/i;
const TRAILING_MARKER_RE = /(Registrar\s*:|Advisor\s*:|ISIN\s*:|\(\s*Advisor\s*:)\s*$/i;
const NAME_EXCISE_ISIN_RE = /[-\s]*ISIN\s*:\s*INF[A-Z0-9]*/gi;
const NAME_TERMINATOR_RE = /\(\s*Advisor\s*:|Registrar\s*:?|Nominee\s+\d|\bARN-?\d+\b|\bINA\d+\b|\b(?:CAMS|KFINTECH|KFIN|KARVY)\b/i;
const ADVISOR_CODE_RE = /\b(ARN-?\d+|INA\d+)\b/i;
const HOLDER_NAME_CHARS_RE = /^[A-Z][A-Za-z .'&-]*$/;

const collapse = (s: string) => s.split(/\s+/).filter(Boolean).join(' ');

function decimalCell(s: string | undefined): Dec | null {
  if (s === undefined) return null;
  const t = s.trim();
  if (!t) return null;
  const negative = t.startsWith('(') || t.startsWith('-');
  const body = t.replace(/^\(/, '').replace(/\)$/, '').replace(/^-/, '').replace(/,/g, '');
  const d = Dec.parse(body);
  if (d === null) return null;
  return negative ? d.neg() : d;
}

/** Python's `_decimal(x) or Decimal(0)` — a zero value is falsy and becomes plain 0. */
const orZero = (d: Dec | null): Dec => (d === null || d.isZero() ? Dec.ZERO : d);

function isHeaderLine(text: string): boolean {
  return HEADER_MARKER_RE.test(text) || RTA_TOKEN_RE.test(text) || SCHEME_CODE_RE.test(text);
}

function looksLikeHolderName(text: string): boolean {
  const t = collapse(text);
  const words = t.split(' ').filter(Boolean);
  if (!(words.length >= 2 && words.length <= 8 && t.length <= 80)) return false;
  if (!HOLDER_NAME_CHARS_RE.test(t)) return false;
  if (!words.every((w) => w === '&' || (w[0] !== undefined && w[0] === w[0].toUpperCase() && w[0] !== w[0].toLowerCase()))) return false;
  if (words.filter((w) => TXN_HEADER_LABELS.has(w)).length >= TXN_MIN_HITS) return false;
  return !isHeaderLine(t);
}

function expectsContinuation(text: string): boolean {
  if (TRAILING_MARKER_RE.test(text.trim())) return true;
  const adv = /\(\s*Advisor\s*:/i.exec(text);
  return adv !== null && !text.slice(adv.index + adv[0].length).includes(')');
}

function findSchemeLine(lines: string[]): number | null {
  for (let k = 0; k < lines.length; k++) {
    const ln = lines[k] as string;
    if (!SCHEME_CODE_RE.test(ln)) continue;
    if ((ln.split('-')[0] ?? '').trim().toUpperCase() === 'ARN') continue;
    return k;
  }
  return null;
}

function headerMemberIndices(lines: string[]): number[] {
  const out: number[] = [];
  let forced = false;
  lines.forEach((ln, idx) => {
    if (forced || isHeaderLine(ln)) {
      out.push(idx);
      forced = expectsContinuation(ln);
    } else {
      forced = false;
    }
  });
  return out;
}

function regionCandidate(buf: string[]) {
  const lines = buf.map((s) => s.trim()).filter(Boolean);
  if (!lines.length) return null;
  const sIdx = findSchemeLine(lines);
  if (sIdx === null) return null;
  const members = headerMemberIndices(lines);
  const headerText = members.map((k) => lines[k]).join(' ');
  if (!headerText.includes('Registrar')) return null;
  return { lines, sIdx, members, headerText };
}

function parseNominees(text: string): string[] | null {
  const m = NOMINEE_RE.exec(text);
  if (!m) return null;
  return [m.groups?.n1, m.groups?.n2, m.groups?.n3].map((n) => (n ?? '').trim()).filter(Boolean);
}

function buildSchemeFromBuffer(buf: string[], period: { from: string; to: string } | null): CasScheme | null {
  const cand = regionCandidate(buf);
  if (!cand) return null;
  const { lines, sIdx, members, headerText } = cand;
  const schemeLine = lines[sIdx] as string;
  const dash = schemeLine.indexOf('-');
  const code = schemeLine.slice(0, dash).trim();
  const schemeRest = schemeLine.slice(dash + 1);
  let nameText = [schemeRest, ...members.filter((k) => k > sIdx).map((k) => lines[k])].join(' ');
  nameText = nameText.replace(INLINE_ADVISOR_RE_G, '');
  nameText = nameText.replace(NAME_EXCISE_ISIN_RE, '');
  const cut = NAME_TERMINATOR_RE.exec(nameText);
  const name = parseSchemeName(cut ? nameText.slice(0, cut.index) : nameText);

  let isin: string | null = INLINE_ISIN_RE.exec(headerText)?.[1]?.trim() ?? null;
  if (!isin || !FULL_ISIN_RE.test(isin)) isin = ISIN_ANYWHERE_RE.exec(headerText)?.[0] ?? null;

  let advisor = INLINE_ADVISOR_RE.exec(headerText)?.[1]?.trim() ?? null;
  const advCode = advisor ? ADVISOR_CODE_RE.exec(advisor) : null;
  if (advisor && advCode?.[1]) advisor = advCode[1];

  const rtaToken = RTA_TOKEN_RE.exec(headerText);
  const rta = rtaToken?.[1] ? rtaToken[1].toUpperCase() : SCHEME_HEAD_RTA_RE.exec(headerText)?.[1]?.trim() || 'CAMS';

  let nominees: string[] = [];
  for (const ln of lines) {
    const n = parseNominees(ln);
    if (n) {
      nominees = n;
      break;
    }
  }
  return {
    scheme: name,
    advisor,
    rta,
    rtaCode: code,
    isin,
    nominees,
    open: Dec.ZERO,
    close: Dec.ZERO,
    closeCalculated: Dec.ZERO,
    valuation: { date: (period && parseCasDate(period.to)) ?? '1970-01-01', nav: Dec.ZERO, cost: null, value: Dec.ZERO },
    transactions: [],
  };
}

function abandonedRegionWarning(buf: string[], where: string): string | null {
  const cand = regionCandidate(buf);
  if (!cand) return null;
  return `scheme header region discarded at ${where} without an 'Opening Unit Balance' anchor; its scheme and transactions were skipped: '${(cand.lines[cand.sIdx] ?? '').slice(0, 80)}'`;
}

const TOL = Dec.parse('0.005') as Dec;

function applyBalanceSignFix(scheme: CasScheme): void {
  let prev = scheme.open;
  for (const t of scheme.transactions) {
    if (t.units === null || t.balance === null) continue;
    if (prev.add(t.units).sub(t.balance).abs().cmp(TOL) <= 0) {
      prev = t.balance;
      continue;
    }
    if (prev.sub(t.units).sub(t.balance).abs().cmp(TOL) <= 0) {
      t.units = t.units.neg();
      if (t.amount !== null) t.amount = t.amount.neg();
      const reclass = getTransactionType(t.description, t.units);
      t.type = reclass.type;
      t.dividendRate = reclass.dividendRate;
    }
    prev = t.balance;
  }
  scheme.closeCalculated = scheme.transactions.reduce((total, t) => (t.units ? total.add(t.units) : total), scheme.open);
}

function reconcileBalances(scheme: CasScheme): string[] {
  const warnings: string[] = [];
  const label = `'${scheme.scheme}' [${scheme.rtaCode}]`;
  let running = scheme.open;
  for (const t of scheme.transactions) {
    if (t.units !== null) running = running.add(t.units);
    if (t.balance === null) continue;
    if (running.sub(t.balance).abs().cmp(TOL) > 0) {
      warnings.push(
        `${label}: unit-balance discontinuity at ${t.date} (${t.type}) — computed ${running} but statement printed ${t.balance}; a transaction row may be missing or mis-parsed`,
      );
      running = t.balance;
    }
  }
  if (running.sub(scheme.close).abs().cmp(TOL) > 0) {
    warnings.push(`${label}: closing unit balance mismatch — computed ${running} but statement printed ${scheme.close}; a transaction row may be missing or mis-parsed`);
  }
  return warnings;
}

/**
 * casparser's `_sort_transactions`: when a scheme's rows are out of date order, sort them
 * (stably) and recompute each running balance from the opening balance.
 */
function sortTransactions(scheme: CasScheme): void {
  const dates = scheme.transactions.map((t) => t.date);
  if (dates.every((d, i) => i === 0 || (dates[i - 1] as string) <= d)) return;
  scheme.transactions.sort((p, q) => (p.date < q.date ? -1 : p.date > q.date ? 1 : 0));
  let balance = scheme.open;
  for (const t of scheme.transactions) {
    if (t.units) balance = balance.add(t.units);
    t.balance = balance;
  }
}

function continuationText(cells: Record<string, string>): string | null {
  const filled = Object.entries(cells).filter(([, v]) => v.trim()).map(([k]) => k);
  if (filled.length !== 1 || filled[0] !== 'Transaction') return null;
  return cells.Transaction?.trim() || null;
}

// ---------------------------------------------------------------- parse

export function parseCamsDetailed(pages: Page[], fileType: 'CAMS' | 'KFINTECH'): RtaCasData {
  let period: { from: string; to: string } | null = null;
  const folios = new Map<string, CasFolio>();
  let currentAmc: string | null = null;
  let currentFolio: CasFolio | null = null;
  let currentScheme: CasScheme | null = null;
  let lastColumns: Column[] = [];
  let headerBuf: string[] = [];
  let headerActive = false;
  let holderNameLinesLeft = 0;
  const warnings: string[] = [];

  for (const page of pages) {
    const headerPos = detectTxnColumns(page.lines, 0);
    let colFirst: number;
    let headerIdx: number;
    let columns: Column[];
    if (headerPos) {
      colFirst = headerPos.first;
      headerIdx = headerPos.last;
      columns = headerPos.columns;
      lastColumns = columns;
    } else {
      colFirst = headerIdx = -1;
      columns = lastColumns;
    }
    let contLineIdx = -2;
    let contBaseline = 0;

    for (let i = 0; i < page.lines.length; i++) {
      const line = page.lines[i] as Line;
      const text = lineText(line);

      if (period === null) {
        const m = STMT_PERIOD_RE.exec(text);
        if (m) period = { from: m[1] ?? '', to: m[2] ?? '' };
      }

      const amc = AMC_RE.exec(text.trim());
      if (amc) {
        currentAmc = amc[0];
        if (headerActive) {
          const w = abandonedRegionWarning(headerBuf, 'AMC boundary');
          if (w) warnings.push(w);
        }
        headerBuf = [];
        headerActive = false;
        holderNameLinesLeft = 0;
        continue;
      }

      if (text.includes('Folio No') && !DATE_CELL_RE.test(text)) {
        const m = FOLIO_LINE_RE.exec(text);
        if (m) {
          const folioNo = (m[1] ?? '').trim();
          const key = `${currentAmc ?? 'UNKNOWN'}\u0000${folioNo}`;
          if (!folios.has(key)) {
            folios.set(key, {
              folio: folioNo,
              amc: currentAmc ?? 'UNKNOWN',
              name: null,
              pan: m[2] || '',
              kyc: m[3] || null,
              panKyc: m[4] || null,
              schemes: [],
            });
          }
          currentFolio = folios.get(key) as CasFolio;
          currentScheme = null;
          holderNameLinesLeft = currentFolio.name === null ? 2 : 0;
          if (headerActive) {
            const w = abandonedRegionWarning(headerBuf, 'folio boundary');
            if (w) warnings.push(w);
          }
          headerBuf = [];
          headerActive = true;
          continue;
        }
      }

      if (holderNameLinesLeft && currentFolio) {
        holderNameLinesLeft -= 1;
        const stripped = text.trim();
        if (looksLikeHolderName(stripped)) {
          currentFolio.name = collapse(stripped);
          holderNameLinesLeft = 0;
        } else if (isHeaderLine(stripped) || OPEN_BAL_RE.test(stripped)) {
          holderNameLinesLeft = 0;
        }
      }

      const open = OPEN_BAL_RE.exec(text);
      if (open) {
        if (headerActive) {
          currentScheme = buildSchemeFromBuffer(headerBuf, period);
          if (currentScheme && currentFolio) {
            currentFolio.schemes.push(currentScheme);
          } else {
            const region = headerBuf.map((s) => s.trim()).filter(Boolean);
            warnings.push(
              `unparseable scheme header region before 'Opening Unit Balance' on page ${page.number}; the scheme and its transactions were skipped: '${region.slice(0, 2).join(' / ').slice(0, 120)}'`,
            );
            currentScheme = null;
          }
          headerActive = false;
          headerBuf = [];
        }
        if (currentScheme) {
          currentScheme.open = orZero(decimalCell(open[1]));
          currentScheme.closeCalculated = currentScheme.open;
        }
        continue;
      }

      let consumedFooter = false;
      if (currentScheme) {
        const close = CLOSE_BAL_RE.exec(text);
        if (close) {
          currentScheme.close = orZero(decimalCell(close[1]));
          headerBuf = [];
          headerActive = true;
          consumedFooter = true;
        }
        const nav = NAV_RE.exec(text);
        if (nav) {
          currentScheme.valuation.date = parseCasDate(nav[1] ?? '') ?? currentScheme.valuation.date;
          currentScheme.valuation.nav = orZero(decimalCell(nav[2]));
          consumedFooter = true;
        }
        const valuation = VALUATION_RE.exec(text);
        if (valuation) {
          currentScheme.valuation.date = parseCasDate(valuation[1] ?? '') ?? currentScheme.valuation.date;
          currentScheme.valuation.value = orZero(decimalCell(valuation[2]));
          consumedFooter = true;
        }
        const cost = COST_VALUE_RE.exec(text);
        if (cost) {
          currentScheme.valuation.cost = decimalCell(cost[1]);
          consumedFooter = true;
        }
        if (!headerActive) {
          const nominees = parseNominees(text);
          if (nominees) currentScheme.nominees = nominees;
        }
      }

      if (headerActive) {
        if (!consumedFooter && !(colFirst <= i && i <= headerIdx)) headerBuf.push(text);
        continue;
      }

      if (!currentScheme) continue;

      if (columns.length && i > headerIdx) {
        const cells = assignCells(line, columns);
        const dateCell = (cells.Date ?? '').trim();
        const desc = (cells.Transaction ?? '').trim();
        const mDate = DATE_CELL_RE.exec(dateCell);
        if (!mDate) {
          const tail = continuationText(cells);
          const last = currentScheme.transactions[currentScheme.transactions.length - 1];
          if (i === contLineIdx + 1 && contBaseline - line.baseline <= CONTINUATION_MAX_GAP && last && tail) {
            last.description = `${last.description} ${tail}`;
            const reclass = getTransactionType(last.description, last.units);
            last.type = reclass.type;
            last.dividendRate = reclass.dividendRate;
            if (last.type === 'GIFT_IN' || last.type === 'GIFT_OUT') last.giftFolio = extractGiftFolio(last.description);
            contLineIdx = i;
            contBaseline = line.baseline;
          }
          continue;
        }
        if (!desc) continue;
        const dateStr = (mDate[1] ?? '').replace(/[-\s]+/g, '-').replace(/^-+|-+$/g, '');
        const amount = decimalCell(cells.Amount);
        const units = decimalCell(cells.Units);
        let nav = decimalCell(cells.Price || cells.NAV);
        const balance = decimalCell(cells['Unit Balance']);
        if (amount === null && units === null && balance === null && !desc.startsWith('***')) continue;
        if (nav === null && amount !== null && units !== null && !units.isZero()) nav = amount.div(units, 4);
        const date = parseCasDate(dateStr);
        if (!date) {
          warnings.push(`unparseable transaction date '${dateStr}' in '${currentScheme.scheme}'; row skipped`);
          continue;
        }
        const { type, dividendRate } = getTransactionType(desc, units);
        if (units !== null) currentScheme.closeCalculated = currentScheme.closeCalculated.add(units);
        currentScheme.transactions.push({
          date,
          description: desc,
          amount,
          units,
          nav,
          balance,
          type,
          dividendRate,
          giftFolio: type === 'GIFT_IN' || type === 'GIFT_OUT' ? extractGiftFolio(desc) : null,
        });
        contLineIdx = i;
        contBaseline = line.baseline;
      }
    }
  }

  if (headerActive) {
    const w = abandonedRegionWarning(headerBuf, 'end of document');
    if (w) warnings.push(w);
  }

  for (const folio of folios.values()) {
    for (const scheme of folio.schemes) {
      applyBalanceSignFix(scheme);
      warnings.push(...reconcileBalances(scheme));
      sortTransactions(scheme);
    }
  }

  return {
    kind: 'rta_detailed',
    fileType,
    statementPeriod: period ?? { from: '', to: '' },
    folios: [...folios.values()],
    warnings,
  };
}
