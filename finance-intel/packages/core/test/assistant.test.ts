import { describe, expect, it } from 'vitest';
import { acceptLlmAnswer, answer, buildLlmMessages, detectIntent, ledgerToCsv, LLM_EXCLUDED_INTENTS, monthlyReport, redactForLlm, type Facts } from '../src/assistant';
import type { MonthSummary } from '../src/analytics';

const month = (m: string, expense: number, income = 10000000): MonthSummary => ({
  month: m, incomePaise: income, expensePaise: expense, loanRepaymentPaise: 0, netInvestedPaise: 500000,
  netCashFlowPaise: income - expense, savingsRate: Number(((income - expense) / income).toFixed(4)),
  byCategory: { rent: 4000000, food_delivery: 600000, shopping: expense - 4600000 }, pendingPaise: 0, transactionCount: 20,
});

const facts: Facts = {
  asOf: '2026-10-11',
  month: month('2026-10', 9000000),
  previousMonths: [month('2026-07', 6000000), month('2026-08', 6500000), month('2026-09', 7000000)],
  largestDiscretionary: [{ label: 'CROMA', category: 'shopping', amountPaise: 1499900, date: '2026-10-03' }],
  insights: [
    {
      id: 'late_fees', type: 'late_fees', title: 'Late payment fees', finding: '', action: '', category: 'late_fees', observedMonthlyPaise: 59000,
      baselineMonthlyPaise: null, estMonthlySavingsPaise: 59000, estAnnualSavingsPaise: 708000, oneTimePaise: 0, confidence: 'high', evidence: [], savingsBasis: [],
    },
  ],
  potentialSavings: { monthlyPaise: 59000, annualPaise: 708000, oneTimePaise: 0 },
  netWorth: { nowPaise: 250000000, asOf: '2026-10-11', assetsPaise: 260000000, liabilitiesPaise: 10000000 },
  netWorthYearAgo: null,
  portfolio: { valuePaise: 180000000, investedPaise: 150000000, xirr: 0.1234, allocation: [{ assetClass: 'equity', valuePaise: 180000000, share: 1 }], topContributors: [{ name: 'HDFC Flexi Cap', gainPaise: 20000000 }], costIncomplete: false },
  emergencyReserveMonths: 1.5,
  cardOutstandingPaise: 10000000,
  concentrationLargestShare: 0.55,
  dataGaps: [],
};

describe('intent detection', () => {
  it.each([
    ['Where did my money go this month?', 'where_money_went'],
    ['What are my largest discretionary expenses?', 'largest_discretionary'],
    ['How much could I save by reducing avoidable spending?', 'savings_potential'],
    ['What is my current net worth?', 'net_worth_now'],
    ['How has my net worth changed over the past year?', 'net_worth_change'],
    ['What is my portfolio worth today?', 'portfolio_value'],
    ['Which holdings contributed most to my gains?', 'top_contributors'],
    ['What is my current asset allocation?', 'asset_allocation'],
    ['Am I spending more than usual?', 'spending_vs_usual'],
    ['What should I prioritize to improve my financial position?', 'priorities'],
  ])('%s → %s', (q, intent) => {
    expect(detectIntent(q)).toBe(intent);
  });
});

describe('deterministic answers', () => {
  it('answers from facts with references and explicit uncertainty', () => {
    const a = answer('spending_vs_usual', facts);
    expect(a.text).toContain('₹90,000.00');
    expect(a.text).toContain('more than usual');
    expect(a.text).toContain('₹65,000.00');
    expect(a.uncertainty).toContain('The current month may be incomplete.');
    expect(a.source).toBe('calculation');
  });

  it('is honest when history is missing', () => {
    const a = answer('net_worth_change', facts);
    expect(a.text).toContain('no snapshot from a year ago');
  });

  it('prioritises late fees, reserves and concentration', () => {
    const a = answer('priorities', facts);
    expect(a.text.split('\n')[0]).toContain('autopay');
    expect(a.text).toContain('1.5 months');
    expect(a.text).toContain('55.0%');
  });
});

describe('LLM guard', () => {
  const base = answer('portfolio_value', facts);

  it('sends only the computed answer and facts', () => {
    const payload = buildLlmMessages('What is my portfolio worth?', base)[1]!.content;
    expect(payload).toContain('₹18,00,000.00');
    expect(payload).not.toContain('CROMA');
  });

  it('keeps account numbers, e-mails and gap notes on the phone', () => {
    const withGap = { ...base, uncertainty: ['HDFC Bank ••1234 data is stale (as of 2026-09-01).'], text: `${base.text} Card XX5678 and a/c no. 50100012345678, mail me@example.com.` };
    const payload = buildLlmMessages('Is my card ending 4321 fine?', withGap)[1]!.content;
    for (const leaked of ['1234', '5678', '50100012345678', '4321', 'me@example.com', 'stale']) expect(payload).not.toContain(leaked);
    expect(payload).toContain('₹18,00,000.00');
    expect(redactForLlm('Spent ₹1,23,456.00 on 2026-10-01')).toBe('Spent ₹1,23,456.00 on 2026-10-01');
    expect(LLM_EXCLUDED_INTENTS.has('largest_discretionary')).toBe(true);
  });

  it('accepts a rephrasing that uses only verified figures', () => {
    const ok = acceptLlmAnswer(JSON.stringify({ answer: 'Your investments total ₹18,00,000.00, up from ₹15,00,000.00 invested.', citedFactIds: ['pv', 'inv'], uncertainty: [] }), base);
    expect(ok?.source).toBe('ai_rephrased');
  });

  it('rejects invented numbers, unknown citations and malformed output', () => {
    expect(acceptLlmAnswer(JSON.stringify({ answer: 'You will have ₹25,00,000 next year.', citedFactIds: ['pv'], uncertainty: [] }), base)).toBeNull();
    expect(acceptLlmAnswer(JSON.stringify({ answer: 'Fine.', citedFactIds: ['made_up'], uncertainty: [] }), base)).toBeNull();
    expect(acceptLlmAnswer('not json', base)).toBeNull();
  });
});

describe('reports', () => {
  it('builds a monthly report and CSV without floating-point amounts', () => {
    const text = monthlyReport(facts.month!, facts.previousMonths[2]!, facts.insights, 250000000);
    expect(text).toContain('Savings rate: 10.0%');
    expect(text).toContain('Net worth: ₹25,00,000.00');
    const csv = ledgerToCsv([
      { key: 'k', accountKey: 'a', instrument: 'account', date: '2026-10-01', at: 0, direction: 'debit', amountPaise: 1005, channel: 'UPI', counterparty: 'Shop, "A"', description: '', reference: null, status: 'posted', confidence: 1, kind: 'expense', category: 'shopping', categorySource: 'rule', pairedWith: null },
    ]);
    expect(csv.split('\n')[1]).toBe('2026-10-01,a,debit,10.05,expense,shopping,UPI,"Shop, ""A""",posted,');
  });
});
