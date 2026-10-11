import { valueInPaise } from '@fi/core';
import { getDatabase } from './database';

export interface SchemeView {
  key: string;
  scheme: string;
  amc: string;
  folio: string;
  isin: string | null;
  /** Units on the latest statement (×1e6). */
  unitsMicro: number | null;
  unitsAsOf: string | null;
  statementValuePaise: number | null;
  costPaise: number | null;
  /** Latest AMFI NAV for this ISIN (×1e6), if the NAV feed has it. */
  navMicro: number | null;
  navDate: string | null;
  /** units × latest NAV; null when either is unknown. */
  currentValuePaise: number | null;
  transactionCount: number;
  lastTransactionDate: string | null;
  /** Sum of imported transaction units. Differs from `unitsMicro` when history is incomplete. */
  transactionUnitsMicro: number | null;
}

export interface HoldingView {
  accountKey: string;
  broker: string;
  depository: string;
  /** Last 4 digits of the client id only. */
  clientIdTail: string;
  asOf: string;
  isin: string;
  name: string | null;
  kind: 'equity' | 'mutual_fund';
  quantityMicro: number;
  priceMicro: number | null;
  valuePaise: number | null;
}

export interface ImportWarning {
  issuer: string;
  periodTo: string | null;
  warnings: string[];
}

export async function loadInvestments(): Promise<{ schemes: SchemeView[]; holdings: HoldingView[]; warnings: ImportWarning[] }> {
  const db = await getDatabase();
  const schemeRows = await db.getAllAsync<{
    key: string; scheme: string; isin: string | null; amc: string; folio: string;
    units_micro: number | null; as_of: string | null; value_paise: number | null; cost_paise: number | null;
    txn_count: number; last_txn: string | null; txn_units: number | null;
  }>(
    `SELECT s.key, s.scheme, s.isin, f.amc, f.folio,
       u.units_micro, u.as_of, u.value_paise, u.cost_paise,
       (SELECT COUNT(*) FROM mf_transactions t WHERE t.scheme_key = s.key) AS txn_count,
       (SELECT MAX(date) FROM mf_transactions t WHERE t.scheme_key = s.key) AS last_txn,
       (SELECT SUM(units_micro) FROM mf_transactions t WHERE t.scheme_key = s.key) AS txn_units
     FROM mf_schemes s
     JOIN mf_folios f ON f.key = s.folio_key
     LEFT JOIN units_snapshots u ON u.key = (SELECT key FROM units_snapshots WHERE scheme_key = s.key ORDER BY as_of DESC LIMIT 1)
     ORDER BY f.amc, s.scheme`,
  );
  const schemes: SchemeView[] = [];
  for (const r of schemeRows) {
    const nav = r.isin
      ? await db.getFirstAsync<{ nav_scaled: number; nav_date: string }>(
          'SELECT nav_scaled, nav_date FROM nav_quotes WHERE isin_growth = ? OR isin_reinvest = ? ORDER BY nav_date DESC LIMIT 1',
          r.isin,
          r.isin,
        )
      : null;
    schemes.push({
      key: r.key,
      scheme: r.scheme,
      amc: r.amc,
      folio: r.folio,
      isin: r.isin,
      unitsMicro: r.units_micro,
      unitsAsOf: r.as_of,
      statementValuePaise: r.value_paise,
      costPaise: r.cost_paise,
      navMicro: nav?.nav_scaled ?? null,
      navDate: nav?.nav_date ?? null,
      currentValuePaise: nav && r.units_micro !== null ? valueInPaise(r.units_micro, nav.nav_scaled) : null,
      transactionCount: r.txn_count,
      lastTransactionDate: r.last_txn,
      transactionUnitsMicro: r.txn_units,
    });
  }

  const holdingRows = await db.getAllAsync<{
    account_key: string; broker: string; depository: string; client_id: string; as_of: string; isin: string;
    name: string | null; kind: 'equity' | 'mutual_fund'; quantity_micro: number; price_micro: number | null; value_paise: number | null;
  }>(
    `SELECT h.account_key, a.broker, a.depository, a.client_id, h.as_of, h.isin, h.name, h.kind, h.quantity_micro, h.price_micro, h.value_paise
     FROM demat_holdings h JOIN demat_accounts a ON a.key = h.account_key
     WHERE h.as_of = (SELECT MAX(as_of) FROM demat_holdings h2 WHERE h2.account_key = h.account_key)
     ORDER BY a.broker, h.kind, h.name`,
  );
  const holdings = holdingRows.map((h) => ({
    accountKey: h.account_key,
    broker: h.broker,
    depository: h.depository,
    clientIdTail: h.client_id.slice(-4),
    asOf: h.as_of,
    isin: h.isin,
    name: h.name,
    kind: h.kind,
    quantityMicro: h.quantity_micro,
    priceMicro: h.price_micro,
    valuePaise: h.value_paise,
  }));

  const warnings = (
    await db.getAllAsync<{ issuer: string; period_to: string | null; warnings: string | null }>(
      "SELECT issuer, period_to, warnings FROM statement_imports WHERE warnings IS NOT NULL AND warnings != '[]' ORDER BY imported_at DESC LIMIT 20",
    )
  ).map((w) => ({ issuer: w.issuer, periodTo: w.period_to, warnings: JSON.parse(w.warnings ?? '[]') as string[] }));

  return { schemes, holdings, warnings };
}
