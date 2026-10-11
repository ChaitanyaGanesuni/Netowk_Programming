/**
 * Passwords for statement PDFs. These open documents your institutions emailed you; they are
 * not banking credentials. CAS PDFs from CAMS, KFintech, CDSL and NSDL use your PAN.
 */
export interface DocumentPasswords {
  pan: string | null;
  /** Extra candidates per institution id (e.g. a bank's statement password). */
  byInstitution: Record<string, string[]>;
}

const CAS_INSTITUTIONS = new Set(['cams', 'kfintech', 'cdsl', 'nsdl']);

/** Ordered password candidates for a document from `institutionId`. */
export function passwordCandidates(passwords: DocumentPasswords, institutionId: string): string[] {
  const out: string[] = [];
  if (CAS_INSTITUTIONS.has(institutionId) && passwords.pan) out.push(passwords.pan.toUpperCase());
  out.push(...(passwords.byInstitution[institutionId] ?? []));
  return [...new Set(out.filter(Boolean))];
}
