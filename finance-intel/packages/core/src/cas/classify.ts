/**
 * Transaction classification and scheme-name cleanup — port of casparser 1.4.1
 * `parsers/_classify.py` (MIT © Sandeep Somasekharan).
 */
import { Dec } from './dec';

export type CasTransactionType =
  | 'PURCHASE'
  | 'PURCHASE_SIP'
  | 'REDEMPTION'
  | 'DIVIDEND_PAYOUT'
  | 'DIVIDEND_REINVEST'
  | 'SWITCH_IN'
  | 'SWITCH_IN_MERGER'
  | 'SWITCH_OUT'
  | 'SWITCH_OUT_MERGER'
  | 'STT_TAX'
  | 'STAMP_DUTY_TAX'
  | 'TDS_TAX'
  | 'SEGREGATION'
  | 'GIFT_IN'
  | 'GIFT_OUT'
  | 'MISC'
  | 'UNKNOWN'
  | 'REVERSAL';

const DIVIDEND_RE = /(?:div\.|dividend|idcw).*?@\s*Rs\.\s*([\d.]+)(?:\s+per\s+unit)?/is;
const REINVEST_RE = /reinvest/i;
const STP_RE = /\bs\s*t\s*p\b|systematic\s+transfer/i;
const GIFT_FOLIO_RE = /Folio\s+No\s*[:.]\s*(\d+)/i;
const REVERSAL_RE = /reversal|rejection|dishonoured|mismatch|insufficient\s+balance|payment\s+not\s+received/i;

export function extractGiftFolio(description: string): string | null {
  return GIFT_FOLIO_RE.exec(description ?? '')?.[1] ?? null;
}

export function getTransactionType(descriptionRaw: string, units: Dec | null): { type: CasTransactionType; dividendRate: Dec | null } {
  const description = descriptionRaw.toLowerCase();
  const div = DIVIDEND_RE.exec(description);
  if (div) {
    return {
      type: REINVEST_RE.test(description) ? 'DIVIDEND_REINVEST' : 'DIVIDEND_PAYOUT',
      dividendRate: Dec.parse(div[1] ?? ''),
    };
  }
  let type: CasTransactionType;
  if (units === null) {
    if (description.includes('stt')) type = 'STT_TAX';
    else if (description.includes('stamp')) type = 'STAMP_DUTY_TAX';
    else if (description.includes('tds')) type = 'TDS_TAX';
    else type = 'MISC';
  } else if (units.sign() > 0) {
    if (description.includes('gift')) type = 'GIFT_IN';
    else if (description.includes('switch') || STP_RE.test(description)) type = description.includes('merger') ? 'SWITCH_IN_MERGER' : 'SWITCH_IN';
    else if (description.includes('segregat')) type = 'SEGREGATION';
    else if (
      description.includes('sip') ||
      description.includes('systematic') ||
      /instal+ment/i.test(description) ||
      /sys.+?invest/is.test(description)
    )
      type = 'PURCHASE_SIP';
    else type = 'PURCHASE';
  } else if (units.sign() < 0) {
    if (description.includes('gift')) type = 'GIFT_OUT';
    else if (REVERSAL_RE.test(description)) type = 'REVERSAL';
    else if (description.includes('switch') || STP_RE.test(description)) type = description.includes('merger') ? 'SWITCH_OUT_MERGER' : 'SWITCH_OUT';
    else type = 'REDEMPTION';
  } else {
    type = 'UNKNOWN';
  }
  return { type, dividendRate: null };
}

export function parseSchemeName(raw: string): string {
  let scheme = raw.replace(/\((formerly|erstwhile).+?\)/gis, '').trim();
  scheme = scheme.replace(/\((Demat|Non-Demat).*/is, '').trim();
  scheme = scheme.replace(/\s+/g, ' ').trim();
  return scheme.replace(/[^a-zA-Z0-9_)]+$/, '').trim();
}
