import { parseInrToPaise } from '../decimal';

/**
 * Generic parser for Indian bank and credit-card transaction alert emails.
 *
 * IMPORTANT: written from common Indian alert phrasing, not from your institutions' actual
 * templates (no samples were available). Every result carries a confidence and the pattern
 * that matched; anything without an amount and a clear direction is rejected rather than
 * guessed. Institution-specific templates can be added in `TEMPLATES` once samples exist.
 */

export type Direction = 'debit' | 'credit';
export type Instrument = 'account' | 'card';
export type PaymentChannel = 'UPI' | 'NEFT' | 'IMPS' | 'RTGS' | 'ATM' | 'CARD' | 'NACH' | 'CHEQUE' | 'NETBANKING' | 'OTHER';

export interface ParsedAlert {
  direction: Direction;
  amountPaise: number;
  instrument: Instrument;
  /** Last 3–4 digits of the account/card, when the alert states them. */
  suffix: string | null;
  channel: PaymentChannel;
  counterparty: string | null;
  reference: string | null;
  /** ISO date stated in the alert, else the email's date. */
  date: string;
  /** "Avl bal" stated in the alert (bank accounts) or available limit (cards). */
  availableBalancePaise: number | null;
  /** Card authorisations are pending until they appear on a statement; bank alerts are posted. */
  status: 'pending' | 'posted';
  confidence: number;
  pattern: string;
}

const AMOUNT = String.raw`(?:rs\.?|inr|₹)\s*([\d,]+(?:\.\d{1,2})?)`;
const AMOUNT_RE = new RegExp(AMOUNT, 'i');

const SKIP_RE = /\b(otp|one[- ]time password|verification code|e-?mandate registration|offer|cashback offer|pre-?approved|loan offer|apply now)\b/i;

const DEBIT_RE = /\b(debited|spent|withdrawn|deducted|paid|sent|used for|using your|has been used|charged|transaction of|purchase of|txn of|has been debited)\b/i;
const CREDIT_RE = /\b(credited|received|deposited|refund(?:ed)?|reversed|reversal|has been credited)\b/i;

