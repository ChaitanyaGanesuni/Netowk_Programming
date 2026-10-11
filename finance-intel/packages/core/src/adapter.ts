import { ProviderError, redact, type ProviderErrorKind } from './errors';
import { DEFAULT_BACKOFF, realSleep, withRetry, type BackoffPolicy } from './retry';
import { assessFreshness, type FreshnessReport } from './freshness';
import type { DataKind } from './institutions';

export type AuthStatus = 'not_connected' | 'active' | 'needs_reauth' | 'revoked';

export interface AuthState {
  status: AuthStatus;
  /** When the current grant stops working without user action, if the source has such a limit. */
  expiresAt: number | null;
}

export interface DiscoveredAccount {
  institutionId: string;
  /** Stable identifier within the provider (never a full account number). */
  externalId: string;
  label: string;
  dataKinds: readonly DataKind[];
  /** Provider-specific evidence, e.g. "~42 matching emails". */
  detail?: string;
}

export interface SyncPage<TRecord> {
  records: readonly TRecord[];
  /** Opaque cursor for the next page; persisted after the page's records are stored. */
  nextCursor: string | null;
  /** True when the provider has nothing further for this run. */
  done: boolean;
}

/**
 * The contract every data source implements. Interactive sign-in is started by the connection
 * UI (it needs a browser); adapters handle everything after that: token renewal, discovery,
 * paging, dedup keys and revocation. Provider-specific code stays behind this interface.
 */
export interface ProviderAdapter<TRecord> {
  readonly id: string;
  readonly expectedCadenceMs: number;
  /** Confirms the grant still works, renewing short-lived tokens when the source allows it. */
  ensureAuthorized(): Promise<AuthState>;
  discoverAccounts(): Promise<DiscoveredAccount[]>;
  /** Fetches one page after `cursor` (null = start of the incremental window or backfill). */
  fetchPage(cursor: string | null): Promise<SyncPage<TRecord>>;
  /** Deterministic idempotency key; the same source item always yields the same key. */
  dedupKey(record: TRecord): string;
  /** Revokes the grant at the source and forgets local credentials. */
  revoke(): Promise<void>;
}

export interface SyncStore<TRecord> {
  loadCursor(adapterId: string): Promise<string | null>;
  saveCursor(adapterId: string, cursor: string | null, completed: boolean): Promise<void>;
  /** Inserts records whose key is new and returns how many were inserted. Must be idempotent. */
  upsert(adapterId: string, items: ReadonlyArray<{ key: string; record: TRecord }>): Promise<number>;
  lastSuccessAt(adapterId: string): Promise<number | null>;
  recordRun(run: SyncRunRecord): Promise<void>;
}

export type SyncRunStatus = 'success' | 'partial' | 'failed' | 'needs_reauth';

export interface SyncRunRecord {
  adapterId: string;
  startedAt: number;
  finishedAt: number;
  status: SyncRunStatus;
  pages: number;
  received: number;
  inserted: number;
  errorKind: ProviderErrorKind | 'unknown' | null;
  /** Already redacted. */
  errorMessage: string | null;
}

export interface RunSyncOptions {
  /** Upper bound on pages per run so scheduled jobs stay within platform limits. */
  maxPages: number;
  backoff?: BackoffPolicy;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Drives one sync run: authorize → page through → store → advance cursor. Records are stored
 * before the cursor moves, so a crash replays at most one page, and the idempotent upsert
 * turns that replay into a no-op. A failure keeps everything stored up to the last good page.
 */
export async function runSync<TRecord>(
  adapter: ProviderAdapter<TRecord>,
  store: SyncStore<TRecord>,
  options: RunSyncOptions,
): Promise<SyncRunRecord> {
  const now = options.now ?? Date.now;
  const retryDeps = { sleep: options.sleep ?? realSleep };
  const backoff = options.backoff ?? DEFAULT_BACKOFF;
  const run: SyncRunRecord = {
    adapterId: adapter.id,
    startedAt: now(),
    finishedAt: 0,
    status: 'success',
    pages: 0,
    received: 0,
    inserted: 0,
    errorKind: null,
    errorMessage: null,
  };

  try {
    const auth = await withRetry(() => adapter.ensureAuthorized(), backoff, retryDeps);
    if (auth.status !== 'active') {
      run.status = 'needs_reauth';
      run.errorKind = 'auth_expired';
      run.errorMessage = `connection is ${auth.status}`;
    } else {
      let cursor = await store.loadCursor(adapter.id);
      let finished = false;
      while (run.pages < options.maxPages) {
        const page = await withRetry(() => adapter.fetchPage(cursor), backoff, retryDeps);
        run.pages++;
        run.received += page.records.length;

        const unique = new Map<string, TRecord>();
        for (const record of page.records) unique.set(adapter.dedupKey(record), record);
        run.inserted += await store.upsert(
          adapter.id,
          [...unique].map(([key, record]) => ({ key, record })),
        );

        cursor = page.nextCursor;
        await store.saveCursor(adapter.id, cursor, page.done);
        if (page.done) {
          finished = true;
          break;
        }
      }
      if (!finished) run.status = 'partial';
    }
  } catch (error) {
    if (error instanceof ProviderError) {
      run.status = error.kind === 'auth_expired' ? 'needs_reauth' : 'failed';
      run.errorKind = error.kind;
    } else {
      run.status = 'failed';
      run.errorKind = 'unknown';
    }
    run.errorMessage = redact(error instanceof Error ? error.message : String(error));
  }

  run.finishedAt = now();
  await store.recordRun(run);
  return run;
}

/** Freshness for an adapter, based on its last fully or partially successful run. */
export async function adapterFreshness<TRecord>(
  adapter: ProviderAdapter<TRecord>,
  store: SyncStore<TRecord>,
  now: number,
): Promise<FreshnessReport> {
  return assessFreshness(await store.lastSuccessAt(adapter.id), adapter.expectedCadenceMs, now);
}
