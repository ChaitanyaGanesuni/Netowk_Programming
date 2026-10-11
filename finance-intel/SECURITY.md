# Security and privacy review (Phase 9)

This is a single-user app that you run on your own phone and your own free Cloudflare account. This document covers what it protects, how it protects it, and what it does not protect.

## What the app never does

- It never asks for, receives or stores net-banking passwords, card PINs, OTPs, or UPI PINs. No screen has a field for them, and no code path accepts them.
- It never scrapes bank or broker websites or apps, and it never reads SMS. `READ_SMS` and `RECEIVE_SMS` are explicitly blocked in `app.json`, together with contacts, location, camera and microphone.
- It never ships an API secret in the APK. The Google OAuth client secret and the token-encryption key live only in Worker secrets. The only key on the phone is your own optional Groq key, which you enter yourself and which is kept in the Keystore.
- It never sells or shares data. There is no analytics or ads SDK, and no telemetry.
- It never shows demonstration data. Every screen shows either your imported data or an empty state that explains what is missing.

## Data flows

| Flow | What crosses | Protection |
|---|---|---|
| Gmail → Worker | Message **IDs** from known financial senders (`gmail.readonly` scope) | OAuth 2.0 + PKCE. Refresh token encrypted with AES-256-GCM in D1. |
| Worker → phone | Raw messages, **only** for IDs the sweep matched | HTTPS. A per-device bearer token (256-bit, stored hashed on the server). The Worker never stores message bodies. |
| Phone (local) | Parsing, ledger, analytics, assistant answers | SQLCipher database with a random 256-bit key held in the Android Keystore. CAS PDFs are opened in a WebView whose Content Security Policy forbids all network access. |
| Phone → AMFI | A plain GET of the public NAV file | Nothing about you is sent. |
| Phone → Groq (optional, off by default) | Your question, the calculated answer, and its figures | Account and card numbers (including last-4 suffixes) and e-mail addresses are masked first (`redactForLlm`, unit-tested). Answers listing individual transactions are never sent. Notes naming accounts stay on the phone. A reply that changes or invents a rupee figure is discarded. Turn on **Zero Data Retention** in the Groq console. |
| Phone → share sheet | Report text, CSV or JSON export, **only when you tap Share** | Written to a private cache folder that is wiped before each export and by "Delete all local data". |

## Threat model

| Threat | Mitigation | Residual risk |
|---|---|---|
| Lost or stolen phone | The database is encrypted with a Keystore key (`WHEN_UNLOCKED_THIS_DEVICE_ONLY`). Android file-based encryption also applies. | Someone who can unlock your phone can open the app. There is no separate app PIN or biometric gate yet. |
| Cloud backup leak | `allowBackup=false`, so the database is not copied to Google Drive. | — |
| Lock-screen exposure | Reminder notifications use `PRIVATE` visibility, so amounts are hidden on a secure lock screen. | Depends on your Android lock-screen settings. |
| Malicious app on the phone | Data sits in the app sandbox. No exported content providers. The OAuth return deep link (`financeintel://oauth`) carries only a status, never a token. | A rooted or compromised phone defeats sandboxing. |
| Worker compromise | Tokens are encrypted, and the Worker only holds read-only Gmail access. | Someone with your Cloudflare account and the Worker secrets could read your financial mail. Use 2FA on Cloudflare and Google. |
| Stolen device token | The Worker serves only financial-sender messages. You can revoke the device. | The holder can read those messages until you revoke it ("Disconnect", or delete the device row). |
| Spoofed bank e-mail | Messages are matched by sender domain, and parsed amounts carry a confidence level. | A forged e-mail that passes Gmail's checks could add a wrong transaction. You can correct its category, and the balance-reconciliation gaps on the dashboard expose most errors. |
| LLM data use | Off by default; redaction, exclusions and figure checks as above. | Fund names, category names and amounts are sent when you enable it. |
| Sideloaded APK tampering | Download only from your own GitHub Actions run. | The APK is signed with the **debug keystore**: any APK signed with the same public debug key could be installed as an update. A personal release keystore is a future step; switching keys later means uninstalling the app, so export your data first (SETUP.md §3). |

## Your controls

- **Export:** Device & privacy settings → **Export all my data (JSON)**; Monthly report → **Export all transactions (CSV)**.
- **Delete locally:** **Delete all local data** removes the database, its key, saved passwords, the AI key, export files and scheduled reminders.
- **Revoke Gmail:** in the Gmail connection screen, **Disconnect and revoke access** revokes the grant at Google and deletes the backend's tokens and message pointers. Alternatively, use myaccount.google.com → Security → Third-party access.
- **Delete the backend:** `npx wrangler delete` and `npx wrangler d1 delete finance-intel`.

## Verified by tests

- The LLM payload contains no account numbers, e-mail addresses or gap notes, and invented figures are rejected (`packages/core/test/assistant.test.ts`).
- The PDF engine makes zero network requests (`engine.browser.test.ts`, run in Chromium).
- The backend serves only matched messages and stores encrypted tokens (`backend/test`).

## Not verified

- No external penetration test or audit has been done.
- Keystore and SQLCipher behaviour has not been verified on a physical device from this sandbox.
