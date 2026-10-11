/**
 * End-to-end test of the on-device import pipeline with the app's real schema and SQL:
 * MIME emails carrying the casparser-verified fixture PDFs → classification → password
 * handling → extraction (the same extractor the WebView runs, here on Node's pdf.js) →
 * parsing → idempotent import → the Investments screen's queries.
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { bytesToBase64, PDF_PAGE_EXTRACTOR_JS, type ExtractedPage } from '@fi/core';
import { FakeSqliteDatabase } from './fakeSqlite';
import { MIGRATIONS } from '../src/lib/schema';
import type { DocumentPasswords } from '../src/lib/passwords';

const fixture = (name: string) => new URL(`../../packages/core/test/fixtures/pdf/${name}`, import.meta.url);

const state = vi.hoisted(() => ({
  db: null as unknown as FakeSqliteDatabase,
  passwords: { pan: null, byInstitution: {} } as DocumentPasswords,
}));

class PdfEngineError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

// eslint-disable-next-line @typescript-eslint/no-implied-eval
const extractPage = new Function(`return ${PDF_PAGE_EXTRACTOR_JS}`)() as (ops: typeof OPS, page: unknown) => Promise<ExtractedPage>;

vi.mock('../src/lib/database', () => ({ getDatabase: async () => state.db }));
vi.mock('../src/lib/secrets', () => ({
  loadDocumentPasswords: async () => state.passwords,
  saveDocumentPasswords: async (p: DocumentPasswords) => {
    state.passwords = p;
  },
}));
vi.mock('../src/lib/pdfEngine', () => ({
  PdfEngineError,
  // Same extractor as the WebView, on Node's pdf.js (the WebView transport is tested in Chromium).
  extractPdf: async (bytes: Uint8Array, password: string) => {
    const task = getDocument({ data: bytes.slice(), password, verbosity: 0 });
    try {
      const doc = await task.promise;
      const pages: ExtractedPage[] = [];
      for (let i = 1; i <= doc.numPages; i++) pages.push(await extractPage(OPS, await doc.getPage(i)));
      return pages;
    } catch (error) {
      const e = error as { name?: string; code?: number; message?: string };
      if (e.name === 'PasswordException') throw new PdfEngineError(e.code === 2 ? 'incorrect_password' : 'password_required', e.message ?? '');
      throw error;
    } finally {
      await task.destroy();
    }
  },
}));

const { processDocuments, requeueDocuments, listDocuments } = await import('../src/lib/documents');
const { loadInvestments } = await import('../src/lib/investments');

function mimeWithPdf(subject: string, from: string, pdfName: string): string {
  const pdf = bytesToBase64(new Uint8Array(readFileSync(fixture(pdfName)))).replace(/(.{76})/g, '$1\r\n');
  return [
    `From: ${from}`,
    `Subject: ${subject}`,
    'Date: Sat, 10 Oct 2026 09:00:00 +0530',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="b1"',
    '',
    '--b1',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Please find your statement attached.',
    '--b1',
    `Content-Type: application/pdf; name="${pdfName}"`,
    'Content-Disposition: attachment',
    'Content-Transfer-Encoding: base64',
    '',
    pdf,
    '--b1--',
    '',
  ].join('\r\n');
}

const messages: Record<string, string> = {
  m_cams: mimeWithPdf('Consolidated Account Statement', 'CAMS <donotreply@camsonline.com>', 'cams_detailed.pdf'),
  m_kfin: mimeWithPdf('Consolidated Account Statement - KFintech', 'KFintech <noreply@kfintech.com>', 'kfin_detailed.pdf'),
  m_cdsl: mimeWithPdf('CDSL Consolidated Account Statement for Sep 2026', 'CDSL <ecas@cdslstatement.com>', 'cdsl.pdf'),
  m_cams_again: mimeWithPdf('Consolidated Account Statement', 'CAMS <donotreply@camsonline.com>', 'cams_detailed.pdf'),
  m_alert: 'From: HDFC Bank <alerts@hdfcbank.net>\r\nSubject: You have done a UPI txn\r\n\r\nRs.250.00 has been debited from account **1234',
};

const client = {
  message: async (_connectionId: string, messageId: string) => ({
    id: messageId,
    raw: bytesToBase64(new TextEncoder().encode(messages[messageId]!)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  }),
} as unknown as Parameters<typeof processDocuments>[0];

async function queue(messageId: string, institutionId: string) {
  await state.db.runAsync(
    'INSERT INTO inbox (connection_id, message_id, institution_id, discovered_at) VALUES (?, ?, ?, ?)',
    'c1', messageId, institutionId, Date.now(),
  );
}

async function count(sql: string): Promise<number> {
  return (await state.db.getFirstAsync<{ n: number }>(sql))!.n;
}

beforeEach(async () => {
  state.db = new FakeSqliteDatabase();
  state.passwords = { pan: null, byInstitution: {} };
  for (const [i, migration] of MIGRATIONS.entries()) {
    await state.db.execAsync(migration);
    await state.db.execAsync(`PRAGMA user_version = ${i + 1}`);
  }
});

describe('document import pipeline', () => {
  it('waits for the PAN, then imports CAS statements exactly once', async () => {
    await queue('m_cams', 'cams');
    await queue('m_kfin', 'kfintech');
    await queue('m_cdsl', 'cdsl');
    await queue('m_alert', 'hdfc');

    const first = await processDocuments(client);
    expect(first).toMatchObject({ processed: 4, imported: 1, needsPassword: 3 });
    const { counts } = await listDocuments();
    expect(counts).toEqual({ needs_password: 3, imported: 1 });
    // The bank alert becomes a ledger transaction (amount in paise, account suffix only).
    const txn = await state.db.getFirstAsync<{ direction: string; amount_paise: number; account_key: string }>('SELECT * FROM raw_transactions');
    expect(txn).toMatchObject({ direction: 'debit', amount_paise: 25000 });
    expect(txn?.account_key).toContain('1234');

    state.passwords = { pan: 'abcde1234f', byInstitution: {} }; // stored lower-case; PDFs need upper-case
    expect(await requeueDocuments(['needs_password'])).toBe(3);
    const second = await processDocuments(client);
    expect(second).toMatchObject({ processed: 3, imported: 3, needsPassword: 0, failed: 0, newTransactions: 42 });
    expect(await count('SELECT COUNT(*) AS n FROM mf_transactions')).toBe(42);
    expect(await count('SELECT COUNT(*) AS n FROM mf_schemes')).toBe(4);
    expect(await count('SELECT COUNT(*) AS n FROM demat_holdings')).toBe(6);
    expect(await count("SELECT COUNT(*) AS n FROM inbox WHERE status = 'pending'")).toBe(0);

    // The same statement arriving again (e.g. a re-requested CAS) adds nothing.
    await queue('m_cams_again', 'cams');
    const third = await processDocuments(client);
    expect(third).toMatchObject({ processed: 1, imported: 1, newTransactions: 0 });
    expect(await count('SELECT COUNT(*) AS n FROM mf_transactions')).toBe(42);
  }, 60000);

  it('reports a wrong password without importing anything', async () => {
    state.passwords = { pan: 'ZZZZZ9999Z', byInstitution: {} };
    await queue('m_cdsl', 'cdsl');
    expect(await processDocuments(client)).toMatchObject({ needsPassword: 1, imported: 0 });
    const { rows } = await listDocuments();
    expect(rows[0]).toMatchObject({ status: 'needs_password', kind: 'cas_depository' });
    expect(rows[0]?.detail).toContain('None of the saved passwords');
    expect(await count("SELECT COUNT(*) AS n FROM inbox WHERE status = 'failed'")).toBe(1);
  }, 60000);

  it('feeds the investments view with exact figures and flags incomplete history', async () => {
    state.passwords = { pan: 'ABCDE1234F', byInstitution: {} };
    await queue('m_cams', 'cams');
    await queue('m_cdsl', 'cdsl');
    await processDocuments(client);
    await state.db.runAsync(
      'INSERT INTO nav_quotes (scheme_code, isin_growth, isin_reinvest, scheme_name, nav_scaled, nav_date, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      '118955', 'INF179K01UT0', null, 'HDFC Flexi Cap', 2100500000, '2026-10-09', Date.now(),
    );

    const { schemes, holdings, warnings } = await loadInvestments();
    expect(warnings).toEqual([]);
    const hdfc = schemes.find((s) => s.isin === 'INF179K01UT0')!;
    expect(hdfc).toMatchObject({ unitsMicro: 57634000, transactionCount: 8, transactionUnitsMicro: 57634000, navDate: '2026-10-09' });
    expect(hdfc.currentValuePaise).toBe(12106022); // 57.634 × ₹2,100.50 = ₹1,21,060.217 → ₹1,21,060.22
    const ppfas = schemes.find((s) => s.isin === 'INF879O01027')!;
    // Statement opened with 10 units it has no transactions for: flagged, never invented.
    expect(ppfas.transactionUnitsMicro).toBe(125500000);
    expect(ppfas.unitsMicro).toBe(135500000);
    expect(new Set(holdings.map((h) => h.accountKey)).size).toBe(3);
    expect(holdings.find((h) => h.isin === 'INE040A01034')).toMatchObject({ broker: 'BAJAJ FINANCIAL SECURITIES LIMITED', clientIdTail: '4321', valuePaise: 2850000 });
  }, 60000);
});
