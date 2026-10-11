import { describe, expect, it } from 'vitest';
import { base64ToBytes, bytesToBase64, classifyMail, decodeEncodedWords, htmlToText, mailBodyText, parseMail, redactSample, utf8Decode } from '../src/mail';

const enc = new TextEncoder();
const gmailRaw = (message: string) => bytesToBase64(enc.encode(message)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const PDF_BYTES = enc.encode('%PDF-1.4 fake');

const casEmail = [
  'From: "CAMS" <donotreply@camsonline.com>',
  'To: user@example.com',
  'Subject: =?UTF-8?B?Q29uc29saWRhdGVkIEFjY291bnQgU3RhdGVtZW50IOKCuQ==?=',
  'Date: Sat, 10 Oct 2026 09:15:00 +0530 (IST)',
  'Message-ID: <abc@cams>',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="outer"',
  '',
  '--outer',
  'Content-Type: multipart/alternative; boundary=inner',
  '',
  '--inner',
  'Content-Type: text/plain; charset=utf-8',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  'Dear Investor, your statement is attached. Amount =E2=82=B91,000=',
  '.00',
  '--inner',
  'Content-Type: text/html; charset=utf-8',
  '',
  '<p>Dear&nbsp;Investor</p>',
  '--inner--',
  '--outer',
  'Content-Type: application/octet-stream; name="ignored.bin"',
  'Content-Disposition: attachment; filename*=UTF-8\'\'CAS%20%E2%82%B9.pdf',
  'Content-Transfer-Encoding: base64',
  '',
  bytesToBase64(PDF_BYTES).replace(/(.{20})/g, '$1\r\n'),
  '--outer--',
  '',
].join('\r\n');

describe('base64', () => {
  it('round-trips arbitrary bytes and accepts base64url', () => {
    const bytes = new Uint8Array(256).map((_, i) => i);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
    expect(utf8Decode(base64ToBytes('4oK5'))).toBe('₹');
    expect(utf8Decode(base64ToBytes('4oK5'.replace('+', '-')))).toBe('₹');
  });

  it('marks malformed UTF-8 instead of throwing', () => {
    expect(utf8Decode(new Uint8Array([0x41, 0xff, 0x42]))).toBe('A�B');
  });
});

describe('parseMail', () => {
  it('parses nested multipart mail from Gmail raw format', () => {
    const mail = parseMail(gmailRaw(casEmail));
    expect(mail.fromAddress).toBe('donotreply@camsonline.com');
    expect(mail.subject).toBe('Consolidated Account Statement ₹');
    expect(mail.date).toBe(Date.UTC(2026, 9, 10, 3, 45));
    expect(mail.messageId).toBe('<abc@cams>');
    expect(mail.text).toBe('Dear Investor, your statement is attached. Amount ₹1,000.00');
    expect(mail.html).toContain('Dear&nbsp;Investor');
    expect(mail.attachments).toHaveLength(1);
    expect(mail.attachments[0]?.filename).toBe('CAS ₹.pdf');
    expect(mail.attachments[0]?.bytes).toEqual(PDF_BYTES);
  });

  it('falls back to flattened HTML when there is no plain part', () => {
    const mail = parseMail(enc.encode('Subject: x\r\nContent-Type: text/html\r\n\r\n<table><tr><td>Amount</td><td>Rs.500</td></tr></table>'));
    expect(mailBodyText(mail)).toBe('Amount\tRs.500');
  });

  it('decodes Q-encoded words and HTML entities', () => {
    expect(decodeEncodedWords('=?iso-8859-1?Q?Caf=E9_alert?=')).toBe('Café alert');
    expect(htmlToText('Rs&#46;10&nbsp;spent &amp; &#x20B9;5<br>next')).toBe('Rs.10 spent & ₹5\nnext');
  });
});

describe('classifyMail', () => {
  it('routes by institution and content', () => {
    const cas = parseMail(gmailRaw(casEmail));
    expect(classifyMail('cams', cas).kind).toBe('cas_rta');
    expect(classifyMail('cdsl', cas).kind).toBe('cas_depository');
    const alert = parseMail(enc.encode('Subject: You have done a UPI txn\r\n\r\nRs.250.00 has been debited from account **1234'));
    expect(classifyMail('hdfc', alert).kind).toBe('transaction_alert');
    const statement = { ...cas, subject: 'Your HSBC Credit Card Statement' };
    expect(classifyMail('hsbc', statement).kind).toBe('card_statement');
    expect(classifyMail('sbi', { ...cas, subject: 'Account Statement for Sep 2026' }).kind).toBe('bank_statement');
    expect(classifyMail('groww', { ...alert, subject: 'Contract Note for 10-10-2026' }).kind).toBe('contract_note');
  });
});

describe('redactSample', () => {
  it('removes digits, emails, PAN and UPI ids', () => {
    const mail = parseMail(
      enc.encode('From: HDFC <alerts@hdfcbank.net>\r\nSubject: Rs.250 debited\r\n\r\nRs.250.00 debited from a/c 50100123456789 to ravi.k@okhdfcbank on 10-10-26. PAN ABCDE1234F. Call 18002586161'),
    );
    const sample = redactSample(mail);
    expect(sample).not.toMatch(/[0-8]/);
    expect(sample).not.toContain('ravi.k');
    expect(sample).not.toContain('ABCDE1234F');
    expect(sample).toContain('Rs.999.99 debited');
  });
});
