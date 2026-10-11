import { z } from 'zod';
import type { Insight, MonthSummary } from '../analytics';
import type { Category } from '../ledger/ledger';
import { formatPaise } from '../money';
import type { AllocationSlice } from '../portfolio';

/**
 * Financial assistant. Every number comes from the deterministic engines; the assistant only
 * selects and phrases verified facts. An optional LLM may rephrase, but its output is checked
 * against the same facts and discarded if it introduces any figure that is not among them.
 */

export type Intent =
  | 'where_money_went'
  | 'largest_discretionary'
  | 'savings_potential'
  | 'net_worth_now'
  | 'net_worth_change'
  | 'portfolio_value'
  | 'top_contributors'
  | 'asset_allocation'
  | 'spending_vs_usual'
  | 'priorities';

export interface Facts {
  asOf: string;
  month: MonthSummary | null;
  /** Earlier months, oldest first (for "usual" comparisons). */
  previousMonths: MonthSummary[];
  largestDiscretionary: Array<{ label: string; category: Category; amountPaise: number; date: string }>;
  insights: Insight[];
  potentialSavings: { monthlyPaise: number; annualPaise: number; oneTimePaise: number };
  netWorth: { nowPaise: number; asOf: string; assetsPaise: number; liabilitiesPaise: number } | null;
  netWorthYearAgo: { valuePaise: number; date: string } | null;
  portfolio: {
    valuePaise: number;
    investedPaise: number | null;
    xirr: number | null;
    allocation: AllocationSlice[];
    topContributors: Array<{ name: string; gainPaise: number }>;
    costIncomplete: boolean;
  } | null;
  emergencyReserveMonths: number | null;
  cardOutstandingPaise: number;
  concentrationLargestShare: number | null;
  /** Things the engines could not determine (stale or missing sources). */
  dataGaps: string[];
}

export interface FactRef {
  id: string;
  label: string;
  value: string;
}

export interface AssistantAnswer {
  intent: Intent;
  text: string;
  facts: FactRef[];
  uncertainty: string[];
  source: 'calculation' | 'ai_rephrased';
}

const INTENT_PATTERNS: ReadonlyArray<readonly [Intent, RegExp]> = [
  ['net_worth_change', /net ?worth.*(change|chang|grow|year|last year|over)|how has my net ?worth/i],
  ['net_worth_now', /net ?worth/i],
  ['top_contributors', /contribut|which holdings|best perform|gains? come/i],
  ['asset_allocation', /allocation|asset mix|how (?:is|am) .*invested|split/i],
  ['portfolio_value', /portfolio|investments? worth|mutual funds? worth/i],
  ['largest_discretionary', /largest|biggest|discretionary/i],
  ['savings_potential', /how much could i save|save by|avoidable|waste|cut back/i],
  ['spending_vs_usual', /more than usual|than normal|spending more|overspend/i],
  ['priorities', /prioriti|improve my financial|what should i (?:do|focus)/i],
  ['where_money_went', /where did my money go|spent|spending|expenses?/i],
];

