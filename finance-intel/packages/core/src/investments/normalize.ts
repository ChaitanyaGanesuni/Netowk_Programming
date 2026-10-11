import type { CasData, CasScheme, DepositoryCasData, RtaCasData } from '../cas';
import { Dec, parseCasDate } from '../cas/dec';

/** Storage scales: rupees in paise, units and prices in millionths. Integers only. */
export const AMOUNT_SCALE = 2;
export const UNITS_SCALE = 6;
export const PRICE_SCALE = 6;

export interface FolioRecord {
  key: string;
  amc: string;
  folio: string;
  holderName: string | null;
  panMasked: string | null;
}

export interface SchemeRecord {
  key: string;
  folioKey: string;
  scheme: string;
  isin: string | null;
  rta: string;
  rtaCode: string;
  advisor: string | null;
}

export interface MfTransactionRecord {
  /** Deterministic: identical rows from overlapping statements collapse to one. */
  key: string;
  schemeKey: string;
  date: string;
  description: string;
  type: string;
  amountPaise: number | null;
  unitsMicro: number | null;
  navMicro: number | null;
  balanceMicro: number | null;
  dividendRateMicro: number | null;
}

export interface UnitsSnapshotRecord {
  key: string;
  schemeKey: string;
  asOf: string;
  unitsMicro: number;
  navMicro: number | null;
  valuePaise: number | null;
  costPaise: number | null;
  source: 'rta_cas' | 'depository_cas';
}

export interface DematAccountRecord {
  key: string;
  depository: string;
  broker: string;
  dpId: string;
  clientId: string;
}

export interface DematHoldingRecord {
  key: string;
  accountKey: string;
  asOf: string;
  isin: string;
  name: string | null;
  kind: 'equity' | 'mutual_fund';
  quantityMicro: number;
  priceMicro: number | null;
  valuePaise: number | null;
  folio: string | null;
}

export interface NormalizedStatement {
  source: 'rta_cas' | 'depository_cas';
  issuer: string;
  periodFrom: string | null;
  periodTo: string | null;
  folios: FolioRecord[];
  schemes: SchemeRecord[];
  transactions: MfTransactionRecord[];
  snapshots: UnitsSnapshotRecord[];
  dematAccounts: DematAccountRecord[];
  dematHoldings: DematHoldingRecord[];
  warnings: string[];
}

