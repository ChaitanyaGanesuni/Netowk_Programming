/**
 * CDSL Consolidated Account Statement parser — TypeScript port of casparser 1.4.1
 * `parsers/cdsl.py` (MIT © Sandeep Somasekharan). Holdings only: demat equities, ETFs
 * and mutual fund units, per demat account. The NPS section is not imported (reported as
 * a warning when present).
 */
import { Dec } from './dec';
import { blockText, type Block } from './layout';

export interface DematOwner {
  name: string;
  pan: string;
}

export interface DematEquity {
  name: string | null;
  isin: string;
  numShares: Dec;
  price: Dec;
  value: Dec;
}

export interface DematMutualFund {
  name: string | null;
  isin: string;
  balance: Dec;
  nav: Dec;
  value: Dec;
  totalCost: Dec | null;
  ucc: string | null;
  folio: string | null;
  pnl: Dec | null;
  returnPct: Dec | null;
}

export interface DematAccount {
  name: string;
  type: string;
  dpId: string;
  clientId: string;
  folios: number;
  balance: Dec;
  owners: DematOwner[];
  equities: DematEquity[];
  mutualFunds: DematMutualFund[];
}

export interface DepositoryCasData {
  kind: 'depository';
  fileType: 'CDSL' | 'NSDL';
  statementPeriod: { from: string; to: string };
  accounts: DematAccount[];
  warnings: string[];
}

const ISIN_RE = /^[A-Z]{2}[0-9A-Z]{9}\d$/;
const INF_ISIN_RE = /^INF[0-9A-Z]{8}\d$/;
const NUMERIC_RE = /^-?(?:[\d,]+(?:\.\d+)?|\.\d+)$/;
const FOLIO_TAIL_RE = /^\d+\/\d+$/;
const PERIOD_RE =
  /(?:for\s+the\s+period\s+from|statement\s+for\s+the\s+period\s+from)\s+(\d{2}[-/][A-Za-z0-9]{2,3}[-/]\d{4})\s+to\s+(\d{2}[-/][A-Za-z0-9]{2,3}[-/]\d{4})/i;
const DEMAT_TYPE_RE = /^(CDSL|NSDL)\s+Demat\s+Account\s*$/i;
const PAN_RE = /(.+?)\s*\(\s*PAN\s*:\s*([^)]+?)\s*\)/gi;
const SUMMARY_DPC_RE = /DP\s*Id\s*:\s*(\S+?)\s+Client\s*Id\s*:\s*(\d+)/i;
const SECTION_DPC_RE = /DP\s*Name\s*:\s*(.+?)\s+DP\s*ID\s*:\s*(\S+)\s+CLIENT\s*ID\s*:\s*(\S+)/is;
const SECTION_BOID_RE = /DP\s*Name\s*:\s*(.+?)\s+(?:BO\s*ID|DPID)\s*:\s*([A-Z0-9]{16})/is;

function toDec(text: string | null | undefined): Dec {
  return optDec(text) ?? Dec.ZERO;
}

function optDec(text: string | null | undefined): Dec | null {
  if (text == null) return null;
  const s = text.replace(/,/g, '').trim();
  if (!s || ['-', '--', 'N.A', 'NA'].includes(s)) return null;
  return Dec.parse(s);
}

/** Python `int(Decimal)`: truncates toward zero. */
const truncToInt = (d: Dec) => Number(d.coefficient / 10n ** BigInt(d.scale));

const looksNumeric = (text: string) => {
  const s = text.trim();
  return s.length > 0 && NUMERIC_RE.test(s);
};

const HUNDRED = Dec.parse('100') as Dec;
const REL = Dec.parse('0.005') as Dec;
const CENT = Dec.parse('0.01') as Dec;

function relClose(a: Dec, b: Dec): boolean {
  if (b.isZero()) return a.abs().cmp(CENT) <= 0;
  // |a - b| / |b| <= 0.005  ⇔  |a - b| <= 0.005 · |b|
  return a.sub(b).abs().cmp(REL.mul(b.abs())) <= 0;
}

