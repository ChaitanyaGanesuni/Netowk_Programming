import {
  allocation,
  assetClassFor,
  buildLedger,
  computeNetWorth,
  concentration,
  DEFAULT_SCENARIOS,
  detectRecurring,
  DISCRETIONARY,
  emergencyReserveMonths,
  fundPerformance,
  generateInsights,
  monthRange,
  reconcileBalances,
  scenarioImpact,
  signedAmount,
  summarizeMonth,
  totalPotentialSavings,
  valueInPaise,
  xirr,
  type AllocationSlice,
  type BalanceGap,
  type BalanceSnapshot,
  type CardInput,
  type Category,
  type Facts,
  type Holding,
  type Insight,
  type LedgerTxn,
  type MonthSummary,
  type NetWorth,
  type RawTxn,
  type RecurringPayment,
  type TxnKind,
  type UserRule,
} from '@fi/core';
import { getDatabase } from './database';

/** Today's month in India. */
export const currentMonth = (now = Date.now()) => new Date(now + 5.5 * 3_600_000).toISOString().slice(0, 7);
const todayIst = (now = Date.now()) => new Date(now + 5.5 * 3_600_000).toISOString().slice(0, 10);

export async function loadLedger(): Promise<LedgerTxn[]> {
  const db = await getDatabase();
  const rows = await db.getAllAsync<{
    key: string; account_key: string; instrument: 'account' | 'card'; date: string; at: number; direction: 'debit' | 'credit';
    amount_paise: number; channel: RawTxn['channel']; counterparty: string | null; description: string; reference: string | null;
    status: 'pending' | 'posted'; confidence: number;
  }>('SELECT * FROM raw_transactions ORDER BY date, at');
  const raw: RawTxn[] = rows.map((r) => ({
    key: r.key, accountKey: r.account_key, instrument: r.instrument, date: r.date, at: r.at, direction: r.direction, amountPaise: r.amount_paise,
    channel: r.channel, counterparty: r.counterparty, description: r.description, reference: r.reference, status: r.status, confidence: r.confidence,
  }));
  const rules = await db.getAllAsync<{ pattern: string; category: Category; kind: TxnKind | null }>('SELECT pattern, category, kind FROM category_rules');
  return buildLedger(raw, rules.map((r): UserRule => ({ pattern: r.pattern, category: r.category, kind: r.kind })));
}

/** Learns your correction: future transactions with this counterparty get the category. */
export async function saveCategoryRule(counterparty: string, category: Category, kind: TxnKind | null): Promise<void> {
  const db = await getDatabase();
  await db.runAsync('INSERT OR REPLACE INTO category_rules (pattern, category, kind, created_at) VALUES (?, ?, ?, ?)', counterparty.toLowerCase().trim(), category, kind, Date.now());
}

export async function deleteCategoryRule(pattern: string): Promise<void> {
  const db = await getDatabase();
  await db.runAsync('DELETE FROM category_rules WHERE pattern = ?', pattern);
}

export interface AccountRow {
  key: string;
  institution_id: string;
  instrument: 'account' | 'card';
  suffix: string | null;
  label: string;
}

export interface PortfolioView {
  valuePaise: number;
  investedPaise: number | null;
  unrealizedGainPaise: number | null;
  realizedGainPaise: number;
  xirr: number | null;
  costIncomplete: boolean;
  allocation: AllocationSlice[];
  concentration: ReturnType<typeof concentration>;
  scenarios: Array<{ name: string; impactPaise: number }>;
  holdings: Array<Holding & { xirr: number | null; gainPaise: number | null; costIncomplete: boolean }>;
}

export interface FinanceState {
  ledger: LedgerTxn[];
  accounts: AccountRow[];
  months: MonthSummary[];
  thisMonth: MonthSummary;
  recurring: RecurringPayment[];
  insights: Insight[];
  potentialSavings: ReturnType<typeof totalPotentialSavings>;
  netWorth: NetWorth;
  netWorthHistory: Array<{ date: string; netWorthPaise: number }>;
  portfolio: PortfolioView;
  balanceGaps: BalanceGap[];
  upcomingDues: Array<{ label: string; dueDate: string; totalDuePaise: number | null; minDuePaise: number | null }>;
  emergencyReserveMonths: number | null;
}

