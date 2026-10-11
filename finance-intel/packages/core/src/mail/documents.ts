import { getInstitution } from '../institutions';
import { mailBodyText, type ParsedMail } from './mime';

/**
 * What an email most likely is, used only to route it to a processor. CAS statements are
 * confirmed by their PDF content (issuer markers), never by subject line alone.
 */
export type DocumentKind =
  | 'cas_rta'
  | 'cas_depository'
  | 'bank_statement'
  | 'card_statement'
  | 'transaction_alert'
  | 'contract_note'
  | 'mf_confirmation'
  | 'other';

export interface Classification {
  kind: DocumentKind;
  pdfAttachments: number;
  /** Why this kind was chosen; shown on the Documents screen. */
  reason: string;
}

const isPdf = (a: { filename: string; mimeType: string }) => a.mimeType === 'application/pdf' || /\.pdf$/i.test(a.filename);

export function classifyMail(institutionId: string, mail: ParsedMail): Classification {
  const institution = getInstitution(institutionId);
  const subject = mail.subject.toLowerCase();
  const pdfs = mail.attachments.filter(isPdf).length;
  const result = (kind: DocumentKind, reason: string): Classification => ({ kind, pdfAttachments: pdfs, reason });

  if (institution?.type === 'rta') {
    if (pdfs && /consolidated account|\bcas\b|account statement/.test(subject)) return result('cas_rta', 'RTA email with a statement PDF');
    if (pdfs) return result('cas_rta', 'RTA email with a PDF (checked against CAS markers)');
    return result('mf_confirmation', 'RTA email without a statement PDF');
  }
  if (institution?.type === 'depository') {
    return pdfs ? result('cas_depository', 'Depository email with a PDF') : result('other', 'Depository email without a PDF');
  }
  if (institution?.type === 'broker') {
    if (/contract note/.test(subject)) return result('contract_note', 'Subject mentions a contract note');
    if (/mutual fund|\bsip\b|units allotted|order (placed|executed)/.test(subject)) return result('mf_confirmation', 'Subject mentions a fund order');
    return result('other', 'Broker email');
  }
  if (institution?.type === 'bank' || institution?.type === 'card_issuer') {
    const statement = /statement/.test(subject) && pdfs > 0;
    const card = institution.type === 'card_issuer' || /credit card|card statement/.test(subject);
    if (statement) return result(card ? 'card_statement' : 'bank_statement', 'Subject mentions a statement and a PDF is attached');
    if (/alert|transaction|debited|credited|spent|\bupi\b|payment|withdraw|txn|purchase/.test(subject) || /debited|credited|spent/i.test(mailBodyText(mail).slice(0, 2000))) {
      return result('transaction_alert', 'Looks like a transaction alert');
    }
    return result('other', 'Bank email that is not a statement or alert');
  }
  return result('other', 'Unknown institution');
}

/**
 * Produces a shareable template of an email so a parser can be written for it without
 * exposing personal data: every digit becomes 9, emails/PAN/UPI ids/long tokens are masked,
 * and the result is truncated. The user reviews it before sharing; nothing is sent automatically.
 */
export function redactSample(mail: ParsedMail, maxLength = 4000): string {
  const mask = (s: string) =>
    s
      .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, 'user@example.com')
      .replace(/[\w.-]+@(ok|ax|yb|ib|upi|paytm|ybl|okhdfcbank|okicici|oksbi|okaxis)\w*/gi, 'someone@upi')
      .replace(/\b[A-Z]{5}\d{4}[A-Z]\b/g, 'AAAAA9999A')
      .replace(/\d/g, '9');
  const body = mask(mailBodyText(mail)).slice(0, maxLength);
  const attachments = mail.attachments.map((a) => `${mask(a.filename)} (${a.mimeType})`).join(', ') || 'none';
  return [`From: ${mask(mail.fromAddress)}`, `Subject: ${mask(mail.subject)}`, `Attachments: ${attachments}`, '', body].join('\n');
}
