/**
 * Minimal RFC 5322 / MIME parser for the financial emails the app reads. Pure TypeScript:
 * no Buffer, no TextDecoder dependency (Hermes support varies), so it runs identically in
 * React Native, Workers and Node.
 */

export interface MailAttachment {
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
}

export interface ParsedMail {
  from: string;
  /** Bare sender address, lower-cased ("alerts@hdfcbank.net"). */
  fromAddress: string;
  subject: string;
  /** Parsed Date header in epoch ms, or null. */
  date: number | null;
  messageId: string | null;
  text: string | null;
  html: string | null;
  attachments: MailAttachment[];
}

// ---------------------------------------------------------------- byte helpers

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_LOOKUP = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64.length; i++) table[B64.charCodeAt(i)] = i;
  table['-'.charCodeAt(0)] = 62; // base64url
  table['_'.charCodeAt(0)] = 63;
  return table;
})();

/** Decodes standard or URL-safe base64, ignoring whitespace and padding. */
export function base64ToBytes(input: string): Uint8Array {
  const out = new Uint8Array(Math.floor((input.length * 3) / 4) + 3);
  let buffer = 0;
  let bits = 0;
  let length = 0;
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    const value = code < 128 ? (B64_LOOKUP[code] ?? -1) : -1;
    if (value < 0) continue;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[length++] = (buffer >> bits) & 0xff;
    }
  }
  return out.slice(0, length);
}

export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += B64[a >> 2];
    out += B64[((a & 3) << 4) | ((b ?? 0) >> 4)];
    out += b === undefined ? '=' : B64[((b & 15) << 2) | ((c ?? 0) >> 6)];
    out += c === undefined ? '=' : B64[c & 63];
  }
  return out;
}

/** Latin-1 view of bytes: one char per byte (lossless round trip). */
function bytesToBinary(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return s;
}

function binaryToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

/** UTF-8 decoder with U+FFFD for malformed sequences. */
export function utf8Decode(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; ) {
    const b0 = bytes[i] as number;
    let cp = 0xfffd;
    let need = 0;
    if (b0 < 0x80) {
      cp = b0;
    } else if (b0 >= 0xc2 && b0 < 0xe0) {
      need = 1;
      cp = b0 & 0x1f;
    } else if (b0 >= 0xe0 && b0 < 0xf0) {
      need = 2;
      cp = b0 & 0x0f;
    } else if (b0 >= 0xf0 && b0 < 0xf5) {
      need = 3;
      cp = b0 & 0x07;
    }
    let ok = true;
    for (let k = 1; k <= need; k++) {
      const b = bytes[i + k];
      if (b === undefined || (b & 0xc0) !== 0x80) {
        ok = false;
        break;
      }
      cp = (cp << 6) | (b & 0x3f);
    }
    if (!ok) {
      out += '�';
      i += 1;
      continue;
    }
    i += need + 1;
    out += String.fromCodePoint(b0 >= 0x80 && need === 0 ? 0xfffd : cp);
  }
  return out;
}

// Windows-1252 differs from Latin-1 in 0x80–0x9F (₹ is not here; Indian mail is mostly UTF-8).
const CP1252: Record<number, number> = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021,
  0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160, 0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018,
  0x92: 0x2019, 0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014, 0x98: 0x02dc,
  0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153, 0x9e: 0x017e, 0x9f: 0x0178,
};

export function decodeCharset(bytes: Uint8Array, charset: string | undefined): string {
  const cs = (charset ?? 'utf-8').toLowerCase().replace(/^"|"$/g, '');
  if (cs === 'utf-8' || cs === 'utf8') return utf8Decode(bytes);
  if (cs === 'us-ascii' || cs === 'ascii' || cs === 'iso-8859-1' || cs === 'latin1') return bytesToBinary(bytes);
  if (cs === 'windows-1252' || cs === 'cp1252') {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(CP1252[b] ?? b);
    return s;
  }
  return utf8Decode(bytes);
}

// ---------------------------------------------------------------- headers

interface Headers {
  get(name: string): string | undefined;
}

function parseHeaderBlock(block: string): Headers {
  const map = new Map<string, string>();
  const unfolded = block.replace(/\r?\n[ \t]+/g, ' ');
  for (const line of unfolded.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const name = line.slice(0, idx).trim().toLowerCase();
    // Header bytes are usually ASCII; decode any raw 8-bit UTF-8 so names and subjects survive.
    if (!map.has(name)) map.set(name, utf8Decode(binaryToBytes(line.slice(idx + 1).trim())));
  }
  return { get: (name) => map.get(name.toLowerCase()) };
}

function decodeQ(text: string): Uint8Array {
  const s = text.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  return binaryToBytes(s);
}

/** Decodes RFC 2047 encoded-words (`=?utf-8?B?...?=`, `=?iso-8859-1?Q?...?=`). */
export function decodeEncodedWords(value: string): string {
  return value
    .replace(/(=\?[^?]+\?[BbQq]\?[^?]*\?=)\s+(?==\?)/g, '$1')
    .replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, charset: string, enc: string, data: string) =>
      decodeCharset(enc.toUpperCase() === 'B' ? base64ToBytes(data) : decodeQ(data), charset.split('*')[0]),
    );
}

interface ContentType {
  type: string;
  params: Record<string, string>;
}