function resolvePnlReturns(numerics: string[], value: Dec, invested: Dec | null, hasDistribCol: boolean): [Dec | null, Dec | null] {
  if (!hasDistribCol) return [null, null];
  const valueIdx = numerics.length >= 4 ? 3 : 2;
  const remaining = numerics.slice(valueIdx + 1).map(toDec).filter((r) => !r.isZero());
  const expected = invested !== null && invested.sign() > 0 ? value.sub(invested) : null;
  let pnl: Dec | null = null;
  let ret: Dec | null = null;
  if (expected !== null) {
    pnl = remaining.find((r) => relClose(r, expected)) ?? null;
    if (pnl === null && numerics.length >= 6) {
      const pos = optDec(numerics[numerics.length - 2]);
      if (pos !== null && relClose(pos, expected)) pnl = pos;
    }
  }
  const others = remaining.filter((r) => pnl === null || r.cmp(pnl) !== 0);
  if (pnl !== null && others.length) ret = others[others.length - 1] ?? null;
  else if (pnl === null && expected !== null) ret = others.find((r) => r.abs().cmp(HUNDRED) < 0) ?? null;
  else if (numerics.length >= 5) ret = optDec(numerics[numerics.length - 1]);
  if (pnl?.isZero()) pnl = null;
  if (ret?.isZero()) ret = null;
  return [pnl, ret];
}

function splitBoId(boId: string): [string, string, string] {
  if (boId.length !== 16) return ['', '', ''];
  if (boId.slice(0, 2).toUpperCase() === 'IN') return ['NSDL', boId.slice(0, 8), boId.slice(8)];
  if (/^\d+$/.test(boId)) return ['CDSL', boId.slice(0, 8), boId.slice(8)];
  return ['', '', ''];
}

const accountKey = (type: string, dp: string, client: string) => `${type.toUpperCase()}|${dp.trim()}|${client.trim()}`;

const cellText = (block: Block, i: number) => (block.cells[i]?.text ?? '').trim();

function isSummaryDematRow(block: Block): boolean {
  return block.cells.length === 4 && DEMAT_TYPE_RE.test(cellText(block, 0)) && SUMMARY_DPC_RE.test(block.cells[1]?.text ?? '');
}

function isSummaryMfFoliosRow(block: Block): boolean {
  return block.cells.length === 4 && /^Mutual\s+Fund\s+Folios/i.test(cellText(block, 0));
}

function isHoldingsHeader(block: Block): boolean {
  const txt = blockText(block);
  if (/\b(IN[EF9][0-9A-Z]{8}\d)\b/i.test(txt)) return false;
  const l = txt.toLowerCase().replace(/\n/g, ' ').replace(/\t\t/g, ' ');
  if (l.includes('isin') && (l.includes('security') || l.includes('scheme name'))) return true;
  return l.includes('current') && l.includes('bal') && l.includes('market');
}

function isTotalRow(block: Block): boolean {
  return ['sub total', 'total', 'grand total'].includes(cellText(block, 0).toLowerCase());
}

function parseHoldingsRow(block: Block): [string, string | null, Dec, Dec, Dec] | null {
  const first = cellText(block, 0);
  if (!ISIN_RE.test(first)) return null;
  let dataStart: number | null = null;
  for (let i = 1; i < block.cells.length; i++) {
    const t = cellText(block, i);
    if (looksNumeric(t) || t === '--' || t === '-') {
      dataStart = i;
      break;
    }
  }
  if (dataStart === null || block.cells.length - dataStart < 3) return null;
  const name =
    block.cells
      .slice(1, dataStart)
      .map((c) => c.text.replace(/\n/g, ' ').trim())
      .filter((t) => t && t !== '@')
      .join(' ') || null;
  return [first, name, toDec(cellText(block, dataStart)), toDec(cellText(block, block.cells.length - 2)), toDec(cellText(block, block.cells.length - 1))];
}