async function loadPortfolio(db: Awaited<ReturnType<typeof getDatabase>>, cashPaise: number): Promise<{ view: PortfolioView; mfInputs: Parameters<typeof computeNetWorth>[0]['mutualFunds']; demat: Parameters<typeof computeNetWorth>[0]['demat'] }> {
  const schemes = await db.getAllAsync<{ key: string; scheme: string; isin: string | null }>('SELECT key, scheme, isin FROM mf_schemes');
  const mfInputs: Parameters<typeof computeNetWorth>[0]['mutualFunds'] = [];
  const holdings: PortfolioView['holdings'] = [];
  const allFlows: Array<{ date: string; amountPaise: number }> = [];
  let realized = 0;
  let invested = 0;
  let costIncomplete = false;
  for (const s of schemes) {
    const snap = await db.getFirstAsync<{ units_micro: number; as_of: string; value_paise: number | null }>(
      'SELECT units_micro, as_of, value_paise FROM units_snapshots WHERE scheme_key = ? ORDER BY as_of DESC LIMIT 1', s.key,
    );
    if (!snap || snap.units_micro === 0) continue;
    const nav = s.isin
      ? await db.getFirstAsync<{ nav_scaled: number; nav_date: string; category: string | null }>(
          'SELECT nav_scaled, nav_date, category FROM nav_quotes WHERE isin_growth = ? OR isin_reinvest = ? ORDER BY nav_date DESC LIMIT 1', s.isin, s.isin,
        )
      : null;
    mfInputs.push({ schemeKey: s.key, scheme: s.scheme, isin: s.isin, unitsMicro: snap.units_micro, unitsAsOf: snap.as_of, navMicro: nav?.nav_scaled ?? null, navDate: nav?.nav_date ?? null, statementValuePaise: snap.value_paise });
    const value = nav ? valueInPaise(snap.units_micro, nav.nav_scaled) : (snap.value_paise ?? 0);
    const txns = await db.getAllAsync<{ date: string; type: string; amount_paise: number | null; units_micro: number | null }>(
      'SELECT date, type, amount_paise, units_micro FROM mf_transactions WHERE scheme_key = ? ORDER BY date', s.key,
    );
    const fundTxns = txns.map((t) => ({ date: t.date, type: t.type, amountPaise: t.amount_paise, unitsMicro: t.units_micro }));
    const perf = fundPerformance(fundTxns);
    const portfolioPerf = fundPerformance(fundTxns, true);
    // The FIFO history must explain the statement's units; otherwise cost is incomplete.
    const incomplete = perf.costIncomplete || perf.unitsMicro !== snap.units_micro;
    const asOf = nav?.nav_date ?? snap.as_of;
    holdings.push({
      id: s.key,
      name: s.scheme,
      assetClass: assetClassFor(nav?.category ?? null, s.scheme),
      valuePaise: value,
      investedPaise: incomplete ? null : perf.investedPaise,
      realizedGainPaise: perf.realizedGainPaise,
      xirr: incomplete ? null : xirr([...perf.flows, { date: asOf, amountPaise: value }]),
      gainPaise: incomplete ? null : value - perf.investedPaise + perf.realizedGainPaise,
      costIncomplete: incomplete,
    });
    realized += perf.realizedGainPaise;
    if (incomplete) costIncomplete = true;
    else invested += perf.investedPaise;
    allFlows.push(...portfolioPerf.flows, { date: asOf, amountPaise: value });
  }

  const dematRows = await db.getAllAsync<{ key: string; account_key: string; isin: string; name: string | null; kind: 'equity' | 'mutual_fund'; value_paise: number | null; as_of: string }>(
    `SELECT h.key, h.account_key, h.isin, h.name, h.kind, h.value_paise, h.as_of FROM demat_holdings h
     WHERE h.as_of = (SELECT MAX(as_of) FROM demat_holdings h2 WHERE h2.account_key = h.account_key)`,
  );
  const rtaIsins = new Set(schemes.map((s) => s.isin));
  const demat = dematRows.map((d) => ({ key: d.key, name: d.name ?? d.isin, isin: d.isin, kind: d.kind, fromFolioAccount: d.account_key.endsWith('MF_FOLIOS'), valuePaise: d.value_paise, asOf: d.as_of }));
  for (const d of demat) {
    if (d.valuePaise === null || (d.kind === 'mutual_fund' && (d.fromFolioAccount || rtaIsins.has(d.isin)))) continue;
    holdings.push({ id: d.key, name: d.name, assetClass: d.kind === 'equity' ? 'equity' : assetClassFor(null, d.name), valuePaise: d.valuePaise, investedPaise: null, realizedGainPaise: 0, xirr: null, gainPaise: null, costIncomplete: true });
  }

  const investedHoldings = holdings;
  const cash: Holding = { id: 'cash', name: 'Bank balances', assetClass: 'cash', valuePaise: Math.max(0, cashPaise), investedPaise: null, realizedGainPaise: 0 };
  const slices = allocation([...investedHoldings, cash].filter((h) => h.valuePaise > 0));
  const value = investedHoldings.reduce((s, h) => s + h.valuePaise, 0);
  const view: PortfolioView = {
    valuePaise: value,
    investedPaise: costIncomplete ? null : invested,
    unrealizedGainPaise: costIncomplete ? null : investedHoldings.reduce((s, h) => s + h.valuePaise, 0) - invested,
    realizedGainPaise: realized,
    xirr: costIncomplete ? null : xirr(allFlows),
    costIncomplete: costIncomplete || holdings.some((h) => h.costIncomplete),
    allocation: slices,
    concentration: concentration(investedHoldings),
    scenarios: DEFAULT_SCENARIOS.map((sc) => ({ name: sc.name, impactPaise: scenarioImpact(slices, sc) })),
    holdings: investedHoldings.sort((a, b) => b.valuePaise - a.valuePaise),
  };
  return { view, mfInputs, demat };
}

