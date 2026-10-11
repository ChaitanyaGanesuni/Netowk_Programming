import { ConnectionDto, runSync, type PublicFeedState, type SyncRunRecord } from '@fi/core';
import { BackendClient } from './api';
import { AmfiNavAdapter, BackendInboxAdapter, SqliteSyncStore, latestNavDate, upsertInbox, upsertNavs } from './adapters';
import { getDatabase } from './database';
import { processDocuments, type ProcessSummary } from './documents';
import type { BackendCredentials } from './secrets';

export interface LocalSnapshot {
  connections: ConnectionDto[];
  connectionsFetchedAt: number | null;
  feeds: Record<string, PublicFeedState>;
  pendingMessages: number;
}

/** Reads everything the connections screen needs from the local database (works offline). */
export async function loadSnapshot(): Promise<LocalSnapshot> {
  const db = await getDatabase();
  const cached = await db.getAllAsync<{ json: string; fetched_at: number }>('SELECT json, fetched_at FROM connections_cache');
  // Re-validate cached JSON: a schema change between app versions must not crash the screen.
  const connections = cached.flatMap((row) => {
    const parsed = ConnectionDto.safeParse(JSON.parse(row.json));
    return parsed.success ? [parsed.data] : [];
  });
  const feeds: Record<string, PublicFeedState> = {};
  for (const row of await db.getAllAsync<{ feed_id: string; last_success_at: number | null; last_error: string | null; data_as_of: string | null }>(
    'SELECT feed_id, last_success_at, last_error, data_as_of FROM feed_state',
  )) {
    feeds[row.feed_id] = { lastSuccessAt: row.last_success_at, lastError: row.last_error, dataAsOf: row.data_as_of };
  }
  const pending = await db.getFirstAsync<{ n: number }>("SELECT COUNT(*) AS n FROM inbox WHERE status = 'pending'");
  return {
    connections,
    connectionsFetchedAt: cached.reduce<number | null>((max, r) => Math.max(max ?? 0, r.fetched_at), null),
    feeds,
    pendingMessages: pending?.n ?? 0,
  };
}

export async function refreshConnections(client: BackendClient): Promise<void> {
  const { connections } = await client.connections();
  const db = await getDatabase();
  const now = Date.now();
  await db.withExclusiveTransactionAsync(async (txn) => {
    await txn.runAsync('DELETE FROM connections_cache');
    for (const connection of connections) {
      await txn.runAsync('INSERT INTO connections_cache (id, json, fetched_at) VALUES (?, ?, ?)', connection.id, JSON.stringify(connection), now);
    }
  });
}

export interface SyncSummary {
  inbox: SyncRunRecord | null;
  nav: SyncRunRecord;
  documents: ProcessSummary | null;
  backendError: string | null;
}

/**
 * Foreground refresh: ask the backend to sweep Gmail now, pull new message pointers, refresh
 * the NAV feed. Background syncing does not depend on this — the backend cron keeps sweeping.
 * Each source fails independently and keeps its last good data.
 */
export async function syncAll(credentials: BackendCredentials | null): Promise<SyncSummary> {
  const db = await getDatabase();
  let inbox: SyncRunRecord | null = null;
  let backendError: string | null = null;

  if (credentials) {
    const client = new BackendClient(credentials);
    try {
      const { connections } = await client.connections();
      for (const connection of connections.filter((c) => c.status === 'active' || c.status === 'error')) {
        await client.syncNow(connection.id);
      }
      await refreshConnections(client);
    } catch (error) {
      backendError = error instanceof Error ? error.message : String(error);
    }
    inbox = await runSync(new BackendInboxAdapter(client), new SqliteSyncStore(db, upsertInbox), { maxPages: 50 });
  }

  // NAVs first, so freshly imported holdings can be valued immediately.
  const nav = await runSync(new AmfiNavAdapter(), new SqliteSyncStore(db, upsertNavs, latestNavDate), { maxPages: 1 });
  let documents: ProcessSummary | null = null;
  if (credentials) {
    try {
      documents = await processDocuments(new BackendClient(credentials));
    } catch (error) {
      backendError ??= error instanceof Error ? error.message : String(error);
    }
  }
  return { inbox, nav, documents, backendError };
}

export async function recentLocalHistory(limit = 30) {
  const db = await getDatabase();
  return db.getAllAsync<{
    id: number;
    source: string;
    started_at: number;
    finished_at: number;
    status: string;
    received: number;
    inserted: number;
    error_message: string | null;
  }>('SELECT * FROM sync_history ORDER BY started_at DESC LIMIT ?', limit);
}

export async function forgetConnectionLocally(connectionId: string): Promise<void> {
  const db = await getDatabase();
  await db.withExclusiveTransactionAsync(async (txn) => {
    await txn.runAsync('DELETE FROM inbox WHERE connection_id = ?', connectionId);
    await txn.runAsync('DELETE FROM connections_cache WHERE id = ?', connectionId);
  });
}