const CARD_RE = /\b(?:credit|debit)?\s*card\b(?:\s*(?:no\.?|number))?(?:\s*(?:ending|ending with|xx+|\*+|x+))?\s*[x*]*\s*(\d{4})\b/i;
const ACCOUNT_RE = /\b(?:a\/c|ac|acct|account)\b(?:\s*(?:no\.?|number))?(?:\s*(?:ending|ending with|xx+|\*+|x+))?\s*[x*]*\s*(\d{3,6})\b/i;
const VPA_RE = /\b([a-z0-9][\w.-]{1,60}@(?:ok\w+|ybl|ibl|axl|paytm|upi|apl|oksbi|okhdfcbank|okicici|okaxis|icici|hdfcbank|sbi|axisbank|kotak|yesbank|ptyes|ptsbi|pthdfc|ptaxis|fbl|jupiteraxis|slc|freecharge|airtel|naviaxis|waaxis|wahdfcbank|waicici|wasbi))\b/i;
const MERCHANT_AT_RE = /\bat\s+([A-Za-z0-9][\w&.'*/ -]{1,50}?)\s+(?:on|via|using|for|ref|avl|available|\.)/i;
const TO_RE = /\b(?:to|towards)\s+(?:vpa\s+)?([A-Za-z0-9][\w&.'@ -]{1,50}?)\s+(?:on|via|ref|upi|\.|avl|having)/i;
const FROM_RE = /\b(?:from|by)\s+(?:vpa\s+)?([A-Za-z0-9][\w&.'@ -]{1,50}?)\s+(?:on|via|ref|upi|\.|avl)/i;
// The id must contain a digit, so words like "number" are never captured as references.
const REF_RE = /\b(?:ref(?:erence)?(?:\s*(?:no|number|id))?|utr|rrn|txn\s*id|transaction\s*(?:id|ref(?:erence)?(?:\s*no)?))(?:\s+is)?[\s.:#-]*((?=[A-Z0-9]*\d)[A-Z0-9]{6,22})\b/i;
const BALANCE_RE = new RegExp(String.raw`\b(?:avl|avail(?:able)?|avbl|clear)\.?\s*(?:bal(?:ance)?|limit|credit\s+limit)\b[^\d₹]{0,25}(?:rs\.?|inr|₹)?\s*([\d,]+(?:\.\d{1,2})?)`, 'i');

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

function iso(year: number, month: number, day: number): string | null {
  if (year < 100) year += 2000;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return d.toISOString().slice(0, 10);
}

/** Finds the first plausible transaction date in alert text (dd-mm-yy, dd/mm/yyyy, dd-Mon-yy, dd Mon yyyy). */
export function findAlertDate(text: string): string | null {
  const named = /\b(\d{1,2})[-\s/]?([A-Za-z]{3})[a-z]*[-\s/,]+(\d{2,4})\b/.exec(text);
  if (named) {
    const month = MONTHS[(named[2] ?? '').toLowerCase()];
    if (month) {
      const date = iso(Number(named[3]), month, Number(named[1]));
      if (date) return date;
    }
  }
  const numeric = /\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})\b/.exec(text);
  if (numeric) return iso(Number(numeric[3]), Number(numeric[2]), Number(numeric[1]));
  const ymd = /\b(20\d{2})-(\d{2})-(\d{2})\b/.exec(text);
  if (ymd) return iso(Number(ymd[1]), Number(ymd[2]), Number(ymd[3]));
  return null;
}

function detectChannel(text: string, instrument: Instrument): PaymentChannel {
  if (/\bupi\b|\bvpa\b/i.test(text) || VPA_RE.test(text)) return 'UPI';
  if (/\bneft\b/i.test(text)) return 'NEFT';
  if (/\bimps\b/i.test(text)) return 'IMPS';
  if (/\brtgs\b/i.test(text)) return 'RTGS';
  if (/\batm\b|cash withdrawal/i.test(text)) return 'ATM';
  if (/\bnach\b|\bach\b|\becs\b|auto[- ]?debit|mandate|standing instruction|\bsi\b/i.test(text)) return 'NACH';
  if (/\bcheque\b|\bchq\b/i.test(text)) return 'CHEQUE';
  if (/net ?banking|internet banking/i.test(text)) return 'NETBANKING';
  if (instrument === 'card' || /\bpos\b|\bcard\b/i.test(text)) return 'CARD';
  return 'OTHER';
}

function clean(name: string | undefined | null): string | null {
  if (!name) return null;
  const t = name.replace(/\s+/g, ' ').replace(/[.,;:-]+$/, '').trim();
  return t.length >= 2 ? t : null;
}

/**
 * Parses one alert. `fallbackDate` (ISO) is used when the text has no date.
 * Returns null when the email is not a transaction alert or is ambiguous.
 */
export function parseAlert(subject: string, body: string, fallbackDate: string, isCardIssuer: boolean): ParsedAlert | null {
  const text = `${subject}\n${body}`.replace(/ /g, ' ').replace(/[ \t]+/g, ' ');
  if (SKIP_RE.test(subject) || (SKIP_RE.test(text) && !/debited|credited|spent/i.test(text))) return null;

  // Use the sentence that contains the amount as the primary evidence.
  const sentences = text.split(/(?<=[.!])\s+|\n/).filter((s) => AMOUNT_RE.test(s));
  const primary = sentences.find((s) => DEBIT_RE.test(s) || CREDIT_RE.test(s));
  if (!primary) return null;

  const debit = DEBIT_RE.exec(primary);
  const credit = CREDIT_RE.exec(primary);
  let direction: Direction;
  if (debit && credit) direction = debit.index <= credit.index ? 'debit' : 'credit';
  else direction = debit ? 'debit' : 'credit';
  // "refund ... credited to your card" etc. stays credit; "reversed" debit becomes credit.
  if (/\breversal\b|\breversed\b|\brefund/i.test(primary) && credit) direction = 'credit';

  const amountMatch = AMOUNT_RE.exec(primary);
  if (!amountMatch) return null;
  let amountPaise: number;
  try {
    amountPaise = parseInrToPaise(amountMatch[1] ?? '');
  } catch {
    return null;
  }
  if (amountPaise <= 0) return null;

  const card = CARD_RE.exec(text);
  const account = ACCOUNT_RE.exec(text);
  const instrument: Instrument = card && (!account || isCardIssuer || (card.index ?? 0) <= (account.index ?? 0)) ? 'card' : isCardIssuer ? 'card' : 'account';
  const suffix = (instrument === 'card' ? card?.[1] : account?.[1]) ?? null;

  const vpa = VPA_RE.exec(primary)?.[1] ?? VPA_RE.exec(text)?.[1];
  const counterparty =
    clean(vpa) ??
    clean(MERCHANT_AT_RE.exec(primary)?.[1]) ??
    clean((direction === 'debit' ? TO_RE : FROM_RE).exec(primary)?.[1]) ??
    clean(MERCHANT_AT_RE.exec(text)?.[1]);

  const balance = BALANCE_RE.exec(text);
  let availableBalancePaise: number | null = null;
  if (balance?.[1]) {
    try {
      availableBalancePaise = parseInrToPaise(balance[1]);
    } catch {
      availableBalancePaise = null;
    }
  }

  const date = findAlertDate(primary) ?? findAlertDate(text) ?? fallbackDate;
  let confidence = 0.6;
  if (suffix) confidence += 0.15;
  if (counterparty) confidence += 0.1;
  if (findAlertDate(text)) confidence += 0.1;
  if (debit && credit && !/refund|reversal|reversed/i.test(primary)) confidence -= 0.25;

  return {
    direction,
    amountPaise,
    instrument,
    suffix,
    channel: detectChannel(text, instrument),
    counterparty,
    reference: REF_RE.exec(text)?.[1] ?? null,
    date,
    availableBalancePaise,
    status: instrument === 'card' && direction === 'debit' ? 'pending' : 'posted',
    confidence: Math.max(0.1, Math.min(0.95, Number(confidence.toFixed(2)))),
    pattern: `${direction}:${instrument}`,
  };
}

/** Card number suffix in statement text ("XXXX XXXX XXXX 7788", "card ending 7788"). */
export function findCardSuffix(text: string): string | null {
  const masked = /(?:[x*•]{4}[\s-]?){3}(\d{4})\b/i.exec(text);
  return masked?.[1] ?? CARD_RE.exec(text)?.[1] ?? null;
}

/** Account number suffix in statement text ("A/c XX1234", "Account No: XXXXXX1234"). */
export function findAccountSuffix(text: string): string | null {
  const m = ACCOUNT_RE.exec(text);
  const digits = m?.[1] ?? /\b(?:account|a\/c)\s*(?:no\.?|number)?\s*:?\s*[x*]*\d*?(\d{4})\b/i.exec(text)?.[1];
  return digits ? digits.slice(-4) : null;
}
