import { describe, expect, it } from 'vitest';
import { ProviderError, runSync, type AuthState, type ProviderAdapter, type SyncPage, type SyncRunRecord, type SyncStore } from '../src';

interface Item {
  id: string;
}

class MemoryStore implements SyncStore<Item> {
  cursor: string | null = null;
  completed = false;
  rows = new Map<string, Item>();
  runs: SyncRunRecord[] = [];
  async loadCursor() {
    return this.cursor;
  }
  async saveCursor(_: string, cursor: string | null, completed: boolean) {
    this.cursor = cursor;
    this.completed = completed;
  }
  async upsert(_: string, items: ReadonlyArray<{ key: string; record: Item }>) {
    let inserted = 0;
    for (const { key, record } of items) {
      if (!this.rows.has(key)) {
        this.rows.set(key, record);
        inserted++;
      }
    }
    return inserted;
  }
  async lastSuccessAt() {
    return null;
  }
  async recordRun(run: SyncRunRecord) {
    this.runs.push(run);
  }
}

function pagedAdapter(pages: Array<SyncPage<Item> | Error>, auth: AuthState = { status: 'active', expiresAt: null }): ProviderAdapter<Item> & { calls: Array<string | null> } {
  const calls: Array<string | null> = [];
  return {
    id: 'fake',
    expectedCadenceMs: 1000,
    calls,
    async ensureAuthorized() {
      return auth;
    },
    async discoverAccounts() {
      return [];
    },
    async fetchPage(cursor) {
      calls.push(cursor);
      const next = pages.shift();
      if (!next) throw new Error('no more pages scripted');
      if (next instanceof Error) throw next;
      return next;
    },
    dedupKey: (record) => record.id,
    async revoke() {},
  };
}

const opts = { maxPages: 10, sleep: async () => {}, now: () => 1000 };

describe('runSync', () => {
  it('pages through, dedups and advances the cursor', async () => {
    const store = new MemoryStore();
    const adapter = pagedAdapter([
      { records: [{ id: 'a' }, { id: 'b' }, { id: 'a' }], nextCursor: 'p2', done: false },
      { records: [{ id: 'b' }, { id: 'c' }], nextCursor: 'end', done: true },
    ]);
    const run = await runSync(adapter, store, opts);
    expect(run.status).toBe('success');
    expect(run.pages).toBe(2);
    expect(run.received).toBe(5);
    expect(run.inserted).toBe(3);
    expect(adapter.calls).toEqual([null, 'p2']);
    expect(store.cursor).toBe('end');
    expect(store.completed).toBe(true);
    expect(store.runs).toHaveLength(1);
  });

  it('is idempotent when a run is replayed', async () => {
    const store = new MemoryStore();
    const page = (): SyncPage<Item> => ({ records: [{ id: 'x' }], nextCursor: null, done: true });
    await runSync(pagedAdapter([page()]), store, opts);
    const second = await runSync(pagedAdapter([page()]), store, opts);
    expect(second.inserted).toBe(0);
    expect(store.rows.size).toBe(1);
  });

  it('marks partial when the page budget runs out and resumes from the saved cursor', async () => {
    const store = new MemoryStore();
    const first = await runSync(
      pagedAdapter([{ records: [{ id: '1' }], nextCursor: 'c1', done: false }]),
      store,
      { ...opts, maxPages: 1 },
    );
    expect(first.status).toBe('partial');
    const adapter = pagedAdapter([{ records: [{ id: '2' }], nextCursor: null, done: true }]);
    await runSync(adapter, store, opts);
    expect(adapter.calls).toEqual(['c1']);
  });

  it('keeps progress before a failure and records a redacted error', async () => {
    const store = new MemoryStore();
    const adapter = pagedAdapter([
      { records: [{ id: '1' }], nextCursor: 'c1', done: false },
      new ProviderError('permanent', 'bad request for user me@example.com'),
    ]);
    const run = await runSync(adapter, store, opts);
    expect(run.status).toBe('failed');
    expect(run.errorKind).toBe('permanent');
    expect(run.errorMessage).not.toContain('me@example.com');
    expect(store.rows.has('1')).toBe(true);
    expect(store.cursor).toBe('c1');
  });

  it('retries transient page errors', async () => {
    const store = new MemoryStore();
    const adapter = pagedAdapter([
      new ProviderError('transient', '503'),
      { records: [{ id: '1' }], nextCursor: null, done: true },
    ]);
    const run = await runSync(adapter, store, opts);
    expect(run.status).toBe('success');
    expect(adapter.calls).toEqual([null, null]);
  });

  it('reports needs_reauth without fetching when the grant is gone', async () => {
    const store = new MemoryStore();
    const adapter = pagedAdapter([], { status: 'needs_reauth', expiresAt: null });
    const run = await runSync(adapter, store, opts);
    expect(run.status).toBe('needs_reauth');
    expect(adapter.calls).toEqual([]);
  });

  it('maps auth_expired thrown mid-sync to needs_reauth', async () => {
    const store = new MemoryStore();
    const adapter = pagedAdapter([new ProviderError('auth_expired', 'invalid_grant')]);
    const run = await runSync(adapter, store, opts);
    expect(run.status).toBe('needs_reauth');
  });
});
