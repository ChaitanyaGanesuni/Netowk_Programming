import type { PaymentChannel, Direction, Instrument } from './alerts';

/**
 * Accounting kinds decide what counts as income or spending:
 * - transfer: between your own accounts — neither income nor expense
 * - card_payment: paying a credit-card bill — the purchases were already counted
 * - investment: contributions/redemptions — not consumption
 * - refund: reduces spending in its category instead of counting as income
 */
export type TxnKind =
  | 'income'
  | 'interest'
  | 'expense'
  | 'fee'
  | 'cash_withdrawal'
  | 'refund'
  | 'transfer'
  | 'card_payment'
  | 'investment'
  | 'loan_repayment';

export type Category =
  | 'salary' | 'interest' | 'refund' | 'food_delivery' | 'dining' | 'groceries' | 'shopping' | 'transport'
  | 'fuel' | 'travel' | 'utilities' | 'telecom' | 'subscriptions' | 'entertainment' | 'health' | 'education'
  | 'rent' | 'insurance' | 'investments' | 'loan_emi' | 'credit_card_payment' | 'bank_charges' | 'late_fees'
  | 'cash' | 'transfers' | 'taxes' | 'income_other' | 'other';

export const DISCRETIONARY: ReadonlySet<Category> = new Set(['food_delivery', 'dining', 'shopping', 'entertainment', 'subscriptions', 'travel']);
export const ESSENTIAL: ReadonlySet<Category> = new Set(['groceries', 'utilities', 'telecom', 'health', 'education', 'rent', 'insurance', 'fuel', 'transport', 'taxes', 'loan_emi']);

/** One transaction as captured from a source (alert or statement), before accounting. */
export interface RawTxn {
  key: string;
  accountKey: string;
  instrument: Instrument;
  date: string;
  /** When the source reported it (email receive time, epoch ms) — orders same-day events. */
  at: number;
  direction: Direction;
  amountPaise: number;
  channel: PaymentChannel;
  counterparty: string | null;
  description: string;
  reference: string | null;
  status: 'pending' | 'posted';
  confidence: number;
}

export interface LedgerTxn extends RawTxn {
  kind: TxnKind;
  category: Category;
  /** 'rule' (built-in), 'user' (your correction), 'match' (transfer/card-payment pairing). */
  categorySource: 'rule' | 'user' | 'match';
  /** Key of the opposite leg for transfers and card payments. */
  pairedWith: string | null;
}

/** Your correction: counterparties matching `pattern` get this category (and optional kind). */
export interface UserRule {
  pattern: string;
  category: Category;
  kind: TxnKind | null;
}

