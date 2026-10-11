# Setup guide

Everything here uses free tiers. You need a Google account, a free Cloudflare account, and Node.js 22 on a laptop. Steps marked **(you)** need your accounts; nothing here asks for bank passwords, PINs or OTPs.

> I could not open the Google Cloud, Cloudflare or Expo consoles from the build sandbox, so menu names below may differ slightly from what you see. The settings themselves (scopes, redirect URI, publishing status) are what matter.

## 1. Deploy the backend (Cloudflare Worker) — (you)

```bash
cd finance-intel
npm install
cd backend
npx wrangler login                       # opens a browser; free account is enough
npx wrangler d1 create finance-intel     # copy the printed database_id into wrangler.jsonc
npm run db:migrate:remote                # creates the tables
npx wrangler deploy                      # prints https://finance-intel.<you>.workers.dev
```

Put that URL into `PUBLIC_BASE_URL` in `backend/wrangler.jsonc`, then set the secrets:

```bash
openssl rand -base64 32 | npx wrangler secret put TOKEN_ENCRYPTION_KEY   # encrypts OAuth tokens
openssl rand -hex 16                                                   # copy this: your enrollment code
npx wrangler secret put ENROLLMENT_CODE                                # paste the code above
npx wrangler deploy
```

Keep the enrollment code; the app asks for it once. Losing `TOKEN_ENCRYPTION_KEY` only means reconnecting Gmail.

## 2. Create the Google OAuth client — (you)

1. In Google Cloud Console, create a project (e.g. "finance-intel").
2. Enable the **Gmail API** for it.
3. Configure the OAuth consent screen / Google Auth Platform:
   - User type **External**, app name "Finance Intel", your email as support and developer contact.
   - Scope: `https://www.googleapis.com/auth/gmail.readonly`.
   - **Publish the app (status "In production").** In "Testing" status Google expires refresh tokens after 7 days, which would break background sync. Google exempts personal-use apps from verification; you will see an "unverified app" warning when you connect, which you can accept because you are the developer.
4. Create an OAuth client of type **Web application** with this authorized redirect URI:
   `https://finance-intel.<you>.workers.dev/oauth/google/callback`
5. Store the credentials in the Worker:

