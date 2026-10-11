/**
 * Phase 4 tests. Alert texts are SYNTHETIC examples of common Indian phrasing — not copies of
 * your banks' templates. They pin down the generic parser's behaviour; real samples will be
 * added as fixtures when available.
 */
import { describe, expect, it } from 'vitest';
import { buildLedger, parseAlert, parseBankStatement, parseCardStatement, reconcileBalances, type RawTxn } from '../src/ledger';

describe('parseAlert', () => {
  it('reads a UPI debit with VPA, reference and available balance', () => {
    const a = parseAlert(
      'You have done a UPI txn. Check details!',
      'Dear Customer, Rs.250.00 has been debited from account **4521 to VPA swiggy.stores@icici on 10-10-26. Your UPI transaction reference number is 528311234567. Avl bal: Rs.12,345.60',
      '2026-10-10',
      false,
    );
    expect(a).toMatchObject({
      direction: 'debit', amountPaise: 25000, instrument: 'account', suffix: '4521', channel: 'UPI',
      counterparty: 'swiggy.stores@icici', reference: '528311234567', date: '2026-10-10', availableBalancePaise: 1234560, status: 'posted',
    });
    expect(a!.confidence).toBeGreaterThan(0.8);
  });

  it('reads a credit card spend as pending', () => {
    const a = parseAlert('Transaction alert', 'Thank you for using your Credit Card ending 7788 for INR 1,499.00 at AMAZON PAY INDIA on 08 Oct 2026 at 21:14:05. Available limit: INR 1,23,000.00', '2026-10-08', true);
    expect(a).toMatchObject({ direction: 'debit', amountPaise: 149900, instrument: 'card', suffix: '7788', status: 'pending', date: '2026-10-08', availableBalancePaise: 12300000 });
    expect(a!.counterparty).toBe('AMAZON PAY INDIA');
  });

  it('reads a salary NEFT credit', () => {
    const a = parseAlert('Credit alert', 'INR 85,000.00 credited to your A/c XX1234 on 01-10-2026 by NEFT from ACME TECH PVT LTD SALARY OCT. Avl Bal INR 1,02,000.50', '2026-10-01', false);
    expect(a).toMatchObject({ direction: 'credit', amountPaise: 8500000, suffix: '1234', channel: 'NEFT', availableBalancePaise: 10200050 });
  });

  it('reads an ATM withdrawal', () => {
    const a = parseAlert('ATM withdrawal', 'Rs 2000 withdrawn at ATM S1AN1234 from A/c XX9012 on 05/10/2026.', '2026-10-05', false);
    expect(a).toMatchObject({ direction: 'debit', amountPaise: 200000, channel: 'ATM', suffix: '9012' });
  });

  it('treats refunds as credits', () => {
    const a = parseAlert('Refund', 'A refund of Rs.499.00 from MYNTRA has been credited to your card ending 7788 on 09-10-2026', '2026-10-09', true);
    expect(a).toMatchObject({ direction: 'credit', amountPaise: 49900, instrument: 'card' });
  });

  it('rejects OTPs, offers and emails without an amount', () => {
    expect(parseAlert('OTP for transaction', 'Your OTP is 123456 for Rs.500 at Amazon', '2026-10-10', false)).toBeNull();
    expect(parseAlert('Exclusive offer', 'Get cashback offer up to Rs.500 on your card', '2026-10-10', true)).toBeNull();
    expect(parseAlert('Statement ready', 'Your statement is ready to download', '2026-10-10', false)).toBeNull();
  });
});

describe('statement summaries', () => {
  it('reads card dues and limits', () => {
    const s = parseCardStatement('Statement Date 15/09/2026\nPayment Due Date 05/10/2026\nTotal Amount Due Rs. 24,567.80\nMinimum Amount Due Rs. 1,230.00\nCredit Limit Rs. 3,00,000.00\nAvailable Credit Limit Rs. 2,75,432.20');
    expect(s).toEqual({ statementDate: '2026-09-15', dueDate: '2026-10-05', totalDuePaise: 2456780, minimumDuePaise: 123000, creditLimitPaise: 30000000, availableLimitPaise: 27543220 });
  });

  it('reads a bank closing balance', () => {
    const s = parseBankStatement('Statement for the period from 01-09-2026 to 30-09-2026\nOpening Balance 10,000.00\nClosing Balance 45,678.90');
    expect(s).toEqual({ periodFrom: '2026-09-01', periodTo: '2026-09-30', openingBalancePaise: 1000000, closingBalancePaise: 4567890 });
  });

  it('reads Cr/Dr markers with the right sign for each statement type', () => {
    expect(parseBankStatement('Closing Balance 45,678.90 Cr')?.closingBalancePaise).toBe(4567890);
    expect(parseBankStatement('Closing Balance 1,000.00 Dr')?.closingBalancePaise).toBe(-100000);
    expect(parseCardStatement('Total Amount Due 250.00 Cr')?.totalDuePaise).toBe(-25000);
  });
});

