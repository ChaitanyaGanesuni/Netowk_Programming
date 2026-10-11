import { describe, expect, it } from 'vitest';
import { normalizeCas, parseCas } from '../src';
import { loadFixturePages } from './pdfHelper';

describe('normalizeCas', () => {
  it('turns an RTA CAS into exact integer records with stable keys', async () => {
    const statement = normalizeCas(parseCas(await loadFixturePages('cams_detailed.pdf')));
    expect(statement.source).toBe('rta_cas');
    expect(statement.periodTo).toBe('2026-10-10');
    expect(statement.folios.map((f) => f.panMasked)).toEqual(['XXXXXX234F', 'XXXXXX234F', 'XXXXXX234F']);
    expect(statement.schemes).toHaveLength(3);
    expect(statement.transactions).toHaveLength(8 + 2 + 30);
    const redemption = statement.transactions.find((t) => t.type === 'REDEMPTION');
    expect(redemption).toMatchObject({ date: '2023-06-20', amountPaise: -2000000, unitsMicro: -12000000, navMicro: 1666666700, balanceMicro: 39844000 });
    const stamp = statement.transactions.find((t) => t.type === 'STAMP_DUTY_TAX');
    expect(stamp).toMatchObject({ amountPaise: 250, unitsMicro: null });
    expect(new Set(statement.transactions.map((t) => t.key)).size).toBe(statement.transactions.length);
    const hdfc = statement.snapshots.find((s) => s.schemeKey.endsWith('INF179K01UT0'));
    expect(hdfc).toMatchObject({ asOf: '2026-10-10', unitsMicro: 57634000, valuePaise: 11597743, costPaise: 10500000 });
    expect(statement.warnings).toEqual([]);
  });

  it('produces identical keys when the same statement is imported twice', async () => {
    const pages = await loadFixturePages('kfin_detailed.pdf');
    const a = normalizeCas(parseCas(pages));
    const b = normalizeCas(parseCas(pages));
    expect(b.transactions.map((t) => t.key)).toEqual(a.transactions.map((t) => t.key));
  });

  it('turns a CDSL CAS into dated demat holdings per account', async () => {
    const statement = normalizeCas(parseCas(await loadFixturePages('cdsl.pdf')));
    expect(statement.periodTo).toBe('2026-09-30');
    expect(statement.dematAccounts.map((a) => a.key)).toEqual(['CDSL|12088700|12345678', 'CDSL|12081600|87654321', 'CDSL|MF_FOLIOS']);
    const reliance = statement.dematHoldings.find((h) => h.isin === 'INE002A01018');
    expect(reliance).toMatchObject({ kind: 'equity', quantityMicro: 20000000, priceMicro: 2950000000, valuePaise: 5900000, asOf: '2026-09-30' });
    expect(statement.dematHoldings.find((h) => h.isin === 'INF204KB14I2')?.kind).toBe('mutual_fund');
    expect(statement.dematHoldings).toHaveLength(6);
  });
});