```bash
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

## 3. Install the Android app — (you)

The app uses native modules (encrypted SQLite, Keystore, WebView), so it needs a real build rather than Expo Go.

**Option A, ready-made APK (recommended, free):**

1. Every push to the app's branch runs the [finance-intel Android APK workflow](https://github.com/ChaitanyaGanesuni/Netowk_Programming/actions/workflows/finance-intel-android.yml). It typechecks, runs all tests, then builds a release APK for 64-bit ARM phones (practically every Android phone from 2017 on).
2. Open the latest green run, scroll to **Artifacts**, and download `finance-intel-apk`. GitHub delivers it as a zip, so unzip it to get `app-release.apk`. Artifacts expire after 90 days, but you can re-run the workflow at any time.
3. Copy it to your phone, open it, and allow "Install unknown apps" for your file manager when Android asks.
4. Play Protect may warn that the app is unrecognised. That is expected for a personal APK.

**About signing:** the APK is signed with the standard Android **debug** key. That is fine for personal sideloading, but anyone can sign an APK with that same key. Only install APKs from your own workflow runs. Moving to a personal release key later requires uninstalling, which deletes the local database, so first use **Export all my data**. After reinstalling, everything is rebuilt from Gmail on the next sync.

**Option B, local build:** install Android Studio (JDK 17 + SDK), then run `cd finance-intel/app && npx expo run:android --variant release` with your phone connected over USB debugging.

## 4. First run

1. Open the app and enter the Worker URL and your enrollment code.
2. Tap **Connect Gmail (read-only)** and approve access.
3. On the Gmail connection screen, tap **Scan mailbox**. Each institution shows roughly how many emails match its senders:
   - **Zero for SBI** usually means SBI alerts reach you by SMS only. Enable email statements in YONO/net-banking.
   - **Zero for anything else** means the sender list in `packages/core/src/institutions.ts` is wrong for you. Send one sample email header (From line only) and I will fix it.
4. Importing your history runs in the background every 30 minutes and finishes over a few hours. Pull down on the Connections screen to sync on demand.

## 5. Import your investments (Phase 3)

1. In the app, open **Documents & statement passwords** and save your PAN. It is stored only in the phone's Keystore and opens CAS PDFs locally.
2. Request a **Detailed** CAS covering *since inception*, emailed to this Gmail. These are one-time requests on the official sites; I can't automate them because they're web forms:
   - **CAMS:** CAS mail-back on camsonline.com.
   - **KFintech:** CAS request on kfintech.com (or mfs.kfintech.com).
   - Choose "Detailed", the period "since inception" (or the earliest date allowed), and set the password to your PAN when asked.
3. Monthly CDSL (or NSDL) statements then arrive on their own; Groww and Bajaj Broking holdings come from these.
4. After the next sync, open **Imported investments** and compare the figures with your PDFs.
   - "history incomplete" means a statement didn't start from your first purchase; request an older period.
   - A statement check warning means the parser and the statement disagree on a row. Please report it.

The PDF engine (`app/assets/pdfjs/engine.html`) is generated automatically by `npm install` (postinstall) from the pinned `pdfjs-dist`.

## 6. Bank and card transactions (Phase 4)

Nothing here needs passwords or manual entry. Transactions come from the alert and statement e-mails your banks already send.

1. In net-banking and on each card's portal, turn on **e-mail** transaction alerts and **e-mail** e-statements:
   - **SBI** in particular often sends alerts by SMS only.
   - The app never reads SMS.
2. Statement PDFs are usually password-protected. On the **Documents** screen, save each institution's statement password using the format the bank documents (often a mix of name and date of birth). The passwords stay in the Keystore.
3. **The parsers are generic.** They were written against typical Indian alert phrasings, not your actual e-mails. After the first sync, open **Documents**:
   - "Imported" means the e-mail was understood.
   - "Unsupported" e-mails have a **Share a redacted sample** button. It turns every digit into 9 and masks e-mail addresses, UPI IDs and PAN, but **names (yours, merchants') are left in**, so read it and delete them before sending. Send me those samples and I will add exact templates.
4. On the **Transactions** screen, tap any transaction to fix its category. The fix becomes a rule for that merchant and applies to its past and future transactions, so you teach the app once. Rules are listed at the bottom of the screen, where you can remove them.
5. The dashboard flags **balance gaps** where the alerts don't add up to the balance your bank reported. A gap usually means some alerts never reached e-mail.

## 7. Daily use

- **Dashboard:** net worth with a 12-month history, this month's cash flow, upcoming card bills, savings opportunities and data gaps.
- **Insights:** each one shows the transactions behind it and how the saving estimate was calculated.
- **Portfolio:** value, XIRR, gains, allocation, concentration and hypothetical shocks. Benchmark comparison, TER and fund overlap are listed as unavailable rather than guessed.
- **Assistant:** answers are calculated on the phone. To have them worded more naturally:
  - Create a free key at console.groq.com, turn on Zero Data Retention, and paste the key on the Assistant screen.
  - Check that the model name exists in your Groq console; the default `llama-3.3-70b-versatile` may be retired.
- **Reminders:** local notifications 3 days before and on each card's due date. Android 13+ asks for permission.
- **Report:** a monthly summary to share, plus a CSV of all transactions.

## Revoking access

- **In the app:** Gmail connection → **Disconnect and revoke access**. This revokes the grant at Google and deletes the backend's tokens, message pointers and history.
- **At Google:** myaccount.google.com → Security → Third-party apps with account access.
- **On the phone:** Device & privacy settings → **Export all my data**, then **Delete all local data**.

See [SECURITY.md](SECURITY.md) for what is stored where.