let n = 0;
function txn(p: Partial<RawTxn> & Pick<RawTxn, 'accountKey' | 'direction' | 'amountPaise'>): RawTxn {
  n++;
  return {
    key: `t${n}`, instrument: 'account', date: '2026-10-01', at: Date.parse('2026-10-01T10:00:00Z') + n * 1000, channel: 'OTHER',
    counterparty: null, description: '', reference: null, status: 'posted', confidence: 0.9, ...p,
  };
}

describe('buildLedger', () => {
  it('categorises with built-in rules and keeps accounting kinds apart', () => {
    const ledger = buildLedger([
      txn({ accountKey: 'hdfc:account:1234', direction: 'credit', amountPaise: 8500000, description: 'NEFT ACME SALARY' }),
      txn({ accountKey: 'hdfc:account:1234', direction: 'debit', amountPaise: 25000, counterparty: 'swiggy.stores@icici' }),
      txn({ accountKey: 'hdfc:account:1234', direction: 'debit', amountPaise: 500000, counterparty: 'BSE STAR MF SIP' }),
      txn({ accountKey: 'hdfc:account:1234', direction: 'debit', amountPaise: 35400, description: 'Debit card annual fee incl GST' }),
      txn({ accountKey: 'hdfc:account:1234', direction: 'debit', amountPaise: 200000, channel: 'ATM' }),
    ]);
    expect(ledger.map((t) => [t.category, t.kind])).toEqual([
      ['salary', 'income'],
      ['food_delivery', 'expense'],
      ['investments', 'investment'],
      ['bank_charges', 'fee'],
      ['cash', 'cash_withdrawal'],
    ]);
  });

  it('pairs a card bill payment so purchases are not counted twice', () => {
    const ledger = buildLedger([
      txn({ accountKey: 'sbi:account:5678', direction: 'debit', amountPaise: 2456780, counterparty: 'BILLDESK', date: '2026-10-03' }),
      txn({ accountKey: 'hsbc:card:7788', instrument: 'card', direction: 'credit', amountPaise: 2456780, description: 'Payment received', date: '2026-10-04' }),
    ]);
    expect(ledger.map((t) => t.kind)).toEqual(['card_payment', 'card_payment']);
    expect(ledger[0]!.pairedWith).toBe(ledger[1]!.key);
  });

  it('pairs transfers between your own accounts', () => {
    const ledger = buildLedger([
      txn({ accountKey: 'hdfc:account:1234', direction: 'debit', amountPaise: 1000000, channel: 'IMPS', date: '2026-10-02' }),
      txn({ accountKey: 'sbi:account:5678', direction: 'credit', amountPaise: 1000000, channel: 'IMPS', date: '2026-10-03' }),
      txn({ accountKey: 'sbi:account:5678', direction: 'credit', amountPaise: 1000000, channel: 'IMPS', date: '2026-10-20', description: 'from friend' }),
    ]);
    expect(ledger.map((t) => t.kind)).toEqual(['transfer', 'transfer', 'income']);
  });

  it('applies your corrections before built-in rules', () => {
    const ledger = buildLedger([txn({ accountKey: 'a', direction: 'debit', amountPaise: 1000, counterparty: 'RAMESH KIRANA STORE' })], [
      { pattern: 'ramesh kirana', category: 'groceries', kind: null },
    ]);
    expect(ledger[0]).toMatchObject({ category: 'groceries', kind: 'expense', categorySource: 'user' });
  });
});

describe('reconcileBalances', () => {
  it('finds the gap a missing alert leaves, and nothing when complete', () => {
    const t1 = txn({ accountKey: 'acc', direction: 'debit', amountPaise: 10000, at: 2000 });
    const snapshots = [
      { accountKey: 'acc', at: 1000, date: '2026-10-01', balancePaise: 100000, source: 'alert' as const },
      { accountKey: 'acc', at: 2000, date: '2026-10-02', balancePaise: 90000, source: 'alert' as const },
      { accountKey: 'acc', at: 3000, date: '2026-10-03', balancePaise: 60000, source: 'alert' as const },
    ];
    const gaps = reconcileBalances(snapshots, [t1]);
    expect(gaps).toEqual([{ accountKey: 'acc', fromDate: '2026-10-02', toDate: '2026-10-03', expectedPaise: 90000, reportedPaise: 60000, gapPaise: -30000 }]);
  });
});

import { findAccountSuffix, findCardSuffix } from '../src/ledger';

describe('statement account attribution', () => {
  it('finds masked card and account suffixes', () => {
    expect(findCardSuffix('Card Number: XXXX XXXX XXXX 7788')).toBe('7788');
    expect(findCardSuffix('Statement for card ending 4321')).toBe('4321');
    expect(findAccountSuffix('Account No : XXXXXXXX1234')).toBe('1234');
  });
});
