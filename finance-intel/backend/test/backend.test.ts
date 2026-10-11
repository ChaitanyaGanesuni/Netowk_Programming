import { beforeEach, describe, expect, it } from 'vitest';
import { ConnectionsResponse, InboxPage, StartAuthResponse, SyncRunsResponse, DiscoveryResponse } from '@fi/core';
import { handleRequest } from '../src/routes';
import { runScheduled } from '../src/gmailSync';
import { decryptSecret, encryptSecret, maskEmail, pkceChallenge } from '../src/crypto';
import type { ConnectionRow } from '../src/db';
import type { Env } from '../src/env';
import { FakeGoogle, createEnv, createTestDb, jsonResponse } from './harness';

const BASE = 'https://fi.test';

let db: ReturnType<typeof createTestDb>;
let env: Env;
let google: FakeGoogle;

async function call(path: string, init: RequestInit & { token?: string } = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.token) headers.set('authorization', `Bearer ${init.token}`);
  return handleRequest(new Request(`${BASE}${path}`, { ...init, headers }), env, google.deps());
}

async function enroll(): Promise<string> {
  const res = await call('/v1/devices/enroll', {
    method: 'POST',
    body: JSON.stringify({ enrollmentCode: env.ENROLLMENT_CODE, deviceName: 'Pixel' }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { deviceToken: string }).deviceToken;
}

function stubTokenEndpoint(refreshToken = '1//refresh-token-abcdefghijklmnopqrstuvwxyz'): void {
  google.on(
    (u) => u.hostname === 'oauth2.googleapis.com' && u.pathname === '/token',
    () =>
      jsonResponse({
        access_token: 'ya29.access-token',
        expires_in: 3600,
        refresh_token: refreshToken,
        scope: 'https://www.googleapis.com/auth/gmail.readonly',
        token_type: 'Bearer',
      }),
  );
  google.on((u) => u.pathname.endsWith('/profile'), () => jsonResponse({ emailAddress: 'Chaitanya@Gmail.com' }));
}

/** Gmail list fake: HDFC has two pages of mail, everyone else has none. */
function stubGmailList(): void {
  google.on(
    (u) => u.pathname.endsWith('/users/me/messages'),
    (u) => {
      const q = u.searchParams.get('q') ?? '';
      if (u.searchParams.get('maxResults') === '1') return jsonResponse({ resultSizeEstimate: q.includes('hdfcbank') ? 42 : 0 });
      if (!q.includes('hdfcbank')) return jsonResponse({ resultSizeEstimate: 0 });
      if (q.includes('after:')) return jsonResponse({ messages: [{ id: 'm3', threadId: 't3' }], resultSizeEstimate: 1 });
      if (u.searchParams.get('pageToken') === 'p2') return jsonResponse({ messages: [{ id: 'm2', threadId: 't2' }], resultSizeEstimate: 2 });
      return jsonResponse({ messages: [{ id: 'm1', threadId: 't1' }], nextPageToken: 'p2', resultSizeEstimate: 2 });
    },
  );
}

async function connectGmail(token: string): Promise<string> {
  stubTokenEndpoint();
  const start = StartAuthResponse.parse(await (await call('/v1/connections/gmail/start', { method: 'POST', token })).json());
  const state = new URL(start.authUrl).searchParams.get('state') ?? '';
  const res = await call(`/oauth/google/callback?state=${state}&code=auth-code`);
  expect(res.status).toBe(302);
  const location = new URL(res.headers.get('location') ?? '');
  expect(location.searchParams.get('status')).toBe('success');
  return location.searchParams.get('connectionId') ?? '';
}

function connectionRow(id: string): ConnectionRow {
  return db.raw.prepare('SELECT * FROM connections WHERE id = ?').get(id) as unknown as ConnectionRow;
}

beforeEach(() => {
  db = createTestDb();
  env = createEnv(db);
  google = new FakeGoogle();
});

describe('crypto', () => {
  it('round-trips secrets and binds them to their context', async () => {
    const sealed = await encryptSecret('secret', env.TOKEN_ENCRYPTION_KEY, 'conn-1:refresh');
    expect(sealed).not.toContain('secret');
    expect(await decryptSecret(sealed, env.TOKEN_ENCRYPTION_KEY, 'conn-1:refresh')).toBe('secret');
    await expect(decryptSecret(sealed, env.TOKEN_ENCRYPTION_KEY, 'conn-2:refresh')).rejects.toThrow();
  });

  it('computes the RFC 7636 PKCE example challenge', async () => {
    expect(await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('masks emails', () => {
    expect(maskEmail('chaitanya@gmail.com')).toBe('c••••••••@gmail.com');
  });
});

describe('device enrolment', () => {
  it('rejects a wrong code and unauthenticated calls', async () => {
    const bad = await call('/v1/devices/enroll', { method: 'POST', body: JSON.stringify({ enrollmentCode: 'x'.repeat(20), deviceName: 'p' }) });
    expect(bad.status).toBe(403);
    expect((await call('/v1/connections')).status).toBe(401);
    expect((await call('/v1/connections', { token: 'nope' })).status).toBe(401);
  });

  it('issues a working token and caps the device count', async () => {
    const token = await enroll();
    expect((await call('/v1/connections', { token })).status).toBe(200);
    await enroll();
    await enroll();
    const fourth = await call('/v1/devices/enroll', {
      method: 'POST',
      body: JSON.stringify({ enrollmentCode: env.ENROLLMENT_CODE, deviceName: 'x' }),
    });
    expect(fourth.status).toBe(409);
  });

  it('stores only a hash of the device token', async () => {
    const token = await enroll();
    const row = db.raw.prepare('SELECT token_hash FROM devices').get() as { token_hash: string };
    expect(row.token_hash).not.toBe(token);
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('Gmail OAuth', () => {
  it('builds an offline PKCE authorization request', async () => {
    const token = await enroll();
    const start = StartAuthResponse.parse(await (await call('/v1/connections/gmail/start', { method: 'POST', token })).json());
    const url = new URL(start.authUrl);
    expect(url.origin).toBe('https://accounts.google.com');
    expect(url.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/gmail.readonly');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('redirect_uri')).toBe('https://fi.test/oauth/google/callback');
  });

  it('stores encrypted tokens and a masked label, never the address', async () => {
    const token = await enroll();
    const id = await connectGmail(token);
    const row = connectionRow(id);
    expect(row.status).toBe('active');
    expect(row.account_label).toBe('c••••••••@gmail.com');
    expect(JSON.stringify(row)).not.toContain('refresh-token');
    expect(JSON.stringify(row)).not.toContain('ya29');
    expect(JSON.stringify(row).toLowerCase()).not.toContain('chaitanya@gmail.com');
    const exchange = google.calls.find((c) => c.url.pathname === '/token');
    expect(exchange?.body).toContain('code_verifier=');
  });

  it('rejects replayed and expired state', async () => {
    const token = await enroll();
    stubTokenEndpoint();
    const start = StartAuthResponse.parse(await (await call('/v1/connections/gmail/start', { method: 'POST', token })).json());
    const state = new URL(start.authUrl).searchParams.get('state') ?? '';
    await call(`/oauth/google/callback?state=${state}&code=c`);
    const replay = await call(`/oauth/google/callback?state=${state}&code=c`);
    expect(new URL(replay.headers.get('location') ?? '').searchParams.get('code')).toBe('invalid_state');

    const second = StartAuthResponse.parse(await (await call('/v1/connections/gmail/start', { method: 'POST', token })).json());
    google.now += 11 * 60_000;
    const late = await call(`/oauth/google/callback?state=${new URL(second.authUrl).searchParams.get('state')}&code=c`);
    expect(new URL(late.headers.get('location') ?? '').searchParams.get('code')).toBe('invalid_state');
  });

  it('reconnecting the same account updates the existing connection', async () => {
    const token = await enroll();
    const first = await connectGmail(token);
    const second = await connectGmail(token);
    expect(second).toBe(first);
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM connections').get()).toEqual({ n: 1 });
  });
});

describe('sync', () => {
  it('backfills with pagination, then syncs incrementally and idempotently', async () => {
    const token = await enroll();
    const id = await connectGmail(token);
    stubGmailList();

    const first = await call(`/v1/connections/${id}/sync`, { method: 'POST', token });
    expect(await first.json()).toMatchObject({ status: 'success', newMessages: 2 });

    const listCalls = google.calls.filter((c) => c.url.pathname.endsWith('/messages') && (c.url.searchParams.get('q') ?? '').includes('hdfcbank'));
    expect(listCalls).toHaveLength(2);
    expect(listCalls[1]?.url.searchParams.get('pageToken')).toBe('p2');

    google.now += 30 * 60_000;
    const second = await call(`/v1/connections/${id}/sync`, { method: 'POST', token });
    expect(await second.json()).toMatchObject({ status: 'success', newMessages: 1 });
    const lastQuery = google.calls.filter((c) => (c.url.searchParams.get('q') ?? '').includes('hdfcbank')).at(-1)?.url.searchParams.get('q');
    expect(lastQuery).toMatch(/after:\d+$/);

    google.now += 30 * 60_000;
    const third = await call(`/v1/connections/${id}/sync`, { method: 'POST', token });
    expect(await third.json()).toMatchObject({ newMessages: 0 });

    const connections = ConnectionsResponse.parse(await (await call('/v1/connections', { token })).json());
    const hdfc = connections.connections[0]?.institutions.find((i) => i.institutionId === 'hdfc');
    expect(hdfc).toMatchObject({ backfillComplete: true, messagesQueued: 3 });
    expect(connections.connections[0]?.lastSuccessAt).toBe(google.now);

    const runs = SyncRunsResponse.parse(await (await call(`/v1/connections/${id}/runs`, { token })).json());
    expect(runs.runs.map((r) => r.newMessages)).toEqual([0, 1, 2]);
  });

  it('enforces a cooldown on manual syncs', async () => {
    const token = await enroll();
    const id = await connectGmail(token);
    stubGmailList();
    await call(`/v1/connections/${id}/sync`, { method: 'POST', token });
    expect((await call(`/v1/connections/${id}/sync`, { method: 'POST', token })).status).toBe(429);
  });

  it('marks the connection needs_reauth when Google rejects the refresh token', async () => {
    const token = await enroll();
    const id = await connectGmail(token);
    google.now += 2 * 3_600_000; // access token expired
    google.on((u) => u.pathname === '/token', () => jsonResponse({ error: 'invalid_grant' }, 400));
    const res = await call(`/v1/connections/${id}/sync`, { method: 'POST', token });
    expect(await res.json()).toMatchObject({ status: 'needs_reauth' });
    const row = connectionRow(id);
    expect(row.status).toBe('needs_reauth');
    expect(row.last_error).toContain('Reconnect');
    expect((await call(`/v1/connections/${id}/sync`, { method: 'POST', token })).status).toBe(409);
  });

  it('backs off after failures and the cron skips the connection until then', async () => {
    const token = await enroll();
    const id = await connectGmail(token);
    google.on((u) => u.pathname.endsWith('/users/me/messages'), () => jsonResponse({ error: 'boom' }, 500));
    await runScheduled(env, google.deps());
    const row = connectionRow(id);
    expect(row.status).toBe('error');
    expect(row.consecutive_failures).toBe(1);
    expect(row.next_attempt_at).toBeGreaterThan(google.now);

    const before = google.calls.length;
    await runScheduled(env, google.deps());
    expect(google.calls.length).toBe(before);

    stubGmailList();
    google.now = (row.next_attempt_at ?? 0) + 1;
    await runScheduled(env, google.deps());
    expect(connectionRow(id)).toMatchObject({ status: 'active', consecutive_failures: 0 });
  });

  it('reports discovery estimates per institution', async () => {
    const token = await enroll();
    const id = await connectGmail(token);
    stubGmailList();
    const body = DiscoveryResponse.parse(await (await call(`/v1/connections/${id}/discover`, { method: 'POST', token })).json());
    expect(body.entries.find((e) => e.institutionId === 'hdfc')?.estimatedMessages).toBe(42);
    expect(body.entries.find((e) => e.institutionId === 'sbi')?.estimatedMessages).toBe(0);
    expect(body.entries.some((e) => e.institutionId === 'amfi')).toBe(false);
  });
});

describe('inbox and message access', () => {
  it('pages message pointers by sequence', async () => {
    const token = await enroll();
    const id = await connectGmail(token);
    stubGmailList();
    await call(`/v1/connections/${id}/sync`, { method: 'POST', token });

    const page1 = InboxPage.parse(await (await call('/v1/inbox?after=0&limit=1', { token })).json());
    expect(page1.items.map((i) => i.messageId)).toEqual(['m1']);
    expect(page1.hasMore).toBe(true);
    const page2 = InboxPage.parse(await (await call(`/v1/inbox?after=${page1.cursor}&limit=1`, { token })).json());
    expect(page2.items.map((i) => i.messageId)).toEqual(['m2']);
    const page3 = InboxPage.parse(await (await call(`/v1/inbox?after=${page2.cursor}&limit=1`, { token })).json());
    expect(page3).toMatchObject({ items: [], cursor: page2.cursor, hasMore: false });
  });

  it('only proxies messages that were matched to an institution', async () => {
    const token = await enroll();
    const id = await connectGmail(token);
    stubGmailList();
    await call(`/v1/connections/${id}/sync`, { method: 'POST', token });
    google.on((u) => /\/messages\/m1$/.test(u.pathname), () => jsonResponse({ id: 'm1', raw: 'aGVsbG8' }));

    const ok = await call(`/v1/connections/${id}/messages/m1`, { token });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ id: 'm1', raw: 'aGVsbG8' });
    expect(ok.headers.get('cache-control')).toBe('no-store');

    const denied = await call(`/v1/connections/${id}/messages/personal123`, { token });
    expect(denied.status).toBe(404);
  });
});

describe('disconnect', () => {
  it('revokes at Google and deletes all connection data', async () => {
    const token = await enroll();
    const id = await connectGmail(token);
    stubGmailList();
    await call(`/v1/connections/${id}/sync`, { method: 'POST', token });
    google.on((u) => u.pathname === '/revoke', () => new Response('', { status: 200 }));

    const res = await call(`/v1/connections/${id}`, { method: 'DELETE', token });
    expect(res.status).toBe(204);
    expect(google.calls.at(-1)?.body).toContain('token=1%2F%2Frefresh-token');
    for (const table of ['connections', 'inbox', 'sync_cursors', 'sync_runs']) {
      expect(db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    }
  });
});
