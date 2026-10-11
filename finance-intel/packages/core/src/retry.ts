import { ProviderError } from './errors';

export interface BackoffPolicy {
  baseMs: number;
  maxMs: number;
  maxAttempts: number;
}

export const DEFAULT_BACKOFF: BackoffPolicy = { baseMs: 500, maxMs: 30_000, maxAttempts: 5 };

/** Exponential backoff with full jitter. `attempt` is 1 for the first retry. */
export function backoffDelayMs(attempt: number, policy: BackoffPolicy, random: () => number = Math.random): number {
  const ceiling = Math.min(policy.maxMs, policy.baseMs * 2 ** (attempt - 1));
  return Math.floor(random() * ceiling);
}

/** Parses a Retry-After header (seconds or HTTP date) into milliseconds from `now`. */
export function parseRetryAfter(header: string | null, now: number): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(header);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
}

export interface RetryDeps {
  sleep: (ms: number) => Promise<void>;
  random?: () => number;
}

export const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `fn`, retrying ProviderErrors that are retryable. Rate-limit errors wait at least
 * the source's Retry-After. Non-provider errors and non-retryable kinds propagate at once.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  policy: BackoffPolicy = DEFAULT_BACKOFF,
  deps: RetryDeps = { sleep: realSleep },
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      if (!(error instanceof ProviderError) || !error.retryable || attempt >= policy.maxAttempts) {
        throw error;
      }
      const backoff = backoffDelayMs(attempt, policy, deps.random);
      const delay = Math.max(backoff, error.options.retryAfterMs ?? 0);
      await deps.sleep(delay);
    }
  }
}