/** Runs every engine over the local data. Pure computation; nothing leaves the device. */
export async function loadFinanceState(now = Date.now()): Promise<FinanceState> {
  const db = await getDatabase();
  const ledger = await loadLedger();
  const accounts = await db.getAllAsync<AccountRow>('SELECT key, institution_id, instrument, suffix, label FROM accounts ORDER BY label');
  const ym = currentMonth(now);
  const months = monthRange(ym, 12).map((m) => summarizeMonth(ledger, m));
  const recurring = detectRecurring(ledger);
  const insights = generateInsights(ledger, recurring, ym);

  const snapshotsRows = await db.getAllAsync<{ account_key: string; at: number; date: string; balance_paise: number; source: string }>('SELECT account_key, at, date, balance_paise, source FROM balance_snapshots ORDER BY at');
  const bankSnapshots: BalanceSnapshot[] = snapshotsRows
    .filter((r) => r.source === 'alert' || r.source === 'bank_statement')
    .map((r) => ({ accountKey: r.account_key, at: r.at, date: r.date, balancePaise: r.balance_paise, source: r.source as BalanceSnapshot['source'] }));
  const latestBank = new Map<string, BalanceSnapshot>();
  for (const s of bankSnapshots) latestBank.set(s.accountKey, s);
  const label = (key: string) => accounts.find((a) => a.key === key)?.label ?? key;

  const cards: CardInput[] = [];
  const upcomingDues: FinanceState['upcomingDues'] = [];
  for (const card of accounts.filter((a) => a.instrument === 'card')) {
    const st = await db.getFirstAsync<{ statement_date: string; due_date: string | null; total_due_paise: number | null; min_due_paise: number | null; credit_limit_paise: number | null }>(
      'SELECT statement_date, due_date, total_due_paise, min_due_paise, credit_limit_paise FROM card_statements WHERE account_key = ? ORDER BY statement_date DESC LIMIT 1', card.key,
    );
    const after = (t: LedgerTxn) => t.accountKey === card.key && (!st || t.date > st.statement_date);
    const limit = [...snapshotsRows].reverse().find((r) => r.account_key === card.key && r.source === 'card_available_limit');
    cards.push({
      accountKey: card.key,
      label: card.label,
      statement: st && st.total_due_paise !== null ? { date: st.statement_date, totalDuePaise: st.total_due_paise, creditLimitPaise: st.credit_limit_paise } : null,
      spendsSinceStatementPaise: ledger.filter((t) => after(t) && t.direction === 'debit').reduce((s, t) => s + t.amountPaise, 0),
      paymentsSinceStatementPaise: ledger.filter((t) => after(t) && t.direction === 'credit').reduce((s, t) => s + t.amountPaise, 0),
      availableLimitPaise: limit?.balance_paise ?? null,
      availableLimitAsOf: limit?.date ?? null,
    });
    if (st?.due_date && st.due_date >= todayIst(now)) upcomingDues.push({ label: card.label, dueDate: st.due_date, totalDuePaise: st.total_due_paise, minDuePaise: st.min_due_paise });
  }

  const bankPaise = [...latestBank.values()].reduce((s, b) => s + b.balancePaise, 0);
  const { view: portfolio, mfInputs, demat } = await loadPortfolio(db, bankPaise);
  const netWorth = computeNetWorth(
    {
      banks: [...latestBank.values()].map((b) => ({ accountKey: b.accountKey, label: label(b.accountKey), balancePaise: b.balancePaise, asOf: b.date, source: b.source === 'bank_statement' ? 'bank_statement' : 'alert' })),
      cards,
      mutualFunds: mfInputs,
      demat,
    },
    now,
  );

  const history = await db.getAllAsync<{ date: string; net_worth_paise: number }>('SELECT date, net_worth_paise FROM networth_snapshots ORDER BY date');
  const rawForGaps: RawTxn[] = ledger;
  const recentSpend = months.slice(-4, -1).filter((m) => m.transactionCount > 0);
  const avgSpend = recentSpend.length ? Math.round(recentSpend.reduce((s, m) => s + m.expensePaise, 0) / recentSpend.length) : 0;
  return {
    ledger,
    accounts,
    months,
    thisMonth: months[months.length - 1]!,
    recurring,
    insights,
    potentialSavings: totalPotentialSavings(insights),
    netWorth,
    netWorthHistory: history.map((h) => ({ date: h.date, netWorthPaise: h.net_worth_paise })),
    portfolio,
    balanceGaps: reconcileBalances(bankSnapshots, rawForGaps),
    upcomingDues: upcomingDues.sort((a, b) => a.dueDate.localeCompare(b.dueDate)),
    emergencyReserveMonths: emergencyReserveMonths(bankPaise, avgSpend),
  };
}