/** Parses `type/subtype; a=b; c="d"` including RFC 2231 `name*=utf-8''%E2%82%B9`. */
function parseParams(value: string | undefined): ContentType {
  if (!value) return { type: '', params: {} };
  const parts = value.match(/(?:[^;"]+|"[^"]*")+/g) ?? [];
  const type = (parts.shift() ?? '').trim().toLowerCase();
  const params: Record<string, string> = {};
  const continuations: Record<string, string[]> = {};
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    let val = part.slice(eq + 1).trim();
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    const ext = /^([^*]+)\*(\d+)?(\*)?$/.exec(key);
    if (ext) {
      const base = ext[1] ?? key;
      let decoded = val;
      if (ext[3] || (!ext[2] && key.endsWith('*'))) {
        const m = /^([^']*)'[^']*'(.*)$/.exec(val);
        const charset = m ? m[1] : undefined;
        const raw = (m ? m[2] : val) ?? '';
        decoded = decodeCharset(binaryToBytes(raw.replace(/%([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)))), charset || 'utf-8');
      }
      (continuations[base] ??= [])[Number(ext[2] ?? 0)] = decoded;
    } else {
      params[key] = decodeEncodedWords(val);
    }
  }
  for (const [key, pieces] of Object.entries(continuations)) params[key] = pieces.join('');
  return { type, params };
}

// ---------------------------------------------------------------- bodies

function decodeTransfer(body: string, encoding: string | undefined): Uint8Array {
  const enc = (encoding ?? '7bit').toLowerCase().trim();
  if (enc === 'base64') return base64ToBytes(body);
  if (enc === 'quoted-printable') {
    const s = body.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    return binaryToBytes(s);
  }
  return binaryToBytes(body);
}

const ENTITIES: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", rsquo: '’', lsquo: '‘', ndash: '–', mdash: '—', rupee: '₹' };

/** Flattens HTML email bodies into readable text for parsing (tables become tab-separated). */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|table)>/gi, '\n')
    .replace(/<\/t[dh]>/gi, '\t')
    .replace(/<[^>]+>/g, '')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, name: string) => ENTITIES[name.toLowerCase()] ?? m)
    .replace(/[ \t ]+\n/g, '\n')
    .replace(/[  ]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

interface Accumulator {
  text: string | null;
  html: string | null;
  attachments: MailAttachment[];
}

function splitHeaderBody(raw: string): [string, string] {
  const m = /\r?\n\r?\n/.exec(raw);
  return m ? [raw.slice(0, m.index), raw.slice(m.index + m[0].length)] : [raw, ''];
}

const MAX_DEPTH = 8;

function walkPart(raw: string, acc: Accumulator, depth: number): void {
  if (depth > MAX_DEPTH) return;
  const [headerBlock, body] = splitHeaderBody(raw);
  const headers = parseHeaderBlock(headerBlock);
  const ct = parseParams(headers.get('content-type') ?? 'text/plain; charset=us-ascii');
  const disposition = parseParams(headers.get('content-disposition'));
  const filename = disposition.params.filename ?? ct.params.name;

  if (ct.type.startsWith('multipart/')) {
    const boundary = ct.params.boundary;
    if (!boundary) return;
    // RFC 2046: the line break before "--boundary" belongs to the delimiter, not the part.
    const escaped = boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const sections = `\r\n${body}`.split(new RegExp(`\\r?\\n--${escaped}`));
    for (const section of sections.slice(1)) {
      if (section.startsWith('--')) break;
      walkPart(section.replace(/^[ \t]*\r?\n/, ''), acc, depth + 1);
    }
    return;
  }
  if (ct.type === 'message/rfc822') {
    walkPart(body, acc, depth + 1);
    return;
  }
  const bytes = decodeTransfer(body, headers.get('content-transfer-encoding'));
  const isAttachment = disposition.type === 'attachment' || (filename !== undefined && !ct.type.startsWith('text/'));
  if (!isAttachment && ct.type === 'text/plain' && acc.text === null) {
    acc.text = decodeCharset(bytes, ct.params.charset);
  } else if (!isAttachment && ct.type === 'text/html' && acc.html === null) {
    acc.html = decodeCharset(bytes, ct.params.charset);
  } else if (isAttachment || filename) {
    acc.attachments.push({ filename: filename ?? 'attachment', mimeType: ct.type || 'application/octet-stream', bytes });
  }
}

const ADDRESS_RE = /<([^>]+)>/;

/** Parses a raw RFC 5322 message (as bytes, or Gmail's base64url `raw` string). */
export function parseMail(input: Uint8Array | string): ParsedMail {
  const bytes = typeof input === 'string' ? base64ToBytes(input) : input;
  const raw = bytesToBinary(bytes);
  const [headerBlock] = splitHeaderBody(raw);
  const headers = parseHeaderBlock(headerBlock);
  const from = decodeEncodedWords(headers.get('from') ?? '');
  const fromAddress = (ADDRESS_RE.exec(from)?.[1] ?? from).trim().toLowerCase();
  const dateHeader = headers.get('date');
  const parsedDate = dateHeader ? Date.parse(dateHeader.replace(/\s*\([^)]*\)\s*$/, '')) : NaN;
  const acc: Accumulator = { text: null, html: null, attachments: [] };
  walkPart(raw, acc, 0);
  return {
    from,
    fromAddress,
    subject: decodeEncodedWords(headers.get('subject') ?? ''),
    date: Number.isNaN(parsedDate) ? null : parsedDate,
    messageId: headers.get('message-id') || null,
    text: acc.text,
    html: acc.html,
    attachments: acc.attachments,
  };
}

/** Best readable body: plain text if present, else flattened HTML. */
export function mailBodyText(mail: ParsedMail): string {
  if (mail.text && mail.text.trim()) return mail.text;
  return mail.html ? htmlToText(mail.html) : '';
}
