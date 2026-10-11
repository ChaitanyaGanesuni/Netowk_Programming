import { normalizeCounterparty, type Category, type LedgerTxn } from '../ledger/ledger';

export interface MonthSummary {
  month: string; // YYYY-MM
  /** Salary, other income and interest. Refunds, transfers and redemptions are excluded. */
  incomePaise: number;
  /** Consumption: expenses + fees + cash withdrawals, net of refunds. */
  expensePaise: number;
  loanRepaymentPaise: number;
  /** Money moved into investments (purchases − redemptions). Savings, not spending. */
  netInvestedPaise: number;
  /** income − expenses − loan repayments. */
  netCashFlowPaise: number;
  /** netCashFlow / income, or null without income. */
  savingsRate: number | null;
  byCategory: Partial<Record<Category, number>>;
  /** Card spends not yet on a statement (included in expenses). */
  pendingPaise: number;
  transactionCount: number;
}

const month = (date: string) => date.slice(0, 7);

export function summarizeMonth(ledger: readonly LedgerTxn[], ym: string): MonthSummary {
  const s: MonthSummary = {
    month: ym, incomePaise: 0, expensePaise: 0, loanRepaymentPaise: 0, netInvestedPaise: 0, netCashFlowPaise: 0,
    savingsRate: null, byCategory: {}, pendingPaise: 0, transactionCount: 0,
  };
  const addCategory = (c: Category, v: number) => {
    s.byCategory[c] = (s.byCategory[c] ?? 0) + v;
  };
  for (const t of ledger) {
    if (month(t.date) !== ym) continue;
    s.transactionCount++;
    switch (t.kind) {
      case 'income':
      case 'interest':
        if (t.direction === 'credit') s.incomePaise += t.amountPaise;
        break;
      case 'expense':
      case 'fee':
      case 'cash_withdrawal':
        if (t.direction === 'debit') {
          s.expensePaise += t.amountPaise;
          addCategory(t.category, t.amountPaise);
          if (t.status === 'pending') s.pendingPaise += t.amountPaise;
        }
        break;
      case 'refund': {
        // A refund reduces spending in the category it reverses; it is not income.
        s.expensePaise -= t.amountPaise;
        const target: Category = t.category === 'refund' || t.category === 'income_other' ? 'shopping' : t.category;
        addCategory(target, -t.amountPaise);
        break;
      }
      case 'loan_repayment':
        if (t.direction === 'debit') s.loanRepaymentPaise += t.amountPaise;
        break;
      case 'investment':
        s.netInvestedPaise += t.direction === 'debit' ? t.amountPaise : -t.amountPaise;
        break;
      default:
        break; // transfers and card payments are neither income nor spending
    }
  }
  s.netCashFlowPaise = s.incomePaise - s.expensePaise - s.loanRepaymentPaise;
  s.savingsRate = s.incomePaise > 0 ? Number((s.netCashFlowPaise / s.incomePaise).toFixed(4)) : null;
  return s;
}

/** The `count` calendar months ending with `endMonth` (inclusive), oldest first. */
export function monthRange(endMonth: string, count: number): string[] {
  const [y, m] = endMonth.split('-').map(Number) as [number, number];
  const out: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    out.push(d.toISOString().slice(0, 7));
  }
  return out;
}

export function summarizeMonths(ledger: readonly LedgerTxn[], endMonth: string, count: number): MonthSummary[] {
  return monthRange(endMonth, count).map((m) => summarizeMonth(ledger, m));
}

// ---------------------------------------------------------------- recurring payments

export type Cadence = 'weekly' | 'monthly' | 'quarterly' | 'yearly';

export interface RecurringPayment {
  counterparty: string;
  category: Category;
  cadence: Cadence;
  typicalAmountPaise: number;
  /** Monthly-equivalent cost (yearly / 12, weekly × 52 / 12). */
  monthlyEquivalentPaise: number;
  lastDate: string;
  nextExpectedDate: string;
  occurrences: number;
  txnKeys: string[];
}

const CADENCES: ReadonlyArray<readonly [Cadence, number, number, number]> = [
  ['weekly', 6, 8, 7],
  ['monthly', 25, 35, 30],
  ['quarterly', 85, 97, 91],
  ['yearly', 355, 375, 365],
];

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] as number) : Math.round(((s[mid - 1] as number) + (s[mid] as number)) / 2);
};

const addDays = (iso: string, d: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + d * 86_400_000).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/**
 * Finds payments that repeat on a regular cadence: same counterparty, ≥3 occurrences
 * (≥2 for yearly), intervals within the cadence window, amounts within ±15% of the median.
 */
export function detectRecurring(ledger: readonly LedgerTxn[]): RecurringPayment[] {
  const groups = new Map<string, LedgerTxn[]>();
  for (const t of ledger) {
    if (t.direction !== 'debit' || !['expense', 'fee', 'loan_repayment', 'investment'].includes(t.kind)) continue;
    const key = normalizeCounterparty(t.counterparty) || `${t.category}:${t.description.toLowerCase().slice(0, 30)}`;
    groups.set(key, [...(groups.get(key) ?? []), t]);
  }
  const out: RecurringPayment[] = [];
  for (const [counterparty, txns] of groups) {
    const sorted = [...txns].sort((a, b) => a.date.localeCompare(b.date));
    if (sorted.length < 2) continue;
    const amounts = sorted.map((t) => t.amountPaise);
    const typical = median(amounts);
    if (!amounts.every((a) => Math.abs(a - typical) <= typical * 0.15)) continue;
    const gaps = sorted.slice(1).map((t, i) => daysBetween(sorted[i]!.date, t.date));
    const gap = median(gaps);
    const cadence = CADENCES.find(([, lo, hi]) => gap >= lo && gap <= hi);
    if (!cadence) continue;
    const [name, lo, hi, period] = cadence;
    if (sorted.length < (name === 'yearly' ? 2 : 3)) continue;
    if (!gaps.every((g) => g >= lo * 0.8 && g <= hi * 1.2)) continue;
    const last = sorted[sorted.length - 1]!;
    out.push({
      counterparty: last.counterparty ?? counterparty,
      category: last.category,
      cadence: name,
      typicalAmountPaise: typical,
      monthlyEquivalentPaise: Math.round((typical * 30.4375) / period),
      lastDate: last.date,
      nextExpectedDate: addDays(last.date, period),
      occurrences: sorted.length,
      txnKeys: sorted.map((t) => t.key),
    });
  }
  return out.sort((a, b) => a.nextExpectedDate.localeCompare(b.nextExpectedDate));
}
