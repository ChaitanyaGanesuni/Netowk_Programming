import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

type Params = unknown[];

function flatten(params: Params): SQLInputValue[] | [Record<string, SQLInputValue>] {
  if (params.length === 1 && Array.isArray(params[0])) return params[0] as SQLInputValue[];
  if (params.length === 1 && params[0] !== null && typeof params[0] === 'object' && !(params[0] instanceof Uint8Array)) {
    return [params[0] as Record<string, SQLInputValue>];
  }
  return params as SQLInputValue[];
}

/** The subset of expo-sqlite's SQLiteDatabase used by the app, backed by Node's SQLite. */
export class FakeSqliteDatabase {
  readonly raw = new DatabaseSync(':memory:');

  async execAsync(sql: string): Promise<void> {
    this.raw.exec(sql);
  }
  async runAsync(sql: string, ...params: Params) {
    const r = this.raw.prepare(sql).run(...(flatten(params) as SQLInputValue[]));
    return { changes: Number(r.changes), lastInsertRowId: Number(r.lastInsertRowid) };
  }
  async getFirstAsync<T>(sql: string, ...params: Params): Promise<T | null> {
    return (this.raw.prepare(sql).get(...(flatten(params) as SQLInputValue[])) as T | undefined) ?? null;
  }
  async getAllAsync<T>(sql: string, ...params: Params): Promise<T[]> {
    return this.raw.prepare(sql).all(...(flatten(params) as SQLInputValue[])) as T[];
  }
  async prepareAsync(sql: string) {
    const statement = this.raw.prepare(sql);
    return {
      executeAsync: async (params: Record<string, SQLInputValue>) => ({ changes: Number(statement.run(params).changes) }),
      finalizeAsync: async () => undefined,
    };
  }
  async withExclusiveTransactionAsync(task: (txn: this) => Promise<void>): Promise<void> {
    this.raw.exec('BEGIN');
    try {
      await task(this);
      this.raw.exec('COMMIT');
    } catch (error) {
      this.raw.exec('ROLLBACK');
      throw error;
    }
  }
  async withTransactionAsync(task: () => Promise<void>): Promise<void> {
    return this.withExclusiveTransactionAsync(task);
  }
  async closeAsync(): Promise<void> {}
}
