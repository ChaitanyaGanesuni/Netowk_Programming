import {
  INSTITUTIONS,
  ProviderError,
  backoffDelayMs,
  buildGmailQuery,
  institutionCadenceMs,
  redact,
  runSync,
  withRetry,
  type AuthState,
  type DiscoveredAccount,
  type Institution,
  type ProviderAdapter,
  type SyncPage,
  type SyncRunRecord,
  type SyncStore,
} from '@fi/core';
import { decryptSecret, encryptSecret, randomToken } from './crypto';
import type { ConnectionRow, CursorRow, SqlDatabase } from './db';
import type { Deps, Env } from './env';
import { listMessages, refreshAccessToken } from './google';
import { log } from './log';

/** Free-plan Workers allow 50 external subrequests per invocation; keep headroom. */
export const SUBREQUEST_BUDGET = 45;
/** Re-scan this much before the last completed sweep, to absorb late-indexed mail. */
const OVERLAP_SECONDS = 2 * 86_400;
const PAGE_SIZE = 100;
const CONNECTION_BACKOFF = { baseMs: 5 * 60_000, maxMs: 6 * 3_600_000, maxAttempts: Number.POSITIVE_INFINITY };

export interface InboxRecord {
  messageId: string;
  institutionId: string;
}

/**
 * Cursor stored per (connection, institution). `highWater` is the start time of the last
 * completed sweep (null until the initial backfill finishes); `sweep` is an in-progress
 * sweep that can span several cron runs.
 */
interface GmailCursor {
  highWater: number | null;
  sweep: { startedS: number; after: number | null; pageToken: string } | null;
}

function parseCursor(text: string | null): GmailCursor {
  if (!text) return { highWater: null, sweep: null };
  return JSON.parse(text) as GmailCursor;
}

export function emailInstitutions(): Institution[] {
  return INSTITUTIONS.filter((institution) => buildGmailQuery(institution) !== null);
}

/** Returns a valid access token, refreshing (and persisting) it when close to expiry. */
export async function getAccessToken(env: Env, deps: Deps, db: SqlDatabase, connection: ConnectionRow): Promise<string> {
  const now = deps.now();
  if (connection.access_token_enc && connection.access_expires_at && connection.access_expires_at - 60_000 > now) {
    return decryptSecret(connection.access_token_enc, env.TOKEN_ENCRYPTION_KEY, `${connection.id}:access`);
  }
  if (!connection.refresh_token_enc) throw new ProviderError('auth_expired', 'no refresh token stored');
  const refreshToken = await decryptSecret(connection.refresh_token_enc, env.TOKEN_ENCRYPTION_KEY, `${connection.id}:refresh`);
  const tokens = await withRetry(() => refreshAccessToken(env, deps, refreshToken), undefined, {
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 2000))),
  });
  const accessEnc = await encryptSecret(tokens.access_token, env.TOKEN_ENCRYPTION_KEY, `${connection.id}:access`);
  const expiresAt = now + tokens.expires_in * 1000;
  await db
    .prepare('UPDATE connections SET access_token_enc = ?, access_expires_at = ?, updated_at = ? WHERE id = ?')
    .bind(accessEnc, expiresAt, now, connection.id)
    .run();
  connection.access_token_enc = accessEnc;
  connection.access_expires_at = expiresAt;
  return tokens.access_token;
}

/** One Gmail search (one institution's senders) behind the shared adapter contract. */
export class GmailInstitutionAdapter implements ProviderAdapter<InboxRecord> {
  readonly id: string;
  readonly expectedCadenceMs: number;
  private accessToken: string | null = null;

  constructor(
    private readonly env: Env,
    private readonly deps: Deps,
    private readonly db: SqlDatabase,
    private readonly connection: ConnectionRow,
    private readonly institution: Institution,
  ) {
    this.id = `${connection.id}:${institution.id}`;
    this.expectedCadenceMs = institutionCadenceMs(institution);
  }

  async ensureAuthorized(): Promise<AuthState> {
    if (this.connection.status === 'needs_reauth' || this.connection.status === 'revoked') {
      return { status: this.connection.status, expiresAt: null };
    }
    this.accessToken = await getAccessToken(this.env, this.deps, this.db, this.connection);
    return { status: 'active', expiresAt: null };
  }

  async discoverAccounts(): Promise<DiscoveredAccount[]> {
    const query = buildGmailQuery(this.institution);
    if (!query || !this.accessToken) return [];
    const list = await listMessages(this.deps, this.accessToken, query, { maxResults: 1 });
    const estimate = list.resultSizeEstimate ?? 0;
    return estimate === 0
      ? []
      : [{
          institutionId: this.institution.id,
          externalId: this.institution.id,
          label: this.institution.name,
          dataKinds: this.institution.channels.flatMap((c) => c.dataKinds),
          detail: `~${estimate} matching emails`,
        }];
  }

