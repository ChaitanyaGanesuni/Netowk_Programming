# Architecture (Phases 2–3)

```
finance-intel/
├── packages/core   Shared TypeScript: adapter contract, sync driver, retry/backoff, freshness,
│                   institution registry, Zod wire contracts, decimal parsing, AMFI parser,
│                   connection-row view model. Pure, unit-tested, no platform APIs.
├── backend         Cloudflare Worker (free tier) + D1: device enrollment, Google OAuth,
│                   encrypted token storage, scheduled Gmail sweeps, message proxy.
└── app             Expo (SDK 57) + Expo Router + SQLCipher SQLite: connections screen,
                    on-device sync of message pointers and NAVs.
```

## Data flow

1. Your institutions email alerts, statements and CAS to your Gmail. Gmail is the durable queue, so nothing is lost while your phone is off.
2. Every 30 minutes the Worker cron refreshes the Gmail access token and runs one search per institution (`from:` the institution's sender domains). It then stores **message IDs only** in D1:
   - The first sweep pages through all history (backfill).
   - Later sweeps use `after:<last sweep start − 2 days>`, so late-indexed mail is not missed.
3. The app pulls new message IDs (`/v1/inbox`, sequence cursor) and fetches each message through the Worker. The Worker serves only messages the sweep matched, so the app cannot read personal mail.
4. Parsing (Phase 4) runs on the phone. Parsed data lives only in the phone's encrypted database.
5. AMFI's NAV file is public, so the app downloads it directly.

## Adapter contract (`packages/core/src/adapter.ts`)

Every source implements `ProviderAdapter<T>`:

| Concern | Method or mechanism |
|---|---|
| Authentication / token renewal | `ensureAuthorized()`. Interactive sign-in is started by the UI. |
| Account discovery | `discoverAccounts()`. For Gmail, an estimated match count per institution. |
| Sync + pagination | `fetchPage(cursor)` returns `{records, nextCursor, done}` |
| Incremental updates | The cursor carries the high-water mark (Gmail) or sequence number (inbox) |
| Deduplication | `dedupKey(record)` plus an idempotent `SyncStore.upsert` |
| Errors | `ProviderError` kinds: `auth_expired`, `rate_limited`, `transient`, `permanent`, `parse_failed` |
| Retry / rate limits | `withRetry`: full-jitter exponential backoff that honours `Retry-After` |
| Revocation | `revoke()`. For Gmail, done per connection via Google's revoke endpoint. |
| Freshness | `assessFreshness(lastSuccess, cadence)`: fresh, aging, stale or never |

`runSync()` drives any adapter:

- It stores each page **before** advancing the cursor, so a crash replays at most one page and dedup makes the replay harmless.
- A failure keeps everything up to the last good page.
- Every run is recorded in sync history.

Adapters implemented in this phase:

| Adapter | Where | Notes |
|---|---|---|
| `GmailInstitutionAdapter` | backend | One per institution; per-run page budget fits the free plan's 50-subrequest limit |
| `BackendInboxAdapter` | app | Pulls message pointers from the Worker |
| `AmfiNavAdapter` | app | Keeps the newest NAV per scheme; an older file never overwrites a newer NAV |

Adding a source later (for example a broker API, if you choose a paid one) means writing one adapter. Nothing else changes.

## Reliability

| Mechanism | Behaviour |
|---|---|
| Connection backoff | After a failed sweep, the next attempt waits 5 min, 10 min, 20 min, … up to 6 h. The cron skips the connection until then. |
| Revoked Google grant | `invalid_grant` marks the connection `needs_reauth`. Every institution row then shows "Reconnect needed" with a reconnect button. |
| Last good data | Each source fails independently. The connections screen keeps showing the last good data, with its age and freshness level. |
| Manual sync | 2-minute cooldown, so taps cannot burn the Gmail quota. |

## Security

| Area | Measure |
|---|---|
| Credentials | No banking passwords, PINs or OTPs anywhere. Gmail uses OAuth 2.0 + PKCE with the read-only scope; the client secret lives only in Worker secrets. |
| Tokens at rest | AES-256-GCM, bound to the connection id as associated data. The key is a Worker secret. Device tokens are stored as SHA-256 hashes. |
| Account identity | The backend stores only a masked label (`c••••@gmail.com`) and a hash of the address. |
| Device enrollment | A one-time enrollment code (constant-time compare), at most 3 devices. Each device token is 256 bits of randomness, kept in the Android Keystore. |
| OAuth state | Single-use, 10-minute TTL, tied to the enrolling device. |
| Least privilege | The message proxy serves only IDs the sweep matched to a financial sender. |
| Local data | SQLCipher with a random 256-bit key held in the Keystore (`WHEN_UNLOCKED_THIS_DEVICE_ONLY`). `android.allowBackup=false` keeps the database out of Google backups. |
| Logs | Structured, with tokens, emails and long digit runs redacted. |
| Validation | Every API response is checked against Zod contracts on both sides. |
| User control | Disconnect (revokes at Google and deletes backend data) and "Delete all local data". |

## Phase 3: statement import

```
Gmail (CAS / statement emails) ──backend proxy──▶ app
  parseMail (pure-TS MIME) → classifyMail → PDF attachments
  → hidden WebView running pdf.js (engine.html, CSP: no network)
      + PDF_PAGE_EXTRACTOR_JS (one atom per text-show op, exact glyph x)
  → parseCas: CAMS/KFintech detailed | CDSL  (ports of casparser 1.4.1, MIT)
  → normalizeCas: integer paise / micro-units, deterministic keys
  → SQLite (encrypted): mf_folios, mf_schemes, mf_transactions, units_snapshots,
                        demat_accounts, demat_holdings, statement_imports, documents
```

**Passwords.** CAS PDFs open with your PAN. You enter it once on the Documents screen and it is stored in the Android Keystore. Bank statement passwords per institution are supported by the same store, for Phase 4.

**Idempotency.**
- A transaction's key covers scheme, date, description, type, amount, units and the printed running balance, so a re-requested or overlapping CAS adds nothing.
- Snapshots are keyed per scheme and date.

**Self-checks.**
- Each RTA scheme is reconciled against the statement's own running unit-balance column, and any discontinuity is stored as a warning.
- The Investments screen flags schemes whose imported transactions don't add up to the statement's units ("history incomplete"). Missing rows are never invented.

**How the parsers are verified.**

| Layer | Test |
|---|---|
| Parser fidelity | Synthetic encrypted CAS PDFs (`packages/core/test/fixtures`) are parsed by casparser itself. Its output is the expected result, and the TypeScript port must match it field by field. |
| On-device engine | The real `engine.html` runs in headless Chromium (the engine behind Android WebView) with the app's injected extractor. It must produce the same atoms as Node, distinguish wrong and missing passwords, and make zero network requests. |
| Pipeline | The app's real migrations and import SQL run against SQLite, from MIME email through import, re-import and the Investments queries. |

**Not yet covered:**
- NSDL CAS (detected; rejected with an explanation).
- CAMS/KFintech *summary* CAS (asks for a Detailed one).
- The NPS section of a CDSL CAS.
- Bank and card email parsing (Phase 4, needs your redacted samples).

## Known gaps carried to later phases

- Raw email parsing per bank and card template: Phase 4. This needs your redacted samples; the Documents screen can produce them.
- Push notifications for `needs_reauth` and failed syncs: Phase 8. Today they show on the connections screen.
- SQLCipher keying (`PRAGMA key`), the OAuth return flow and the WebView bridge on a physical device still need on-device confirmation; the build sandbox has no Android emulator (the engine page itself is tested in Chromium).
