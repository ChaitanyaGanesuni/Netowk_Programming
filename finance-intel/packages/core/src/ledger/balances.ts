import { signedAmount, type RawTxn } from './ledger';

/** A balance stated by a source: an alert's "Avl bal" or a statement's closing balance. */
export interface BalanceSnapshot {
  accountKey: string;
  /** Epoch ms when this balance was true (the alert/statement time). */
  at: number;
  date: string;
  balancePaise: number;
  source: 'alert' | 'bank_statement' | 'card_statement';
}

export interface BalanceGap {
  accountKey: string;
  fromDate: string;
  toDate: string;
  expectedPaise: number;
  reportedPaise: number;
  /** reported − expected: what unseen transactions must add up to. */
  gapPaise: number;
}

/**
 * Checks consecutive balance checkpoints of each account against the posted transactions
 * between them. A gap means transactions are missing (e.g. an SMS-only alert) — it is
 * reported, never filled with an invented transaction.
 */
export function reconcileBalances(snapshots: readonly BalanceSnapshot[], txns: readonly RawTxn[], tolerancePaise = 100): BalanceGap[] {
  const gaps: BalanceGap[] = [];
  const byAccount = new Map<string, BalanceSnapshot[]>();
  for (const s of snapshots) byAccount.set(s.accountKey, [...(byAccount.get(s.accountKey) ?? []), s]);
  for (const [accountKey, list] of byAccount) {
    const ordered = [...list].sort((a, b) => a.at - b.at);
    const accountTxns = txns.filter((t) => t.accountKey === accountKey && t.status === 'posted');
    for (let i = 1; i < ordered.length; i++) {
      const prev = ordered[i - 1]!;
      const next = ordered[i]!;
      const movement = accountTxns.filter((t) => t.at > prev.at && t.at <= next.at).reduce((sum, t) => sum + signedAmount(t), 0);
      const expected = prev.balancePaise + movement;
      if (Math.abs(next.balancePaise - expected) > tolerancePaise) {
        gaps.push({ accountKey, fromDate: prev.date, toDate: next.date, expectedPaise: expected, reportedPaise: next.balancePaise, gapPaise: next.balancePaise - expected });
      }
    }
  }
  return gaps;
}

/** Latest stated balance per account. */
export function latestBalances(snapshots: readonly BalanceSnapshot[]): Map<string, BalanceSnapshot> {
  const out = new Map<string, BalanceSnapshot>();
  for (const s of snapshots) {
    const current = out.get(s.accountKey);
    if (!current || s.at > current.at) out.set(s.accountKey, s);
  }
  return out;
}
