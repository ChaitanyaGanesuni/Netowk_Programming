# Integration Feasibility Audit — Personal Finance Intelligence (India)

**Status:** Phase 1 deliverable. No application code has been written yet. The decision gate in §9 needs your input before Phase 2 starts.
**Audit date:** 2026-10-11
**Scope:** One user (you), personal and non-commercial use, Android and iOS.

---

## 0. How to read this document

### 0.1 Confidence labels

Every claim carries one of these labels:

| Label | Meaning |
|---|---|
| **[V]** | **Verified.** Stated on an official regulator or provider page (RBI, Sahamati, AMFI, Zerodha, Upstox, Dhan, Angel One, Google, Cloudflare, Supabase, Anthropic) and seen in that page's content during this audit. |
| **[S]** | **Secondary.** Reported by a third party, such as a blog, a comparison site or a forum post. Treat it as likely but unconfirmed. |
| **[A]** | **Assumption.** My engineering judgement, not a sourced fact. It must be tested with real data before we rely on it. |
| **[U]** | **Unknown.** I could not establish this. It needs a direct check or a sample document from you. |

### 0.2 Research limitation

This audit ran in a cloud sandbox whose network policy blocks direct HTTPS connections to most Indian financial domains, including amfiindia.com, sahamati.org.in, kite.trade, docs.setu.co and perfios.ai. Every one of those requests returned `CONNECT 403`.

I verified facts through web-search excerpts of those official pages instead, and every URL is cited. Nothing here comes from memory without a label. **Before Phase 3, we re-check each [V] item against the live page from a normal network.** Prices in particular change often.

---

## 1. Executive summary

1. **You cannot use India's Account Aggregator (AA) network directly. [V]**
   The RBI Master Direction and Sahamati both say a Financial Information User (FIU) must be "registered with and regulated by" a financial sector regulator: RBI, SEBI, IRDAI or PFRDA. Sahamati adds that only directly regulated entities qualify. An individual building a personal app is not eligible, and neither is an unregulated company you might set up for this purpose. Every AA technology partner I found, including Setu, Perfios and Finvu's FIU tooling, sells to FIUs, so none of them removes this requirement. **This is a hard blocker. I will not work around it.**

2. **No authorized "personal export API" for AA data exists that I could find. [U]**
   Consumer AA apps such as Finvu and OneMoney manage consents. I found no evidence that they offer a programmatic export.
   Fold, an AA-powered personal finance app, offers a CSV export from its web app [S]. It is a manual download, though, so it **does not meet your zero-manual-entry rule**. It is listed only as a fallback.

3. **Your own mailbox is the most complete legitimate automatic source for bank and card data.**
   Indian banks and card issuers email per-transaction alerts and monthly e-statements to the address you registered with them.
   - SEBI makes email the default way depositories and mutual fund RTAs send the Consolidated Account Statement (CAS) [S].
   - NSDL and CDSL email a monthly CAS by the 10th of the following month whenever there was activity [S].
   - Google's documentation says apps for **personal use** are exempt from OAuth verification [V].

   Reading your own Gmail with your consent is therefore authorized, free and runs without you. Its limit is that it only knows what institutions email you (see §3.2).

4. **Broker APIs are free but need a daily login.**
   - Zerodha's Kite Connect **Personal** plan is free and includes holdings and funds, but no market data [V]. Its access token expires at about 6 AM daily, a regulatory requirement [V].
   - Upstox [V], Dhan [V] and Angel One [V] also use tokens that expire daily.
   - Upstox's **Analytics Token** is an exception: it is read-only, valid for 1 year, and requires a static IP for account APIs [V].

   Broker data therefore refreshes automatically only after a one-tap daily login, unless you use the Upstox Analytics Token route. The monthly depository CAS covers the gap.

5. **Market data:**
   - **Mutual fund NAVs:** AMFI publishes them free in `NAVAll.txt` [S, widely documented].
   - **Live stock quotes:** Kite Connect's paid plan costs ₹500 per month [V]. We do not need it: broker holdings responses carry `last_price` [V], and month-end CAS carries valuations.
   - **Gold:** I found **no** official free API for IBJA gold or silver rates [U]. Sovereign Gold Bonds (SGBs) and gold ETFs are valued through the CAS and AMFI NAVs. Physical and app-based "digital gold" **cannot be connected** [A].

