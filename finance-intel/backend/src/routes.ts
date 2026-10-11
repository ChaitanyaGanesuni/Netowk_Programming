import {
  ProviderError,
  type ConnectionDto,
  type ConnectionsResponse,
  type DiscoveryResponse,
  type InboxPage,
  type StartAuthResponse,
  type SyncRunsResponse,
  EnrollRequest,
  buildGmailQuery,
} from '@fi/core';
import { encryptSecret, maskEmail, pkceChallenge, randomToken, sha256Hex, timingSafeEqual } from './crypto';
import type { ConnectionRow, CursorRow, DeviceRow, SyncRunRow } from './db';
import type { Deps, Env } from './env';
import {
  GMAIL_SCOPE,
  buildAuthUrl,
  exchangeCode,
  fetchRawMessage,
  getProfileEmail,
  listMessages,
  revokeToken,
} from './google';
import { decryptSecret } from './crypto';
import { emailInstitutions, getAccessToken, SUBREQUEST_BUDGET, syncConnection } from './gmailSync';
import { log } from './log';

const MAX_DEVICES = 3;
const OAUTH_STATE_TTL_MS = 10 * 60_000;
const MANUAL_SYNC_COOLDOWN_MS = 2 * 60_000;

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

async function authenticateDevice(request: Request, env: Env, deps: Deps): Promise<DeviceRow> {
  const header = request.headers.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) throw new HttpError(401, 'unauthenticated', 'missing device token');
  const device = await env.DB
    .prepare('SELECT * FROM devices WHERE token_hash = ? AND revoked_at IS NULL')
    .bind(await sha256Hex(token))
    .first<DeviceRow>();
  if (!device) throw new HttpError(401, 'unauthenticated', 'unknown or revoked device');
  await env.DB.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').bind(deps.now(), device.id).run();
  return device;
}

async function loadConnection(env: Env, id: string): Promise<ConnectionRow> {
  const connection = await env.DB.prepare('SELECT * FROM connections WHERE id = ?').bind(id).first<ConnectionRow>();
  if (!connection) throw new HttpError(404, 'not_found', 'connection not found');
  return connection;
}

async function toDto(env: Env, connection: ConnectionRow): Promise<ConnectionDto> {
  const { results: cursors } = await env.DB
    .prepare('SELECT * FROM sync_cursors WHERE connection_id = ?')
    .bind(connection.id)
    .all<CursorRow>();
  const { results: counts } = await env.DB
    .prepare('SELECT institution_id, COUNT(*) AS n FROM inbox WHERE connection_id = ? GROUP BY institution_id')
    .bind(connection.id)
    .all<{ institution_id: string; n: number }>();
  return {
    id: connection.id,
    provider: 'gmail',
    accountLabel: connection.account_label,
    status: connection.status,
    scopes: connection.scopes.split(' ').filter(Boolean),
    createdAt: connection.created_at,
    lastSuccessAt: connection.last_success_at,
    lastErrorAt: connection.last_error_at,
    lastError: connection.last_error,
    // Gmail grants for a production-status OAuth app have no fixed expiry; they end on
    // revocation, a password change, or ~6 months without use.
    consentExpiresAt: null,
    nextAttemptAt: connection.next_attempt_at,
    institutions: emailInstitutions().map((institution) => {
      const cursor = cursors.find((c) => c.institution_id === institution.id);
      return {
        institutionId: institution.id,
        backfillComplete: cursor?.backfill_complete === 1,
        lastSuccessAt: cursor?.last_success_at ?? null,
        messagesQueued: counts.find((c) => c.institution_id === institution.id)?.n ?? 0,
      };
    }),
  };
}

async function enroll(request: Request, env: Env, deps: Deps): Promise<Response> {
  const body = EnrollRequest.safeParse(await request.json().catch(() => null));
  if (!body.success) throw new HttpError(400, 'invalid_request', 'invalid enrollment request');
  if (!env.ENROLLMENT_CODE || !timingSafeEqual(body.data.enrollmentCode, env.ENROLLMENT_CODE)) {
    log('device.enroll_rejected');
    throw new HttpError(403, 'forbidden', 'invalid enrollment code');
  }
  const active = await env.DB.prepare('SELECT COUNT(*) AS n FROM devices WHERE revoked_at IS NULL').first<{ n: number }>();
  if ((active?.n ?? 0) >= MAX_DEVICES) throw new HttpError(409, 'device_limit', 'device limit reached; revoke a device first');
  const deviceId = randomToken(12);
  const deviceToken = randomToken(32);
  await env.DB
    .prepare('INSERT INTO devices (id, name, token_hash, created_at) VALUES (?, ?, ?, ?)')
    .bind(deviceId, body.data.deviceName, await sha256Hex(deviceToken), deps.now())
    .run();
  log('device.enrolled', { device: deviceId });
  return json({ deviceId, deviceToken }, 201);
}

