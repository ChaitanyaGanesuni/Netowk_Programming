import { describe, expect, it } from 'vitest';
import {
  buildLedger,
  computeNetWorth,
  detectRecurring,
  generateInsights,
  summarizeMonth,
  totalPotentialSavings,
  type LedgerTxn,
  type RawTxn,
} from '../src';

let n = 0;
function raw(p: Partial<RawTxn> & Pick<RawTxn, 'direction' | 'amountPaise' | 'date'>): RawTxn {
  n++;
  return {
    key: `k${n}`, accountKey: 'hdfc:account:1234', instrument: 'account', at: Date.parse(`${p.date}T10:00:00Z`) + n, channel: 'UPI',
    counterparty: null, description: '', reference: null, status: 'posted', confidence: 0.9, ...p,
  };
}

function ledgerFor(raws: RawTxn[]): LedgerTxn[] {
  return buildLedger(raws);
}

describe('summarizeMonth', () => {
  it('excludes transfers, card payments and investments from income and spending; nets refunds', () => {
    const ledger = ledgerFor([
      raw({ date: '2026-09-01', direction: 'credit', amountPaise: 10000000, description: 'SALARY SEP' }),
      raw({ date: '2026-09-02', direction: 'debit', amountPaise: 2000000, counterparty: 'nobroker rent' }),
      raw({ date: '2026-09-05', direction: 'debit', amountPaise: 300000, counterparty: 'amazon' }),
      raw({ date: '2026-09-07', direction: 'credit', amountPaise: 100000, description: 'refund from amazon', instrument: 'card', accountKey: 'hsbc:card:7788' }),
      raw({ date: '2026-09-10', direction: 'debit', amountPaise: 500000, counterparty: 'BSE STAR MF' }),
      raw({ date: '2026-09-12', direction: 'debit', amountPaise: 1500000, channel: 'IMPS' }),
      raw({ date: '2026-09-12', direction: 'credit', amountPaise: 1500000, channel: 'IMPS', accountKey: 'sbi:account:5678' }),
      raw({ date: '2026-09-20', direction: 'debit', amountPaise: 800000, counterparty: 'BILLDESK' }),
      raw({ date: '2026-09-21', direction: 'credit', amountPaise: 800000, instrument: 'card', accountKey: 'hsbc:card:7788', description: 'payment received' }),
    ]);
    const s = summarizeMonth(ledger, '2026-09');
    expect(s.incomePaise).toBe(10000000);
    expect(s.expensePaise).toBe(2000000 + 300000 - 100000);
    expect(s.netInvestedPaise).toBe(500000);
    expect(s.netCashFlowPaise).toBe(10000000 - 2200000);
    expect(s.savingsRate).toBe(0.78);
    expect(s.byCategory.rent).toBe(2000000);
  });
});

describe('detectRecurring', () => {
  it('finds monthly subscriptions and predicts the next date, ignoring irregular spends', () => {
    const ledger = ledgerFor([
      raw({ date: '2026-07-05', direction: 'debit', amountPaise: 64900, counterparty: 'NETFLIX.COM' }),
      raw({ date: '2026-08-05', direction: 'debit', amountPaise: 64900, counterparty: 'NETFLIX.COM' }),
      raw({ date: '2026-09-05', direction: 'debit', amountPaise: 64900, counterparty: 'NETFLIX.COM' }),
      raw({ date: '2026-07-10', direction: 'debit', amountPaise: 30000, counterparty: 'swiggy' }),
      raw({ date: '2026-07-14', direction: 'debit', amountPaise: 90000, counterparty: 'swiggy' }),
      raw({ date: '2026-09-01', direction: 'debit', amountPaise: 45000, counterparty: 'swiggy' }),
    ]);
    const rec = detectRecurring(ledger);
    expect(rec).toHaveLength(1);
    expect(rec[0]).toMatchObject({ counterparty: 'NETFLIX.COM', cadence: 'monthly', category: 'subscriptions', typicalAmountPaise: 64900, nextExpectedDate: '2026-10-05', occurrences: 3 });
  });
});

