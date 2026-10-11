# Finance Intel

A private, automated personal finance app for India. It is Android-first and built on free tiers.

- [`INTEGRATION_FEASIBILITY.md`](INTEGRATION_FEASIBILITY.md) records what can be connected legitimately, the costs, and the decisions taken.
- [`ARCHITECTURE.md`](ARCHITECTURE.md) explains how data flows and how it is secured.
- [`SETUP.md`](SETUP.md) walks you through deploying the backend, creating the Google OAuth client and installing the app.
- [`SECURITY.md`](SECURITY.md) covers the threat model, data flows and your export/delete controls.

| Phase | Status |
|---|---|
| 1. Feasibility and cost audit | Done |
| 2. Authentication and connection architecture | Done (needs on-device verification) |
| 3. Real investment integrations (CAS import) | Done for CAMS, KFintech and CDSL; NSDL pending a sample |
| 4. Bank and card transactions | Done with **generic** alert and statement parsers (no real samples yet); confidence-scored, with a redacted-sample path for anything unparsed |
| 5. Net worth and cash flow | Done |
| 6. Spending insights | Done (evidence-backed, never double-counted) |
| 7. Portfolio analytics | Done (XIRR, FIFO gains, allocation, concentration, scenarios); benchmark, TER and overlap disclosed as unavailable |
| 8. Assistant, notifications, reports | Done (deterministic answers; optional free Groq rewording, redacted and figure-checked) |
| 9. Security review and release | Done; APK built by GitHub Actions (debug-signed, for personal sideloading) |

**Get the APK:** open the latest successful run of the [finance-intel Android APK workflow](https://github.com/ChaitanyaGanesuni/Netowk_Programming/actions/workflows/finance-intel-android.yml) and download the `finance-intel-apk` artifact. Installation is in SETUP.md §3.

```bash
npm install
npm run typecheck   # app, backend, core
npm test            # core (ledger, analytics, portfolio, assistant, casparser differential, Chromium engine), backend, app pipeline
```

Third-party code: see [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
