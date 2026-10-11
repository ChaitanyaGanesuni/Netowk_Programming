import type { SQLiteDatabase } from 'expo-sqlite';
import {
  ProviderError,
  classifyHttpStatus,
  daysToMs,
  getInstitution,
  parseNavAll,
  type AuthState,
  type DiscoveredAccount,
  type InboxItem,
  type NavQuote,
  type ProviderAdapter,
  type SyncPage,
  type SyncRunRecord,
  type SyncStore,
} from '@fi/core';
import type { BackendClient } from './api';

/** Pulls message pointers queued by the backend's scheduled Gmail sweep. */
export class BackendInboxAdapter implements ProviderAdapter<InboxItem> {
  readonly id = 'backend-inbox';
  readonly expectedCadenceMs = daysToMs(1);

  constructor(private readonly client: BackendClient) {}

  async ensureAuthorized(): Promise<AuthState> {
    return { status: 'active', expiresAt: null };
  }

  async discoverAccounts(): Promise<DiscoveredAccount[]> {
    return [];
  }

  async fetchPage(cursor: string | null): Promise<SyncPage<InboxItem>> {
    const page = await this.client.inbox(cursor ?? '0');
    return { records: page.items, nextCursor: page.cursor, done: !page.hasMore };
  }

  dedupKey(item: InboxItem): string {
    return `${item.connectionId}:${item.messageId}`;
  }

  async revoke(): Promise<void> {}
}

const AMFI_URL = (() => {
  const channel = getInstitution('amfi')?.channels[0];
  if (channel?.kind !== 'public_feed') throw new Error('AMFI feed missing from registry');
  return channel.url;
})();

/** Downloads AMFI's daily NAV file. Public data: no credentials involved. */
export class AmfiNavAdapter implements ProviderAdapter<NavQuote> {
  readonly id = 'amfi';
  readonly expectedCadenceMs = daysToMs(1);
  lastRejectedLines = 0;

  async ensureAuthorized(): Promise<AuthState> {
    return { status: 'active', expiresAt: null };
  }

  async discoverAccounts(): Promise<DiscoveredAccount[]> {
    return [];
  }

  async fetchPage(): Promise<SyncPage<NavQuote>> {
    let response: Response;
    try {
      response = await fetch(AMFI_URL);
    } catch {
      throw new ProviderError('transient', 'AMFI unreachable');
    }
    if (!response.ok) throw new ProviderError(classifyHttpStatus(response.status), `AMFI returned HTTP ${response.status}`);
    const parsed = parseNavAll(await response.text());
    this.lastRejectedLines = parsed.rejected.length;
    if (parsed.quotes.length === 0) throw new ProviderError('parse_failed', 'AMFI file contained no NAV rows; format may have changed');
    return { records: parsed.quotes, nextCursor: null, done: true };
  }

  dedupKey(quote: NavQuote): string {
    return `${quote.schemeCode}:${quote.navDate}`;
  }

  async revoke(): Promise<void> {}
}

type Upsert<T> = (db: SQLiteDatabase, items: ReadonlyArray<{ key: string; record: T }>) => Promise<number>;

/** SQLite-backed sync state shared by the app-side adapters. */
export class SqliteSyncStore<T> implements SyncStore<T> {
  constructor(
    private readonly db: SQLiteDatabase,
    private readonly upsertFn: Upsert<T>,
    private readonly dataAsOf?: (items: ReadonlyArray<T>) => string | null,
  ) {}

  private latestAsOf: string | null = null;

  async loadCursor(feedId: string): Promise<string | null> {
    const row = await this.db.getFirstAsync<{ cursor: string | null }>('SELECT cursor FROM feed_state WHERE feed_id = ?', feedId);
    return row?.cursor ?? null;
  }

  async saveCursor(feedId: string, cursor: string | null, completed: boolean): Promise<void> {
    await this.db.runAsync(
      `INSERT INTO feed_state (feed_id, cursor, completed) VALUES (?, ?, ?)
       ON CONFLICT (feed_id) DO UPDATE SET cursor = excluded.cursor, completed = excluded.completed`,
      feedId,
      cursor,
      completed ? 1 : 0,
    );
  }

