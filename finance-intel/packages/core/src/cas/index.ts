import { parseCamsDetailed, type RtaCasData } from './camsDetailed';
import { parseCdsl, type DepositoryCasData } from './cdsl';
import { atomsFromPages, blocksFromAtoms, extractPages, sampleText } from './layout';
import type { ExtractedPage } from './pdfExtractor';

export * from './camsDetailed';
export * from './cdsl';
export * from './classify';
export * from './dec';
export * from './layout';
export * from './pdfExtractor';

export type CasIssuer = 'CAMS' | 'KFINTECH' | 'NSDL' | 'CDSL' | 'UNKNOWN';
export type CasVariant = 'DETAILED' | 'SUMMARY' | 'UNKNOWN';

export type CasData = RtaCasData | DepositoryCasData;

export class UnsupportedStatementError extends Error {
  override readonly name = 'UnsupportedStatementError';
  constructor(
    readonly issuer: CasIssuer,
    message: string,
  ) {
    super(message);
  }
}

/** Issuer detection markers from casparser `parsers/detect.py`. */
export function detectIssuer(pages: readonly ExtractedPage[]): CasIssuer {
  const text = sampleText(pages, 2);
  if (text.includes('CAMSCASWS')) return 'CAMS';
  if (text.includes('KFINCASWS')) return 'KFINTECH';
  if (text.includes('NSDL Consolidated Account Statement') || text.includes('About NSDL')) return 'NSDL';
  if (text.includes('Central Depository Services (India) Limited')) return 'CDSL';
  return 'UNKNOWN';
}

export function detectVariant(pages: readonly ExtractedPage[]): CasVariant {
  const m = /consolidated\s+account\s+(statement|summary)/i.exec(sampleText(pages, 1));
  if (!m) return 'UNKNOWN';
  return (m[1] ?? '').toLowerCase() === 'statement' ? 'DETAILED' : 'SUMMARY';
}

/** Parses the text content of a decrypted CAS PDF (PDF_PAGE_EXTRACTOR_JS output per page). */
export function parseCas(pages: readonly ExtractedPage[]): CasData {
  const issuer = detectIssuer(pages);
  const atoms = atomsFromPages(pages);
  if (issuer === 'CAMS' || issuer === 'KFINTECH') {
    const variant = detectVariant(pages);
    if (variant !== 'DETAILED') {
      throw new UnsupportedStatementError(issuer, 'This is a summary CAS. Request a "Detailed" statement (with transactions) from CAMS/KFintech.');
    }
    return parseCamsDetailed(extractPages(atoms), issuer);
  }
  if (issuer === 'CDSL') return parseCdsl(blocksFromAtoms(atoms));
  if (issuer === 'NSDL') {
    throw new UnsupportedStatementError(issuer, 'NSDL CAS parsing is not implemented yet. Share a redacted NSDL CAS to add it.');
  }
  throw new UnsupportedStatementError('UNKNOWN', 'Not a recognised CAMS, KFintech, CDSL or NSDL consolidated account statement.');
}