const RULES: ReadonlyArray<readonly [Category, RegExp]> = [
  ['late_fees', /late (?:payment )?(?:fee|charge)|overdue|penal (?:interest|charge)/],
  ['credit_card_payment', /credit ?card (?:bill )?payment|cc ?payment|card ?payment|cred club|cred\b|payment received|thank you for (?:your )?payment|towards (?:your )?(?:credit )?card|bbps.*card/],
  ['salary', /\bsalary\b|payroll|\bsal(?:ary)? cr|\bsal\b/],
  ['interest', /\binterest\b|\bint\.? ?(?:pd|cr|credit)\b/],
  ['refund', /refund|reversal|reversed|cashback/],
  ['investments', /mutual ?fund|\bmf\b|\bsip\b|bse ?star|\biccl\b|nsccl|indian clearing|groww|zerodha|\bkite\b|upstox|\bcams\b|kfin|paytm ?money|bajaj (?:broking|financial securities)|\bnps\b|\bppf\b|sovereign gold/],
  ['loan_emi', /\bemi\b|\bloan\b|bajaj finance(?! securities)|home ?loan|personal ?loan/],
  ['bank_charges', /\bcharges?\b|\bfee\b|gst on|annual fee|sms alert|\bamc\b|non[- ]?maint|min(?:imum)? bal/],
  ['taxes', /income ?tax|\btds\b|advance tax|gst payment/],
  ['cash', /\batm\b|cash withdrawal/],
  ['food_delivery', /swiggy|zomato|eatsure|eat ?club|box8|faasos/],
  ['groceries', /bigbasket|blinkit|zepto|dmart|d ?mart|jiomart|instamart|grofers|reliance (?:fresh|smart)|nature'?s basket|more retail|spencer/],
  ['dining', /restaurant|\bcafe\b|starbucks|mcdonald|domino|\bkfc\b|pizza|burger|dineout|chaayos|haldiram/],
  ['subscriptions', /netflix|spotify|prime video|amazon prime|hotstar|disney|youtube|apple\.com|itunes|google ?play|zee5|sonyliv|jiocinema|audible|microsoft|adobe|chatgpt|openai|linkedin premium/],
  ['shopping', /amazon|flipkart|myntra|ajio|meesho|nykaa|tata ?cliq|croma|reliance digital|ikea|decathlon|lifestyle|westside|pantaloons/],
  ['transport', /\buber\b|\bola\b|rapido|\bmetro\b|fastag|namma yatri|blusmart/],
  ['fuel', /petrol|\bfuel\b|hpcl|bpcl|iocl|indian ?oil|\bshell\b|bharat petroleum|hindustan petroleum/],
  ['travel', /irctc|makemytrip|goibibo|cleartrip|indigo|air ?india|vistara|akasa|spicejet|booking\.com|airbnb|\boyo\b|redbus|ixigo/],
  ['utilities', /electricity|bescom|tneb|msedcl|bses|tata power|water board|indane|bharat ?gas|hp ?gas|adani (?:electricity|gas)|piped gas/],
  ['telecom', /airtel|\bjio\b|vodafone|\bvi\b|bsnl|act fibernet|hathway|broadband/],
  ['entertainment', /bookmyshow|\bpvr\b|inox|steam|playstation|xbox/],
  ['health', /pharmacy|apollo|1mg|pharmeasy|netmeds|hospital|clinic|diagnostic|practo|medplus/],
  ['education', /school|college|university|coursera|udemy|byju|unacademy|tuition/],
  ['rent', /\brent\b|nobroker|housing\.com/],
  ['insurance', /insurance|\blic\b|policybazaar|ergo|lombard|star health|\backo\b|go ?digit|max life|hdfc life|sbi life/],
];

export function normalizeCounterparty(text: string | null): string {
  return (text ?? '').toLowerCase().replace(/[^a-z0-9@.]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function ruleCategory(txn: Pick<RawTxn, 'counterparty' | 'description' | 'channel' | 'direction'>): Category {
  const haystack = `${normalizeCounterparty(txn.counterparty)} ${txn.description.toLowerCase()}`;
  if (txn.channel === 'ATM') return 'cash';
  for (const [category, re] of RULES) {
    if (!re.test(haystack)) continue;
    // Refund/salary/interest words only make sense on credits; skip them on debits.
    if (txn.direction === 'debit' && (category === 'refund' || category === 'salary' || category === 'interest')) continue;
    return category;
  }
  return txn.direction === 'credit' ? 'income_other' : 'other';
}

function kindFor(category: Category, txn: RawTxn): TxnKind {
  if (txn.direction === 'credit') {
    if (category === 'salary' || category === 'income_other') return txn.instrument === 'card' ? 'refund' : 'income';
    if (category === 'interest') return 'interest';
    if (category === 'refund') return 'refund';
    if (category === 'credit_card_payment') return 'card_payment';
    if (category === 'investments') return 'investment';
    return txn.instrument === 'card' ? 'refund' : 'income';
  }
  switch (category) {
    case 'credit_card_payment':
      return 'card_payment';
    case 'investments':
      return 'investment';
    case 'loan_emi':
      return 'loan_repayment';
    case 'bank_charges':
    case 'late_fees':
      return 'fee';
    case 'cash':
      return 'cash_withdrawal';
    default:
      return 'expense';
  }
}

const DAY = 86_400_000;
const days = (a: string, b: string) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY;

/**
 * Builds the ledger: user rules first, then built-in rules, then pairing of
 * (a) bank debit ↔ card credit of the same amount within 7 days → card payment, and
 * (b) debit ↔ credit between two of your bank accounts within 3 days → transfer.
 */
export function buildLedger(raw: readonly RawTxn[], userRules: readonly UserRule[] = []): LedgerTxn[] {
  const rules = userRules.map((r) => ({ ...r, pattern: normalizeCounterparty(r.pattern) })).filter((r) => r.pattern);
  const ledger: LedgerTxn[] = raw.map((txn) => {
    const cp = `${normalizeCounterparty(txn.counterparty)} ${txn.description.toLowerCase()}`;
    const user = rules.find((r) => cp.includes(r.pattern));
    const category = user?.category ?? ruleCategory(txn);
    return {
      ...txn,
      category,
      kind: user?.kind ?? kindFor(category, txn),
      categorySource: user ? 'user' : 'rule',
      pairedWith: null,
    };
  });

  const sorted = [...ledger].sort((a, b) => a.date.localeCompare(b.date) || a.key.localeCompare(b.key));
  const paired = new Set<string>();

  const pair = (a: LedgerTxn, b: LedgerTxn, kind: TxnKind, category: Category) => {
    for (const [x, y] of [[a, b], [b, a]] as const) {
      if (x.categorySource !== 'user') {
        x.kind = kind;
        x.category = category;
        x.categorySource = 'match';
      }
      x.pairedWith = y.key;
      paired.add(x.key);
    }
  };

  // (a) Card bill payments.
  for (const cardCredit of sorted.filter((t) => t.instrument === 'card' && t.direction === 'credit' && t.kind !== 'refund')) {
    const bankDebit = sorted.find(
      (t) => !paired.has(t.key) && t.instrument === 'account' && t.direction === 'debit' && t.amountPaise === cardCredit.amountPaise && days(t.date, cardCredit.date) <= 7,
    );
    if (bankDebit && !paired.has(cardCredit.key)) pair(bankDebit, cardCredit, 'card_payment', 'credit_card_payment');
  }
  // (b) Transfers between your own bank accounts.
  for (const debit of sorted.filter((t) => t.instrument === 'account' && t.direction === 'debit' && t.kind !== 'investment' && t.kind !== 'card_payment')) {
    if (paired.has(debit.key)) continue;
    const credit = sorted.find(
      (t) =>
        !paired.has(t.key) && t.instrument === 'account' && t.direction === 'credit' && t.accountKey !== debit.accountKey &&
        t.amountPaise === debit.amountPaise && days(t.date, debit.date) <= 3 && t.kind !== 'interest',
    );
    if (credit) pair(debit, credit, 'transfer', 'transfers');
  }
  return ledger;
}

/** Signed effect on your money: credits positive, debits negative (paise). */
export const signedAmount = (t: Pick<RawTxn, 'direction' | 'amountPaise'>) => (t.direction === 'credit' ? t.amountPaise : -t.amountPaise);