function parseMfHoldingsRow(block: Block, schemeMeta: Map<string, Record<string, string>>): DematMutualFund | null {
  if (block.cells.length < 5) return null;
  let isinIdx: number | null = null;
  for (let i = 0; i < Math.min(3, block.cells.length); i++) {
    if (ISIN_RE.test(cellText(block, i))) {
      isinIdx = i;
      break;
    }
  }
  if (isinIdx === null) return null;
  const isin = cellText(block, isinIdx);
  const name =
    block.cells
      .slice(0, isinIdx)
      .map((c) => c.text.replace(/\n/g, ' ').trim())
      .filter(Boolean)
      .join(' ') || null;
  let folio: string | null = isinIdx + 1 < block.cells.length ? cellText(block, isinIdx + 1) || null : null;
  let folioEnd = isinIdx + 1;
  if (folio && isinIdx + 2 < block.cells.length) {
    const tail = cellText(block, isinIdx + 2);
    if (FOLIO_TAIL_RE.test(tail)) {
      folio += tail;
      folioEnd = isinIdx + 2;
    }
  }
  const discIdx = folioEnd + 1;
  const hasDistribCol = discIdx < block.cells.length && !looksNumeric(block.cells[discIdx]?.text ?? '');
  const dataStart = discIdx + (hasDistribCol ? 1 : 0);
  const numerics = block.cells.slice(dataStart).map((c) => c.text.trim()).filter(looksNumeric);
  if (numerics.length < 3) return null;
  const balance = toDec(numerics[0]);
  const nav = toDec(numerics[1]);
  let invested: Dec | null = null;
  let value: Dec;
  if (numerics.length >= 4) {
    invested = optDec(numerics[2]);
    value = toDec(numerics[3]);
  } else {
    value = toDec(numerics[2]);
  }
  const [pnl, returnPct] = resolvePnlReturns(numerics, value, invested, hasDistribCol);
  let ucc: string | null = null;
  const code = name ? /^\s*([A-Z0-9]+)\s*-\s*/.exec(name)?.[1] : undefined;
  if (code) ucc = schemeMeta.get(code)?.ucc ?? null;
  return { name, isin, balance, nav, value, totalCost: invested, ucc, folio, pnl, returnPct };
}

