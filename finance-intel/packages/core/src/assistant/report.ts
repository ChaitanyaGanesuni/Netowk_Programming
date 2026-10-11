import type { Insight, MonthSummary } from '../analytics';
import type { LedgerTxn } from '../ledger/ledger';
import { formatPaise } from '../money';

/** Plain-text monthly report built only from computed figures. */
export function monthlyReport(month: MonthSummary, previous: MonthSummary | null, insights: readonly Insight[], netWorthPaise: number | null): string {
  const lines: string[] = [];
  lines.push(`Finance report — ${month.month}`);
  lines.push('');
  lines.push(`Income: ${formatPaise(month.incomePaise)}`);
  lines.push(`Spending: ${formatPaise(month.expensePaise)}${previous ? ` (previous month ${formatPaise(previous.expensePaise)})` : ''}`);
  if (month.loanRepaymentPaise) lines.push(`Loan repayments: ${formatPaise(month.loanRepaymentPaise)}`);
  lines.push(`Net cash flow: ${formatPaise(month.netCashFlowPaise)}`);
  lines.push(`Savings rate: ${month.savingsRate === null ? 'n/a (no income recorded)' : `${(month.savingsRate * 100).toFixed(1)}%`}`);
  lines.push(`Invested (net): ${formatPaise(month.netInvestedPaise)}`);
  if (netWorthPaise !== null) lines.push(`Net worth: ${formatPaise(netWorthPaise)}`);
  lines.push('');
  lines.push('Spending by category:');
  for (const [c, v] of Object.entries(month.byCategory).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))) {
    if ((v ?? 0) !== 0) lines.push(`  ${c.replace(/_/g, ' ')}: ${formatPaise(v ?? 0)}`);
  }
  if (insights.length) {
    lines.push('');
    lines.push('Potential savings (not guaranteed):');
    for (const i of insights) lines.push(`  ${i.title}: ${formatPaise(i.estMonthlySavingsPaise)}/month — ${i.action}`);
  }
  return lines.join('\n');
}

const csvCell = (v: string | number | null) => {
  const s = v === null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** CSV export of the ledger (amounts in rupees with 2 decimals, computed from paise). */
export function ledgerToCsv(ledger: readonly LedgerTxn[]): string {
  const header = ['date', 'account', 'direction', 'amount_inr', 'kind', 'category', 'channel', 'counterparty', 'status', 'reference'];
  const rows = [...ledger]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((t) => [t.date, t.accountKey, t.direction, `${Math.trunc(t.amountPaise / 100)}.${String(t.amountPaise % 100).padStart(2, '0')}`, t.kind, t.category, t.channel, t.counterparty, t.status, t.reference].map(csvCell).join(','));
  return [header.join(','), ...rows].join('\n');
}
