import { describe, expect, it } from 'vitest';
import { Dec, getTransactionType, parseCasDate, parseSchemeName } from '../src/cas';

const d = (s: string) => Dec.parse(s) as Dec;

describe('Dec', () => {
  it('parses Indian formats, parentheses and bare fractions', () => {
    expect(d('1,23,456.78').toString()).toBe('123456.78');
    expect(d('(1,234.500)').toString()).toBe('-1234.500');
    expect(d('.196').toString()).toBe('0.196');
    expect(Dec.parse('N.A.')).toBeNull();
    expect(Dec.parse('')).toBeNull();
    expect(Dec.parse('1e5')).toBeNull();
  });

  it('adds exactly where floats drift', () => {
    expect(d('0.1').add(d('0.2')).toString()).toBe('0.3');
    let total = Dec.ZERO;
    for (let i = 0; i < 1000; i++) total = total.add(d('0.001'));
    expect(total.cmp(d('1'))).toBe(0);
  });

  it('divides and quantizes half-to-even like Python Decimal', () => {
    expect(d('5000.00').div(d('3.876'), 4).toString()).toBe('1289.9897');
    expect(d('0.00005').quantize(4).toString()).toBe('0.0000');
    expect(d('0.00015').quantize(4).toString()).toBe('0.0002');
    expect(d('-2.5').quantize(0).toString()).toBe('-2');
  });

  it('converts to scaled integers only without precision loss', () => {
    expect(d('1250.50').toScaledInt(2)).toBe(125050);
    expect(() => d('1.005').toScaledInt(2)).toThrow(RangeError);
  });
});

describe('CAS helpers', () => {
  it('parses statement dates', () => {
    expect(parseCasDate('15-Jan-2021')).toBe('2021-01-15');
    expect(parseCasDate('5Jan2021')).toBe('2021-01-05');
    expect(parseCasDate('30-09-2026')).toBe('2026-09-30');
    expect(parseCasDate('31-Feb-2021')).toBeNull();
  });

  it('classifies transactions like casparser', () => {
    expect(getTransactionType('Systematic Investment Purchase - Instalment 4/120', d('3.1')).type).toBe('PURCHASE_SIP');
    expect(getTransactionType('S T P Out (Axis Liquid)', d('-2')).type).toBe('SWITCH_OUT');
    expect(getTransactionType('Redemption - Payment Rejection Reversal', d('-1')).type).toBe('REVERSAL');
    expect(getTransactionType('*** STT Paid ***', null).type).toBe('STT_TAX');
    const div = getTransactionType('IDCW Payout @ Rs.1.50 per unit', d('0'));
    expect(div.type).toBe('DIVIDEND_PAYOUT');
    expect(div.dividendRate?.toString()).toBe('1.50');
  });

  it('cleans scheme names', () => {
    expect(parseSchemeName('Axis Bluechip Fund (formerly Axis Equity Fund) - Direct Growth (Demat) ')).toBe('Axis Bluechip Fund - Direct Growth');
  });
});
