import { z } from 'zod';
import { ProviderError, classifyHttpStatus, parseRetryAfter } from '@fi/core';
import type { Deps, Env } from './env';

export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

export function callbackUrl(env: Env): string {
  return `${env.PUBLIC_BASE_URL.replace(/\/$/, '')}/oauth/google/callback`;
}

export function buildAuthUrl(env: Env, state: string, codeChallenge: string): string {
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: callbackUrl(env),
    response_type: 'code',
    scope: GMAIL_SCOPE,
    // offline + consent makes Google return a refresh token, so syncing works with the app closed.
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'false',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  return `${AUTH_URL}?${params}`;
}

const TokenResponse = z.object({
  access_token: z.string(),
  expires_in: z.number(),
  refresh_token: z.string().optional(),
  scope: z.string(),
  token_type: z.string(),
});
export type TokenResponse = z.infer<typeof TokenResponse>;

const TokenError = z.object({ error: z.string() }).loose();

async function errorFromResponse(response: Response, deps: Deps, what: string): Promise<ProviderError> {
  let kind = classifyHttpStatus(response.status);
  if (response.status === 400) {
    const body = TokenError.safeParse(await response.json().catch(() => null));
    // invalid_grant: the refresh token was revoked, expired or the password changed.
    if (body.success && body.data.error === 'invalid_grant') kind = 'auth_expired';
  }
  const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'), deps.now());
  return new ProviderError(kind, `${what} failed with HTTP ${response.status}`, {
    httpStatus: response.status,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });
}

async function postForm(url: string, form: Record<string, string>, deps: Deps, what: string): Promise<Response> {
  let response: Response;
  try {
    response = await deps.fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form),
    });
  } catch {
    throw new ProviderError('transient', `${what} network error`);
  }
  if (!response.ok) throw await errorFromResponse(response, deps, what);
  return response;
}

export async function exchangeCode(env: Env, deps: Deps, code: string, codeVerifier: string): Promise<TokenResponse> {
  const response = await postForm(
    TOKEN_URL,
    {
      code,
      code_verifier: codeVerifier,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: callbackUrl(env),
      grant_type: 'authorization_code',
    },
    deps,
    'token exchange',
  );
  return TokenResponse.parse(await response.json());
}

export async function refreshAccessToken(env: Env, deps: Deps, refreshToken: string): Promise<TokenResponse> {
  const response = await postForm(
    TOKEN_URL,
    {
      refresh_token: refreshToken,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      grant_type: 'refresh_token',
    },
    deps,
    'token refresh',
  );
  return TokenResponse.parse(await response.json());
}

/** Revokes the grant at Google. A 400 means it was already invalid, which is fine here. */
export async function revokeToken(deps: Deps, token: string): Promise<void> {
  try {
    await postForm(REVOKE_URL, { token }, deps, 'token revoke');
  } catch (error) {
    if (error instanceof ProviderError && (error.kind === 'permanent' || error.kind === 'auth_expired')) return;
    throw error;
  }
}

async function gmailGet(deps: Deps, accessToken: string, path: string, what: string): Promise<Response> {
  let response: Response;
  try {
    response = await deps.fetch(`${GMAIL_BASE}${path}`, { headers: { authorization: `Bearer ${accessToken}` } });
  } catch {
    throw new ProviderError('transient', `${what} network error`);
  }
  if (!response.ok) throw await errorFromResponse(response, deps, what);
  return response;
}

const Profile = z.object({ emailAddress: z.string() });

export async function getProfileEmail(deps: Deps, accessToken: string): Promise<string> {
  const response = await gmailGet(deps, accessToken, '/profile', 'gmail profile');
  return Profile.parse(await response.json()).emailAddress;
}

const MessageList = z.object({
  messages: z.array(z.object({ id: z.string(), threadId: z.string() })).optional(),
  nextPageToken: z.string().optional(),
  resultSizeEstimate: z.number().optional(),
});
export type MessageList = z.infer<typeof MessageList>;

export async function listMessages(
  deps: Deps,
  accessToken: string,
  query: string,
  options: { pageToken?: string; maxResults: number },
): Promise<MessageList> {
  const params = new URLSearchParams({ q: query, maxResults: String(options.maxResults) });
  if (options.pageToken) params.set('pageToken', options.pageToken);
  const response = await gmailGet(deps, accessToken, `/messages?${params}`, 'gmail list');
  return MessageList.parse(await response.json());
}

/** Returns Gmail's response for a raw message untouched, so the worker never parses mail. */
export async function fetchRawMessage(deps: Deps, accessToken: string, messageId: string): Promise<Response> {
  if (!/^[A-Za-z0-9]+$/.test(messageId)) throw new ProviderError('permanent', 'invalid message id');
  return gmailGet(deps, accessToken, `/messages/${messageId}?format=raw`, 'gmail get');
}
