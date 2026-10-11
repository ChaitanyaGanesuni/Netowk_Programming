import { DISCRETIONARY, normalizeCounterparty, type Category, type LedgerTxn } from '../ledger/ledger';
import { monthRange, type RecurringPayment } from './cashflow';

export type InsightType =
  | 'late_fees'
  | 'bank_charges'
  | 'duplicate_charge'
  | 'subscriptions'
  | 'food_delivery'
  | 'category_spike'
  | 'small_purchases'
  | 'growing_faster_than_income';

export interface Insight {
  id: string;
  type: InsightType;
  title: string;
  /** Plain statement of what the data shows. */
  finding: string;
  /** Realistic suggested action. */
  action: string;
  category: Category | null;
  observedMonthlyPaise: number;
  /** Historical comparison (average of earlier months), when available. */
  baselineMonthlyPaise: number | null;
  /** Potential (not guaranteed) savings; claimed transactions are never counted twice. */
  estMonthlySavingsPaise: number;
  estAnnualSavingsPaise: number;
  /** One-off recoverable amount (e.g. a duplicate charge to dispute). */
  oneTimePaise: number;
  confidence: 'high' | 'medium' | 'low';
  /** Supporting transactions (may be shared with other insights). */
  evidence: string[];
  /** Transactions whose amounts back the savings estimate — each belongs to one insight only. */
  savingsBasis: string[];
}

const monthOf = (d: string) => d.slice(0, 7);
const spendKinds = new Set(['expense', 'fee', 'cash_withdrawal']);

/**
 * Generates spending insights for the 3 months ending `endMonth`, compared with the 3 months
 * before. Essential categories (groceries, rent, utilities, …) are never labelled waste.
 */