function scaled(value: Dec | null, scale: number, what: string, warnings: string[]): number | null {
  if (value === null) return null;
  try {
    return value.toScaledInt(scale);
  } catch (error) {
    warnings.push(`${what}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/** Keeps only the last 4 characters of a PAN for display ("XXXXXX234F"). */
export function maskPan(pan: string | null): string | null {
  if (!pan) return null;
  return pan.length > 4 ? `${'X'.repeat(pan.length - 4)}${pan.slice(-4)}` : pan;
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toUpperCase();

function schemeKey(folioKey: string, scheme: CasScheme): string {
  return `${folioKey}|${scheme.isin ?? norm(scheme.rtaCode || scheme.scheme)}`;
}

function normalizeRta(data: RtaCasData): NormalizedStatement {
  const warnings = [...data.warnings];
  const out: NormalizedStatement = {
    source: 'rta_cas',
    issuer: data.fileType,
    periodFrom: parseCasDate(data.statementPeriod.from),
    periodTo: parseCasDate(data.statementPeriod.to),
    folios: [],
    schemes: [],
    transactions: [],
    snapshots: [],
    dematAccounts: [],
    dematHoldings: [],
    warnings,
  };
  for (const folio of data.folios) {
    const folioKey = `${norm(folio.amc)}|${folio.folio.replace(/\s+/g, '')}`;
    out.folios.push({ key: folioKey, amc: folio.amc, folio: folio.folio, holderName: folio.name, panMasked: maskPan(folio.pan) });
    for (const scheme of folio.schemes) {
      const sKey = schemeKey(folioKey, scheme);
      out.schemes.push({ key: sKey, folioKey, scheme: scheme.scheme, isin: scheme.isin, rta: scheme.rta, rtaCode: scheme.rtaCode, advisor: scheme.advisor });
      const label = `${scheme.scheme} (${folio.folio})`;
      for (const t of scheme.transactions) {
        const record: MfTransactionRecord = {
          key: '',
          schemeKey: sKey,
          date: t.date,
          description: t.description,
          type: t.type,
          amountPaise: scaled(t.amount, AMOUNT_SCALE, `${label} amount`, warnings),
          unitsMicro: scaled(t.units, UNITS_SCALE, `${label} units`, warnings),
          navMicro: scaled(t.nav, PRICE_SCALE, `${label} NAV`, warnings),
          balanceMicro: scaled(t.balance, UNITS_SCALE, `${label} balance`, warnings),
          dividendRateMicro: scaled(t.dividendRate, PRICE_SCALE, `${label} dividend rate`, warnings),
        };
        record.key = [sKey, t.date, norm(t.description), t.type, record.amountPaise, record.unitsMicro, record.balanceMicro].join('|');
        out.transactions.push(record);
      }
      const asOf = scheme.valuation.date;
      const units = scaled(scheme.close, UNITS_SCALE, `${label} closing units`, warnings);
      if (units !== null && /^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
        out.snapshots.push({
          key: `${sKey}|${asOf}`,
          schemeKey: sKey,
          asOf,
          unitsMicro: units,
          navMicro: scheme.valuation.nav.isZero() ? null : scaled(scheme.valuation.nav, PRICE_SCALE, `${label} valuation NAV`, warnings),
          valuePaise: scaled(scheme.valuation.value, AMOUNT_SCALE, `${label} valuation`, warnings),
          costPaise: scaled(scheme.valuation.cost, AMOUNT_SCALE, `${label} cost`, warnings),
          source: 'rta_cas',
        });
      }
    }
  }
  return out;
}

function normalizeDepository(data: DepositoryCasData): NormalizedStatement {
  const warnings = [...data.warnings];
  const asOf = parseCasDate(data.statementPeriod.to);
  const out: NormalizedStatement = {
    source: 'depository_cas',
    issuer: data.fileType,
    periodFrom: parseCasDate(data.statementPeriod.from),
    periodTo: asOf,
    folios: [],
    schemes: [],
    transactions: [],
    snapshots: [],
    dematAccounts: [],
    dematHoldings: [],
    warnings,
  };
  if (!asOf) {
    warnings.push('Statement date not found; holdings were not imported.');
    return out;
  }
  for (const account of data.accounts) {
    const isFolios = account.type === 'Mutual Fund Folios';
    const accountKey = isFolios ? `${data.fileType}|MF_FOLIOS` : `${account.type.split(' ')[0]}|${account.dpId}|${account.clientId}`;
    out.dematAccounts.push({ key: accountKey, depository: data.fileType, broker: account.name, dpId: account.dpId, clientId: account.clientId });
    for (const e of account.equities) {
      const quantity = scaled(e.numShares, UNITS_SCALE, `${e.isin} quantity`, warnings);
      if (quantity === null) continue;
      out.dematHoldings.push({
        key: `${accountKey}|${e.isin}|${asOf}`,
        accountKey,
        asOf,
        isin: e.isin,
        name: e.name,
        kind: 'equity',
        quantityMicro: quantity,
        priceMicro: scaled(e.price, PRICE_SCALE, `${e.isin} price`, warnings),
        valuePaise: scaled(e.value, AMOUNT_SCALE, `${e.isin} value`, warnings),
        folio: null,
      });
    }
    for (const m of account.mutualFunds) {
      const quantity = scaled(m.balance, UNITS_SCALE, `${m.isin} units`, warnings);
      if (quantity === null) continue;
      out.dematHoldings.push({
        key: `${accountKey}|${m.isin}|${m.folio ?? ''}|${asOf}`,
        accountKey,
        asOf,
        isin: m.isin,
        name: m.name,
        kind: 'mutual_fund',
        quantityMicro: quantity,
        priceMicro: scaled(m.nav, PRICE_SCALE, `${m.isin} NAV`, warnings),
        valuePaise: scaled(m.value, AMOUNT_SCALE, `${m.isin} value`, warnings),
        folio: m.folio,
      });
    }
  }
  return out;
}

/** Converts parsed CAS data into storage records with exact integer amounts. */
export function normalizeCas(data: CasData): NormalizedStatement {
  return data.kind === 'rta_detailed' ? normalizeRta(data) : normalizeDepository(data);
}
