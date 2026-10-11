import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { SqlDatabase, SqlStatement } from '../src/db';
import type { Deps, Env } from '../src/env';
import { bytesToBase64 } from '../src/crypto';

/** D1-compatible facade over Node's built-in SQLite, running the real migration. */
export function createTestDb(): SqlDatabase & { raw: DatabaseSync } {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  raw.exec(readFileSync(fileURLToPath(new URL('../migrations/0001_init.sql', import.meta.url)), 'utf8'));

  const statement = (sql: string, values: SQLInputValue[] = []): SqlStatement => ({
    bind: (...next: unknown[]) => statement(sql, next as SQLInputValue[]),
    async first<T>() {
      return (raw.prepare(sql).get(...values) as T | undefined) ?? null;
    },
    async all<T>() {
      return { results: raw.prepare(sql).all(...values) as T[] };
    },
    async run() {
      const result = raw.prepare(sql).run(...values);
      return { meta: { changes: Number(result.changes) } };
    },
  });

  return {
    raw,
    prepare: (sql) => statement(sql),
    async batch(statements) {
      raw.exec('BEGIN');
      try {
        const results = [];
        for (const s of statements) results.push(await s.run());
        raw.exec('COMMIT');
        return results;
      } catch (error) {
        raw.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

export function createEnv(db: SqlDatabase): Env {
  return {
    DB: db,
    PUBLIC_BASE_URL: 'https://fi.test',
    APP_REDIRECT_URI: 'financeintel://oauth',
    GOOGLE_CLIENT_ID: 'client-id',
    GOOGLE_CLIENT_SECRET: 'client-secret',
    TOKEN_ENCRYPTION_KEY: bytesToBase64(new Uint8Array(32).fill(7)),
    ENROLLMENT_CODE: 'enrol-me-please-0123456789',
  };
}

type Handler = (url: URL, init: RequestInit | undefined) => Response | Promise<Response>;

/** Scriptable fake for Google's OAuth and Gmail endpoints. Records every call. */
export class FakeGoogle {
  calls: Array<{ url: URL; body: string | null }> = [];
  private routes: Array<{ match: (url: URL) => boolean; handler: Handler }> = [];
  now = Date.UTC(2026, 9, 11, 12);

  on(match: (url: URL) => boolean, handler: Handler): this {
    this.routes.unshift({ match, handler });
    return this;
  }

  deps(): Deps {
    return {
      now: () => this.now,
      fetch: async (input, init) => {
        const url = new URL(String(input));
        const body = init?.body instanceof URLSearchParams ? init.body.toString() : null;
        this.calls.push({ url, body });
        const route = this.routes.find((r) => r.match(url));
        if (!route) throw new Error(`unexpected fetch ${url}`);
        return route.handler(url, init);
      },
    };
  }
}

export const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
