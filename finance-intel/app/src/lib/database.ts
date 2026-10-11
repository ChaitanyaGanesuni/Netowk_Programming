import { deleteDatabaseAsync, openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';
import { MIGRATIONS } from './schema';
import { getOrCreateDatabaseKey } from './secrets';

const DB_NAME = 'finance-intel.db';

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
