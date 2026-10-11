/**
 * Ordered migrations; index + 1 is the schema version stored in PRAGMA user_version.
 * Money columns are integer paise and NAVs are integers scaled by 10^6 — never REAL.
 */
export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  -- Last connection list from the backend, kept so the screen works offline.
  CREATE TABLE connections_cache (id TEXT PRIMARY KEY, json TEXT NOT NULL, fetched_at INTEGER NOT NULL);

  -- Per-source sync state for app-side adapters (backend inbox, AMFI NAV feed).
  CREATE TABLE feed_state (
    feed_id TEXT PRIMARY KEY,
    cursor TEXT,
    completed INTEGER NOT NULL DEFAULT 0,
    last_success_at INTEGER,
    last_attempt_at INTEGER,
    last_status TEXT,
    last_error TEXT,
    data_as_of TEXT
  );

  CREATE TABLE sync_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    finished_at INTEGER NOT NULL,
    status TEXT NOT NULL,
    received INTEGER NOT NULL,
    inserted INTEGER NOT NULL,
    error_kind TEXT,
    error_message TEXT
  );
  CREATE INDEX idx_sync_history_started ON sync_history (started_at DESC);

  -- Pointers to finance emails; parsing (Phase 4) moves status off 'pending'.
  CREATE TABLE inbox (
    connection_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    institution_id TEXT NOT NULL,
    discovered_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'parsed', 'failed', 'ignored')),
    PRIMARY KEY (connection_id, message_id)
  );

  CREATE TABLE nav_quotes (
    scheme_code TEXT PRIMARY KEY,
    isin_growth TEXT,
    isin_reinvest TEXT,
    scheme_name TEXT NOT NULL,
    nav_scaled INTEGER NOT NULL,
    nav_date TEXT NOT NULL,
    fetched_at INTEGER NOT NULL
  );
  CREATE INDEX idx_nav_isin_growth ON nav_quotes (isin_growth);
  `,
  `
  -- Phase 3: processed emails and imported investment records.
  CREATE TABLE documents (
    connection_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    institution_id TEXT NOT NULL,
    received_at INTEGER,
    subject TEXT NOT NULL,
    kind TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('imported', 'needs_password', 'unsupported', 'failed', 'awaiting_parser', 'skipped')),
    detail TEXT,
    warnings TEXT,
    parser_version INTEGER NOT NULL,
    processed_at INTEGER NOT NULL,
    PRIMARY KEY (connection_id, message_id)
  );
  CREATE INDEX idx_documents_status ON documents (status, received_at DESC);

  CREATE TABLE mf_folios (key TEXT PRIMARY KEY, amc TEXT NOT NULL, folio TEXT NOT NULL, holder_name TEXT, pan_masked TEXT, updated_at INTEGER NOT NULL);
  CREATE TABLE mf_schemes (
    key TEXT PRIMARY KEY, folio_key TEXT NOT NULL, scheme TEXT NOT NULL, isin TEXT, rta TEXT NOT NULL,
    rta_code TEXT NOT NULL, advisor TEXT, updated_at INTEGER NOT NULL
  );
  CREATE TABLE mf_transactions (
    key TEXT PRIMARY KEY, scheme_key TEXT NOT NULL, date TEXT NOT NULL, description TEXT NOT NULL, type TEXT NOT NULL,
    amount_paise INTEGER, units_micro INTEGER, nav_micro INTEGER, balance_micro INTEGER, dividend_rate_micro INTEGER,
    source_message_id TEXT NOT NULL, imported_at INTEGER NOT NULL
  );
  CREATE INDEX idx_mf_txn_scheme_date ON mf_transactions (scheme_key, date);
  CREATE TABLE units_snapshots (
    key TEXT PRIMARY KEY, scheme_key TEXT NOT NULL, as_of TEXT NOT NULL, units_micro INTEGER NOT NULL,
    nav_micro INTEGER, value_paise INTEGER, cost_paise INTEGER, source TEXT NOT NULL, source_message_id TEXT NOT NULL
  );
  CREATE INDEX idx_units_scheme_asof ON units_snapshots (scheme_key, as_of DESC);
  CREATE TABLE demat_accounts (key TEXT PRIMARY KEY, depository TEXT NOT NULL, broker TEXT NOT NULL, dp_id TEXT NOT NULL, client_id TEXT NOT NULL);
  CREATE TABLE demat_holdings (
    key TEXT PRIMARY KEY, account_key TEXT NOT NULL, as_of TEXT NOT NULL, isin TEXT NOT NULL, name TEXT, kind TEXT NOT NULL,
    quantity_micro INTEGER NOT NULL, price_micro INTEGER, value_paise INTEGER, folio TEXT, source_message_id TEXT NOT NULL
  );
  CREATE INDEX idx_demat_holdings_account ON demat_holdings (account_key, as_of DESC);
  CREATE TABLE statement_imports (
    id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL, source TEXT NOT NULL, issuer TEXT NOT NULL,
    period_from TEXT, period_to TEXT, imported_at INTEGER NOT NULL, new_transactions INTEGER NOT NULL, warnings TEXT
  );
  `,
];
