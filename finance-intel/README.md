# Finance Intel

A private, automated personal finance app for India. It is Android-first and built on free tiers.

- [`INTEGRATION_FEASIBILITY.md`](INTEGRATION_FEASIBILITY.md) records what can be connected legitimately, the costs, and the decisions taken.
- [`ARCHITECTURE.md`](ARCHITECTURE.md) explains how data flows and how it is secured.
- [`SETUP.md`](SETUP.md) walks you through deploying the backend, creating the Google OAuth client and installing the app.

| Phase | Status |
|---|---|
| 1. Feasibility and cost audit | Done |
| 2. Authentication and connection architecture | Done (needs on-device verification) |
| 3–9 | Not started |

```bash
npm install
npm run typecheck   # app, backend, core
npm test            # core + backend unit/integration tests
```
