import { describe, expect, it } from 'vitest';
import { allocation, assetClassFor, concentration, emergencyReserveMonths, fundPerformance, scenarioImpact, xirr, DEFAULT_SCENARIOS, type Holding } from '../src/portfolio';

describe('xirr', () => {
  it('returns 10% for a one-year 10% gain', () => {
    expect(xirr([{ date: '2025-01-01', amountPaise: -10000000 }, { date: '2026-01-01', amountPaise: 11000000 }])).toBeCloseTo(0.1, 6);
  });

  it('matches the standard spreadsheet XIRR example', () => {
    // The widely used Excel documentation example; XIRR ≈ 0.373362535.
    const r = xirr([
      { date: '2008-01-01', amountPaise: -1000000 },
      { date: '2008-03-01', amountPaise: 275000 },
      { date: '2008-10-30', amountPaise: 425000 },
      { date: '2009-02-15', amountPaise: 325000 },
      { date: '2009-04-01', amountPaise: 275000 },
    ]);
    expect(r).toBeCloseTo(0.373362535, 6);
  });

  it('handles losses and refuses undefined cases', () => {
    expect(xirr([{ date: '2025-01-01', amountPaise: -100000 }, { date: '2026-01-01', amountPaise: 80000 }])).toBeCloseTo(-0.2, 6);
    expect(xirr([{ date: '2025-01-01', amountPaise: -100000 }])).toBeNull();
  });
});

describe('fundPerformance (FIFO)', () => {
  const txns = [
    { date: '2023-01-01', type: 'PURCHASE', amountPaise: 1000000, unitsMicro: 100000000 }, // 100 u @ 100
    { date: '2023-06-01', type: 'PURCHASE_SIP', amountPaise: 1200000, unitsMicro: 100000000 }, // 100 u @ 120
    { date: '2023-06-01', type: 'STAMP_DUTY_TAX', amountPaise: 60, unitsMicro: null },
    { date: '2024-01-01', type: 'REDEMPTION', amountPaise: -1500000, unitsMicro: -100000000 }, // sell 100 u @ 150
    { date: '2024-03-01', type: 'DIVIDEND_REINVEST', amountPaise: 50000, unitsMicro: 400000 },
  ];

  it('computes cost basis and realised gain first-in-first-out', () => {
    const p = fundPerformance(txns);
    expect(p.unitsMicro).toBe(100400000);
    expect(p.investedPaise).toBe(1200000 + 50000);
    expect(p.realizedGainPaise).toBe(1500000 - 1000000);
    expect(p.costIncomplete).toBe(false);
    expect(p.flows).toEqual([
      { date: '2023-01-01', amountPaise: -1000000 },
      { date: '2023-06-01', amountPaise: -1200000 },
      { date: '2023-06-01', amountPaise: -60 },
      { date: '2024-01-01', amountPaise: 1500000 },
    ]);
  });

  it('flags selling units that were never bought in the imported history', () => {
    expect(fundPerformance([{ date: '2024-01-01', type: 'REDEMPTION', amountPaise: -100, unitsMicro: -1000000 }]).costIncomplete).toBe(true);
  });
});

describe('allocation and risk', () => {
  const holdings: Holding[] = [
    { id: 'a', name: 'HDFC Flexi Cap', assetClass: assetClassFor('Equity Scheme - Flexi Cap Fund', 'HDFC Flexi Cap'), valuePaise: 6000000, investedPaise: 5000000, realizedGainPaise: 0 },
    { id: 'b', name: 'SBI Gilt Fund', assetClass: assetClassFor('Debt Scheme - Gilt Fund', 'SBI Gilt Fund'), valuePaise: 2000000, investedPaise: 2000000, realizedGainPaise: 0 },
    { id: 'c', name: 'Nippon India ETF Gold BeES', assetClass: assetClassFor(null, 'Nippon India ETF Gold BeES'), valuePaise: 1000000, investedPaise: null, realizedGainPaise: 0 },
    { id: 'd', name: 'Savings', assetClass: 'cash', valuePaise: 1000000, investedPaise: null, realizedGainPaise: 0 },
  ];

  it('classifies and slices by asset class', () => {
    expect(holdings.map((h) => h.assetClass)).toEqual(['equity', 'debt', 'gold', 'cash']);
    expect(allocation(holdings)[0]).toEqual({ assetClass: 'equity', valuePaise: 6000000, share: 0.6 });
  });

  it('measures concentration, reserves and scenario impact', () => {
    expect(concentration(holdings)).toEqual({ largest: { name: 'HDFC Flexi Cap', share: 0.6 }, top5Share: 1, hhi: 0.42 });
    expect(emergencyReserveMonths(1000000, 400000)).toBe(2.5);
    expect(scenarioImpact(allocation(holdings), DEFAULT_SCENARIOS[0]!)).toBe(-1200000);
  });
});