export function parseCdsl(blocks: Block[]): DepositoryCasData {
  const warnings: string[] = [];
  let period: { from: string; to: string } | null = null;
  for (const b of blocks) {
    const m = PERIOD_RE.exec(blockText(b));
    if (m) {
      period = { from: m[1] ?? '', to: m[2] ?? '' };
      break;
    }
  }

  // Phase 1: account roster from the page-2 summary.
  const accountsByKey = new Map<string, DematAccount>();
  const ordered: DematAccount[] = [];
  let mfFoliosAccount: DematAccount | null = null;
  let pendingOwners: DematOwner[] = [];
  for (const b of blocks) {
    if (b.page !== 2) continue;
    const txt = blockText(b);
    const l = txt.toLowerCase();
    if (l.includes('in the single name of') || l.includes('in the joint name')) {
      pendingOwners = [];
      continue;
    }
    if (new RegExp(PAN_RE.source, 'i').test(txt) && !txt.includes('Mutual')) {
      for (const m of txt.matchAll(PAN_RE)) pendingOwners.push({ name: (m[1] ?? '').trim(), pan: (m[2] ?? '').trim() });
      continue;
    }
    if (isSummaryDematRow(b)) {
      const typeWord = (DEMAT_TYPE_RE.exec(cellText(b, 0))?.[1] ?? '').toUpperCase();
      const brokerDp = b.cells[1]?.text ?? '';
      const brokerLines = brokerDp.split('\n').map((s) => s.trim()).filter(Boolean);
      const dpc = SUMMARY_DPC_RE.exec(brokerDp);
      const account: DematAccount = {
        name: brokerLines[0] ?? '',
        type: `${typeWord} Demat Account`,
        dpId: dpc?.[1] ?? '',
        clientId: dpc?.[2] ?? '',
        folios: truncToInt(toDec(cellText(b, 2))),
        balance: toDec(cellText(b, 3)),
        owners: [...pendingOwners],
        equities: [],
        mutualFunds: [],
      };
      const key = accountKey(typeWord, account.dpId, account.clientId);
      if (!accountsByKey.has(key)) {
        accountsByKey.set(key, account);
        ordered.push(account);
      }
      continue;
    }
    if (isSummaryMfFoliosRow(b) && mfFoliosAccount === null) {
      mfFoliosAccount = {
        name: 'Mutual Fund Folios',
        type: 'Mutual Fund Folios',
        dpId: '',
        clientId: '',
        folios: Number(/(\d+)/.exec(b.cells[1]?.text ?? '')?.[1] ?? 0),
        balance: toDec(cellText(b, 3)),
        owners: [...pendingOwners],
        equities: [],
        mutualFunds: [],
      };
      ordered.push(mfFoliosAccount);
    }
  }

  // Phase 2: scheme-code metadata from the descriptive MF blocks.
  const schemeMeta = new Map<string, Record<string, string>>();
  let pending: Record<string, string> = {};
  for (const b of blocks) {
    if (b.page < 3) continue;
    const txt = blockText(b);
    if (SECTION_BOID_RE.test(txt)) break;
    if (txt.includes('Scheme Name :') && txt.includes('Scheme Code :')) {
      const sm = /Scheme\s*Name\s*:\s*(.+?)\s+Scheme\s*Code\s*:\s*(\S+)/s.exec(txt);
      if (sm) pending = { scheme_name: (sm[1] ?? '').replace(/\n/g, ' ').trim(), scheme_code: (sm[2] ?? '').trim() };
    } else if (txt.includes('Folio No :')) {
      const fm = /Folio\s*No\s*:\s*(\S+)/.exec(txt);
      if (fm?.[1]) pending.folio = fm[1];
    } else if (txt.includes('ISIN :') && txt.includes('UCC')) {
      const im = /ISIN\s*:\s*(\S+)/.exec(txt);
      const um = /UCC\s*:\s*([\w/]+)?/.exec(txt);
      if (im?.[1] && pending.scheme_code) {
        pending.isin = im[1];
        if (um?.[1]) pending.ucc = um[1];
        schemeMeta.set(pending.scheme_code, { ...pending });
        pending = {};
      }
    }
  }

  // Phase 3: holdings tables.
  let current: DematAccount | null = null;
  let mode: 'equities' | 'mf_holdings' | null = null;
  let sawNps = false;
  for (const b of blocks) {
    if (b.page < 3) continue;
    const txt = blockText(b);
    const l = txt.toLowerCase();
    if (l.includes('nps trust')) sawNps = true;

    const bo = SECTION_BOID_RE.exec(txt);
    if (bo) {
      const [typeWord, dpId, clientId] = splitBoId(bo[2] ?? '');
      if (typeWord) {
        current = accountsByKey.get(accountKey(typeWord, dpId, clientId)) ?? null;
        mode = null;
        continue;
      }
    }
    const dpc = SECTION_DPC_RE.exec(txt);
    if (dpc) {
      const upper = txt.toUpperCase();
      const typeWord = upper.includes('NSDL') && !upper.includes('CDSL') ? 'NSDL' : 'CDSL';
      current = accountsByKey.get(accountKey(typeWord, dpc[2] ?? '', dpc[3] ?? '')) ?? null;
      mode = null;
      continue;
    }
    if (l.includes('statement of transactions')) {
      mode = null;
      continue;
    }
    if (l.includes('holding statement') && l.includes('as on')) {
      mode = 'equities';
      continue;
    }
    if (l.includes('mutual fund units held as on')) {
      current = mfFoliosAccount;
      mode = 'mf_holdings';
      continue;
    }
    if (isHoldingsHeader(b) || isTotalRow(b)) continue;
    if (!current || !mode) continue;
    if (mode === 'equities') {
      const row = parseHoldingsRow(b);
      if (!row) continue;
      const [isin, name, numShares, price, value] = row;
      if (INF_ISIN_RE.test(isin)) {
        current.mutualFunds.push({ name, isin, balance: numShares, nav: price, value, totalCost: null, ucc: null, folio: null, pnl: null, returnPct: null });
      } else {
        current.equities.push({ name, isin, numShares, price, value });
      }
    } else {
      const mf = parseMfHoldingsRow(b, schemeMeta);
      if (mf) current.mutualFunds.push(mf);
    }
  }

  if (sawNps) warnings.push('This CAS contains an NPS section, which is not imported yet.');
  return { kind: 'depository', fileType: 'CDSL', statementPeriod: period ?? { from: '', to: '' }, accounts: ordered, warnings };
}
