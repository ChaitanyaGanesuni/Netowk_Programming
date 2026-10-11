/**
 * Portfolio analytics. Rupee totals are exact integers (paise); XIRR is a rate and is solved
 * numerically, which is the only place floating point is used.
 */

export interface CashFlow {
  date: string;
  /** Money out of your pocket is negative, money back to you (or current value) positive. */
  amountPaise: number;
}

const DAY = 86_400_000;

/** XIRR (annualised internal rate of return) for dated cash flows; null if undefined. */
export function xirr(flows: readonly CashFlow[]): number | null {
  const valid = flows.filter((f) => f.amountPaise !== 0);
  if (!valid.some((f) => f.amountPaise < 0) || !valid.some((f) => f.amountPaise > 0)) return null;
  const t0 = Math.min(...valid.map((f) => Date.parse(`${f.date}T00:00:00Z`)));
  const points = valid.map((f) => ({ years: (Date.parse(`${f.date}T00:00:00Z`) - t0) / (365 * DAY), amount: f.amountPaise / 100 }));
  if (Math.max(...points.map((p) => p.years)) < 1 / 365) return null;
  const npv = (r: number) => points.reduce((s, p) => s + p.amount / (1 + r) ** p.years, 0);
  const dnpv = (r: number) => points.reduce((s, p) => s - (p.years * p.amount) / (1 + r) ** (p.years + 1), 0);

  let rate = 0.1;
  for (let i = 0; i < 50; i++) {
    const value = npv(rate);
    const derivative = dnpv(rate);
    if (!Number.isFinite(value) || !Number.isFinite(derivative) || derivative === 0) break;
    const next = rate - value / derivative;
    if (next <= -0.9999 || !Number.isFinite(next)) break;
    if (Math.abs(next - rate) < 1e-9) return next;
    rate = next;
  }
  // Fall back to bisection on a wide bracket.
  let lo = -0.9999;
  let hi = 10;
  let fLo = npv(lo);
  if (fLo * npv(hi) > 0) return null;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const fMid = npv(mid);
    if (Math.abs(fMid) < 1e-7 || hi - lo < 1e-10) return mid;
    if (fLo * fMid < 0) hi = mid;
    else {
      lo = mid;
      fLo = fMid;
    }
  }
  return (lo + hi) / 2;
}

// ---------------------------------------------------------------- FIFO gains from CAS transactions

export interface FundTxn {
  date: string;
  type: string; // casparser transaction types
  amountPaise: number | null;
  unitsMicro: number | null;
}

export interface FundPerformance {
  /** Units still held according to the imported transactions. */
  unitsMicro: number;
  /** Cost of the units still held (FIFO). */
  investedPaise: number;
  realizedGainPaise: number;
  /** Cash flows for XIRR, excluding the terminal value. */
  flows: CashFlow[];
  /** True when units were sold that were never bought in the imported history. */
  costIncomplete: boolean;
}

const BUY_TYPES = new Set(['PURCHASE', 'PURCHASE_SIP', 'SWITCH_IN', 'SWITCH_IN_MERGER', 'DIVIDEND_REINVEST', 'GIFT_IN', 'SEGREGATION']);
const SELL_TYPES = new Set(['REDEMPTION', 'SWITCH_OUT', 'SWITCH_OUT_MERGER', 'GIFT_OUT']);
const TAX_TYPES = new Set(['STT_TAX', 'STAMP_DUTY_TAX', 'TDS_TAX']);
/** Movements that are not cash in or out of your pocket for a portfolio-level XIRR. */
const INTERNAL_TYPES = new Set(['DIVIDEND_REINVEST', 'SWITCH_IN', 'SWITCH_IN_MERGER', 'SWITCH_OUT', 'SWITCH_OUT_MERGER', 'SEGREGATION']);

const mulDiv = (a: number, b: number, c: number) => Number((BigInt(a) * BigInt(b)) / BigInt(c));

