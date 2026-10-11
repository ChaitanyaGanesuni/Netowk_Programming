import { Directory, File, Paths } from 'expo-file-system';
import { shareAsync } from 'expo-sharing';
import { getDatabase } from './database';

/** Writes text to the app cache and opens the system share sheet. The user picks the destination. */
export async function shareTextFile(name: string, body: string, mimeType: string): Promise<void> {
  clearExports(); // only the latest export is ever kept on the phone
  const dir = new Directory(Paths.cache, 'exports');
  dir.create({ idempotent: true });
  const file = new File(dir, name);
  file.create();
  file.write(body);
  await shareAsync(file.uri, { mimeType, dialogTitle: name });
}

const EXPORT_TABLES = [
  'accounts', 'raw_transactions', 'balance_snapshots', 'card_statements', 'category_rules', 'networth_snapshots',
  'mf_folios', 'mf_schemes', 'mf_transactions', 'units_snapshots', 'demat_accounts', 'demat_holdings', 'statement_imports', 'documents', 'sync_history',
] as const;

/** Full export of your local data as JSON (amounts are integer paise / micro-units). */
export async function exportAllData(): Promise<void> {
  const db = await getDatabase();
  const data: Record<string, unknown[]> = {};
  for (const table of EXPORT_TABLES) data[table] = await db.getAllAsync(`SELECT * FROM ${table}`);
  const body = JSON.stringify({ exportedAt: new Date().toISOString(), units: { amounts: 'paise', units: 'millionths', prices: 'millionths' }, data }, null, 1);
  await shareTextFile(`finance-intel-export-${new Date().toISOString().slice(0, 10)}.json`, body, 'application/json');
}

/** Removes previously shared export files (also called by "Delete all local data"). */
export function clearExports(): void {
  const dir = new Directory(Paths.cache, 'exports');
  if (dir.exists) dir.delete();
}
