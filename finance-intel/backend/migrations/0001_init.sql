-- Integration backend schema. Holds credentials (encrypted), sync state and message pointers.
-- Financial content (email bodies, amounts, balances) is NOT stored here; the app fetches
-- messages on demand and keeps parsed data in its local encrypted SQLite database.

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  revoked_at INTEGER
);

CREATE TABLE oauth_states (
  state TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  code_verifier TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE connections (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  -- SHA-256 of the lower-cased account email: lets a reconnect update the same row
  -- without storing the address itself.
  account_hash TEXT NOT NULL,
  account_label TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'needs_reauth', 'error', 'revoked')),
  scopes TEXT NOT NULL,
  refresh_token_enc TEXT,
  access_token_enc TEXT,
  access_expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_success_at INTEGER,
  last_error_at INTEGER,
  last_error TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  UNIQUE (provider, account_hash)
);

CREATE TABLE sync_cursors (
  connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  institution_id TEXT NOT NULL,
  cursor TEXT,
  backfill_complete INTEGER NOT NULL DEFAULT 0,
  last_success_at INTEGER,
  PRIMARY KEY (connection_id, institution_id)
);

-- Pointers to matched messages. `seq` gives the app a stable incremental cursor.
CREATE TABLE inbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  institution_id TEXT NOT NULL,
  discovered_at INTEGER NOT NULL,
  UNIQUE (connection_id, message_id)
);

CREATE TABLE sync_runs (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  trigger TEXT NOT NULL CHECK (trigger IN ('cron', 'manual')),
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  status TEXT NOT NULL,
  new_messages INTEGER NOT NULL DEFAULT 0,
  error_kind TEXT,
  error_message TEXT
);

CREATE INDEX idx_sync_runs_connection ON sync_runs (connection_id, started_at DESC);
CREATE INDEX idx_inbox_connection ON inbox (connection_id, seq);