/**
 * FIFO cost basis and realised gains for one scheme. `portfolioLevel` drops internal
 * movements (switches, reinvested dividends) from the cash flows, as they are not money
 * entering or leaving your pocket.
 */
export function fundPerformance(txns: readonly FundTxn[], portfolioLevel = false): FundPerformance {
  const lots: Array<{ units: number; cost: number }> = [];
  let realized = 0;
  let costIncomplete = false;
  const flows: CashFlow[] = [];
  const sorted = [...txns].sort((a, b) => a.date.localeCompare(b.date));
  for (const t of sorted) {
    const amount = t.amountPaise ?? 0;
    if (TAX_TYPES.has(t.type)) {
      if (amount) flows.push({ date: t.date, amountPaise: -Math.abs(amount) });
      continue;
    }
    if (t.type === 'DIVIDEND_PAYOUT') {
      if (amount) flows.push({ date: t.date, amountPaise: Math.abs(amount) });
      realized += Math.abs(amount);
      continue;
    }
    const units = t.unitsMicro ?? 0;
    if (BUY_TYPES.has(t.type) && units > 0) {
      lots.push({ units, cost: Math.abs(amount) });
      if (!(portfolioLevel && INTERNAL_TYPES.has(t.type)) && t.type !== 'DIVIDEND_REINVEST') flows.push({ date: t.date, amountPaise: -Math.abs(amount) });
    } else if (SELL_TYPES.has(t.type) || units < 0) {
      let toSell = Math.abs(units);
      let costOfSold = 0;
      while (toSell > 0 && lots.length) {
        const lot = lots[0]!;
        const take = Math.min(lot.units, toSell);
        const lotCost = mulDiv(lot.cost, take, lot.units);
        costOfSold += lotCost;
        lot.units -= take;
        lot.cost -= lotCost;
        toSell -= take;
        if (lot.units === 0) lots.shift();
      }
      if (toSell > 0) costIncomplete = true;
      const proceeds = Math.abs(amount);
      if (!costIncomplete) realized += proceeds - costOfSold;
      if (!(portfolioLevel && INTERNAL_TYPES.has(t.type))) flows.push({ date: t.date, amountPaise: proceeds });
    }
  }
  return {
    unitsMicro: lots.reduce((s, l) => s + l.units, 0),
    investedPaise: lots.reduce((s, l) => s + l.cost, 0),
    realizedGainPaise: realized,
    flows,
    costIncomplete,
  };
}

// ---------------------------------------------------------------- allocation & risk

export type AssetClass = 'equity' | 'debt' | 'hybrid' | 'gold' | 'silver' | 'international_equity' | 'cash' | 'other';

/** Asset class from the AMFI SEBI category heading and the scheme name. */
export function assetClassFor(category: string | null, name: string): AssetClass {
  const n = name.toLowerCase();
  const c = (category ?? '').toLowerCase();
  if (/\bgold\b/.test(n)) return 'gold';
  if (/\bsilver\b/.test(n)) return 'silver';
  if (/overseas|international|global|nasdaq|s&p 500|us equity|feeder/.test(`${c} ${n}`)) return 'international_equity';
  if (c.startsWith('equity scheme') || c.includes('elss')) return 'equity';
  if (c.startsWith('debt scheme')) return 'debt';
  if (c.startsWith('hybrid scheme') || c.startsWith('solution oriented')) return 'hybrid';
  if (/nifty|sensex|equity|bees\b|midcap|smallcap|large ?cap/.test(n)) return 'equity';
  if (/gilt|bond|sdl|g-?sec|liquid|overnight|debt|money market|treasury/.test(n)) return 'debt';
  return 'other';
}

export interface Holding {
  id: string;
  name: string;
  assetClass: AssetClass;
  valuePaise: number;
  investedPaise: number | null;
  realizedGainPaise: number;
}

export interface AllocationSlice {
  assetClass: AssetClass;
  valuePaise: number;
  share: number;
}

