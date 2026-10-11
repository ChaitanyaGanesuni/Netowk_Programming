import { assessFreshness, daysToMs, type FreshnessLevel } from '../freshness';
import { valueInPaise } from '../money';

/** Every figure states where it came from and how old it is. */
export interface NetWorthItem {
  id: string;
  label: string;
  kind: 'bank' | 'mutual_fund' | 'equity' | 'etf_or_demat_fund' | 'card';
  side: 'asset' | 'liability';
  valuePaise: number;
  asOf: string;
  source: string;
  /** True when part of the value is computed (e.g. card spends since the last statement). */
  estimated: boolean;
  freshness: FreshnessLevel;
}

export interface BankBalanceInput {
  accountKey: string;
  label: string;
  /** Available balance from the latest alert or statement. */
  balancePaise: number;
  asOf: string;
  source: 'alert' | 'bank_statement';
}

export interface CardInput {
  accountKey: string;
  label: string;
  statement: { date: string; totalDuePaise: number; creditLimitPaise: number | null } | null;
  /** Card debits/credits recorded after the statement date. */
  spendsSinceStatementPaise: number;
  paymentsSinceStatementPaise: number;
  /** Latest "available limit" from an alert, used only when there is no statement. */
  availableLimitPaise: number | null;
  availableLimitAsOf: string | null;
}

export interface MutualFundInput {
  schemeKey: string;
  scheme: string;
  isin: string | null;
  unitsMicro: number;
  unitsAsOf: string;
  navMicro: number | null;
  navDate: string | null;
  statementValuePaise: number | null;
}

export interface DematInput {
  key: string;
  name: string;
  isin: string;
  kind: 'equity' | 'mutual_fund';
  /** True for the depository's "Mutual Fund Folios" pseudo-account (same units as the RTA CAS). */
  fromFolioAccount: boolean;
  valuePaise: number | null;
  asOf: string;
}

export interface NetWorth {
  assetsPaise: number;
  liabilitiesPaise: number;
  netWorthPaise: number;
  bankPaise: number;
  investmentsPaise: number;
  cardOutstandingPaise: number;
  items: NetWorthItem[];
  notes: string[];
}

const freshness = (asOf: string, cadenceDays: number, now: number) => assessFreshness(Date.parse(`${asOf}T00:00:00Z`), daysToMs(cadenceDays), now).level;

export function computeNetWorth(
  input: { banks: BankBalanceInput[]; cards: CardInput[]; mutualFunds: MutualFundInput[]; demat: DematInput[] },
  now: number,
): NetWorth {
  const items: NetWorthItem[] = [];
  const notes: string[] = [];

  for (const b of input.banks) {
    items.push({ id: b.accountKey, label: b.label, kind: 'bank', side: 'asset', valuePaise: b.balancePaise, asOf: b.asOf, source: b.source === 'alert' ? 'Available balance in last alert' : 'Statement closing balance', estimated: false, freshness: freshness(b.asOf, 7, now) });
  }

  for (const c of input.cards) {
    if (c.statement) {
      const outstanding = c.statement.totalDuePaise + c.spendsSinceStatementPaise - c.paymentsSinceStatementPaise;
      const estimated = c.spendsSinceStatementPaise !== 0 || c.paymentsSinceStatementPaise !== 0;
      items.push({ id: c.accountKey, label: c.label, kind: 'card', side: 'liability', valuePaise: Math.max(0, outstanding), asOf: c.statement.date, source: estimated ? 'Last statement total ± card alerts since' : 'Last statement total due', estimated, freshness: freshness(c.statement.date, 31, now) });
      if (outstanding < 0) notes.push(`${c.label}: payments exceed the statement balance plus spends; shown as 0.`);
    } else if (c.availableLimitPaise !== null && c.availableLimitAsOf) {
      notes.push(`${c.label}: no statement yet, so the outstanding amount is unknown (only the available limit is known).`);
    } else {
      notes.push(`${c.label}: no statement or limit data yet; not included.`);
    }
  }

  const rtaIsins = new Set(input.mutualFunds.map((m) => m.isin).filter((i): i is string => Boolean(i)));
  for (const m of input.mutualFunds) {
    if (m.unitsMicro === 0) continue;
    const atNav = m.navMicro !== null && m.navDate ? valueInPaise(m.unitsMicro, m.navMicro) : null;
    const value = atNav ?? m.statementValuePaise;
    if (value === null) {
      notes.push(`${m.scheme}: no NAV or statement value; not included.`);
      continue;
    }
    const asOf = atNav !== null ? (m.navDate as string) : m.unitsAsOf;
    items.push({ id: m.schemeKey, label: m.scheme, kind: 'mutual_fund', side: 'asset', valuePaise: value, asOf, source: atNav !== null ? `Units from CAS (${m.unitsAsOf}) × AMFI NAV` : 'CAS statement value', estimated: false, freshness: freshness(asOf, 3, now) });
  }

  for (const d of input.demat) {
    // The depository CAS repeats RTA folio units; count each fund once (prefer the RTA data).
    if (d.kind === 'mutual_fund' && (d.fromFolioAccount || rtaIsins.has(d.isin))) continue;
    if (d.valuePaise === null) continue;
    items.push({ id: d.key, label: d.name, kind: d.kind === 'equity' ? 'equity' : 'etf_or_demat_fund', side: 'asset', valuePaise: d.valuePaise, asOf: d.asOf, source: 'Depository CAS closing price', estimated: false, freshness: freshness(d.asOf, 31, now) });
  }

  const sum = (pred: (i: NetWorthItem) => boolean) => items.filter(pred).reduce((s, i) => s + i.valuePaise, 0);
  const assetsPaise = sum((i) => i.side === 'asset');
  const liabilitiesPaise = sum((i) => i.side === 'liability');
  return {
    assetsPaise,
    liabilitiesPaise,
    netWorthPaise: assetsPaise - liabilitiesPaise,
    bankPaise: sum((i) => i.kind === 'bank'),
    investmentsPaise: sum((i) => i.kind === 'mutual_fund' || i.kind === 'equity' || i.kind === 'etf_or_demat_fund'),
    cardOutstandingPaise: liabilitiesPaise,
    items,
    notes,
  };
}
