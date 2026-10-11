import * as SecureStore from 'expo-secure-store';
import { getRandomBytes } from 'expo-crypto';
import type { DocumentPasswords } from './passwords';

export { passwordCandidates, type DocumentPasswords } from './passwords';

/**
 * Device-bound secrets live in the Android Keystore / iOS Keychain, never in SQLite or
 * AsyncStorage, and are excluded from cloud backups ("THIS_DEVICE_ONLY").
 */
const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

const KEYS = {
  backendUrl: 'fi.backendUrl',
  deviceToken: 'fi.deviceToken',
  dbKey: 'fi.dbKey',
  docPasswords: 'fi.docPasswords',
} as const;

export interface BackendCredentials {
  backendUrl: string;
  deviceToken: string;
}

export async function loadBackendCredentials(): Promise<BackendCredentials | null> {
  const [backendUrl, deviceToken] = await Promise.all([
    SecureStore.getItemAsync(KEYS.backendUrl, OPTIONS),
    SecureStore.getItemAsync(KEYS.deviceToken, OPTIONS),
  ]);
  return backendUrl && deviceToken ? { backendUrl, deviceToken } : null;
}

export async function saveBackendCredentials(credentials: BackendCredentials): Promise<void> {
  await SecureStore.setItemAsync(KEYS.backendUrl, credentials.backendUrl, OPTIONS);
  await SecureStore.setItemAsync(KEYS.deviceToken, credentials.deviceToken, OPTIONS);
}

/** Returns the SQLCipher key, generating 256 random bits on first use. */
export async function getOrCreateDatabaseKey(): Promise<string> {
  const existing = await SecureStore.getItemAsync(KEYS.dbKey, OPTIONS);
  if (existing) return existing;
  const key = Array.from(getRandomBytes(32), (b) => b.toString(16).padStart(2, '0')).join('');
  await SecureStore.setItemAsync(KEYS.dbKey, key, OPTIONS);
  return key;
}

export async function deleteAllSecrets(): Promise<void> {
  await Promise.all([...Object.values(KEYS), 'fi.aiSettings'].map((key) => SecureStore.deleteItemAsync(key, OPTIONS)));
}

export async function loadDocumentPasswords(): Promise<DocumentPasswords> {
  const raw = await SecureStore.getItemAsync(KEYS.docPasswords, OPTIONS);
  if (!raw) return { pan: null, byInstitution: {} };
  try {
    const parsed = JSON.parse(raw) as Partial<DocumentPasswords>;
    return { pan: parsed.pan ?? null, byInstitution: parsed.byInstitution ?? {} };
  } catch {
    return { pan: null, byInstitution: {} };
  }
}

export async function saveDocumentPasswords(passwords: DocumentPasswords): Promise<void> {
  await SecureStore.setItemAsync(KEYS.docPasswords, JSON.stringify(passwords), OPTIONS);
}
