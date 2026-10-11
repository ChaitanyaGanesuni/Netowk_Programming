import type { z } from 'zod';
import {
  ConnectionsResponse,
  DiscoveryResponse,
  EnrollResponse,
  ErrorResponse,
  InboxPage,
  RawMessageResponse,
  ProviderError,
  StartAuthResponse,
  SyncRunsResponse,
  classifyHttpStatus,
  parseRetryAfter,
} from '@fi/core';
import type { BackendCredentials } from './secrets';

export class ApiError extends Error {
  override readonly name = 'ApiError';
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function parseError(response: Response): Promise<ApiError> {
  const body = ErrorResponse.safeParse(await response.json().catch(() => null));
  return new ApiError(response.status, body.success ? body.data.code : 'http_error', body.success ? body.data.error : `HTTP ${response.status}`);
}

/** Enrols this device with the one-time code configured on the backend. */
export async function enrollDevice(backendUrl: string, enrollmentCode: string, deviceName: string): Promise<EnrollResponse> {
  const response = await fetch(`${backendUrl}/v1/devices/enroll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enrollmentCode, deviceName }),
  });
  if (!response.ok) throw await parseError(response);
  return EnrollResponse.parse(await response.json());
}

/** Typed client for the integration backend. Every response is validated before use. */
export class BackendClient {
  constructor(private readonly credentials: BackendCredentials) {}

  private async request<S extends z.ZodType>(path: string, schema: S, init: RequestInit = {}): Promise<z.infer<S>> {
    let response: Response;
    try {
      response = await fetch(`${this.credentials.backendUrl}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${this.credentials.deviceToken}`, ...init.headers },
      });
    } catch {
      throw new ProviderError('transient', 'backend unreachable');
    }
    if (!response.ok) {
      const error = await parseError(response);
      // Rate limits and outages are retryable for the sync driver; other errors are not.
      const kind = classifyHttpStatus(response.status);
      if (kind === 'transient' || kind === 'rate_limited') {
        const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'), Date.now());
        throw new ProviderError(kind, error.message, retryAfterMs === undefined ? {} : { retryAfterMs });
      }
      throw error;
    }
    if (response.status === 204) return schema.parse(undefined);
    return schema.parse(await response.json());
  }

  connections() {
    return this.request('/v1/connections', ConnectionsResponse);
  }

  startGmailAuth() {
    return this.request('/v1/connections/gmail/start', StartAuthResponse, { method: 'POST' });
  }

  discover(connectionId: string) {
    return this.request(`/v1/connections/${encodeURIComponent(connectionId)}/discover`, DiscoveryResponse, { method: 'POST' });
  }

  async syncNow(connectionId: string): Promise<void> {
    const response = await fetch(`${this.credentials.backendUrl}/v1/connections/${encodeURIComponent(connectionId)}/sync`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.credentials.deviceToken}` },
    });
    // 429 = a sync just ran; that is fine for a "sync now" tap.
    if (!response.ok && response.status !== 429) throw await parseError(response);
  }

  runs(connectionId: string) {
    return this.request(`/v1/connections/${encodeURIComponent(connectionId)}/runs`, SyncRunsResponse);
  }

  inbox(after: string, limit = 200) {
    return this.request(`/v1/inbox?after=${encodeURIComponent(after)}&limit=${limit}`, InboxPage);
  }

  /** Raw RFC 5322 message (base64url). The backend only serves finance-sender messages. */
  message(connectionId: string, messageId: string) {
    return this.request(`/v1/connections/${encodeURIComponent(connectionId)}/messages/${encodeURIComponent(messageId)}`, RawMessageResponse);
  }

  async disconnect(connectionId: string): Promise<void> {
    const response = await fetch(`${this.credentials.backendUrl}/v1/connections/${encodeURIComponent(connectionId)}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${this.credentials.deviceToken}` },
    });
    if (!response.ok) throw await parseError(response);
  }
}
