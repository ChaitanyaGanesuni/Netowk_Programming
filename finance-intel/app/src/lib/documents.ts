import type { SQLiteDatabase } from 'expo-sqlite';
import {
  atomsFromPages,
  classifyMail,
  extractPages,
  findAccountSuffix,
  findCardSuffix,
  getInstitution,
  lineText,
  mailBodyText,
  normalizeCas,
  parseAlert,
  parseBankStatement,
  parseCardStatement,
  parseCas,
  parseMail,
  ProviderError,
  redactSample,
  UnsupportedStatementError,
  type DocumentKind,
  type ExtractedPage,
  type NormalizedStatement,
  type ParsedMail,
} from '@fi/core';
import { ApiError, type BackendClient } from './api';
import { getDatabase } from './database';
import { extractPdf, PdfEngineError } from './pdfEngine';
import { passwordCandidates } from './passwords';
import { loadDocumentPasswords } from './secrets';

/** Bump when parsing improves, so "Reprocess" can find documents parsed by older code. */
export const PARSER_VERSION = 2;

export type DocumentStatus = 'imported' | 'needs_password' | 'unsupported' | 'failed' | 'awaiting_parser' | 'skipped';

export interface ProcessSummary {
  processed: number;
  imported: number;
  newTransactions: number;
  needsPassword: number;
  failed: number;
  stoppedEarly: string | null;
}

const CAS_INSTITUTIONS = ['cams', 'kfintech', 'cdsl', 'nsdl'];
/** Covered by the monthly CAS (holdings) — individual parsers are not built. */
const COVERED_BY_CAS: ReadonlySet<DocumentKind> = new Set(['contract_note', 'mf_confirmation']);

interface Outcome {
  status: DocumentStatus;
  detail: string;
  warnings: string[];
  newTransactions: number;
}