export function allocation(holdings: readonly Holding[]): AllocationSlice[] {
  const total = holdings.reduce((s, h) => s + h.valuePaise, 0);
  const by = new Map<AssetClass, number>();
  for (const h of holdings) by.set(h.assetClass, (by.get(h.assetClass) ?? 0) + h.valuePaise);
  return [...by]
    .map(([assetClass, valuePaise]) => ({ assetClass, valuePaise, share: total ? Number((valuePaise / total).toFixed(4)) : 0 }))
    .sort((a, b) => b.valuePaise - a.valuePaise);
}

export interface Concentration {
  largest: { name: string; share: number } | null;
  top5Share: number;
  /** Herfindahl–Hirschman index (0–1); above 0.25 is concentrated. */
  hhi: number;
}

export function concentration(holdings: readonly Holding[]): Concentration {
  const total = holdings.reduce((s, h) => s + h.valuePaise, 0);
  if (!total) return { largest: null, top5Share: 0, hhi: 0 };
  const sorted = [...holdings].sort((a, b) => b.valuePaise - a.valuePaise);
  const shares = sorted.map((h) => h.valuePaise / total);
  return {
    largest: { name: sorted[0]!.name, share: Number(shares[0]!.toFixed(4)) },
    top5Share: Number(shares.slice(0, 5).reduce((s, x) => s + x, 0).toFixed(4)),
    hhi: Number(shares.reduce((s, x) => s + x * x, 0).toFixed(4)),
  };
}

/** Months of average spending covered by liquid bank balances. */
export function emergencyReserveMonths(liquidPaise: number, avgMonthlyExpensePaise: number): number | null {
  return avgMonthlyExpensePaise > 0 ? Number((liquidPaise / avgMonthlyExpensePaise).toFixed(1)) : null;
}

export interface Scenario {
  name: string;
  shocks: Partial<Record<AssetClass, number>>;
}

/** Hypothetical shocks — illustrations, not forecasts. */
export const DEFAULT_SCENARIOS: readonly Scenario[] = [
  { name: 'Equity correction (−20%)', shocks: { equity: -0.2, international_equity: -0.2, hybrid: -0.1 } },
  { name: 'Severe equity crash (−35%)', shocks: { equity: -0.35, international_equity: -0.3, hybrid: -0.18, debt: -0.02 } },
  { name: 'Rate shock (debt −4%, gold +5%)', shocks: { debt: -0.04, hybrid: -0.03, gold: 0.05 } },
  { name: 'Gold & silver fall (−15%)', shocks: { gold: -0.15, silver: -0.2 } },
];

export function scenarioImpact(slices: readonly AllocationSlice[], scenario: Scenario): number {
  return slices.reduce((s, x) => s + Math.round(x.valuePaise * (scenario.shocks[x.assetClass] ?? 0)), 0);
}

/** Drift of current shares from your target shares (only when you have set targets). */
export function allocationDrift(slices: readonly AllocationSlice[], targets: Partial<Record<AssetClass, number>>): Array<{ assetClass: AssetClass; current: number; target: number; drift: number }> {
  return (Object.entries(targets) as Array<[AssetClass, number]>).map(([assetClass, target]) => {
    const current = slices.find((s) => s.assetClass === assetClass)?.share ?? 0;
    return { assetClass, current, target, drift: Number((current - target).toFixed(4)) };
  });
}

/** What the app cannot compute from free, authorised data — shown instead of guessing. */
export const UNAVAILABLE_ANALYTICS: ReadonlyArray<{ metric: string; reason: string }> = [
  { metric: 'Benchmark comparison', reason: 'Index levels (Nifty, Sensex) need a licensed data feed; no free authorised source was verified.' },
  { metric: 'Expense ratios (TER)', reason: "AMFI's TER file location could not be verified, so expense ratios are not shown rather than guessed." },
  { metric: 'Fund overlap', reason: 'Requires each fund’s monthly portfolio disclosure; per-AMC parsers are not built yet.' },
];