  async upsert(_feedId: string, items: ReadonlyArray<{ key: string; record: T }>): Promise<number> {
    if (this.dataAsOf) {
      const asOf = this.dataAsOf(items.map((i) => i.record));
      if (asOf && (!this.latestAsOf || asOf > this.latestAsOf)) this.latestAsOf = asOf;
    }
    return this.upsertFn(this.db, items);
  }

  async lastSuccessAt(feedId: string): Promise<number | null> {
    const row = await this.db.getFirstAsync<{ last_success_at: number | null }>('SELECT last_success_at FROM feed_state WHERE feed_id = ?', feedId);
    return row?.last_success_at ?? null;
  }

  async recordRun(run: SyncRunRecord): Promise<void> {
    const ok = run.status === 'success' || run.status === 'partial';
    await this.db.runAsync(
      `INSERT INTO feed_state (feed_id, last_attempt_at, last_status, last_error, last_success_at, data_as_of)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (feed_id) DO UPDATE SET
         last_attempt_at = excluded.last_attempt_at,
         last_status = excluded.last_status,
         last_error = excluded.last_error,
         last_success_at = COALESCE(excluded.last_success_at, feed_state.last_success_at),
         data_as_of = COALESCE(excluded.data_as_of, feed_state.data_as_of)`,
      run.adapterId,
      run.finishedAt,
      run.status,
      ok ? null : run.errorMessage,
      ok ? run.finishedAt : null,
      ok ? this.latestAsOf : null,
    );
    await this.db.runAsync(
      `INSERT INTO sync_history (source, started_at, finished_at, status, received, inserted, error_kind, error_message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      run.adapterId,
      run.startedAt,
      run.finishedAt,
      run.status,
      run.received,
      run.inserted,
      run.errorKind,
      run.errorMessage,
    );
  }
}

export const upsertInbox: Upsert<InboxItem> = async (db, items) => {
  let inserted = 0;
  await db.withExclusiveTransactionAsync(async (txn) => {
    for (const { record } of items) {
      const result = await txn.runAsync(
        'INSERT OR IGNORE INTO inbox (connection_id, message_id, institution_id, discovered_at) VALUES (?, ?, ?, ?)',
        record.connectionId,
        record.messageId,
        record.institutionId,
        record.discoveredAt,
      );
      inserted += result.changes;
    }
  });
  return inserted;
};

/** Keeps the newest NAV per scheme; an older file never overwrites a newer NAV. */
export const upsertNavs: Upsert<NavQuote> = async (db, items) => {
  let changed = 0;
  const fetchedAt = Date.now();
  await db.withExclusiveTransactionAsync(async (txn) => {
    const statement = await txn.prepareAsync(
      `INSERT INTO nav_quotes (scheme_code, isin_growth, isin_reinvest, scheme_name, nav_scaled, nav_date, fetched_at)
       VALUES ($code, $isinA, $isinB, $name, $nav, $date, $fetched)
       ON CONFLICT (scheme_code) DO UPDATE SET
         isin_growth = excluded.isin_growth, isin_reinvest = excluded.isin_reinvest, scheme_name = excluded.scheme_name,
         nav_scaled = excluded.nav_scaled, nav_date = excluded.nav_date, fetched_at = excluded.fetched_at
       WHERE excluded.nav_date > nav_quotes.nav_date
          OR (excluded.nav_date = nav_quotes.nav_date AND excluded.nav_scaled != nav_quotes.nav_scaled)`,
    );
    try {
      for (const { record } of items) {
        const result = await statement.executeAsync({
          $code: record.schemeCode,
          $isinA: record.isinGrowthOrPayout,
          $isinB: record.isinReinvestment,
          $name: record.schemeName,
          $nav: record.navScaled,
          $date: record.navDate,
          $fetched: fetchedAt,
        });
        changed += result.changes;
      }
    } finally {
      await statement.finalizeAsync();
    }
  });
  return changed;
};

export const latestNavDate = (quotes: ReadonlyArray<NavQuote>): string | null =>
  quotes.reduce<string | null>((max, q) => (max === null || q.navDate > max ? q.navDate : max), null);
