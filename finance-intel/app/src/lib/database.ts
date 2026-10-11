import { deleteDatabaseAsync, openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';
import { getOrCreateDatabaseKey } from './secrets';

const DB_NAME = 'finance-intel.db';

/**
 * Ordered migrations; index + 1 is the schema version stored in PRAGMA user_version.
 * Money columns are integer paise and NAVs are integers scaled by 10^6 — never REAL.
 */
const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  -- Last connection list from the backend, kept so the screen works offline.
  CREATE TABLE connections_cache (id TEXT PRIMARY KEY, json TEXT NOT NULL, fetched_at INTEGER NOT NULL);

  -- Per-source sync state for app-side adapters (backend inbox, AMFI NAV feed).
  CREATE TABLE feed_state (
    feed_id TEXT PRIMARY KEY,
    cursor TEXT,
    completed INTEGER NOT NULL DEFAULT 0,
    last_success_at INTEGER,
    last_attempt_at INTEGER,
    last_status TEXT,
    last_error TEXT,
    data_as_of TEXT
  );

  CREATE TABLE sync_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    finished_at INTEGER NOT NULL,
    status TEXT NOT NULL,
    received INTEGER NOT NULL,
    inserted INTEGER NOT NULL,
    error_kind TEXT,
    error_message TEXT
  );
  CREATE INDEX idx_sync_history_started ON sync_history (started_at DESC);

  -- Pointers to finance emails; parsing (Phase 4) moves status off 'pending'.
  CREATE TABLE inbox (
    connection_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    institution_id TEXT NOT NULL,
    discovered_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'parsed', 'failed', 'ignored')),
    PRIMARY KEY (connection_id, message_id)
  );

  CREATE TABLE nav_quotes (
    scheme_code TEXT PRIMARY KEY,
    isin_growth TEXT,
    isin_reinvest TEXT,
    scheme_name TEXT NOT NULL,
    nav_scaled INTEGER NOT NULL,
    nav_date TEXT NOT NULL,
    fetched_at INTEGER NOT NULL
  );
  CREATE INDEX idx_nav_isin_growth ON nav_quotes (isin_growth);
  `,
];

async function migrate(db: SQLiteDatabase): Promise<void> {
  const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  const current = row?.user_version ?? 0;
  for (let version = current; version < MIGRATIONS.length; version++) {
    await db.withExclusiveTransactionAsync(async (txn) => {
      await txn.execAsync(MIGRATIONS[version] ?? '');
      await txn.execAsync(`PRAGMA user_version = ${version + 1}`);
    });
  }
}

let opening: Promise<SQLiteDatabase> | null = null;

/** Opens the SQLCipher-encrypted database (key from the Keystore) and applies migrations. */
export function getDatabase(): Promise<SQLiteDatabase> {
  opening ??= (async () => {
    const key = await getOrCreateDatabaseKey();
    const db = await openDatabaseAsync(DB_NAME);
    // SQLCipher requires the key before any other statement. The key is 64 hex chars,
    // so it cannot break out of the quoted literal.
    if (!/^[0-9a-f]{64}$/.test(key)) throw new Error('corrupt database key');
    await db.execAsync(`PRAGMA key = "x'${key}'"`);
    await db.execAsync('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
    await migrate(db);
    return db;
  })();
  opening.catch(() => {
    opening = null;
  });
  return opening;
}

/** Closes and deletes the local database file. */
export async function deleteLocalDatabase(): Promise<void> {
  if (opening) {
    const db = await opening.catch(() => null);
    await db?.closeAsync();
    opening = null;
  }
  await deleteDatabaseAsync(DB_NAME).catch(() => undefined);
}
