import { parseInrToPaise } from '../decimal';
import { findAlertDate } from './alerts';

/**
 * Generic summary extraction from bank and credit-card statement text (PDF or email body).
 * Only labelled totals are read — the per-transaction tables differ by bank and are not
 * parsed here. Built from common Indian statement labels, not your institutions' samples.
 */

export interface CardStatementSummary {
  statementDate: string | null;
  dueDate: string | null;
  totalDuePaise: number | null;
  minimumDuePaise: number | null;
  creditLimitPaise: number | null;
  availableLimitPaise: number | null;
}

export interface BankStatementSummary {
  periodFrom: string | null;
  periodTo: string | null;
  openingBalancePaise: number | null;
  closingBalancePaise: number | null;
}

// "Cr"/"Dr" must follow on the same line as a separate word ("Credit Limit" below is not "Cr").
const AMT = String.raw`(?:rs\.?|inr|₹)?\s*(-?[\d,]+\.\d{2})(?:[ \t]*\b(cr|dr)\b)?`;

/** `negativeMarker`: on card statements "Cr" (amount owed to you) is negative; on bank statements "Dr" (overdrawn) is. */
function amountAfter(text: string, labels: string, negativeMarker: 'cr' | 'dr' = 'cr'): number | null {
  const re = new RegExp(String.raw`(?:${labels})[^\d\n]{0,40}?(?:\n[^\d\n]{0,20})?${AMT}`, 'i');
  const m = re.exec(text);
  if (!m?.[1]) return null;
  try {
    const value = parseInrToPaise(m[1].replace(/^-/, ''));
    const negative = m[1].startsWith('-') || (m[2] ?? '').toLowerCase() === negativeMarker;
    return negative ? -value : value;
  } catch {
    return null;
  }
}

function dateAfter(text: string, labels: string): string | null {
  const re = new RegExp(String.raw`(?:${labels})[^\n\d]{0,30}([^\n]{0,30})`, 'i');
  const m = re.exec(text);
  return m?.[1] ? findAlertDate(m[1]) : null;
}

export function parseCardStatement(text: string): CardStatementSummary | null {
  const summary: CardStatementSummary = {
    statementDate: dateAfter(text, String.raw`statement date|statement generation date|bill date`),
    dueDate: dateAfter(text, String.raw`payment due date|due date|pay by`),
    totalDuePaise: amountAfter(text, String.raw`total (?:amount )?(?:due|dues|payment due|outstanding)|total amount payable|closing balance`),
    minimumDuePaise: amountAfter(text, String.raw`minimum (?:amount )?(?:due|payment(?: due)?)|min\.? (?:amt|amount) due`),
    creditLimitPaise: amountAfter(text, String.raw`(?<!available )(?<!avl\.? )credit limit|total credit limit`),
    availableLimitPaise: amountAfter(text, String.raw`available (?:credit )?limit|avl\.? (?:credit )?limit`),
  };
  return summary.totalDuePaise !== null || summary.dueDate !== null ? summary : null;
}

export function parseBankStatement(text: string): BankStatementSummary | null {
  const period = /(?:period|from)\s*:?\s*([^\n]{6,20}?)\s+(?:to|-)\s+([^\n]{6,20})/i.exec(text);
  const summary: BankStatementSummary = {
    periodFrom: period ? findAlertDate(period[1] ?? '') : null,
    periodTo: period ? findAlertDate(period[2] ?? '') : null,
    openingBalancePaise: amountAfter(text, String.raw`opening balance`, 'dr'),
    closingBalancePaise: amountAfter(text, String.raw`closing balance|available balance as on`, 'dr'),
  };
  return summary.closingBalancePaise !== null ? summary : null;
}