export function detectIntent(question: string): Intent | null {
  return INTENT_PATTERNS.find(([, re]) => re.test(question))?.[0] ?? null;
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const label = (c: string) => c.replace(/_/g, ' ');

function avg(months: readonly MonthSummary[], pick: (m: MonthSummary) => number): number | null {
  const withData = months.filter((m) => m.transactionCount > 0);
  return withData.length ? Math.round(withData.reduce((s, m) => s + pick(m), 0) / withData.length) : null;
}

/** Answers from verified facts only. Always available, no network needed. */
export function answer(intent: Intent, f: Facts): AssistantAnswer {
  const facts: FactRef[] = [];
  const fact = (id: string, labelText: string, value: string) => {
    facts.push({ id, label: labelText, value });
    return value;
  };
  const uncertainty = [...f.dataGaps];
  const done = (text: string): AssistantAnswer => ({ intent, text, facts, uncertainty, source: 'calculation' });

  switch (intent) {
    case 'where_money_went': {
      if (!f.month) return done('There are no transactions for this month yet.');
      const cats = Object.entries(f.month.byCategory).filter(([, v]) => (v ?? 0) > 0).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0)).slice(0, 5);
      const total = fact('spend', `Spending in ${f.month.month}`, formatPaise(f.month.expensePaise));
      const parts = cats.map(([c, v], i) => `${label(c)} ${fact(`cat${i}`, label(c), formatPaise(v ?? 0))}`);
      if (f.month.pendingPaise) uncertainty.push(`${formatPaise(f.month.pendingPaise)} of card spends are not on a statement yet.`);
      return done(`In ${f.month.month} you spent ${total}. The largest categories: ${parts.join(', ')}. Transfers between your accounts, card bill payments and investments are not counted as spending.`);
    }
    case 'largest_discretionary': {
      if (!f.largestDiscretionary.length) return done('No discretionary purchases were found this month.');
      const items = f.largestDiscretionary.slice(0, 5).map((t, i) => `${t.label} (${label(t.category)}, ${t.date}) ${fact(`d${i}`, t.label, formatPaise(t.amountPaise))}`);
      return done(`Your largest discretionary purchases this month: ${items.join('; ')}.`);
    }
    case 'savings_potential': {
      if (!f.insights.length) return done('No avoidable-spending patterns were found in the last 3 months of data.');
      const monthly = fact('save_m', 'Potential monthly savings', formatPaise(f.potentialSavings.monthlyPaise));
      const annual = fact('save_y', 'Potential annual savings', formatPaise(f.potentialSavings.annualPaise));
      const top = [...f.insights].sort((a, b) => b.estMonthlySavingsPaise - a.estMonthlySavingsPaise).slice(0, 3)
        .map((i, k) => `${i.title}: ${fact(`ins${k}`, i.title, formatPaise(i.estMonthlySavingsPaise))}/month`);
      const once = f.potentialSavings.oneTimePaise ? ` Plus ${fact('save_once', 'Possibly recoverable once', formatPaise(f.potentialSavings.oneTimePaise))} in possible duplicate charges to check.` : '';
      uncertainty.push('These are potential savings based on your history, not guaranteed amounts.');
      return done(`Reducing avoidable spending could save about ${monthly} a month (${annual} a year). Biggest opportunities: ${top.join('; ')}.${once}`);
    }
    case 'net_worth_now': {
      if (!f.netWorth) return done('Net worth cannot be computed yet: no balances or holdings have been imported.');
      return done(`Your net worth is ${fact('nw', 'Net worth', formatPaise(f.netWorth.nowPaise))} (assets ${fact('assets', 'Assets', formatPaise(f.netWorth.assetsPaise))}, liabilities ${fact('liab', 'Liabilities', formatPaise(f.netWorth.liabilitiesPaise))}) as of ${f.netWorth.asOf}.`);
    }
    case 'net_worth_change': {
      if (!f.netWorth) return done('Net worth cannot be computed yet.');
      if (!f.netWorthYearAgo) {
        uncertainty.push('Net-worth history starts when the app was first synced, so a one-year comparison is not available yet.');
        return done(`Your net worth is ${fact('nw', 'Net worth', formatPaise(f.netWorth.nowPaise))}; there is no snapshot from a year ago to compare with.`);
      }
      const change = f.netWorth.nowPaise - f.netWorthYearAgo.valuePaise;
      return done(`Your net worth moved from ${fact('nw_then', `Net worth on ${f.netWorthYearAgo.date}`, formatPaise(f.netWorthYearAgo.valuePaise))} to ${fact('nw', 'Net worth', formatPaise(f.netWorth.nowPaise))}, a change of ${fact('nw_delta', 'Change', formatPaise(change))}.`);
    }
    case 'portfolio_value': {
      if (!f.portfolio) return done('No investments have been imported yet.');
      const value = fact('pv', 'Portfolio value', formatPaise(f.portfolio.valuePaise));
      const invested = f.portfolio.investedPaise !== null ? ` against ${fact('inv', 'Invested (cost)', formatPaise(f.portfolio.investedPaise))} invested` : '';
      const ret = f.portfolio.xirr !== null ? `; XIRR ${fact('xirr', 'XIRR', pct(f.portfolio.xirr))}` : '';
      if (f.portfolio.costIncomplete) uncertainty.push('Some purchase history is missing, so cost and XIRR cover only the imported transactions.');
      return done(`Your portfolio is worth ${value}${invested}${ret}.`);
    }
    case 'top_contributors': {
      if (!f.portfolio?.topContributors.length) return done('Gains by holding are not available yet.');
      const items = f.portfolio.topContributors.slice(0, 5).map((c, i) => `${c.name} ${fact(`g${i}`, c.name, formatPaise(c.gainPaise))}`);
      return done(`Largest contributors to your gains (realised + unrealised): ${items.join('; ')}.`);
    }
    case 'asset_allocation': {
      if (!f.portfolio?.allocation.length) return done('No holdings to allocate yet.');
      const items = f.portfolio.allocation.map((s, i) => `${label(s.assetClass)} ${fact(`a${i}`, label(s.assetClass), pct(s.share))}`);
      return done(`Your allocation: ${items.join(', ')}.`);
    }
    case 'spending_vs_usual': {
      if (!f.month) return done('There is no spending data for this month yet.');
      const usual = avg(f.previousMonths.slice(-3), (m) => m.expensePaise);
      if (usual === null) return done(`You have spent ${fact('spend', 'This month', formatPaise(f.month.expensePaise))} so far; there is no earlier month to compare with yet.`);
      const diff = f.month.expensePaise - usual;
      const verdict = diff > usual * 0.1 ? 'more than usual' : diff < -usual * 0.1 ? 'less than usual' : 'about the same as usual';
      uncertainty.push('The current month may be incomplete.');
      return done(`You have spent ${fact('spend', 'This month', formatPaise(f.month.expensePaise))} this month, ${verdict} (your 3-month average is ${fact('usual', '3-month average', formatPaise(usual))}).`);
    }
    case 'priorities': {
      const steps: string[] = [];
      const late = f.insights.find((i) => i.type === 'late_fees');
      if (late) steps.push(`Stop late fees with card autopay (${fact('p_late', 'Late fees per month', formatPaise(late.estMonthlySavingsPaise))}/month).`);
      if (f.emergencyReserveMonths !== null && f.emergencyReserveMonths < 3) steps.push(`Build an emergency reserve: your bank balance covers ${fact('p_res', 'Reserve (months)', String(f.emergencyReserveMonths))} months of spending; 3–6 months is a common target.`);
      const sr = f.month?.savingsRate;
      if (sr !== null && sr !== undefined && sr < 0.2) steps.push(`Raise your savings rate from ${fact('p_sr', 'Savings rate', pct(sr))}, starting with the avoidable spending below.`);
      if (f.potentialSavings.monthlyPaise > 0) steps.push(`Act on spending insights worth about ${fact('p_save', 'Potential monthly savings', formatPaise(f.potentialSavings.monthlyPaise))} a month.`);
      if (f.concentrationLargestShare !== null && f.concentrationLargestShare > 0.4) steps.push(`Your largest holding is ${fact('p_conc', 'Largest holding share', pct(f.concentrationLargestShare))} of your portfolio; consider whether that concentration is intended.`);
      if (!steps.length) steps.push('Nothing urgent stands out in the available data. Keep investing regularly and review again next month.');
      uncertainty.push('Priorities are rule-based suggestions from your data, not financial advice.');
      return done(steps.map((s, i) => `${i + 1}. ${s}`).join('\n'));
    }
  }
}

