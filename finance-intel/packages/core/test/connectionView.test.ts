import { describe, expect, it } from 'vitest';
import { buildConnectionRows, daysToMs, type ConnectionDto } from '../src';

const now = Date.UTC(2026, 9, 11, 12);

function gmail(overrides: Partial<ConnectionDto> = {}): ConnectionDto {
  return {
    id: 'c1',
    provider: 'gmail',
    accountLabel: 'c••••@gmail.com',
    status: 'active',
    scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    createdAt: now - daysToMs(1),
    lastSuccessAt: now - 60_000,
    lastErrorAt: null,
    lastError: null,
    consentExpiresAt: null,
    nextAttemptAt: null,
    institutions: [
      { institutionId: 'hdfc', backfillComplete: true, lastSuccessAt: now - 60_000, messagesQueued: 120 },
      { institutionId: 'sbi', backfillComplete: true, lastSuccessAt: now - 60_000, messagesQueued: 0 },
      { institutionId: 'hsbc', backfillComplete: false, lastSuccessAt: now - 60_000, messagesQueued: 4 },
    ],
    ...overrides,
  };
}

describe('buildConnectionRows', () => {
  it('asks to connect Gmail when nothing is connected', () => {
    const rows = buildConnectionRows([], {}, now);
    const hdfc = rows.find((r) => r.institutionId === 'hdfc');
    expect(hdfc).toMatchObject({ status: 'not_connected', action: 'connect_gmail' });
    expect(hdfc?.accountTypes).toEqual(['savings_account', 'credit_card']);
    expect(rows.find((r) => r.institutionId === 'amfi')).toMatchObject({ status: 'never_fetched', action: null });
  });

  it('distinguishes connected, empty and backfilling institutions', () => {
    const rows = buildConnectionRows([gmail()], {}, now);
    expect(rows.find((r) => r.institutionId === 'hdfc')).toMatchObject({ status: 'connected', messagesFound: 120 });
    expect(rows.find((r) => r.institutionId === 'sbi')).toMatchObject({ status: 'no_emails_found' });
    expect(rows.find((r) => r.institutionId === 'hsbc')).toMatchObject({ status: 'backfilling' });
    expect(rows.find((r) => r.institutionId === 'hdfc')?.freshness.level).toBe('fresh');
  });

  it('surfaces reconnects and errors on every email institution', () => {
    const rows = buildConnectionRows([gmail({ status: 'needs_reauth', lastError: 'Reconnect Gmail.' })], {}, now);
    const emailRows = rows.filter((r) => r.institutionId !== 'amfi');
    expect(emailRows.every((r) => r.action === 'reconnect_gmail' && r.lastError === 'Reconnect Gmail.')).toBe(true);
  });

  it('judges NAV freshness by NAV date and keeps last good data on error', () => {
    const fresh = buildConnectionRows([], { amfi: { lastSuccessAt: now, lastError: null, dataAsOf: '2026-10-09' } }, now);
    expect(fresh.find((r) => r.institutionId === 'amfi')?.freshness.level).toBe('fresh');
    const failing = buildConnectionRows([], { amfi: { lastSuccessAt: now - daysToMs(9), lastError: 'HTTP 503', dataAsOf: '2026-10-01' } }, now);
    const amfi = failing.find((r) => r.institutionId === 'amfi');
    expect(amfi).toMatchObject({ status: 'connected', statusLabel: 'Using last good data', action: 'retry' });
    expect(amfi?.freshness.level).toBe('stale');
  });
});
