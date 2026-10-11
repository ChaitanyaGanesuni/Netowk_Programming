import { daysToMs } from './freshness';

export type InstitutionType = 'bank' | 'card_issuer' | 'broker' | 'depository' | 'rta' | 'market_data';

export type DataKind =
  | 'bank_transactions'
  | 'bank_balance'
  | 'card_transactions'
  | 'card_statement'
  | 'demat_holdings'
  | 'mf_holdings'
  | 'mf_transactions'
  | 'broker_contract_notes'
  | 'fixed_deposits'
  | 'nav_prices';

export type ProductType = 'savings_account' | 'credit_card' | 'demat_account' | 'mutual_fund_folios' | 'market_feed';

/** How data reaches us. Every channel here is read through an authorized integration. */
export type ChannelKind = 'email_alert' | 'email_statement' | 'email_cas' | 'email_confirmation' | 'public_feed';

export interface EmailChannel {
  kind: Exclude<ChannelKind, 'public_feed'>;
  /**
   * Gmail `from:` terms (domains or addresses). These are UNVERIFIED until the discovery scan
   * finds matching mail in your inbox and you confirm with samples; `verified` tracks that.
   */
  senders: readonly string[];
  verified: boolean;
  /** Typical gap between messages, used for freshness. */
  expectedCadenceDays: number;
  dataKinds: readonly DataKind[];
}

export interface PublicFeedChannel {
  kind: 'public_feed';
  url: string;
  expectedCadenceDays: number;
  dataKinds: readonly DataKind[];
}

export type Channel = EmailChannel | PublicFeedChannel;

export interface Product {
  id: string;
  name: string;
  type: ProductType;
}

export interface Institution {
  id: string;
  name: string;
  type: InstitutionType;
  products: readonly Product[];
  channels: readonly Channel[];
  /** Things this source cannot provide, shown on the connections screen. */
  limitations: readonly string[];
}

/**
 * The institutions you hold accounts with (as of 2026-10-11), plus the depositories, RTAs and
 * the AMFI NAV feed that cover your investments. Add new institutions here; nothing else in
 * the app hard-codes institution names.
 */
