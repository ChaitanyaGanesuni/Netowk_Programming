import { redact } from '@fi/core';

/** Structured, redacted logging. Never pass tokens or message contents here. */
export function log(event: string, fields: Record<string, string | number | boolean | null> = {}): void {
  const safe: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(fields)) safe[key] = typeof value === 'string' ? redact(value) : value;
  console.log(JSON.stringify({ event, ...safe }));
}