describe('computeNetWorth', () => {
  it('nets card outstanding, values funds at NAV and counts depository fund copies once', () => {
    const nw = computeNetWorth(
      {
        banks: [{ accountKey: 'hdfc', label: 'HDFC ••1234', balancePaise: 5000000, asOf: '2026-10-10', source: 'alert' }],
        cards: [
          { accountKey: 'hsbc', label: 'HSBC TravelOne', statement: { date: '2026-09-15', totalDuePaise: 2000000, creditLimitPaise: 30000000 }, spendsSinceStatementPaise: 300000, paymentsSinceStatementPaise: 2000000, availableLimitPaise: null, availableLimitAsOf: null },
          { accountKey: 'sbicard', label: 'Flipkart SBI', statement: null, spendsSinceStatementPaise: 0, paymentsSinceStatementPaise: 0, availableLimitPaise: 10000000, availableLimitAsOf: '2026-10-01' },
        ],
        mutualFunds: [{ schemeKey: 's1', scheme: 'HDFC Flexi Cap', isin: 'INF179K01UT0', unitsMicro: 57634000, unitsAsOf: '2026-09-30', navMicro: 2100500000, navDate: '2026-10-09', statementValuePaise: 11597743 }],
        demat: [
          { key: 'd1', name: 'RELIANCE', isin: 'INE002A01018', kind: 'equity', fromFolioAccount: false, valuePaise: 5900000, asOf: '2026-09-30' },
          { key: 'd2', name: 'HDFC Flexi Cap', isin: 'INF179K01UT0', kind: 'mutual_fund', fromFolioAccount: true, valuePaise: 11597743, asOf: '2026-09-30' },
        ],
      },
      Date.parse('2026-10-11T00:00:00Z'),
    );
    expect(nw.bankPaise).toBe(5000000);
    expect(nw.investmentsPaise).toBe(12106022 + 5900000);
    expect(nw.cardOutstandingPaise).toBe(300000);
    expect(nw.netWorthPaise).toBe(5000000 + 12106022 + 5900000 - 300000);
    expect(nw.items.find((i) => i.id === 'hsbc')).toMatchObject({ estimated: true });
    expect(nw.notes.join(' ')).toContain('Flipkart SBI: no statement yet');
  });
});

describe('generateInsights', () => {
  const build = () => {
    const raws: RawTxn[] = [];
    for (const m of ['04', '05', '06']) {
      raws.push(raw({ date: `2026-${m}-02`, direction: 'credit', amountPaise: 10000000, description: 'SALARY' }));
      raws.push(raw({ date: `2026-${m}-10`, direction: 'debit', amountPaise: 200000, counterparty: 'MYNTRA' }));
      raws.push(raw({ date: `2026-${m}-11`, direction: 'debit', amountPaise: 300000, counterparty: 'swiggy' }));
    }
    for (const m of ['07', '08', '09']) {
      raws.push(raw({ date: `2026-${m}-02`, direction: 'credit', amountPaise: 10000000, description: 'SALARY' }));
      raws.push(raw({ date: `2026-${m}-05`, direction: 'debit', amountPaise: 64900, counterparty: 'NETFLIX.COM' }));
      raws.push(raw({ date: `2026-${m}-10`, direction: 'debit', amountPaise: 900000, counterparty: 'MYNTRA' }));
      for (let d = 11; d < 16; d++) raws.push(raw({ date: `2026-${m}-${d}`, direction: 'debit', amountPaise: 120000, counterparty: 'swiggy' }));
      raws.push(raw({ date: `2026-${m}-20`, direction: 'debit', amountPaise: 4000000, counterparty: 'nobroker rent' }));
    }
    raws.push(raw({ date: '2026-09-25', direction: 'debit', amountPaise: 59000, description: 'Late payment fee', instrument: 'card', accountKey: 'hsbc:card:7788' }));
    raws.push(raw({ date: '2026-09-26', direction: 'debit', amountPaise: 1499900, counterparty: 'CROMA' }));
    raws.push(raw({ date: '2026-09-26', direction: 'debit', amountPaise: 1499900, counterparty: 'CROMA' }));
    return buildLedger(raws);
  };

  it('produces evidence-backed insights without double counting or flagging essentials', () => {
    const ledger = build();
    const insights = generateInsights(ledger, detectRecurring(ledger), '2026-09');
    const types = insights.map((i) => i.type);
    expect(types).toEqual(expect.arrayContaining(['late_fees', 'duplicate_charge', 'subscriptions', 'food_delivery', 'category_spike']));
    expect(insights.some((i) => i.category === 'rent')).toBe(false);

    const food = insights.find((i) => i.type === 'food_delivery')!;
    expect(food.observedMonthlyPaise).toBe(600000);
    expect(food.baselineMonthlyPaise).toBe(300000);
    expect(food.estMonthlySavingsPaise).toBe(180000);

    const dup = insights.find((i) => i.type === 'duplicate_charge')!;
    expect(dup.oneTimePaise).toBe(1499900);
    expect(dup.evidence).toHaveLength(2);

    // No transaction contributes savings to two insights.
    const counted = insights.flatMap((i) => i.savingsBasis);
    expect(new Set(counted).size).toBe(counted.length);
    const total = totalPotentialSavings(insights);
    expect(total.annualPaise).toBe(total.monthlyPaise * 12);
  });
});