async function startGmailAuth(env: Env, deps: Deps, device: DeviceRow): Promise<Response> {
  const state = randomToken(24);
  const verifier = randomToken(48);
  await env.DB
    .prepare('INSERT INTO oauth_states (state, device_id, code_verifier, created_at) VALUES (?, ?, ?, ?)')
    .bind(state, device.id, verifier, deps.now())
    .run();
  const body: StartAuthResponse = { authUrl: buildAuthUrl(env, state, await pkceChallenge(verifier)) };
  return json(body);
}

function appRedirect(env: Env, params: Record<string, string>): Response {
  return new Response(null, { status: 302, headers: { location: `${env.APP_REDIRECT_URI}?${new URLSearchParams(params)}` } });
}

async function gmailCallback(url: URL, env: Env, deps: Deps): Promise<Response> {
  const state = url.searchParams.get('state') ?? '';
  const code = url.searchParams.get('code');
  // Single use: the state row is deleted as it is read.
  const pending = await env.DB
    .prepare('DELETE FROM oauth_states WHERE state = ? RETURNING device_id, code_verifier, created_at')
    .bind(state)
    .first<{ device_id: string; code_verifier: string; created_at: number }>();
  if (!pending || deps.now() - pending.created_at > OAUTH_STATE_TTL_MS) {
    return appRedirect(env, { status: 'error', code: 'invalid_state' });
  }
  if (!code) return appRedirect(env, { status: 'error', code: url.searchParams.get('error') ?? 'denied' });

  try {
    const tokens = await exchangeCode(env, deps, code, pending.code_verifier);
    if (!tokens.scope.split(' ').includes(GMAIL_SCOPE)) return appRedirect(env, { status: 'error', code: 'scope_not_granted' });
    if (!tokens.refresh_token) return appRedirect(env, { status: 'error', code: 'no_refresh_token' });

    const email = (await getProfileEmail(deps, tokens.access_token)).toLowerCase();
    const accountHash = await sha256Hex(email);
    const existing = await env.DB
      .prepare("SELECT id FROM connections WHERE provider = 'gmail' AND account_hash = ?")
      .bind(accountHash)
      .first<{ id: string }>();
    const id = existing?.id ?? randomToken(12);
    const now = deps.now();
    const refreshEnc = await encryptSecret(tokens.refresh_token, env.TOKEN_ENCRYPTION_KEY, `${id}:refresh`);
    const accessEnc = await encryptSecret(tokens.access_token, env.TOKEN_ENCRYPTION_KEY, `${id}:access`);
    await env.DB
      .prepare(
        `INSERT INTO connections (id, provider, account_hash, account_label, status, scopes, refresh_token_enc, access_token_enc, access_expires_at, created_at, updated_at)
         VALUES (?, 'gmail', ?, ?, 'active', ?, ?, ?, ?, ?, ?)
         ON CONFLICT (provider, account_hash) DO UPDATE SET
           status = 'active', scopes = excluded.scopes, refresh_token_enc = excluded.refresh_token_enc,
           access_token_enc = excluded.access_token_enc, access_expires_at = excluded.access_expires_at,
           updated_at = excluded.updated_at, consecutive_failures = 0, next_attempt_at = NULL,
           last_error = NULL, last_error_at = NULL`,
      )
      .bind(id, accountHash, maskEmail(email), tokens.scope, refreshEnc, accessEnc, now + tokens.expires_in * 1000, now, now)
      .run();
    log('connection.authorized', { connection: id, reconnect: Boolean(existing) });
    return appRedirect(env, { status: 'success', connectionId: id });
  } catch (error) {
    log('connection.authorize_failed', { error: error instanceof Error ? error.message : String(error) });
    return appRedirect(env, { status: 'error', code: 'exchange_failed' });
  }
}

async function discover(env: Env, deps: Deps, connection: ConnectionRow): Promise<Response> {
  const accessToken = await getAccessToken(env, deps, env.DB, connection);
  const entries = [];
  for (const institution of emailInstitutions()) {
    const query = buildGmailQuery(institution);
    if (!query) continue;
    const list = await listMessages(deps, accessToken, query, { maxResults: 1 });
    entries.push({ institutionId: institution.id, query, estimatedMessages: list.resultSizeEstimate ?? 0 });
  }
  const body: DiscoveryResponse = { connectionId: connection.id, scannedAt: deps.now(), entries };
  return json(body);
}

async function manualSync(env: Env, deps: Deps, connection: ConnectionRow): Promise<Response> {
  if (connection.status === 'needs_reauth' || connection.status === 'revoked') {
    throw new HttpError(409, 'needs_reauth', 'reconnect this account first');
  }
  const last = await env.DB
    .prepare('SELECT started_at FROM sync_runs WHERE connection_id = ? ORDER BY started_at DESC LIMIT 1')
    .bind(connection.id)
    .first<{ started_at: number }>();
  if (last && deps.now() - last.started_at < MANUAL_SYNC_COOLDOWN_MS) {
    throw new HttpError(429, 'cooldown', 'a sync ran less than two minutes ago');
  }
  return json(await syncConnection(env, deps, connection, 'manual', SUBREQUEST_BUDGET));
}

