/**
 * The subset of Cloudflare D1 the backend uses. Declared structurally so tests can run the
 * same queries against Node's built-in SQLite.
 */
export interface SqlStatement {
  bind(...values: unknown[]): SqlStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes: number } }>;
}

export interface SqlDatabase {
  prepare(sql: string): SqlStatement;
  batch(statements: SqlStatement[]): Promise<Array<{ meta: { changes: number } }>>;
}

export interface DeviceRow {
  id: string;
  name: string;
  token_hash: string;
  revoked_at: number | null;
}

export interface ConnectionRow {
  id: string;
  provider: string;
  account_hash: string;
  account_label: string;
  status: 'active' | 'needs_reauth' | 'error' | 'revoked';
  scopes: string;
  refresh_token_enc: string | null;
  access_token_enc: string | null;
  access_expires_at: number | null;
  created_at: number;
  updated_at: number;
  last_success_at: number | null;
  last_error_at: number | null;
  last_error: string | null;
  consecutive_failures: number;
  next_attempt_at: number | null;
}

export interface CursorRow {
  connection_id: string;
  institution_id: string;
  cursor: string | null;
  backfill_complete: number;
  last_success_at: number | null;
}

export interface SyncRunRow {
  id: string;
  connection_id: string;
  trigger: 'cron' | 'manual';
  started_at: number;
  finished_at: number | null;
  status: string;
  new_messages: number;
  error_kind: string | null;
  error_message: string | null;
}
