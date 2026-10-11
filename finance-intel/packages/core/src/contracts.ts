import { z } from 'zod';

/**
 * Wire contracts between the app and the integration backend. Both sides validate with these
 * schemas, so a malformed or tampered response is rejected instead of rendered.
 */

export const EnrollRequest = z.object({
  enrollmentCode: z.string().min(16).max(256),
  deviceName: z.string().min(1).max(64),
});
export type EnrollRequest = z.infer<typeof EnrollRequest>;

export const EnrollResponse = z.object({
  deviceId: z.string(),
  deviceToken: z.string().min(32),
});
export type EnrollResponse = z.infer<typeof EnrollResponse>;

export const ConnectionStatus = z.enum(['active', 'needs_reauth', 'error', 'revoked']);
export type ConnectionStatus = z.infer<typeof ConnectionStatus>;

export const ConnectionProvider = z.enum(['gmail']);
export type ConnectionProvider = z.infer<typeof ConnectionProvider>;

export const InstitutionSyncState = z.object({
  institutionId: z.string(),
  backfillComplete: z.boolean(),
  lastSuccessAt: z.number().int().nullable(),
  messagesQueued: z.number().int().nonnegative(),
});
export type InstitutionSyncState = z.infer<typeof InstitutionSyncState>;

export const ConnectionDto = z.object({
  id: z.string(),
  provider: ConnectionProvider,
  /** Masked account label, e.g. "c•••••@gmail.com". */
  accountLabel: z.string(),
  status: ConnectionStatus,
  scopes: z.array(z.string()),
  createdAt: z.number().int(),
  lastSuccessAt: z.number().int().nullable(),
  lastErrorAt: z.number().int().nullable(),
  lastError: z.string().nullable(),
  /** Null when the grant has no fixed expiry (Gmail in production mode). */
  consentExpiresAt: z.number().int().nullable(),
  nextAttemptAt: z.number().int().nullable(),
  institutions: z.array(InstitutionSyncState),
});
export type ConnectionDto = z.infer<typeof ConnectionDto>;

export const ConnectionsResponse = z.object({ connections: z.array(ConnectionDto) });
export type ConnectionsResponse = z.infer<typeof ConnectionsResponse>;

export const StartAuthResponse = z.object({ authUrl: z.string().url() });
export type StartAuthResponse = z.infer<typeof StartAuthResponse>;

export const DiscoveryEntry = z.object({
  institutionId: z.string(),
  query: z.string(),
  /** Gmail's estimate of matching messages; an estimate, not an exact count. */
  estimatedMessages: z.number().int().nonnegative(),
});
export const DiscoveryResponse = z.object({
  connectionId: z.string(),
  scannedAt: z.number().int(),
  entries: z.array(DiscoveryEntry),
});
export type DiscoveryResponse = z.infer<typeof DiscoveryResponse>;

export const InboxItem = z.object({
  connectionId: z.string(),
  messageId: z.string(),
  institutionId: z.string(),
  discoveredAt: z.number().int(),
});
export type InboxItem = z.infer<typeof InboxItem>;

export const InboxPage = z.object({
  items: z.array(InboxItem),
  /** Position to pass back as `after`; persist it even when no items were returned. */
  cursor: z.string(),
  hasMore: z.boolean(),
});
export type InboxPage = z.infer<typeof InboxPage>;

export const SyncRunDto = z.object({
  id: z.string(),
  connectionId: z.string(),
  startedAt: z.number().int(),
  finishedAt: z.number().int().nullable(),
  status: z.enum(['running', 'success', 'partial', 'failed', 'needs_reauth']),
  newMessages: z.number().int().nonnegative(),
  errorKind: z.string().nullable(),
  errorMessage: z.string().nullable(),
});
export type SyncRunDto = z.infer<typeof SyncRunDto>;

export const SyncRunsResponse = z.object({ runs: z.array(SyncRunDto) });
export type SyncRunsResponse = z.infer<typeof SyncRunsResponse>;

export const ErrorResponse = z.object({ error: z.string(), code: z.string() });
export type ErrorResponse = z.infer<typeof ErrorResponse>;