  async fetchPage(cursorText: string | null): Promise<SyncPage<InboxRecord>> {
    if (!this.accessToken) throw new ProviderError('auth_expired', 'not authorized');
    const cursor = parseCursor(cursorText);
    const sweep = cursor.sweep ?? {
      startedS: Math.floor(this.deps.now() / 1000),
      after: cursor.highWater === null ? null : cursor.highWater - OVERLAP_SECONDS,
      pageToken: '',
    };
    const query = buildGmailQuery(this.institution, sweep.after ?? undefined);
    if (!query) return { records: [], nextCursor: JSON.stringify(cursor), done: true };

    const list = await listMessages(this.deps, this.accessToken, query, {
      maxResults: PAGE_SIZE,
      ...(sweep.pageToken ? { pageToken: sweep.pageToken } : {}),
    });
    const records = (list.messages ?? []).map((m) => ({ messageId: m.id, institutionId: this.institution.id }));
    const next: GmailCursor = list.nextPageToken
      ? { highWater: cursor.highWater, sweep: { ...sweep, pageToken: list.nextPageToken } }
      : { highWater: sweep.startedS, sweep: null };
    return { records, nextCursor: JSON.stringify(next), done: !list.nextPageToken };
  }

  dedupKey(record: InboxRecord): string {
    return record.messageId;
  }

  async revoke(): Promise<void> {
    // Revocation is per Google grant, handled for the whole connection in routes.ts.
  }
}

/** Persists cursors and message pointers in D1. Adapter ids are "<connectionId>:<institutionId>". */
export class D1InboxStore implements SyncStore<InboxRecord> {
  constructor(
    private readonly db: SqlDatabase,
    private readonly now: () => number,
  ) {}

  private split(adapterId: string): [string, string] {
    const index = adapterId.indexOf(':');
    return [adapterId.slice(0, index), adapterId.slice(index + 1)];
  }

  async loadCursor(adapterId: string): Promise<string | null> {
    const [connectionId, institutionId] = this.split(adapterId);
    await this.db
      .prepare('INSERT OR IGNORE INTO sync_cursors (connection_id, institution_id) VALUES (?, ?)')
      .bind(connectionId, institutionId)
      .run();
    const row = await this.db
      .prepare('SELECT cursor FROM sync_cursors WHERE connection_id = ? AND institution_id = ?')
      .bind(connectionId, institutionId)
      .first<Pick<CursorRow, 'cursor'>>();
    return row?.cursor ?? null;
  }

  async saveCursor(adapterId: string, cursor: string | null): Promise<void> {
    const [connectionId, institutionId] = this.split(adapterId);
    const backfillComplete = parseCursor(cursor).highWater !== null ? 1 : 0;
    await this.db
      .prepare(
        'UPDATE sync_cursors SET cursor = ?, backfill_complete = MAX(backfill_complete, ?) WHERE connection_id = ? AND institution_id = ?',
      )
      .bind(cursor, backfillComplete, connectionId, institutionId)
      .run();
  }

  async upsert(adapterId: string, items: ReadonlyArray<{ key: string; record: InboxRecord }>): Promise<number> {
    if (items.length === 0) return 0;
    const [connectionId] = this.split(adapterId);
    const now = this.now();
    const statement = 'INSERT OR IGNORE INTO inbox (connection_id, message_id, institution_id, discovered_at) VALUES (?, ?, ?, ?)';
    const results = await this.db.batch(
      items.map(({ record }) => this.db.prepare(statement).bind(connectionId, record.messageId, record.institutionId, now)),
    );
    return results.reduce((sum, result) => sum + result.meta.changes, 0);
  }

  async lastSuccessAt(adapterId: string): Promise<number | null> {
    const [connectionId, institutionId] = this.split(adapterId);
    const row = await this.db
      .prepare('SELECT last_success_at FROM sync_cursors WHERE connection_id = ? AND institution_id = ?')
      .bind(connectionId, institutionId)
      .first<Pick<CursorRow, 'last_success_at'>>();
    return row?.last_success_at ?? null;
  }

  async recordRun(run: SyncRunRecord): Promise<void> {
    if (run.status !== 'success' && run.status !== 'partial') return;
    const [connectionId, institutionId] = this.split(run.adapterId);
    await this.db
      .prepare('UPDATE sync_cursors SET last_success_at = ? WHERE connection_id = ? AND institution_id = ?')
      .bind(run.finishedAt, connectionId, institutionId)
      .run();
  }
}

