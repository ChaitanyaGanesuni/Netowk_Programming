import { describe, expect, it } from 'vitest';
import {
  DecimalParseError,
  INSTITUTIONS,
  ProviderError,
  assessFreshness,
  backoffDelayMs,
  buildGmailQuery,
  classifyHttpStatus,
  daysToMs,
  formatScaled,
  getInstitution,
  parseAmfiDate,
  parseDecimalToScaled,
  parseInrToPaise,
  parseNavAll,
  parseRetryAfter,
  redact,
  withRetry,
} from '../src';

describe('decimal parsing', () => {
  it('parses into scaled integers without floating point', () => {
    expect(parseDecimalToScaled('0.1', 2)).toBe(10);
    expect(parseDecimalToScaled('1234.5', 2)).toBe(123450);
    expect(parseDecimalToScaled('-0.25', 4)).toBe(-2500);
    expect(parseDecimalToScaled('105.2346', 6)).toBe(105234600);
  });

  it('refuses to round extra precision', () => {
    expect(() => parseDecimalToScaled('1.005', 2)).toThrow(DecimalParseError);
  });

  it('rejects malformed and out-of-range input', () => {
    expect(() => parseDecimalToScaled('1e3', 2)).toThrow(DecimalParseError);
    expect(() => parseDecimalToScaled('12.', 2)).toThrow(DecimalParseError);
    expect(() => parseDecimalToScaled('99999999999999999', 2)).toThrow(DecimalParseError);
  });

  it('parses Indian rupee formats into paise', () => {
    expect(parseInrToPaise('Rs. 1,23,456.78')).toBe(12345678);
    expect(parseInrToPaise('INR 500')).toBe(50000);
    expect(parseInrToPaise('₹ 12.5')).toBe(1250);
  });

  it('formats scaled integers', () => {
    expect(formatScaled(12345678, 2)).toBe('123456.78');
    expect(formatScaled(-5, 2)).toBe('-0.05');
    expect(formatScaled(7, 0)).toBe('7');
  });
});

describe('errors and redaction', () => {
  it('classifies HTTP statuses', () => {
    expect(classifyHttpStatus(401)).toBe('auth_expired');
    expect(classifyHttpStatus(429)).toBe('rate_limited');
    expect(classifyHttpStatus(503)).toBe('transient');
    expect(classifyHttpStatus(400)).toBe('permanent');
  });

  it('redacts tokens, emails and long digit runs', () => {
    const text = 'Bearer ya29.abc-def user me@example.com acct 123456789012 refresh_token=1//0gabcdefghijklmnopqrstuvwxyz';
    const out = redact(text);
    expect(out).not.toContain('ya29');
    expect(out).not.toContain('me@example.com');
    expect(out).not.toContain('123456789012');
    expect(out).not.toContain('1//0g');
  });
});

describe('retry', () => {
  it('caps backoff and applies jitter', () => {
    const policy = { baseMs: 100, maxMs: 1000, maxAttempts: 5 };
    expect(backoffDelayMs(1, policy, () => 0.999)).toBe(99);
    expect(backoffDelayMs(10, policy, () => 0.5)).toBe(500);
  });

  it('parses Retry-After seconds and dates', () => {
    expect(parseRetryAfter('3', 0)).toBe(3000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4_000)).toBe(6000);
    expect(parseRetryAfter('soon', 0)).toBeUndefined();
  });

  it('retries transient errors and honours Retry-After', async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls === 1) throw new ProviderError('rate_limited', 'slow down', { retryAfterMs: 2000 });
        if (calls === 2) throw new ProviderError('transient', 'blip');
        return 'ok';
      },
      { baseMs: 10, maxMs: 100, maxAttempts: 5 },
      { sleep: async (ms) => void sleeps.push(ms), random: () => 0.5 },
    );
    expect(result).toBe('ok');
    expect(sleeps).toEqual([2000, 10]);
  });

  it('does not retry auth or permanent errors', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new ProviderError('auth_expired', 'reconnect');
        },
        undefined,
        { sleep: async () => {} },
      ),
    ).rejects.toThrow('reconnect');
    expect(calls).toBe(1);
  });

  it('gives up after maxAttempts', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new ProviderError('transient', 'down');
        },
        { baseMs: 1, maxMs: 1, maxAttempts: 3 },
        { sleep: async () => {} },
      ),
    ).rejects.toThrow('down');
    expect(calls).toBe(3);
  });
});

