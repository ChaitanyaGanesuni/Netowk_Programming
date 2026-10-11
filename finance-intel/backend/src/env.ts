import type { SqlDatabase } from './db';

export interface Env {
  DB: SqlDatabase;
  PUBLIC_BASE_URL: string;
  APP_REDIRECT_URI: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  /** Base64 of 32 random bytes; encrypts OAuth tokens at rest. */
  TOKEN_ENCRYPTION_KEY: string;
  /** One-time code you type into the app to enrol a device. */
  ENROLLMENT_CODE: string;
}

/** Injected dependencies, so tests can replace the network and the clock. */
export interface Deps {
  fetch: typeof fetch;
  now: () => number;
}