// ---------------------------------------------------------------- optional LLM rephrasing

export const LlmAnswer = z.object({
  answer: z.string().min(1).max(2000),
  citedFactIds: z.array(z.string()),
  uncertainty: z.array(z.string()).max(5),
});
export type LlmAnswer = z.infer<typeof LlmAnswer>;

/**
 * Builds the prompt for an optional LLM. Only the computed answer, its fact list and gaps are
 * sent — no transactions, merchant names, account numbers or personal identifiers.
 */
/** Intents whose answers are transaction-level (merchant, date, amount) are never sent to an LLM. */
export const LLM_EXCLUDED_INTENTS: ReadonlySet<Intent> = new Set<Intent>(['largest_discretionary']);

const ACCOUNT_NUMBER_RE = /(?:[•*xX]{2,}\s?|\b(?:a\/c|acct|account|card)\s*(?:no\.?|number|ending(?:\s+in)?)?\s*[:#]?\s*)\d{3,}|\b\d{6,}\b/gi;
const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;

/** Masks account/card numbers (incl. last-4 suffixes) and e-mail addresses before text leaves the phone. */
export function redactForLlm(text: string): string {
  return text.replace(EMAIL_RE, '[email]').replace(ACCOUNT_NUMBER_RE, '[account]');
}

/**
 * Builds the LLM request. Sends only the question, the verified answer text and its figures,
 * with account numbers and e-mail addresses masked. Known gaps stay on the phone (they name
 * accounts) and are re-attached to whatever answer is shown.
 */
export function buildLlmMessages(question: string, base: AssistantAnswer): Array<{ role: 'system' | 'user'; content: string }> {
  return [
    {
      role: 'system',
      content:
        'You rewrite a verified financial answer for a person in India in clear, friendly language. Use ONLY the facts provided; ' +
        'do not calculate, estimate or introduce any new number. Do not recommend specific securities or promise returns. ' +
        'Reply as JSON: {"answer": string, "citedFactIds": string[], "uncertainty": string[]}.',
    },
    {
      role: 'user',
      content: JSON.stringify({
        question: redactForLlm(question),
        verifiedAnswer: redactForLlm(base.text),
        facts: base.facts.map((f) => ({ id: f.id, label: redactForLlm(f.label), value: f.value })),
      }),
    },
  ];
}

const MONEY_RE = /(?:₹|rs\.?|inr)\s*-?[\d,]+(?:\.\d+)?/gi;
const normalizeMoney = (s: string) => s.toLowerCase().replace(/rs\.?|inr|₹|\s|,/g, '').replace(/\.00$/, '');

/**
 * Accepts the LLM's reply only if it parses, cites known facts, and every rupee figure it
 * mentions is one of the verified fact values. Otherwise returns null (use the calculation).
 */
export function acceptLlmAnswer(raw: unknown, base: AssistantAnswer): AssistantAnswer | null {
  const parsed = LlmAnswer.safeParse(typeof raw === 'string' ? safeJson(raw) : raw);
  if (!parsed.success) return null;
  const ids = new Set(base.facts.map((f) => f.id));
  if (parsed.data.citedFactIds.some((id) => !ids.has(id))) return null;
  const allowed = new Set(base.facts.map((f) => normalizeMoney(f.value)));
  for (const m of parsed.data.answer.match(MONEY_RE) ?? []) {
    if (!allowed.has(normalizeMoney(m))) return null;
  }
  return { ...base, text: parsed.data.answer, uncertainty: [...new Set([...base.uncertainty, ...parsed.data.uncertainty])], source: 'ai_rephrased' };
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