/** Writes one parsed statement; every insert is keyed, so re-importing changes nothing. */
async function importStatement(db: SQLiteDatabase, s: NormalizedStatement, messageId: string): Promise<{ newTransactions: number; holdings: number }> {
  const now = Date.now();
  let newTransactions = 0;
  await db.withExclusiveTransactionAsync(async (txn) => {
    for (const f of s.folios) {
      await txn.runAsync(
        `INSERT INTO mf_folios (key, amc, folio, holder_name, pan_masked, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET holder_name = COALESCE(excluded.holder_name, holder_name), pan_masked = COALESCE(excluded.pan_masked, pan_masked), updated_at = excluded.updated_at`,
        f.key, f.amc, f.folio, f.holderName, f.panMasked, now,
      );
    }
    for (const sc of s.schemes) {
      await txn.runAsync(
        `INSERT INTO mf_schemes (key, folio_key, scheme, isin, rta, rta_code, advisor, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET scheme = excluded.scheme, isin = COALESCE(excluded.isin, isin), advisor = COALESCE(excluded.advisor, advisor), updated_at = excluded.updated_at`,
        sc.key, sc.folioKey, sc.scheme, sc.isin, sc.rta, sc.rtaCode, sc.advisor, now,
      );
    }
    for (const t of s.transactions) {
      const result = await txn.runAsync(
        `INSERT OR IGNORE INTO mf_transactions
         (key, scheme_key, date, description, type, amount_paise, units_micro, nav_micro, balance_micro, dividend_rate_micro, source_message_id, imported_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        t.key, t.schemeKey, t.date, t.description, t.type, t.amountPaise, t.unitsMicro, t.navMicro, t.balanceMicro, t.dividendRateMicro, messageId, now,
      );
      newTransactions += result.changes;
    }
    for (const u of s.snapshots) {
      await txn.runAsync(
        `INSERT OR REPLACE INTO units_snapshots (key, scheme_key, as_of, units_micro, nav_micro, value_paise, cost_paise, source, source_message_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        u.key, u.schemeKey, u.asOf, u.unitsMicro, u.navMicro, u.valuePaise, u.costPaise, u.source, messageId,
      );
    }
    for (const a of s.dematAccounts) {
      await txn.runAsync(
        `INSERT INTO demat_accounts (key, depository, broker, dp_id, client_id) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET broker = excluded.broker`,
        a.key, a.depository, a.broker, a.dpId, a.clientId,
      );
    }
    for (const h of s.dematHoldings) {
      await txn.runAsync(
        `INSERT OR REPLACE INTO demat_holdings (key, account_key, as_of, isin, name, kind, quantity_micro, price_micro, value_paise, folio, source_message_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        h.key, h.accountKey, h.asOf, h.isin, h.name, h.kind, h.quantityMicro, h.priceMicro, h.valuePaise, h.folio, messageId,
      );
    }
    await txn.runAsync(
      `INSERT INTO statement_imports (message_id, source, issuer, period_from, period_to, imported_at, new_transactions, warnings) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      messageId, s.source, s.issuer, s.periodFrom, s.periodTo, now, newTransactions, JSON.stringify(s.warnings),
    );
  });
  return { newTransactions, holdings: s.dematHoldings.length + s.snapshots.length };
}

/** Opens a PDF with the first working password; 'locked' when none works. */
async function openPdf(bytes: Uint8Array, candidates: string[]): Promise<ExtractedPage[] | 'locked'> {
  for (const password of candidates.length ? candidates : ['']) {
    try {
      return await extractPdf(bytes, password);
    } catch (error) {
      if (error instanceof PdfEngineError && (error.code === 'incorrect_password' || error.code === 'password_required')) continue;
      throw error;
    }
  }
  return 'locked';
}

const pdfText = (pages: ExtractedPage[]) => extractPages(atomsFromPages(pages)).flatMap((p) => p.lines.map(lineText)).join('\n');
const isPdf = (a: { filename: string; mimeType: string }) => a.mimeType === 'application/pdf' || /\.pdf$/i.test(a.filename);
/** Calendar date in India for an epoch-ms timestamp. */
const istDate = (ms: number) => new Date(ms + 5.5 * 3_600_000).toISOString().slice(0, 10);

async function ensureAccount(db: SQLiteDatabase, institutionId: string, instrument: 'account' | 'card', suffix: string | null): Promise<string> {
  const key = `${institutionId}:${instrument}:${suffix ?? 'unknown'}`;
  const name = getInstitution(institutionId)?.name ?? institutionId;
  await db.runAsync(
    'INSERT OR IGNORE INTO accounts (key, institution_id, instrument, suffix, label, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    key, institutionId, instrument, suffix, `${name} ${instrument === 'card' ? 'card' : 'a/c'}${suffix ? ` ••${suffix}` : ''}`, Date.now(),
  );
  return key;
}

async function processAlert(db: SQLiteDatabase, institutionId: string, messageId: string, mail: ParsedMail, receivedAt: number): Promise<Outcome> {
  const isCardIssuer = getInstitution(institutionId)?.type === 'card_issuer';
  const parsed = parseAlert(mail.subject, mailBodyText(mail), istDate(receivedAt), isCardIssuer);
  if (!parsed) {
    return { status: 'unsupported', detail: 'Not recognised as a transaction alert. Share a redacted sample so its format can be added.', warnings: [], newTransactions: 0 };
  }
  const accountKey = await ensureAccount(db, institutionId, parsed.instrument, parsed.suffix);
  const key = parsed.reference
    ? `${accountKey}|${parsed.date}|${parsed.direction}|${parsed.amountPaise}|${parsed.reference}`
    : `msg:${messageId}`;
  let inserted = 0;
  await db.withExclusiveTransactionAsync(async (txn) => {
    const r = await txn.runAsync(
      `INSERT OR IGNORE INTO raw_transactions
       (key, account_key, instrument, date, at, direction, amount_paise, channel, counterparty, description, reference, status, confidence, source_message_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      key, accountKey, parsed.instrument, parsed.date, receivedAt, parsed.direction, parsed.amountPaise, parsed.channel,
      parsed.counterparty, mail.subject.slice(0, 200), parsed.reference, parsed.status, parsed.confidence, messageId,
    );
    inserted = r.changes;
    if (parsed.availableBalancePaise !== null) {
      await txn.runAsync(
        'INSERT OR REPLACE INTO balance_snapshots (key, account_key, at, date, balance_paise, source, source_message_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
        `${accountKey}|${receivedAt}`, accountKey, receivedAt, parsed.date, parsed.availableBalancePaise,
        parsed.instrument === 'card' ? 'card_available_limit' : 'alert', messageId,
      );
    }
  });
  const warnings = parsed.confidence < 0.6 ? [`Low-confidence parse (${parsed.confidence}); please check this transaction.`] : [];
  return {
    status: 'imported',
    detail: `${parsed.direction === 'debit' ? 'Debit' : 'Credit'} ₹${(parsed.amountPaise / 100).toFixed(2)}${parsed.counterparty ? ` · ${parsed.counterparty}` : ''} · ${parsed.channel}${parsed.availableBalancePaise !== null ? ' · balance updated' : ''}.`,
    warnings,
    newTransactions: inserted,
  };
}

async function processStatementSummary(db: SQLiteDatabase, institutionId: string, messageId: string, mail: ParsedMail, kind: 'card_statement' | 'bank_statement', receivedAt: number): Promise<Outcome> {
  const candidates = passwordCandidates(await loadDocumentPasswords(), institutionId);
  const texts: string[] = [];
  let locked = false;
  for (const attachment of mail.attachments.filter(isPdf)) {
    const opened = await openPdf(attachment.bytes, candidates);
    if (opened === 'locked') locked = true;
    else texts.push(pdfText(opened));
  }
  if (!texts.length && !locked) texts.push(mailBodyText(mail));
  if (!texts.length) {
    return { status: 'needs_password', detail: `Add the statement password for ${getInstitution(institutionId)?.name ?? institutionId} under Documents.`, warnings: [], newTransactions: 0 };
  }
  const text = texts.join('\n');
  if (kind === 'card_statement') {
    const summary = parseCardStatement(text);
    if (!summary) return { status: 'unsupported', detail: 'Could not find the total due or due date in this statement. Share a redacted sample.', warnings: [], newTransactions: 0 };
    const accountKey = await ensureAccount(db, institutionId, 'card', findCardSuffix(text));
    await db.runAsync(
      `INSERT OR REPLACE INTO card_statements (key, account_key, statement_date, due_date, total_due_paise, min_due_paise, credit_limit_paise, available_limit_paise, source_message_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      `${accountKey}|${summary.statementDate ?? messageId}`, accountKey, summary.statementDate ?? istDate(receivedAt), summary.dueDate,
      summary.totalDuePaise, summary.minimumDuePaise, summary.creditLimitPaise, summary.availableLimitPaise, messageId,
    );
    return { status: 'imported', detail: `Card statement: total due ${summary.totalDuePaise !== null ? `₹${(summary.totalDuePaise / 100).toFixed(2)}` : '?'}, due ${summary.dueDate ?? '?'}.`, warnings: [], newTransactions: 0 };
  }
  const summary = parseBankStatement(text);
  if (!summary) return { status: 'unsupported', detail: 'Could not find the closing balance in this statement. Share a redacted sample.', warnings: [], newTransactions: 0 };
  const accountKey = await ensureAccount(db, institutionId, 'account', findAccountSuffix(text));
  const asOf = summary.periodTo ?? istDate(receivedAt);
  const at = Date.parse(`${asOf}T18:29:59Z`); // end of that day in India
  await db.runAsync(
    'INSERT OR REPLACE INTO balance_snapshots (key, account_key, at, date, balance_paise, source, source_message_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
    `${accountKey}|stmt|${asOf}`, accountKey, at, asOf, summary.closingBalancePaise, 'bank_statement', messageId,
  );
  return { status: 'imported', detail: `Bank statement: closing balance ₹${((summary.closingBalancePaise ?? 0) / 100).toFixed(2)} on ${asOf}.`, warnings: [], newTransactions: 0 };
}

async function processStatementPdfs(db: SQLiteDatabase, institutionId: string, pdfs: Uint8Array[], messageId: string): Promise<Outcome> {
  const passwords = await loadDocumentPasswords();
  const candidates = passwordCandidates(passwords, institutionId);
  const outcomes: Outcome[] = [];
  for (const bytes of pdfs) {
    const opened = await openPdf(bytes, candidates);
    const pages = opened === 'locked' ? null : opened;
    const passwordProblem = opened === 'locked';
    if (!pages) {
      outcomes.push({
        status: passwordProblem ? 'needs_password' : 'failed',
        detail: candidates.length ? 'None of the saved passwords opened this PDF.' : 'Add your PAN under Documents → Passwords to open CAS statements.',
        warnings: [],
        newTransactions: 0,
      });
      continue;
    }
    try {
      const statement = normalizeCas(parseCas(pages));
      const { newTransactions, holdings } = await importStatement(db, statement, messageId);
      outcomes.push({
        status: 'imported',
        detail: `${statement.issuer} statement ${statement.periodFrom ?? '?'} → ${statement.periodTo ?? '?'}: ${newTransactions} new transactions, ${holdings} holdings/valuations.`,
        warnings: statement.warnings,
        newTransactions,
      });
    } catch (error) {
      if (error instanceof UnsupportedStatementError) {
        outcomes.push({ status: 'unsupported', detail: error.message, warnings: [], newTransactions: 0 });
      } else {
        throw error;
      }
    }
  }
  if (outcomes.length === 0) return { status: 'skipped', detail: 'No PDF attachment.', warnings: [], newTransactions: 0 };
  const imported = outcomes.filter((o) => o.status === 'imported');
  const primary = imported[0] ?? outcomes.find((o) => o.status === 'needs_password') ?? outcomes[0]!;
  return {
    status: primary.status,
    detail: outcomes.map((o) => o.detail).join(' '),
    warnings: outcomes.flatMap((o) => o.warnings),
    newTransactions: imported.reduce((sum, o) => sum + o.newTransactions, 0),
  };
}

async function recordDocument(
  db: SQLiteDatabase,
  row: { connection_id: string; message_id: string; institution_id: string },
  meta: { receivedAt: number | null; subject: string; kind: DocumentKind },
  outcome: Outcome,
): Promise<void> {
  await db.withExclusiveTransactionAsync(async (txn) => {
    await txn.runAsync(
      `INSERT OR REPLACE INTO documents (connection_id, message_id, institution_id, received_at, subject, kind, status, detail, warnings, parser_version, processed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.connection_id, row.message_id, row.institution_id, meta.receivedAt, meta.subject, meta.kind, outcome.status, outcome.detail,
      outcome.warnings.length ? JSON.stringify(outcome.warnings) : null, PARSER_VERSION, Date.now(),
    );
    const inboxStatus = outcome.status === 'needs_password' || outcome.status === 'failed' ? 'failed' : 'parsed';
    await txn.runAsync('UPDATE inbox SET status = ? WHERE connection_id = ? AND message_id = ?', inboxStatus, row.connection_id, row.message_id);
  });
}

/**
 * Processes pending finance emails: CAS statements first (they carry investment history),
 * newest first. Network problems stop the run and leave the rest pending for next time.
 */
export async function processDocuments(client: BackendClient, limit = 20): Promise<ProcessSummary> {
  const db = await getDatabase();
  const summary: ProcessSummary = { processed: 0, imported: 0, newTransactions: 0, needsPassword: 0, failed: 0, stoppedEarly: null };
  const rows = await db.getAllAsync<{ connection_id: string; message_id: string; institution_id: string }>(
    `SELECT connection_id, message_id, institution_id FROM inbox WHERE status = 'pending'
     ORDER BY CASE WHEN institution_id IN (${CAS_INSTITUTIONS.map(() => '?').join(', ')}) THEN 0 ELSE 1 END, discovered_at DESC, rowid DESC LIMIT ?`,
    ...CAS_INSTITUTIONS,
    limit,
  );

  for (const row of rows) {
    let raw;
    try {
      raw = await client.message(row.connection_id, row.message_id);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        await db.runAsync("UPDATE inbox SET status = 'ignored' WHERE connection_id = ? AND message_id = ?", row.connection_id, row.message_id);
        continue;
      }
      summary.stoppedEarly = error instanceof Error ? error.message : String(error);
      if (error instanceof ProviderError || error instanceof ApiError) break;
      throw error;
    }

    const mail = parseMail(raw.raw);
    const classification = classifyMail(row.institution_id, mail);
    const meta = { receivedAt: mail.date ?? (raw.internalDate ? Number(raw.internalDate) : null), subject: mail.subject.slice(0, 300), kind: classification.kind };
    let outcome: Outcome;
    try {
      if (classification.kind === 'cas_rta' || classification.kind === 'cas_depository') {
        const pdfs = mail.attachments.filter((a) => a.mimeType === 'application/pdf' || /\.pdf$/i.test(a.filename)).map((a) => a.bytes);
        outcome = await processStatementPdfs(db, row.institution_id, pdfs, row.message_id);
      } else if (classification.kind === 'transaction_alert') {
        outcome = await processAlert(db, row.institution_id, row.message_id, mail, meta.receivedAt ?? Date.now());
      } else if (classification.kind === 'card_statement' || classification.kind === 'bank_statement') {
        outcome = await processStatementSummary(db, row.institution_id, row.message_id, mail, classification.kind, meta.receivedAt ?? Date.now());
      } else if (COVERED_BY_CAS.has(classification.kind)) {
        outcome = { status: 'skipped', detail: `${classification.reason}. Holdings from this come through the monthly CAS.`, warnings: [], newTransactions: 0 };
      } else {
        outcome = { status: 'skipped', detail: classification.reason, warnings: [], newTransactions: 0 };
      }
    } catch (error) {
      if (error instanceof PdfEngineError && (error.code === 'engine_unavailable' || error.code === 'timeout')) {
        summary.stoppedEarly = error.message;
        break;
      }
      outcome = { status: 'failed', detail: error instanceof Error ? error.message : String(error), warnings: [], newTransactions: 0 };
    }

    await recordDocument(db, row, meta, outcome);
    summary.processed++;
    if (outcome.status === 'imported') summary.imported++;
    if (outcome.status === 'needs_password') summary.needsPassword++;
    if (outcome.status === 'failed') summary.failed++;
    summary.newTransactions += outcome.newTransactions;
  }
  return summary;
}

/** Re-queues emails an older parser could not handle, so improved parsers pick them up. */
export async function requeueOutdated(): Promise<number> {
  const db = await getDatabase();
  const result = await db.runAsync(
    `UPDATE inbox SET status = 'pending' WHERE (connection_id, message_id) IN
       (SELECT connection_id, message_id FROM documents WHERE parser_version < ? AND status IN ('awaiting_parser', 'unsupported'))`,
    PARSER_VERSION,
  );
  return result.changes;
}

/** Puts documents with the given statuses back in the queue (e.g. after adding a password). */
export async function requeueDocuments(statuses: DocumentStatus[]): Promise<number> {
  const db = await getDatabase();
  const placeholders = statuses.map(() => '?').join(', ');
  const result = await db.runAsync(
    `UPDATE inbox SET status = 'pending' WHERE (connection_id, message_id) IN (SELECT connection_id, message_id FROM documents WHERE status IN (${placeholders}))`,
    ...statuses,
  );
  return result.changes;
}

export interface DocumentRow {
  connection_id: string;
  message_id: string;
  institution_id: string;
  received_at: number | null;
  subject: string;
  kind: DocumentKind;
  status: DocumentStatus;
  detail: string | null;
  warnings: string | null;
  processed_at: number;
}

export async function listDocuments(limit = 100): Promise<{ rows: DocumentRow[]; counts: Record<string, number> }> {
  const db = await getDatabase();
  const rows = await db.getAllAsync<DocumentRow>('SELECT * FROM documents ORDER BY COALESCE(received_at, processed_at) DESC LIMIT ?', limit);
  const counts: Record<string, number> = {};
  for (const r of await db.getAllAsync<{ status: string; n: number }>('SELECT status, COUNT(*) AS n FROM documents GROUP BY status')) counts[r.status] = r.n;
  return { rows, counts };
}

/** Fetches a message again and returns a redacted template the user may choose to share. */
export async function redactedSampleFor(client: BackendClient, connectionId: string, messageId: string): Promise<string> {
  const raw = await client.message(connectionId, messageId);
  return redactSample(parseMail(raw.raw));
}