/** Records today's net worth (one row per day) for the history chart. */
export async function recordNetWorthSnapshot(state: FinanceState, now = Date.now()): Promise<void> {
  if (!state.netWorth.items.length) return;
  const db = await getDatabase();
  await db.runAsync(
    'INSERT OR REPLACE INTO networth_snapshots (date, net_worth_paise, assets_paise, liabilities_paise, created_at) VALUES (?, ?, ?, ?, ?)',
    todayIst(now), state.netWorth.netWorthPaise, state.netWorth.assetsPaise, state.netWorth.liabilitiesPaise, now,
  );
}

/** Verified facts for the assistant, assembled from the engines. */
export function buildFacts(state: FinanceState, now = Date.now()): Facts {
  const ym = currentMonth(now);
  const largest = state.ledger
    .filter((t) => t.date.startsWith(ym) && t.direction === 'debit' && DISCRETIONARY.has(t.category) && t.kind === 'expense')
    .sort((a, b) => b.amountPaise - a.amountPaise)
    .slice(0, 5)
    .map((t) => ({ label: t.counterparty ?? t.category, category: t.category, amountPaise: t.amountPaise, date: t.date }));
  const yearAgo = new Date(now - 365 * 86_400_000).toISOString().slice(0, 10);
  const then = [...state.netWorthHistory].reverse().find((h) => h.date <= yearAgo) ?? null;
  const gaps: string[] = [];
  for (const item of state.netWorth.items) if (item.freshness === 'stale') gaps.push(`${item.label} data is stale (as of ${item.asOf}).`);
  gaps.push(...state.netWorth.notes);
  if (state.balanceGaps.length) gaps.push(`${state.balanceGaps.length} balance gap(s) suggest transactions without email alerts.`);
  return {
    asOf: todayIst(now),
    month: state.thisMonth.transactionCount ? state.thisMonth : null,
    previousMonths: state.months.slice(0, -1),
    largestDiscretionary: largest,
    insights: state.insights,
    potentialSavings: state.potentialSavings,
    netWorth: state.netWorth.items.length ? { nowPaise: state.netWorth.netWorthPaise, asOf: todayIst(now), assetsPaise: state.netWorth.assetsPaise, liabilitiesPaise: state.netWorth.liabilitiesPaise } : null,
    netWorthYearAgo: then ? { valuePaise: then.netWorthPaise, date: then.date } : null,
    portfolio: state.portfolio.valuePaise
      ? {
          valuePaise: state.portfolio.valuePaise,
          investedPaise: state.portfolio.investedPaise,
          xirr: state.portfolio.xirr,
          allocation: state.portfolio.allocation,
          topContributors: state.portfolio.holdings.filter((h) => h.gainPaise !== null).sort((a, b) => (b.gainPaise ?? 0) - (a.gainPaise ?? 0)).slice(0, 5).map((h) => ({ name: h.name, gainPaise: h.gainPaise ?? 0 })),
          costIncomplete: state.portfolio.costIncomplete,
        }
      : null,
    emergencyReserveMonths: state.emergencyReserveMonths,
    cardOutstandingPaise: state.netWorth.cardOutstandingPaise,
    concentrationLargestShare: state.portfolio.concentration.largest?.share ?? null,
    dataGaps: gaps,
  };
}

export const ledgerNet = (ledger: readonly LedgerTxn[]) => ledger.reduce((s, t) => s + signedAmount(t), 0);
