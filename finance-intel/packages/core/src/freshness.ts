export type FreshnessLevel = 'never' | 'fresh' | 'aging' | 'stale';

export interface FreshnessReport {
  level: FreshnessLevel;
  lastSuccessAt: number | null;
  ageMs: number | null;
  /** How often new data is expected from this source; drives the thresholds. */
  expectedCadenceMs: number;
}

const DAY_MS = 86_400_000;

/**
 * Data is "fresh" within one expected cadence, "aging" within two (plus a day of grace for
 * delivery delays), and "stale" beyond that. A monthly statement is therefore fresh for
 * ~31 days and only stale after ~63, while daily alerts go stale after ~3 days.
 */
export function assessFreshness(lastSuccessAt: number | null, expectedCadenceMs: number, now: number): FreshnessReport {
  if (lastSuccessAt === null) {
    return { level: 'never', lastSuccessAt, ageMs: null, expectedCadenceMs };
  }
  const ageMs = Math.max(0, now - lastSuccessAt);
  const level: FreshnessLevel =
    ageMs <= expectedCadenceMs + DAY_MS ? 'fresh' : ageMs <= 2 * expectedCadenceMs + DAY_MS ? 'aging' : 'stale';
  return { level, lastSuccessAt, ageMs, expectedCadenceMs };
}

export function daysToMs(days: number): number {
  return days * DAY_MS;
}

/** Human-readable age such as "3 h", "2 d", "5 w" for status rows. */
export function formatAge(ageMs: number | null): string {
  if (ageMs === null) return 'never';
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h`;
  const days = Math.floor(hours / 24);
  if (days < 21) return `${days} d`;
  return `${Math.floor(days / 7)} w`;
}