describe('freshness', () => {
  const now = Date.UTC(2026, 9, 11);
  it('reports never-synced sources', () => {
    expect(assessFreshness(null, daysToMs(1), now).level).toBe('never');
  });
  it('grades monthly statements against their cadence', () => {
    expect(assessFreshness(now - daysToMs(20), daysToMs(31), now).level).toBe('fresh');
    expect(assessFreshness(now - daysToMs(45), daysToMs(31), now).level).toBe('aging');
    expect(assessFreshness(now - daysToMs(70), daysToMs(31), now).level).toBe('stale');
  });
});

describe('institution registry', () => {
  it('has unique ids and covers the user institutions', () => {
    const ids = INSTITUTIONS.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ['sbi', 'hdfc', 'hsbc', 'sbicard', 'groww', 'bajaj-broking', 'cdsl', 'nsdl', 'cams', 'kfintech', 'amfi']) {
      expect(getInstitution(id)).toBeDefined();
    }
  });

  it('builds OR queries with an optional lower bound', () => {
    const hdfc = getInstitution('hdfc');
    const hsbc = getInstitution('hsbc');
    expect(hdfc && buildGmailQuery(hdfc)).toBe('{from:hdfcbank.net from:hdfcbank.com from:hdfcbank.bank.in}');
    expect(hsbc && buildGmailQuery(hsbc, 1760000000.9)).toBe('from:hsbc.co.in after:1760000000');
  });

  it('returns null for feeds without email senders', () => {
    const amfi = getInstitution('amfi');
    expect(amfi && buildGmailQuery(amfi)).toBeNull();
  });
});

describe('AMFI NAV parser', () => {
  const sample = [
    'Scheme Code;ISIN Div Payout/ ISIN Growth;ISIN Div Reinvestment;Scheme Name;Net Asset Value;Date',
    '',
    'Open Ended Schemes(Debt Scheme - Banking and PSU Fund)',
    '',
    'Aditya Birla Sun Life Mutual Fund',
    '',
    '119551;INF209KA12Z1;INF209KA13Z9;Example Banking & PSU Debt Fund - DIRECT - IDCW;105.2346;10-Oct-2026',
    '119552;INF209K01YY7;-;Example Fund - Growth;12.5;10-Oct-2026',
    '119553;-;-;Example Wound-up Fund;N.A.;10-Oct-2026',
    '119554;-;-;Bad Date Fund;10.0;2026-10-10',
    '119555;-;-;Too Precise Fund;1.1234567;10-Oct-2026',
  ].join('\r\n');

  it('parses quotes, counts unpriced rows and reports rejects', () => {
    const result = parseNavAll(sample);
    expect(result.quotes).toHaveLength(2);
    expect(result.quotes[0]).toEqual({
      schemeCode: '119551',
      isinGrowthOrPayout: 'INF209KA12Z1',
      isinReinvestment: 'INF209KA13Z9',
      schemeName: 'Example Banking & PSU Debt Fund - DIRECT - IDCW',
      navScaled: 105234600,
      navDate: '2026-10-10',
    });
    expect(result.quotes[1]?.isinReinvestment).toBeNull();
    expect(result.unpriced).toBe(1);
    expect(result.rejected.map((r) => r.line)).toEqual([10, 11]);
  });

  it('validates calendar dates', () => {
    expect(parseAmfiDate('31-Feb-2026')).toBeNull();
    expect(parseAmfiDate('1-Jan-2026')).toBe('2026-01-01');
  });
});