6. **Recommended architecture** (details in §9):
   - An **email-ingestion pipeline**, using the Gmail API in personal-use mode, for bank and card alerts, e-statements, CAS files and RTA confirmations.
   - **AMFI NAV** feeds.
   - **Optional free broker APIs**.
   - **Local-first SQLite** storage, with parsing on the device.
   - A **₹0 backend** (Cloudflare Workers free tier) for scheduled jobs and notifications.
   - Optional AI at roughly **$0.10–$3 per month**.

   The expected recurring cost is **₹0–₹300 per month**, plus Apple's developer fee if you want the iOS build installed long-term (§10).

---

## 2. Banking and account aggregation

### 2.1 The Account Aggregator framework

| Item | Finding | Label |
|---|---|---|
| Legal basis | RBI Master Direction, NBFC – Account Aggregator (Reserve Bank) Directions, 2016, as updated. [rbi.org.in MD id=10598](https://www.rbi.org.in/Scripts/BS_ViewMasDirections.aspx?id=10598) | [V] |
| FIU definition | "An entity registered with and regulated by any financial sector regulator." | [V] |
| Sahamati FIU rule | Only entities directly "Registered with and regulated by" a financial sector regulator can be FIUs, so an unregulated holding company does not qualify. [Sahamati FIU guideline FUR001](https://sahamati.org.in/aa-community-guidelines-v1/fiu-roles-and-responsibilities) | [V] |
| FIU onboarding path | Build the FIU module to ReBIT specifications, test in an AA sandbox, enrol in the UAT registry, get certified by an empanelled certifier, then get listed in the live registry. [Sahamati FIU](https://sahamati.org.in/fiu/) | [V] |
| Sahamati membership | Requires a regulator's registration certificate, among other documents. [Sahamati RE membership form](https://sahamati.org.in/membership-form) | [V] |
| Reciprocity | One AA vendor says an FIU must also agree to act as an FIP (data reciprocity). [MoneyOne onboarding](https://docs.moneyone.in/business/onboarding/) | [S] |
| SRO status | One blog reports that RBI recognised Sahamati as the AA self-regulatory organisation on 5 June 2026. [ecorpit](https://ecorpit.com/account-aggregator-integration-fintech-builders-2026/) | [S] |
| Data available via AA | Bank deposits (savings and current), term and recurring deposits, equities, mutual funds and ETFs (through NSDL, CDSL, CAMS and KFintech as FIPs), NPS and insurance. [Sahamati FI types](https://sahamati.org.in/fi-types-activated-by-non-banking-fips-on-aa/), [CDSL FIP](https://www.cdslindia.com/Investors/FIP.html) | [V]/[S] |
| History and refresh | Set per consent (date range and fetch frequency) and limited by what each FIP supports. I did not find published per-bank figures. | [U] |

**Eligibility verdict:** **Not eligible.** An individual cannot be an FIU. Registering as an NBFC or another regulated entity to read your own bank data would be disproportionate, and the onboarding would require a real regulated business use case.

### 2.2 AA technology providers (FIU-side)

All of these serve regulated FIUs. None of them changes the eligibility verdict above.

| Provider | Docs | Personal-use eligible? | Sandbox | Pricing found | Label |
|---|---|---|---|---|---|
| Setu (Agya Technologies) | [docs.setu.co AA](https://docs.setu.co/data/account-aggregator/overview) | No. You must be an FIU. | Yes. A staging environment with mock data for all 23 FI types. | No public price. A certification cost is billed by Setu, amount not published. Third-party estimates (₹10–₹25 per fetch) are unofficial. | [V] docs; [S] prices |
| Perfios FIU Lite | [perfios.ai FIU Lite](https://perfios.ai/in/products/fiu-lite/) | Product page not reachable from this sandbox. It is an FIU product, so presumably regulated entities only. | [U] | ₹1,000/month for enrolment with 100 fetches included; top-up at ₹20 per fetch, minimum 200 fetches; plus GST. This comes from a search excerpt and could not be opened. | [S] |
| Finvu, OneMoney, CAMSfinserv, Saafe, NeSL, CRIF and others (the AAs themselves) | [Sahamati AA list](https://sahamati.org.in/account-aggregators/) | AAs serve FIUs. Their consumer apps only manage consent. | — | — | [V] |

**Cost if you were eligible:** at least ₹1,000/month plus certification, plus GST [S]. This is moot, because you are not eligible.

### 2.3 Consumer-side AA apps

| App | What an individual can do | Automatic export to our app? | Label |
|---|---|---|---|
| Finvu ([Play](https://play.google.com/store/apps/details?id=com.finvu), [App Store](https://apps.apple.com/in/app/finvu/id6499302887)) | Link accounts and manage or revoke consents. Sahamati lists viewing financial data as "Coming Soon". | **No.** I found no API or export. | [S] |
| OneMoney ([Play](https://play.google.com/store/apps/details?id=com.onemoney.app)) | Link accounts and manage consents. | **No.** I found no API or export. | [S] |
| Fold (uses Finvu and CAMS Finserv AA) | A unified view of bank and card transactions; CSV export from the web app. [Fold help](https://help.fold.money/hc/en-us/articles/17257745724178) | **Manual download only.** This does not meet the zero-manual-entry rule. | [S] |

### 2.4 Legitimate alternatives for bank data

| Option | Coverage | Automatic? | Authorization | Cost | Verdict |
|---|---|---|---|---|---|
| **A. Gmail API: bank and card transaction alert emails** | Every debit and credit your bank emails. Many alerts include the available balance [A]. Coverage depends on bank and alert settings [U]. | **Yes.** Server-side polling or Gmail push. The mail stays in Gmail even when the app is closed. | Your own Google OAuth consent. Google exempts **personal use** from verification [V]. In "Testing" status, refresh tokens expire after **7 days** [V], so the app must be in **Production (unverified, personal use)** status. That shows an "unverified app" warning once and caps the app at 100 users [V]. | ₹0 | **Recommended primary source** |
| **B. Gmail API: monthly bank and card e-statement PDFs** | Authoritative posted transactions and the statement closing balance. Used to reconcile the alert data from A. | **Yes,** once a month. | Same as A. Each PDF password is a *document* password, usually derived from date of birth or customer ID [A]. It is not a banking credential. You enter the rule once and it is stored encrypted on the device. | ₹0 | **Recommended reconciliation source** |
| C. IMAP with a Google app password | Same as A and B. | Yes. | An app password grants full mailbox access and cannot be scoped. | ₹0 | Fallback only. Weaker than OAuth. |
| D. Android SMS reading on the device | Bank SMS alerts. | Yes, on **Android only**. | Google Play restricts READ_SMS to default SMS handlers, with limited exceptions for budgeting apps [V]. A sideloaded personal APK is not distributed through Play, so whether the policy applies is [U]. iOS has no third-party SMS reading API [A, well established]. | ₹0 | Optional Android-only supplement. Not in the core design. |
| E. Bank-specific open APIs | Indian banks do not offer consumer read APIs. Corporate APIs exist, such as ICICI's and Yes Bank's API banking, but they target businesses [A]. | — | — | — | Not viable |
| F. Fold CSV export | Bank and card transactions via AA. | **No.** It is manual. | Fold's terms. | ₹0 | Emergency backfill only |

**Known limitations of A and B, disclosed up front:**
- Balance is exact only at the statement date and in alerts that state "Avl Bal". Between those points it is calculated from transactions and then reconciled.
- If a bank stops sending an alert type, or sends some alerts only by SMS, those transactions appear only on the next monthly statement. The connections screen shows this lag per institution.
- Each bank's email template needs its own parser, so a template change can break that parser. Parse failures go to quarantine and show an error on the connections screen; they are never silently dropped.
- Pending card authorizations versus posted transactions: alerts are usually sent at authorization and statements are posted. We model the two states separately (§6, requirement 7).

---

## 3. Investment integrations

### 3.1 Brokerage APIs

| Broker | Plan / cost | Holdings fields | Auth and token life | Refresh limit | Docs | Label |
|---|---|---|---|---|---|---|
| **Zerodha Kite Connect: Personal** | **Free.** Orders, holdings, positions and funds; **no live or historical market data.** | `tradingsymbol`, `isin`, `quantity`, `t1_quantity`, `average_price`, `last_price`, `close_price`, `pnl`, and more | OAuth-style redirect login. The `request_token` lasts minutes. The `access_token` expires at **about 6 AM the next day** (regulatory requirement). | Rate limits per the docs [U on exact values] | [Charges](https://support.zerodha.com/category/trading-and-markets/general-kite/kite-api/articles/what-are-the-charges-for-kite-apis), [Portfolio API](https://kite.trade/docs/connect/v3/portfolio/), [User/session](https://kite.trade/docs/connect/v3/user/) | [V] |
| Zerodha Kite Connect: Connect (paid) | **₹500/month per app.** Adds WebSocket quotes and historical candles. An Oct 2026 FAQ says paid users with ≥₹2,000 brokerage in a month get 500 developer credits toward renewal. | Same | Same | Same | [Charges](https://support.zerodha.com/category/trading-and-markets/general-kite/kite-api/articles/what-are-the-charges-for-kite-apis) | [V] |
| Zerodha MF (Coin) | Free or paid tier [U]. `GET /mf/holdings` returns folio, fund, ISIN, average price, last NAV, P&L and quantity. **Only MF units held in the Zerodha demat.** | — | Same token | — | [MF API](https://kite.trade/docs/connect/v3/mutual-funds/) | [V] fields; [U] whether included in the Personal plan |
| **Upstox: standard token** | Free [S] | Holdings endpoints | OAuth. Token valid **until 3:30 AM the next day**. | — | [Get Token](https://upstox.com/developer/api-documentation/get-token/) | [V] |
| **Upstox: Analytics Token** | Free [S] | Read-only subset, including portfolio APIs | **Valid for 1 year**, read-only. **Requires a static IP** for account-specific APIs. | — | [Analytics token](https://upstox.com/developer/api-documentation/analytics-token/), [Static IP announcement](https://upstox.com/developer/api-documentation/announcements/analytics-token-static-ip/) | [V] |
| Dhan (DhanHQ v2) | Trading APIs free. Data API ₹499 + tax per month. | `GET /holdings` | Access token valid **24 h** and renewable. API key and secret valid 12 months. | — | [Auth](https://dhanhq.co/docs/v2/authentication/), [Portfolio](https://dhanhq.co/docs/v2/portfolio/) | [V] |
| Angel One SmartAPI | Free | `getHolding`, `getAllHolding` (1 request/s) | Client code + **PIN + TOTP** login. The session is valid until midnight. | 1 req/s for holdings | [SmartAPI docs](https://smartapi.angelone.in/docs) | [V] |
| Fyers, Groww, ICICI Direct and others | Not investigated in depth. They will be added if you hold accounts there. | — | — | — | — | [U] |

**Automation verdict per broker:**
- **Zerodha Personal (free):** Fully automatic within a day after one daily login tap. The backend cannot log in for you without storing your password and TOTP secret, and **we will not do that**. When the token is stale, the connections screen shows "Login needed" and the monthly CAS keeps holdings current.
- **Upstox Analytics Token:** The **only broker route that works for a year without daily interaction.** It needs a backend with a static outbound IP, which free serverless platforms do not provide [A]. A small VPS costs roughly $4–6/month [A — price not verified; I will quote exact figures before purchase].
- **Angel One:** Automating its login requires storing your PIN and TOTP seed, which **violates your "never store PINs" rule**. Supported only as a manual login with tap-to-refresh.
- **Dhan:** One login per day, the same pattern as Zerodha.

### 3.2 Mutual fund holdings and transactions

**NAV data is not holdings.** NAVs only value units. Units and cash flows come from the separate sources below.

| Source | Data | How it arrives | Automatic? | Label |
|---|---|---|---|---|
| **NSDL / CDSL depository CAS (monthly)** | Demat holdings, MF units across all folios linked to your PAN, SGBs, bonds and NPS, with month-end valuation. **Holdings only, no MF transactions**, per casparser's schema. | Emailed to your registered address by the 10th of the next month when there was activity; every six months (Apr/Oct) for dormant accounts. | **Yes** (email ingestion) | [S] timing ([Upstox explainer](https://upstox.com/market-talk/all-about-the-consolidated-account-statement/)); [V] contents ([casparser](https://github.com/codereverser/casparser)) |
| **CAMS + KFintech detailed CAS** | Every folio and **full transaction history**: purchases, SIPs, redemptions, switches, dividends and stamp duty. | You request it through CAMS's mail-back or KFintech's form on their official sites, choosing "Detailed" and a period. It arrives as a password-protected PDF. [AMFI CAS](https://www.amfiindia.com/investor-corner/investor-center/cas.html) | **Once only** at onboarding for history since inception, then optionally each quarter. The request form is public; automating it may run into captchas or terms [U], so you click the official form and our app parses the email that comes back. | [V] |
| MFCentral portal | Holdings and CAS download; periods up to 365 days for specific-period CAS [S]. | Login with OTP | **No public API** found [U]. casparser v1.0 does not parse MFCentral's CAS template [V]. | [S]/[V] |
| CAMS / KFintech **transaction confirmation emails** | One email per SIP, purchase or redemption, with units, NAV and amount [A]. | Email | **Yes** | [A]: needs your sample emails to confirm |
| Zerodha `/mf/holdings` | Coin MF units only | Broker API | After daily login | [V] |

**Recommended MF pipeline:**
1. **One-time backfill:** a detailed CAMS + KFintech CAS covering inception to today. You request it once, and we parse every transaction.
2. **Ongoing:** RTA confirmation emails add transactions automatically, and the monthly NSDL/CDSL CAS reconciles units.
3. **Self-healing:** if units from CAS minus units derived from transactions ≠ 0, the app flags "missing transactions" and suggests a fresh detailed CAS. It **never invents** the missing rows.

**Parser:** [`casparser`](https://github.com/codereverser/casparser), MIT licence, Python [V]. It parses CAMS/KFintech summary and detailed CAS plus NSDL/CDSL CAS, and returns folios, schemes, transactions and valuations. Its `parse_warnings` flag data that did not reconcile [V].
This is Python, and the app is TypeScript, so we have two options:
- (a) run casparser in the backend, which needs a Python runtime; or
- (b) port the needed parsing to TypeScript on the device, using pdf.js text extraction.

I recommend **(b) for privacy, with casparser as the reference oracle in tests**. Porting carries effort and correctness risk, and that is flagged in the roadmap.

### 3.3 NAV and market data

| Data | Source | Cost | Refresh | Terms | Label |
|---|---|---|---|---|---|
| All MF NAVs, latest | AMFI `https://www.amfiindia.com/spages/NAVAll.txt`, semicolon-separated: scheme code, ISINs, name, NAV, date | Free | Daily (evening) | Public download page [S]; AMFI terms not read [U] | [S] URL; [V] historical download is limited to 90 days per request ([AMFI NAV download](https://www.amfiindia.com/net-asset-value/nav-download)) |
| Historical MF NAVs | AMFI historical download (90-day windows) | Free | On demand | As above | [V] |
| Expense ratio (TER) | AMCs must publish daily scheme-wise TER on their site **and on AMFI's site** as a downloadable spreadsheet (per the SID text) | Free | Daily | — | [V] requirement; [U] exact AMFI file URL |
| Stock/ETF last price | `last_price` / `close_price` in broker holdings responses | Free with broker | With each sync | Broker terms | [V] fields |
| Stock/ETF EOD prices | NSE/BSE bhavcopy (daily EOD file) | Free download | Daily | **NSE's terms on automated access were not verified.** Not used until checked. | [U] |
| Live quotes | Kite Connect paid, ₹500/month; Dhan Data API, ₹499/month + tax | Paid | Real-time | Licensed via broker | [V] — **not recommended; you don't need live ticks** |
| Fund underlying holdings (for overlap) | AMC monthly portfolio disclosures (SEBI-mandated) | Free | Monthly | Each AMC publishes in a different format | [A] — Phase 7, with a per-AMC adapter; overlap shown only where data exists |

### 3.4 Gold and silver

| Instrument | Holdings source | Price source | Automatic? | Label |
|---|---|---|---|---|
| Sovereign Gold Bonds | NSDL/CDSL CAS lists SGBs [S] | CAS valuation; RBI-published issue and redemption prices [U on API] | **Yes**, monthly | [S] |
| Gold / silver ETFs | Demat via CAS + broker API | Broker `last_price`; CAS valuation | **Yes** | [V]/[S] |
| Gold / silver MF fund-of-funds | CAS (RTA) | AMFI NAV | **Yes** | [S] |
| Digital gold (PhonePe, Paytm, Google Pay vendors, etc.) | No API found. These are not regulated securities and do not appear in CAS. | — | **Cannot be connected** | [A] |
| Physical gold/silver | — | IBJA publishes reference rates twice daily on business days [S]. **No official API was found** [U]. | **Cannot be connected** (no holdings source) | [S]/[U] |

### 3.5 Fixed deposits and other assets

| Asset | Source | Automatic? | Label |
|---|---|---|---|
| Bank FDs/RDs | FD-opening and maturity advice emails; some banks list FDs on the monthly e-statement | Partially, depending on the bank's emails | [A] — needs your samples |
| NPS | NSDL/CDSL CAS may include an NPS block [V per casparser schema] | Partially | [V]/[U] |
| EPF / PPF | No authorized personal API found | **Not connectable** in this phase | [U] |
| Insurance, real estate, loans given | — | **Not connectable** | — |
| Loans taken (home/personal) | EMI debits from bank data are visible; outstanding principal only if the lender emails statements | Partially | [A] |

---

## 4. Account-aggregation and data-access options ranked

Ranked by: (1) legitimacy, (2) coverage, (3) zero-manual-entry, (4) cost, (5) reliability, (6) complexity, (7) freshness.

| Rank | Option | Legit | Coverage | Zero-manual | Cost | Reliability | Complexity | Freshness |
|---|---|---|---|---|---|---|---|---|
| 1 | **Gmail API ingestion (alerts + statements + CAS + RTA mails)** | ✅ your consent | High: banks, cards, MF, demat | ✅ after setup | ₹0 | Medium: template drift | High: one parser per institution | Minutes (alerts) to monthly (statements) |
| 2 | **AMFI NAV feed** | ✅ public | All MF NAVs | ✅ | ₹0 | High | Low | Daily |
| 3 | **Upstox Analytics Token** (only if you use Upstox) | ✅ official | Upstox holdings | ✅ for 1 year | VPS ~$4–6/mo [A] | High | Medium | On demand |
| 4 | **Zerodha Kite Personal / Dhan** | ✅ official | Broker holdings and funds | ⚠️ one login tap per day | ₹0 | High | Low | Daily, after login |
| 5 | Android SMS (sideload) | ✅ on-device | Bank SMS | ✅ on Android only | ₹0 | Medium | Medium | Real-time |
| 6 | Fold CSV export | ✅ | Banks and cards via AA | ❌ manual export | ₹0 | Medium | Low | When you export |
| 7 | Account Aggregator (direct, as an FIU) | ❌ **not eligible** | Highest | ✅ | ≥₹1,000/mo + certification [S] | High | Very high | Per consent |
| ✗ | Screen-scraping net-banking with your password | ❌ violates your rules and bank terms | — | — | — | — | — | — |

---

## 5. What cannot be connected (disclosure)

- **Direct bank APIs and the AA network:** eligibility blocker (§2.1).
- **Real-time balances between alerts:** derived, not authoritative, until the next alert or statement.
- **Banks or cards that do not email alerts or statements:** these have no coverage until you enable email alerts in net-banking. That is a one-time setting change.
- **Digital gold and physical gold or silver.**
- **EPF, PPF, insurance surrender values and real estate.**
- **MFCentral CAS via API:** none found.
- **Live intraday market prices** without the paid broker data plan, which is not recommended.
- **iOS SMS.**

---

## 6. Authentication flows (no passwords, PINs or OTPs are ever stored)

| Integration | Flow | What we store | Where |
|---|---|---|---|
| Gmail | OAuth 2.0 with PKCE (installed app), scope `gmail.readonly`. A label filter (`label:finance-intel`) limits *what we read*, but the scope itself grants read access to all mail. **This is disclosed to you.** | Refresh token | Backend secret store (encrypted), or on the device only for a no-backend mode |
| Zerodha | Kite login redirect → `request_token` → server-side exchange using `api_secret` | Daily `access_token` | Backend only; `api_secret` never ships in the app |
| Upstox Analytics | Token generated in the Upstox developer console | Long-lived token | Backend secret store on the static-IP host |
| Dhan | Token from Dhan Web, renewable | 24 h token | Backend |
| PDF passwords (statements/CAS) | You enter the rule once, e.g. "PAN + DOB" | The rule, encrypted | Device secure store (expo-secure-store / Keychain / Keystore) |

---

## 7. Infrastructure options (backend)

| Option | Free tier (verified) | Fit | Label |
|---|---|---|---|
| **Cloudflare Workers + D1** | 100k requests/day; **5 cron triggers**; **10 ms CPU per invocation**; D1 5M rows read and 100k rows written per day, 5 GB storage; hard-enforced from 1 Sep 2026 | Good for: cron, the Gmail poll (I/O-bound), the AMFI NAV fetch, token exchange and push notifications. **Too little CPU for PDF parsing**, so parsing runs on the device. | [V] [limits](https://developers.cloudflare.com/workers/platform/limits/) |
| Supabase Free | 500 MB DB, 500k Edge Function invocations, **paused after 7 days of inactivity** | Workable, but there is a pausing risk if cron does not count as activity [U] | [V] [pausing](https://supabase.com/docs/guides/platform/free-project-pausing), [pricing](https://supabase.com/pricing) |
| Cloudflare Workers Paid | $5/month (price to re-verify [U]); much higher CPU limits | Only if server-side parsing becomes necessary | [U] |
| Small VPS with a static IP | ~$4–6/month [A] | Required **only** for the Upstox Analytics Token | [A] |

**Recommendation:** Cloudflare Workers free tier as the integration backend.
- It holds the integration secrets and tokens, runs the cron jobs, and queues *pointers* (Gmail message IDs) plus small extracted payloads.
- The device downloads the raw emails and PDFs through the backend proxy or directly through Gmail, parses them locally, and stores normalized data in SQLite.
- **Financial records are not kept in the cloud by default.** Cloud backup is an opt-in, end-to-end-encrypted export.

---

## 8. AI provider (optional)

All arithmetic happens in the deterministic engine. The LLM only receives verified, minimized summaries with evidence IDs, and the app works fully without it.

| Model | Price (input / output per 1M tokens) | Est. monthly cost* | Label |
|---|---|---|---|
| Claude Opus 5.5 (default) | $4 / $20 | ≈ $3.20 | [V] Anthropic pricing table, Oct 2026 |
| Claude Sonnet 5.5 | $2 / $10 | ≈ $1.60 | [V] |
| Claude Haiku 5.5 | $0.10 / $0.50 | ≈ $0.08 | [V] |

\*Assumes 100 assistant questions per month at about 4k input and 800 output tokens each. Transaction categorization is mostly rule-based; AI fallback for unmatched merchants adds roughly 1–2k short calls per month, under $0.50 even on Opus [A].

---

## 9. Decision gate — recommended architecture

### 9.1 Recommendation: "Email-first + official free feeds + optional broker APIs"

```
 Institutions ──email──▶ Gmail ◀──OAuth (read-only)── Cloudflare Worker (cron, free)
   (banks, cards,                                         │  • polls Gmail by label/sender, queues message IDs
    NSDL/CDSL, CAMS/KFin)                                 │  • fetches AMFI NAVAll.txt daily
                                                          │  • exchanges/holds broker tokens (Kite/Dhan/Upstox*)
 Broker APIs ◀──────── token ─────────────────────────────┤  • sends push alerts (sync failure, consent/token expiry, bills)
 AMFI NAV   ◀──────── public ─────────────────────────────┘
                                                          ▼
                     Expo app (Android + iOS): provider adapters → parsers → normalizer
                     → dedup / transfer matching → SQLite (encrypted) → engines
                     (net worth, cash flow, waste, XIRR) → UI; optional LLM on summaries
```
\*The Upstox Analytics route needs a static-IP host and is used only if you have an Upstox account.

### 9.2 Why this design

- It is the only design that is **both legitimate and largely zero-manual** for an individual.
- The core costs ₹0.
- Email acts as a durable, server-side queue. Data is not lost when the phone is off, and the backend never has to hold your transaction history.
- Every adapter implements the same interface (auth, discover, sync, paginate, incremental cursor, dedup key, errors, token renewal, revoke, freshness), so if an AA-for-individuals route appears later, it plugs in as a new adapter.

### 9.3 Honest automation level

| Data | Automation level |
|---|---|
| Bank transactions | Automatic (alerts), reconciled monthly (statements) |
| Bank balance | Automatic when alerts carry it; otherwise authoritative monthly and derived in between |
| Credit card | Automatic (alerts and statement: total due, minimum due, due date) |
| MF holdings and transactions | **One-time CAS request** at onboarding, then automatic (RTA emails + monthly CAS) |
| Stocks/ETFs/SGBs | Automatic monthly (CAS); daily after one login tap (Zerodha/Dhan), or fully automatic (Upstox Analytics + VPS) |
| NAVs | Automatic, daily |

### 9.4 Inputs needed from you before Phase 2

1. **Institutions:** which banks, credit cards, brokers or demat accounts (NSDL or CDSL), and mutual fund platforms do you use?
2. **Email:** is a single Gmail address registered with all of them? Other providers (Outlook, Zoho) need IMAP or Graph adapters.
3. **Upstox Analytics route:** if you use Upstox, is a ~$4–6/month static-IP VPS acceptable? I will quote exact prices before any purchase.
4. **iOS distribution:** with a free Apple account, sideloaded builds expire every 7 days [A]. A long-lived install needs the Apple Developer Program, about $99/year [A — to verify]. Is that acceptable, or Android-first?
5. **AI:** Opus 5.5 (about $3/month), Haiku 5.5 (about $0.10/month), or off?
6. **Samples:** one redacted alert email and one statement per bank or card, so the parsers are built against real templates, not guessed ones.

---

## 10. Cost summary

| Category | Item | Cost | Label |
|---|---|---|---|
| **Development** | Expo / EAS free tier builds, TypeScript tooling | ₹0 (free build quota [U]) | [U] |
| | Google Cloud project for Gmail OAuth | ₹0 | [V] personal-use exemption |
| | Zerodha Kite Personal API app | ₹0 | [V] |
| **Recurring operating** | Cloudflare Workers + D1 free | ₹0 | [V] |
| | AMFI NAV | ₹0 | [S] |
| | AI assistant | $0.08–$3.20/month | [V] prices, [A] usage |
| | *Optional:* static-IP VPS for Upstox Analytics | ~$4–6/month | [A] |
| | *Optional, not recommended:* live market data (Kite Connect / Dhan Data) | ₹500 / ₹499 + tax per month | [V] |
| | *Optional:* Apple Developer Program | ~$99/year | [A] |
| **Regulated-provider onboarding** | Account Aggregator as an FIU | **Not available to an individual.** If it were: ≥₹1,000/month + certification + GST [S] | [V] eligibility |

**Expected total for one user:** ₹0 per month for the core system, about ₹10–₹270 per month with AI, and more only if you choose the optional items.

---

## 11. Risks and open verification items

| # | Item | Action |
|---|---|---|
| R1 | Bank email templates change without notice | Per-bank parser versioning, quarantine for unparsed mail, and a parse-failure alert on the connections screen |
| R2 | The Gmail "unverified app" production mode for personal use: must confirm refresh tokens persist past 7 days | Test in Phase 2 with your account |
| R3 | Whether Zerodha's Personal plan includes `/mf/holdings` | Test call in Phase 3 |
| R4 | NSE bhavcopy automated-access terms | Read NSE's terms of use before any use; otherwise rely on broker and CAS prices |
| R5 | Exact AMFI TER file URL and format | Locate from a normal network in Phase 7 |
| R6 | Porting casparser to TypeScript: correctness | Use the Python casparser as a test oracle against your real CAS files |
| R7 | Re-verify every [V] price and limit from a non-sandboxed network | Before Phase 3 |
| R8 | Supabase pausing semantics (if chosen over Cloudflare) | Not needed under the recommended option |

---

## 12. Source index

- RBI Master Direction, NBFC-AA: https://www.rbi.org.in/Scripts/BS_ViewMasDirections.aspx?id=10598
- Sahamati FIU guide: https://sahamati.org.in/fiu/ · FIU guideline FUR001: https://sahamati.org.in/aa-community-guidelines-v1/fiu-roles-and-responsibilities · Membership: https://sahamati.org.in/membership-form · AA list: https://sahamati.org.in/account-aggregators/ · Non-bank FI types: https://sahamati.org.in/fi-types-activated-by-non-banking-fips-on-aa/ · AA apps: https://sahamati.org.in/aa-apps/
- ReBIT/NBFC-AA API spec v2.0.0: https://sahamati.org.in/wp-content/uploads/2025/10/2-API_Specifications_v2.0.0.pdf
- CDSL as FIP: https://www.cdslindia.com/Investors/FIP.html · NSDL as FIP: https://nsdl.com/financial-information-provider
- Setu AA docs: https://docs.setu.co/data/account-aggregator/overview
- Perfios FIU Lite: https://perfios.ai/in/products/fiu-lite/
- Fold CSV export: https://help.fold.money/hc/en-us/articles/17257745724178 · Fold AA access: https://help.fold.money/hc/en-us/articles/17449613167890
- Zerodha API charges: https://support.zerodha.com/category/trading-and-markets/general-kite/kite-api/articles/what-are-the-charges-for-kite-apis · Kite portfolio: https://kite.trade/docs/connect/v3/portfolio/ · Kite user/session: https://kite.trade/docs/connect/v3/user/ · Kite MF: https://kite.trade/docs/connect/v3/mutual-funds/ · Personal API announcement: https://kite.trade/forum/discussion/14868/
- Upstox tokens: https://upstox.com/developer/api-documentation/get-token/ · Analytics token: https://upstox.com/developer/api-documentation/analytics-token/
- DhanHQ auth: https://dhanhq.co/docs/v2/authentication/ · Portfolio: https://dhanhq.co/docs/v2/portfolio/
- Angel One SmartAPI: https://smartapi.angelone.in/docs
- AMFI CAS: https://www.amfiindia.com/investor-corner/investor-center/cas.html · NAV download: https://www.amfiindia.com/net-asset-value/nav-download
- casparser: https://github.com/codereverser/casparser
- Google OAuth app audience and 7-day tokens: https://support.google.com/cloud/answer/15549945 · Restricted scope verification: https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification
- Google Play SMS policy: https://support.google.com/googleplay/android-developer/answer/10208820
- Cloudflare Workers limits: https://developers.cloudflare.com/workers/platform/limits/ · D1 free-tier enforcement: https://developers.cloudflare.com/changelog/post/2026-09-01-d1-free-tier-limit-enforcement/
- Supabase pausing: https://supabase.com/docs/guides/platform/free-project-pausing · Pricing: https://supabase.com/pricing
- Secondary: Upstox CAS explainer https://upstox.com/market-talk/all-about-the-consolidated-account-statement/ · ecorpit AA 2026 https://ecorpit.com/account-aggregator-integration-fintech-builders-2026/