export interface ConnectionSyncResult {
  runId: string;
  status: 'success' | 'partial' | 'failed' | 'needs_reauth';
  newMessages: number;
}

/** Sweeps every institution for one connection and records a single sync_runs row. */
export async function syncConnection(
  env: Env,
  deps: Deps,
  connection: ConnectionRow,
  trigger: 'cron' | 'manual',
  subrequestBudget: number,
): Promise<ConnectionSyncResult> {
  const db = env.DB;
  const runId = randomToken(12);
  const startedAt = deps.now();
  await db
    .prepare("INSERT INTO sync_runs (id, connection_id, trigger, started_at, status) VALUES (?, ?, ?, ?, 'running')")
    .bind(runId, connection.id, trigger, startedAt)
    .run();

  const institutions = emailInstitutions();
  const maxPages = Math.max(1, Math.floor((subrequestBudget - 1) / institutions.length));
  const store = new D1InboxStore(db, deps.now);
  const runs: SyncRunRecord[] = [];
  for (const institution of institutions) {
    const adapter = new GmailInstitutionAdapter(env, deps, db, connection, institution);
    const run = await runSync(adapter, store, {
      maxPages,
      now: deps.now,
      backoff: { baseMs: 250, maxMs: 2000, maxAttempts: 2 },
    });
    runs.push(run);
    if (run.status === 'needs_reauth') break;
  }

  const newMessages = runs.reduce((sum, run) => sum + run.inserted, 0);
  const failure = runs.find((run) => run.status === 'needs_reauth') ?? runs.find((run) => run.status === 'failed');
  const status: ConnectionSyncResult['status'] = failure
    ? (failure.status as 'needs_reauth' | 'failed')
    : runs.some((run) => run.status === 'partial')
      ? 'partial'
      : 'success';
  const finishedAt = deps.now();

  if (status === 'needs_reauth') {
    await db
      .prepare(
        "UPDATE connections SET status = 'needs_reauth', access_token_enc = NULL, access_expires_at = NULL, last_error_at = ?, last_error = ?, updated_at = ? WHERE id = ?",
      )
      .bind(finishedAt, 'Google access was revoked or expired. Reconnect Gmail.', finishedAt, connection.id)
      .run();
  } else if (status === 'failed') {
    const failures = connection.consecutive_failures + 1;
    const nextAttempt = finishedAt + backoffDelayMs(failures, CONNECTION_BACKOFF, () => 1);
    await db
      .prepare(
        "UPDATE connections SET status = 'error', consecutive_failures = ?, next_attempt_at = ?, last_error_at = ?, last_error = ?, updated_at = ? WHERE id = ?",
      )
      .bind(failures, nextAttempt, finishedAt, failure?.errorMessage ?? 'sync failed', finishedAt, connection.id)
      .run();
  } else {
    await db
      .prepare(
        "UPDATE connections SET status = 'active', consecutive_failures = 0, next_attempt_at = NULL, last_success_at = ?, updated_at = ? WHERE id = ?",
      )
      .bind(finishedAt, finishedAt, connection.id)
      .run();
  }

  await db
    .prepare('UPDATE sync_runs SET finished_at = ?, status = ?, new_messages = ?, error_kind = ?, error_message = ? WHERE id = ?')
    .bind(finishedAt, status, newMessages, failure?.errorKind ?? null, failure ? redact(failure.errorMessage ?? '') : null, runId)
    .run();
  log('sync.finished', { connection: connection.id, trigger, status, newMessages, institutions: runs.length });
  return { runId, status, newMessages };
}

/** Cron entry point: sync every due connection and expire abandoned OAuth attempts. */
export async function runScheduled(env: Env, deps: Deps): Promise<void> {
  const now = deps.now();
  await env.DB.prepare('DELETE FROM oauth_states WHERE created_at < ?').bind(now - 3_600_000).run();
  const { results } = await env.DB
    .prepare(
      "SELECT * FROM connections WHERE status IN ('active', 'error') AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY last_success_at ASC",
    )
    .bind(now)
    .all<ConnectionRow>();
  if (results.length === 0) return;
  const budget = Math.floor(SUBREQUEST_BUDGET / results.length);
  for (const connection of results) {
    try {
      await syncConnection(env, deps, connection, 'cron', budget);
    } catch (error) {
      log('sync.crashed', { connection: connection.id, error: error instanceof Error ? error.message : String(error) });
    }
  }
}