export function generateInsights(ledger: readonly LedgerTxn[], recurring: readonly RecurringPayment[], endMonth: string): Insight[] {
  const recent = new Set(monthRange(endMonth, 3));
  const prior = new Set(monthRange(monthRange(endMonth, 4)[0] as string, 3));
  const debits = ledger.filter((t) => t.direction === 'debit' && spendKinds.has(t.kind));
  const recentDebits = debits.filter((t) => recent.has(monthOf(t.date)));
  const priorDebits = debits.filter((t) => prior.has(monthOf(t.date)));
  const priorMonthsWithData = new Set(priorDebits.map((t) => monthOf(t.date))).size;
  const claimed = new Set<string>();
  const insights: Insight[] = [];

  const claim = (txns: readonly LedgerTxn[]) => {
    const fresh = txns.filter((t) => !claimed.has(t.key));
    fresh.forEach((t) => claimed.add(t.key));
    return fresh;
  };
  const sum = (txns: readonly LedgerTxn[]) => txns.reduce((s, t) => s + t.amountPaise, 0);
  const perMonth = (paise: number, months: number) => Math.round(paise / Math.max(1, months));

  // 1. Late fees — fully avoidable with autopay.
  const late = recentDebits.filter((t) => t.category === 'late_fees');
  if (late.length) {
    const own = claim(late);
    const monthly = perMonth(sum(own), 3);
    insights.push({
      id: 'late_fees', type: 'late_fees', title: 'Late payment fees', category: 'late_fees',
      finding: `${late.length} late-payment charge(s) totalling ₹${(sum(late) / 100).toFixed(2)} in the last 3 months.`,
      action: 'Set up autopay for at least the minimum due on each card so a missed date never costs a fee.',
      observedMonthlyPaise: monthly, baselineMonthlyPaise: null, estMonthlySavingsPaise: monthly, estAnnualSavingsPaise: monthly * 12, oneTimePaise: 0,
      confidence: 'high', evidence: late.map((t) => t.key), savingsBasis: own.map((t) => t.key),
    });
  }

  // 2. Bank charges.
  const charges = recentDebits.filter((t) => t.category === 'bank_charges');
  if (charges.length) {
    const own = claim(charges);
    const monthly = perMonth(sum(own), 3);
    insights.push({
      id: 'bank_charges', type: 'bank_charges', title: 'Bank and card charges', category: 'bank_charges',
      finding: `${charges.length} charge(s) such as fees, GST on charges or minimum-balance penalties: ₹${(sum(charges) / 100).toFixed(2)} in 3 months.`,
      action: 'Check which fees are waivable (annual fee spend targets, minimum balance, SMS charges) and ask the bank to reverse first-time charges.',
      observedMonthlyPaise: monthly, baselineMonthlyPaise: null, estMonthlySavingsPaise: monthly, estAnnualSavingsPaise: monthly * 12, oneTimePaise: 0,
      confidence: 'medium', evidence: charges.map((t) => t.key), savingsBasis: own.map((t) => t.key),
    });
  }

  // 3. Possible duplicate charges: same merchant and amount within a day, on the same account.
  const byGroup = new Map<string, LedgerTxn[]>();
  for (const t of recentDebits) {
    if (!t.counterparty) continue;
    const k = `${t.accountKey}|${normalizeCounterparty(t.counterparty)}|${t.amountPaise}`;
    byGroup.set(k, [...(byGroup.get(k) ?? []), t]);
  }
  for (const group of byGroup.values()) {
    const sorted = [...group].sort((a, b) => a.at - b.at);
    for (let i = 1; i < sorted.length; i++) {
      const a = sorted[i - 1]!;
      const b = sorted[i]!;
      if (Math.abs(b.at - a.at) > 86_400_000 || claimed.has(b.key)) continue;
      claim([b]);
      insights.push({
        id: `duplicate:${b.key}`, type: 'duplicate_charge', title: `Possible duplicate: ${b.counterparty}`, category: b.category,
        finding: `Two charges of ₹${(b.amountPaise / 100).toFixed(2)} to ${b.counterparty} within a day (${a.date} and ${b.date}).`,
        action: 'If you only made one purchase, raise a dispute with the merchant or bank; if both were intended, ignore this.',
        observedMonthlyPaise: 0, baselineMonthlyPaise: null, estMonthlySavingsPaise: 0, estAnnualSavingsPaise: 0, oneTimePaise: b.amountPaise,
        confidence: 'low', evidence: [a.key, b.key], savingsBasis: [b.key],
      });
    }
  }

  // 4. Subscriptions: recurring payments in the subscriptions category.
  const subs = recurring.filter((r) => r.category === 'subscriptions');
  if (subs.length) {
    const evidence = subs.flatMap((r) => r.txnKeys);
    // Claim the recent subscription debits; savings are counted only if they were not already
    // claimed by an earlier insight (e.g. a charge flagged as a duplicate).
    const own = claim(debits.filter((t) => evidence.includes(t.key) && recent.has(monthOf(t.date))));
    const monthly = subs.reduce((s, r) => s + r.monthlyEquivalentPaise, 0);
    const ownShare = own.length > 0 ? monthly : 0;
    insights.push({
      id: 'subscriptions', type: 'subscriptions', title: `${subs.length} active subscription(s)`, category: 'subscriptions',
      finding: `${subs.map((r) => `${r.counterparty} (~₹${(r.typicalAmountPaise / 100).toFixed(0)}/${r.cadence.replace('ly', '')})`).join(', ')} — about ₹${(monthly / 100).toFixed(0)} per month.`,
      action: 'Cancel the ones you have not used in the last month. Savings depend on which you keep, so this is an upper bound.',
      observedMonthlyPaise: monthly, baselineMonthlyPaise: null, estMonthlySavingsPaise: ownShare, estAnnualSavingsPaise: ownShare * 12, oneTimePaise: 0,
      confidence: 'low', evidence, savingsBasis: own.map((t) => t.key),
    });
  }

  // 5. Food delivery.
  const food = recentDebits.filter((t) => t.category === 'food_delivery');
  const recentSpend = sum(recentDebits);
  if (food.length >= 4) {
    const avg = perMonth(sum(food), 3);
    const priorFood = priorDebits.filter((t) => t.category === 'food_delivery');
    const baseline = priorMonthsWithData ? perMonth(sum(priorFood), priorMonthsWithData) : null;
    const share = recentSpend ? sum(food) / recentSpend : 0;
    if (avg >= 300000 || share >= 0.1) {
      const own = claim(food);
      const savings = Math.round((sum(own) / 3) * 0.3);
      insights.push({
        id: 'food_delivery', type: 'food_delivery', title: 'Food delivery', category: 'food_delivery',
        finding: `₹${(avg / 100).toFixed(0)} a month on ${food.length} delivery orders over 3 months (${Math.round(share * 100)}% of spending)${baseline !== null ? `, vs ₹${(baseline / 100).toFixed(0)} a month before` : ''}.`,
        action: 'Replacing about a third of orders with home-cooked or dine-in meals is a realistic target.',
        observedMonthlyPaise: avg, baselineMonthlyPaise: baseline, estMonthlySavingsPaise: savings, estAnnualSavingsPaise: savings * 12, oneTimePaise: 0,
        confidence: food.length >= 10 ? 'medium' : 'low', evidence: food.map((t) => t.key), savingsBasis: own.map((t) => t.key),
      });
    }
  }

  // 6. Discretionary category spikes vs the prior 3 months.
  if (priorMonthsWithData >= 2) {
    for (const category of DISCRETIONARY) {
      if (category === 'food_delivery' || category === 'subscriptions') continue;
      const now = recentDebits.filter((t) => t.category === category);
      const before = priorDebits.filter((t) => t.category === category);
      const avgNow = perMonth(sum(now), 3);
      const avgBefore = perMonth(sum(before), priorMonthsWithData);
      if (avgBefore > 0 && avgNow > avgBefore * 1.5 && avgNow - avgBefore >= 100000) {
        const own = claim(now);
        const excess = Math.max(0, Math.min(avgNow - avgBefore, Math.round(sum(own) / 3)));
        insights.push({
          id: `spike:${category}`, type: 'category_spike', title: `${category[0]!.toUpperCase()}${category.slice(1)} is up`, category,
          finding: `₹${(avgNow / 100).toFixed(0)} a month recently vs ₹${(avgBefore / 100).toFixed(0)} before (+${Math.round((avgNow / avgBefore - 1) * 100)}%).`,
          action: `Returning to your earlier ${category} level would free up the difference; check whether the increase was one-off (e.g. a festival or trip).`,
          observedMonthlyPaise: avgNow, baselineMonthlyPaise: avgBefore, estMonthlySavingsPaise: excess, estAnnualSavingsPaise: excess * 12, oneTimePaise: 0,
          confidence: 'medium', evidence: now.map((t) => t.key), savingsBasis: own.map((t) => t.key),
        });
      }
    }
  }

  // 7. Many small discretionary purchases.
  const small = recentDebits.filter((t) => DISCRETIONARY.has(t.category) && t.amountPaise < 50000 && !claimed.has(t.key));
  if (small.length >= 45) {
    const own = claim(small);
    const avg = perMonth(sum(own), 3);
    const savings = Math.round(avg * 0.2);
    insights.push({
      id: 'small_purchases', type: 'small_purchases', title: 'Many small purchases', category: null,
      finding: `${small.length} discretionary purchases under ₹500 in 3 months, adding up to ₹${(avg / 100).toFixed(0)} a month.`,
      action: 'Small, frequent spends add up; a weekly budget for them typically trims around a fifth.',
      observedMonthlyPaise: avg, baselineMonthlyPaise: null, estMonthlySavingsPaise: savings, estAnnualSavingsPaise: savings * 12, oneTimePaise: 0,
      confidence: 'low', evidence: own.map((t) => t.key), savingsBasis: own.map((t) => t.key),
    });
  }

  // 8. Discretionary spending growing faster than income (information only — no extra savings claimed).
  const income = (set: Set<string>) => ledger.filter((t) => set.has(monthOf(t.date)) && t.direction === 'credit' && (t.kind === 'income' || t.kind === 'interest')).reduce((s, t) => s + t.amountPaise, 0);
  const incomeNow = income(recent);
  const incomeBefore = income(prior);
  if (priorMonthsWithData >= 2 && incomeBefore > 0) {
    const discNow = sum(recentDebits.filter((t) => DISCRETIONARY.has(t.category)));
    const discBefore = sum(priorDebits.filter((t) => DISCRETIONARY.has(t.category)));
    const incomeGrowth = incomeNow / incomeBefore - 1;
    const discGrowth = discBefore > 0 ? discNow / discBefore - 1 : 0;
    if (discBefore > 0 && discGrowth - incomeGrowth > 0.2) {
      insights.push({
        id: 'growth_vs_income', type: 'growing_faster_than_income', title: 'Discretionary spending is outpacing income', category: null,
        finding: `Discretionary spending grew ${Math.round(discGrowth * 100)}% over the last 3 months while income changed ${Math.round(incomeGrowth * 100)}%.`,
        action: 'Set a monthly cap for discretionary categories at your earlier level.',
        observedMonthlyPaise: Math.round(discNow / 3), baselineMonthlyPaise: Math.round(discBefore / 3), estMonthlySavingsPaise: 0, estAnnualSavingsPaise: 0, oneTimePaise: 0,
        confidence: 'medium', evidence: [], savingsBasis: [],
      });
    }
  }

  return insights;
}

export function totalPotentialSavings(insights: readonly Insight[]): { monthlyPaise: number; annualPaise: number; oneTimePaise: number } {
  return insights.reduce(
    (acc, i) => ({ monthlyPaise: acc.monthlyPaise + i.estMonthlySavingsPaise, annualPaise: acc.annualPaise + i.estAnnualSavingsPaise, oneTimePaise: acc.oneTimePaise + i.oneTimePaise }),
    { monthlyPaise: 0, annualPaise: 0, oneTimePaise: 0 },
  );
}
