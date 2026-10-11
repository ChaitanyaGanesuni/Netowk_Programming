# Setup guide (Phase 2)

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

## 3. Build and install the Android app — (you)

The app uses native modules (encrypted SQLite, Keystore), so it needs a development or preview build rather than Expo Go.

**Option A, cloud build (EAS):**

```bash
cd finance-intel/app
npx eas-cli@latest login
npx eas-cli@latest build --platform android --profile preview   # produces an installable APK
```

EAS has a free build quota; I could not verify the current limit from the sandbox.

**Option B, local build:** install Android Studio (JDK + SDK), connect your phone with USB debugging, then run `npx expo run:android`.

## 4. First run

1. Open the app and enter the Worker URL and your enrollment code.
2. Tap **Connect Gmail (read-only)** and approve access.
3. On the Gmail connection screen, tap **Scan mailbox**. Each institution shows roughly how many emails match its senders:
   - **Zero for SBI** usually means SBI alerts reach you by SMS only. Enable email statements in YONO/net-banking.
   - **Zero for anything else** means the sender list in `packages/core/src/institutions.ts` is wrong for you. Send one sample email header (From line only) and I will fix it.
4. Importing your history runs in the background every 30 minutes and finishes over a few hours. Pull down on the Connections screen to sync on demand.

## 5. Optional but recommended

- In net-banking and on each card's portal, turn on **email** transaction alerts and **email** e-statements. More emails means fewer gaps.
- Request a **detailed** CAS once from CAMS and once from KFintech, covering inception to today, delivered to the same Gmail. Phase 3 uses it to import your full mutual fund transaction history.

## Revoking access

- **In the app:** Gmail connection → **Disconnect and revoke access**. This revokes the grant at Google and deletes the backend's tokens, message pointers and history.
- **At Google:** myaccount.google.com → Security → Third-party apps with account access.
- **On the phone:** Device & privacy settings → **Delete all local data**.
