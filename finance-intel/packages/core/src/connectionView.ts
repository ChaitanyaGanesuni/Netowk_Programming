import type { ConnectionDto } from './contracts';
import { assessFreshness, daysToMs, type FreshnessReport } from './freshness';
import { INSTITUTIONS, institutionCadenceMs, type DataKind, type Institution, type ProductType } from './institutions';

export type RowStatus =
  | 'not_connected'
  | 'backfilling'
  | 'connected'
  | 'no_emails_found'
  | 'needs_reauth'
  | 'error'
  | 'never_fetched';

export type RowAction = 'connect_gmail' | 'reconnect_gmail' | 'retry' | null;

export interface PublicFeedState {
  lastSuccessAt: number | null;
  lastError: string | null;
  /** Business date the data refers to, e.g. the NAV date (YYYY-MM-DD). */
  dataAsOf: string | null;
}

export interface ConnectionRowView {
  institutionId: string;
  name: string;
  accountTypes: ProductType[];
  products: string[];
  status: RowStatus;
  statusLabel: string;
  dataAvailable: DataKind[];
  /** "Mailbox checked" for email sources, "Fetched" for public feeds. */
  lastSuccessAt: number | null;
  freshness: FreshnessReport;
  consentExpiresAt: number | null;
  consentNote: string;
  lastError: string | null;
  messagesFound: number | null;
  action: RowAction;
  limitations: readonly string[];
}

const STATUS_LABEL: Record<RowStatus, string> = {
  not_connected: 'Not connected',
  backfilling: 'Importing history',
  connected: 'Connected',
  no_emails_found: 'No emails found',
  needs_reauth: 'Reconnect needed',
  error: 'Sync error',
  never_fetched: 'Not fetched yet',
};

function dataKinds(institution: Institution): DataKind[] {
  return [...new Set(institution.channels.flatMap((channel) => channel.dataKinds))];
}

function baseRow(institution: Institution): Pick<ConnectionRowView, 'institutionId' | 'name' | 'accountTypes' | 'products' | 'dataAvailable' | 'limitations'> {
  return {
    institutionId: institution.id,
    name: institution.name,
    accountTypes: [...new Set(institution.products.map((p) => p.type))],
    products: institution.products.map((p) => p.name),
    dataAvailable: dataKinds(institution),
    limitations: institution.limitations,
  };
}

const GMAIL_CONSENT_NOTE = 'No fixed expiry. Ends if you revoke access, change your Google password, or the app is unused for ~6 months.';

function emailRow(institution: Institution, gmail: ConnectionDto | undefined, now: number): ConnectionRowView {
  const cadence = institutionCadenceMs(institution);
  if (!gmail) {
    return {
      ...baseRow(institution),
      status: 'not_connected',
      statusLabel: STATUS_LABEL.not_connected,
      lastSuccessAt: null,
      freshness: assessFreshness(null, cadence, now),
      consentExpiresAt: null,
      consentNote: 'Connect Gmail to start importing this institution’s emails.',
      lastError: null,
      messagesFound: null,
      action: 'connect_gmail',
    };
  }
  const state = gmail.institutions.find((i) => i.institutionId === institution.id);
  const lastSuccessAt = state?.lastSuccessAt ?? null;
  let status: RowStatus;
  if (gmail.status === 'needs_reauth' || gmail.status === 'revoked') status = 'needs_reauth';
  else if (gmail.status === 'error') status = 'error';
  else if (!state?.backfillComplete) status = 'backfilling';
  else if (state.messagesQueued === 0) status = 'no_emails_found';
  else status = 'connected';

  return {
    ...baseRow(institution),
    status,
    statusLabel: STATUS_LABEL[status],
    lastSuccessAt,
    freshness: assessFreshness(lastSuccessAt, cadence, now),
    consentExpiresAt: gmail.consentExpiresAt,
    consentNote: GMAIL_CONSENT_NOTE,
    lastError: status === 'error' || status === 'needs_reauth' ? gmail.lastError : null,
    messagesFound: state?.messagesQueued ?? 0,
    action: status === 'needs_reauth' ? 'reconnect_gmail' : status === 'error' ? 'retry' : null,
  };
}

function feedRow(institution: Institution, feed: PublicFeedState | undefined, now: number): ConnectionRowView {
  const cadence = institutionCadenceMs(institution);
  const lastSuccessAt = feed?.lastSuccessAt ?? null;
  // A NAV dated Friday is current all weekend, so judge feed data by its business date
  // with a 3-day allowance, not only by when we fetched it.
  const asOf = feed?.dataAsOf ? Date.parse(`${feed.dataAsOf}T00:00:00Z`) : null;
  const freshness = asOf === null ? assessFreshness(lastSuccessAt, cadence, now) : assessFreshness(asOf, cadence + daysToMs(2), now);
  const status: RowStatus = feed?.lastError && !lastSuccessAt ? 'error' : lastSuccessAt ? 'connected' : 'never_fetched';
  return {
    ...baseRow(institution),
    status,
    statusLabel: feed?.lastError && lastSuccessAt ? 'Using last good data' : STATUS_LABEL[status],
    lastSuccessAt,
    freshness,
    consentExpiresAt: null,
    consentNote: 'Public data; no login or consent needed.',
    lastError: feed?.lastError ?? null,
    messagesFound: null,
    action: feed?.lastError ? 'retry' : null,
  };
}

/**
 * Builds the connections screen: one row per institution in the registry, combining the
 * Gmail connection's per-institution sync state with locally fetched public feeds.
 */
export function buildConnectionRows(
  connections: readonly ConnectionDto[],
  feeds: Readonly<Record<string, PublicFeedState>>,
  now: number,
): ConnectionRowView[] {
  const gmail = connections.find((c) => c.provider === 'gmail');
  return INSTITUTIONS.map((institution) =>
    institution.channels.every((c) => c.kind === 'public_feed')
      ? feedRow(institution, feeds[institution.id], now)
      : emailRow(institution, gmail, now),
  );
}