async function disconnect(env: Env, deps: Deps, connection: ConnectionRow): Promise<Response> {
  if (connection.refresh_token_enc) {
    const refreshToken = await decryptSecret(connection.refresh_token_enc, env.TOKEN_ENCRYPTION_KEY, `${connection.id}:refresh`);
    await revokeToken(deps, refreshToken);
  }
  // Cascades remove cursors, message pointers and sync history for this connection.
  await env.DB.prepare('DELETE FROM connections WHERE id = ?').bind(connection.id).run();
  log('connection.revoked', { connection: connection.id });
  return new Response(null, { status: 204 });
}

async function listRuns(env: Env, connection: ConnectionRow): Promise<Response> {
  const { results } = await env.DB
    .prepare('SELECT * FROM sync_runs WHERE connection_id = ? ORDER BY started_at DESC LIMIT 50')
    .bind(connection.id)
    .all<SyncRunRow>();
  const body: SyncRunsResponse = {
    runs: results.map((r) => ({
      id: r.id,
      connectionId: r.connection_id,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      status: r.status as SyncRunsResponse['runs'][number]['status'],
      newMessages: r.new_messages,
      errorKind: r.error_kind,
      errorMessage: r.error_message,
    })),
  };
  return json(body);
}

async function inbox(url: URL, env: Env): Promise<Response> {
  const after = Number(url.searchParams.get('after') ?? '0');
  const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') ?? '200')));
  if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit)) {
    throw new HttpError(400, 'invalid_request', 'invalid cursor');
  }
  const { results } = await env.DB
    .prepare('SELECT seq, connection_id, message_id, institution_id, discovered_at FROM inbox WHERE seq > ? ORDER BY seq LIMIT ?')
    .bind(after, limit)
    .all<{ seq: number; connection_id: string; message_id: string; institution_id: string; discovered_at: number }>();
  const body: InboxPage = {
    items: results.map((r) => ({
      connectionId: r.connection_id,
      messageId: r.message_id,
      institutionId: r.institution_id,
      discoveredAt: r.discovered_at,
    })),
    cursor: String(results.at(-1)?.seq ?? after),
    hasMore: results.length === limit,
  };
  return json(body);
}

async function rawMessage(env: Env, deps: Deps, connection: ConnectionRow, messageId: string): Promise<Response> {
  // Least privilege: only messages the sync matched to a known institution can be read.
  const known = await env.DB
    .prepare('SELECT 1 AS ok FROM inbox WHERE connection_id = ? AND message_id = ?')
    .bind(connection.id, messageId)
    .first();
  if (!known) throw new HttpError(404, 'not_found', 'message is not in the finance inbox');
  const accessToken = await getAccessToken(env, deps, env.DB, connection);
  const upstream = await fetchRawMessage(deps, accessToken, messageId);
  return new Response(upstream.body, {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

export async function handleRequest(request: Request, env: Env, deps: Deps): Promise<Response> {
  const url = new URL(request.url);
  const { pathname } = url;
  const method = request.method;
  try {
    if (method === 'GET' && pathname === '/health') return json({ ok: true });
    if (method === 'POST' && pathname === '/v1/devices/enroll') return await enroll(request, env, deps);
    if (method === 'GET' && pathname === '/oauth/google/callback') return await gmailCallback(url, env, deps);

    const device = await authenticateDevice(request, env, deps);
    if (method === 'GET' && pathname === '/v1/connections') {
      const { results } = await env.DB.prepare('SELECT * FROM connections ORDER BY created_at').all<ConnectionRow>();
      const body: ConnectionsResponse = { connections: await Promise.all(results.map((c) => toDto(env, c))) };
      return json(body);
    }
    if (method === 'POST' && pathname === '/v1/connections/gmail/start') return await startGmailAuth(env, deps, device);
    if (method === 'GET' && pathname === '/v1/inbox') return await inbox(url, env);

    const match = /^\/v1\/connections\/([\w-]+)(?:\/(discover|sync|runs|messages\/([A-Za-z0-9]+)))?$/.exec(pathname);
    if (match) {
      const [, id = '', action, messageId] = match;
      const connection = await loadConnection(env, id);
      if (method === 'DELETE' && !action) return await disconnect(env, deps, connection);
      if (method === 'POST' && action === 'discover') return await discover(env, deps, connection);
      if (method === 'POST' && action === 'sync') return await manualSync(env, deps, connection);
      if (method === 'GET' && action === 'runs') return await listRuns(env, connection);
      if (method === 'GET' && messageId) return await rawMessage(env, deps, connection, messageId);
    }
    throw new HttpError(404, 'not_found', 'no such route');
  } catch (error) {
    if (error instanceof HttpError) return json({ error: error.message, code: error.code }, error.status);
    if (error instanceof ProviderError) {
      const status = error.kind === 'auth_expired' ? 409 : error.kind === 'rate_limited' ? 429 : 502;
      return json({ error: error.message, code: error.kind }, status);
    }
    log('request.crashed', { path: pathname, error: error instanceof Error ? error.message : String(error) });
    return json({ error: 'internal error', code: 'internal' }, 500);
  }
}
