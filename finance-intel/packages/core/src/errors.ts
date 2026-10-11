/**
 * Error taxonomy shared by every provider adapter. The kind drives retry and UI behaviour;
 * messages must never contain tokens, passwords, account numbers or email bodies.
 */
export type ProviderErrorKind =
  /** Token expired or was revoked; the user must reconnect. Not retried. */
  | 'auth_expired'
  /** Source asked us to slow down. Retried after `retryAfterMs`. */
  | 'rate_limited'
  /** Network failure or 5xx. Retried with backoff. */
  | 'transient'
  /** Request is wrong or the source rejected it permanently. Not retried. */
  | 'permanent'
  /** Data arrived but could not be understood; quarantined, not retried. */
  | 'parse_failed';

export class ProviderError extends Error {
  override readonly name = 'ProviderError';

  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
    readonly options: { retryAfterMs?: number; httpStatus?: number } = {},
  ) {
    super(message);
  }

  get retryable(): boolean {
    return this.kind === 'transient' || this.kind === 'rate_limited';
  }
}

/** Maps an HTTP status from a provider API onto the shared taxonomy. */
export function classifyHttpStatus(status: number): ProviderErrorKind {
  if (status === 401) return 'auth_expired';
  if (status === 429) return 'rate_limited';
  if (status === 408 || status >= 500) return 'transient';
  return 'permanent';
}

const SECRET_PATTERNS: readonly RegExp[] = [
  /ya29\.[\w.-]+/g, // Google access tokens
  /1\/\/[\w.-]{20,}/g, // Google refresh tokens
  /\b(?:access|refresh|id)_token["'=:\s]+[\w.-]+/gi,
  /\bBearer\s+[\w.-]+/gi,
  /[\w.+-]+@[\w-]+\.[\w.-]+/g, // email addresses
  /\b\d{9,18}\b/g, // account / card numbers
];

/** Strips anything that looks like a secret or personal identifier before logging. */
export function redact(text: string): string {
  return SECRET_PATTERNS.reduce((acc, pattern) => acc.replace(pattern, '[redacted]'), text);
}