export const INSTITUTIONS: readonly Institution[] = [
  {
    id: 'sbi',
    name: 'State Bank of India',
    type: 'bank',
    products: [{ id: 'sbi-savings', name: 'SBI savings account', type: 'savings_account' }],
    channels: [
      { kind: 'email_alert', senders: ['sbi.co.in'], verified: false, expectedCadenceDays: 3, dataKinds: ['bank_transactions', 'bank_balance'] },
      { kind: 'email_statement', senders: ['sbi.co.in'], verified: false, expectedCadenceDays: 31, dataKinds: ['bank_transactions', 'bank_balance', 'fixed_deposits'] },
    ],
    limitations: [
      'SBI sends many transaction alerts by SMS only; those appear when the monthly e-statement arrives.',
      'E-statement email delivery must be enabled in YONO/net-banking.',
    ],
  },
  {
    id: 'hdfc',
    name: 'HDFC Bank',
    type: 'bank',
    products: [
      { id: 'hdfc-savings', name: 'HDFC Bank savings account', type: 'savings_account' },
      { id: 'hdfc-swiggy-card', name: 'Swiggy HDFC Bank credit card', type: 'credit_card' },
      { id: 'hdfc-regalia-card', name: 'HDFC Bank Regalia credit card', type: 'credit_card' },
    ],
    channels: [
      { kind: 'email_alert', senders: ['hdfcbank.net', 'hdfcbank.com', 'hdfcbank.bank.in'], verified: false, expectedCadenceDays: 3, dataKinds: ['bank_transactions', 'bank_balance', 'card_transactions'] },
      { kind: 'email_statement', senders: ['hdfcbank.net', 'hdfcbank.com', 'hdfcbank.bank.in'], verified: false, expectedCadenceDays: 31, dataKinds: ['bank_transactions', 'bank_balance', 'card_statement', 'fixed_deposits'] },
    ],
    limitations: ['Card and bank alerts share sender domains; each message is attributed by card/account suffix during parsing.'],
  },
  {
    id: 'hsbc',
    name: 'HSBC India',
    type: 'card_issuer',
    products: [{ id: 'hsbc-travelone-card', name: 'HSBC TravelOne credit card', type: 'credit_card' }],
    channels: [
      { kind: 'email_alert', senders: ['hsbc.co.in'], verified: false, expectedCadenceDays: 7, dataKinds: ['card_transactions'] },
      { kind: 'email_statement', senders: ['hsbc.co.in'], verified: false, expectedCadenceDays: 31, dataKinds: ['card_statement'] },
    ],
    limitations: [],
  },
  {
    id: 'sbicard',
    name: 'SBI Card',
    type: 'card_issuer',
    products: [{ id: 'sbicard-flipkart', name: 'Flipkart SBI credit card', type: 'credit_card' }],
    channels: [
      { kind: 'email_alert', senders: ['sbicard.com'], verified: false, expectedCadenceDays: 7, dataKinds: ['card_transactions'] },
      { kind: 'email_statement', senders: ['sbicard.com'], verified: false, expectedCadenceDays: 31, dataKinds: ['card_statement'] },
    ],
    limitations: [],
  },
  {
    id: 'groww',
    name: 'Groww',
    type: 'broker',
    products: [
      { id: 'groww-demat', name: 'Groww demat & trading', type: 'demat_account' },
      { id: 'groww-mf', name: 'Mutual funds via Groww', type: 'mutual_fund_folios' },
    ],
    channels: [
      { kind: 'email_confirmation', senders: ['groww.in'], verified: false, expectedCadenceDays: 31, dataKinds: ['broker_contract_notes', 'mf_transactions'] },
    ],
    limitations: [
      'Groww Trade API costs about ₹499/month (not free), so it is not used. Holdings come from the depository CAS.',
      'Mutual fund units bought on Groww sit in AMC folios; they are read from the CAMS/KFintech CAS.',
    ],
  },
  {
    id: 'bajaj-broking',
    name: 'Bajaj Broking',
    type: 'broker',
    products: [{ id: 'bajaj-demat', name: 'Bajaj Broking demat & trading', type: 'demat_account' }],
    channels: [
      { kind: 'email_confirmation', senders: ['bajajbroking.in', 'bajajfinserv.in'], verified: false, expectedCadenceDays: 31, dataKinds: ['broker_contract_notes'] },
    ],
    limitations: ['Bajaj Broking API pricing is unpublished, so it is not used. Holdings come from the depository CAS.'],
  },
  {
    id: 'cdsl',
    name: 'CDSL (depository CAS)',
    type: 'depository',
    products: [],
    channels: [
      { kind: 'email_cas', senders: ['cdslstatement.com', 'cdslindia.com'], verified: false, expectedCadenceDays: 31, dataKinds: ['demat_holdings', 'mf_holdings'] },
    ],
    limitations: ['Monthly CAS lists holdings only, not trade-by-trade history.', 'Sent only in months with activity; otherwise every six months.'],
  },
  {
    id: 'nsdl',
    name: 'NSDL (depository CAS)',
    type: 'depository',
    products: [],
    channels: [
      { kind: 'email_cas', senders: ['nsdl.co.in', 'nsdl.com'], verified: false, expectedCadenceDays: 31, dataKinds: ['demat_holdings', 'mf_holdings'] },
    ],
    limitations: ['Only one depository sends your consolidated CAS; the other row may stay empty.'],
  },
  {
    id: 'cams',
    name: 'CAMS (mutual fund RTA)',
    type: 'rta',
    products: [],
    channels: [
      { kind: 'email_cas', senders: ['camsonline.com'], verified: false, expectedCadenceDays: 92, dataKinds: ['mf_holdings', 'mf_transactions'] },
      { kind: 'email_confirmation', senders: ['camsonline.com'], verified: false, expectedCadenceDays: 31, dataKinds: ['mf_transactions'] },
    ],
    limitations: ['Full transaction history needs a one-time detailed CAS request on the CAMS website.'],
  },
  {
    id: 'kfintech',
    name: 'KFintech (mutual fund RTA)',
    type: 'rta',
    products: [],
    channels: [
      { kind: 'email_cas', senders: ['kfintech.com'], verified: false, expectedCadenceDays: 92, dataKinds: ['mf_holdings', 'mf_transactions'] },
      { kind: 'email_confirmation', senders: ['kfintech.com'], verified: false, expectedCadenceDays: 31, dataKinds: ['mf_transactions'] },
    ],
    limitations: ['Full transaction history needs a one-time detailed CAS request on the KFintech website.'],
  },
  {
    id: 'amfi',
    name: 'AMFI NAV feed',
    type: 'market_data',
    products: [{ id: 'amfi-nav', name: 'Daily mutual fund NAVs', type: 'market_feed' }],
    channels: [
      { kind: 'public_feed', url: 'https://www.amfiindia.com/spages/NAVAll.txt', expectedCadenceDays: 1, dataKinds: ['nav_prices'] },
    ],
    limitations: ['NAVs value units; they are not holdings. Published once per business day.'],
  },
];

export function getInstitution(id: string): Institution | undefined {
  return INSTITUTIONS.find((institution) => institution.id === id);
}

export function emailChannels(institution: Institution): EmailChannel[] {
  return institution.channels.filter((channel): channel is EmailChannel => channel.kind !== 'public_feed');
}

/** Union of sender terms across an institution's email channels, de-duplicated. */
export function institutionSenders(institution: Institution): string[] {
  return [...new Set(emailChannels(institution).flatMap((channel) => channel.senders))];
}

/** Shortest expected cadence across channels — the freshness bar for the institution row. */
export function institutionCadenceMs(institution: Institution): number {
  const days = Math.min(...institution.channels.map((channel) => channel.expectedCadenceDays));
  return daysToMs(days);
}

const SENDER_TERM_RE = /^[a-z0-9.@_-]+$/i;

/**
 * Builds a Gmail search query for an institution's senders, optionally bounded below by a
 * Unix time in seconds. Gmail's `{a b}` syntax is OR.
 */
export function buildGmailQuery(institution: Institution, afterEpochSeconds?: number): string | null {
  const senders = institutionSenders(institution);
  if (senders.length === 0) return null;
  for (const sender of senders) {
    if (!SENDER_TERM_RE.test(sender)) throw new Error(`invalid sender term for ${institution.id}`);
  }
  const fromClause = senders.length === 1 ? `from:${senders[0]}` : `{${senders.map((s) => `from:${s}`).join(' ')}}`;
  return afterEpochSeconds === undefined ? fromClause : `${fromClause} after:${Math.floor(afterEpochSeconds)}`;
}
