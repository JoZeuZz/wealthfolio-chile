import { monthKey, type MonthKey } from '../dates';
import { abs, add, compare, subtract, toNumber, zero, type Money } from '../money';
import { Direction, isIncome, isSpending, TransactionKind } from '../model/kinds';
import type { NormalizedTransaction } from '../model/transaction';
import { categoryGroup, CategoryGroup } from '../categories/defaults';

/**
 * Monthly aggregates.
 *
 * The arithmetic here is the product: every number on the dashboard and every
 * insight is derived from these totals, so the definitions have to be exactly
 * right and stay obvious.
 *
 * The rule that governs all of it: `internal_transfer` and
 * `credit_card_payment` never touch income or expenses. They are movements of
 * money the user already had.
 */

/**
 * Two views of a month, kept apart on purpose.
 *
 * A $100.000 purchase with a $20.000 refund has two correct readings:
 *
 *   cash     inflow 20.000, outflow 100.000, net -80.000
 *   spending gross 100.000, refunds 20.000, net 80.000
 *
 * Both are true and they answer different questions. Reporting one figure
 * called "expenses" and another called "income" folded the refund into income,
 * which inflated income and made the savings rate `(20.000 - 100.000) / 20.000`
 * — minus four hundred per cent — for a month somebody had a good return in.
 *
 * Invariants, all covered by tests:
 *
 *   fixedExpenses + variableExpenses === grossSpending
 *   netSpending                      === grossSpending - refunds
 *   netCashFlow                      === cashInflows - cashOutflows
 *
 * `internal_transfer` and `credit_card_payment` appear in none of them. They
 * move money the user already had.
 */
export interface MonthlySummary {
  month: MonthKey;

  // ── Cash view: what entered and left the accounts ──────────────────
  /** Everything that increased cash: income, refunds, interest earned. */
  cashInflows: Money;
  /** Everything that decreased it: purchases, fees, taxes. */
  cashOutflows: Money;
  netCashFlow: Money;

  // ── Spending view: what was consumed ──────────────────────────────
  /** Purchases, fees and taxes, before anything came back. */
  grossSpending: Money;
  /** Money returned from an earlier purchase. Not income. */
  refunds: Money;
  /** `grossSpending - refunds`. Can exceed cash outflows in a refund-heavy month. */
  netSpending: Money;

  // ── Income proper ─────────────────────────────────────────────────
  /** External money arriving. Refunds are excluded: they are not new money. */
  income: Money;
  /** `(income - netSpending) / income`, 0..1. Undefined when there was no income. */
  savingsRate?: number;

  /** Gross spending in categories marked as fixed. */
  fixedExpenses: Money;
  variableExpenses: Money;
  /** Total moved between the user's own accounts. Excluded from everything above. */
  internalTransfers: Money;
  /** Total paid towards credit cards. Also excluded. */
  cardPayments: Money;
  transactionCount: number;
}

export interface CategoryTotal {
  category: string;
  /** Net spending: `gross - refunds`. Negative when more came back than went out. */
  amount: Money;
  /** Spending before refunds. */
  gross: Money;
  /** Refunds carrying this category. One without a category is attributed to none. */
  refunds: Money;
  transactionCount: number;
  /** Share of the month's net spending, 0..1. */
  share: number;
}

export interface MerchantTotal {
  merchant: string;
  amount: Money;
  transactionCount: number;
}

export interface MetricsOptions {
  currency?: string;
}

/**
 * The currency a set of movements is expressed in.
 *
 * Every total here is a sum of imported movements, so the currency is a fact
 * about the data, not a display preference. Wealthfolio's `baseCurrency` is the
 * currency it *reports* in — `USD` on a fresh instance — and handing that to
 * the metrics as the accumulator's currency turned the whole panel into
 * `MoneyError: currency mismatch: USD vs CLP` the moment a CLP statement was
 * imported. Observed on a real v3.6.2 container.
 *
 * `fallback` is only for an empty set, where there is nothing to be wrong
 * about. Mixed currencies throw: summing CLP and USD needs an exchange rate,
 * and inventing one would put a fabricated number on the user's dashboard.
 */
export function currencyOf(
  transactions: readonly NormalizedTransaction[],
  fallback: string,
): string {
  const currencies = new Set(transactions.map((transaction) => transaction.amount.currency));
  if (currencies.size === 0) return fallback;
  if (currencies.size > 1) {
    throw new MixedCurrencyError([...currencies].sort());
  }
  return [...currencies][0] as string;
}

/**
 * Every currency present, sorted, without deciding anything.
 *
 * The counterpart to {@link currencyOf}: that one insists on a single answer
 * because its caller needs one number, this one reports the situation so the
 * caller can show several.
 */
export function currenciesOf(transactions: readonly NormalizedTransaction[]): string[] {
  return [...new Set(transactions.map((transaction) => transaction.amount.currency))].sort();
}

/** A month's totals for one currency, alongside the rows they came from. */
export interface CurrencySummary {
  currency: string;
  summary: MonthlySummary;
  transactions: NormalizedTransaction[];
}

/**
 * One summary per currency, never a mixed one.
 *
 * Refusing to add CLP to USD is right — the sum would be a number nobody can
 * act on — but refusing left the whole panel showing an error, so somebody with
 * one dollar account stopped seeing their peso totals too. Splitting says the
 * truth and says all of it.
 *
 * Converting is not on the table with the API the SDK publishes.
 * `ExchangeRatesAPI` in 3.7.0 is `getAll`, `update` and `add`: current rates,
 * not historical ones. Restating an eight-month-old movement at today's rate
 * would be another invented number, and a harder one to notice.
 *
 * Ordered by how much of the month each currency accounts for, so the main one
 * leads.
 */
export function summarizeByCurrency(
  month: MonthKey,
  transactions: readonly NormalizedTransaction[],
  options: { fallbackCurrency?: string } = {},
): CurrencySummary[] {
  const currencies = currenciesOf(transactions);
  if (currencies.length === 0) {
    const currency = options.fallbackCurrency ?? 'CLP';
    return [{ currency, summary: summarizeMonth(month, [], { currency }), transactions: [] }];
  }

  return currencies
    .map((currency) => {
      const rows = transactions.filter(
        (transaction) => transaction.amount.currency === currency,
      );
      return { currency, summary: summarizeMonth(month, rows, { currency }), transactions: rows };
    })
    .sort((a, b) => b.transactions.length - a.transactions.length ||
      (a.currency < b.currency ? -1 : 1));
}

/** More than one currency in a set that has to be totalled as one number. */
export class MixedCurrencyError extends Error {
  constructor(readonly currencies: readonly string[]) {
    super(
      `los movimientos vienen en más de una moneda (${currencies.join(', ')}) y no hay tipo de cambio para sumarlos`,
    );
    this.name = 'MixedCurrencyError';
  }
}

/** Bucket transactions by month, preserving input order within each bucket. */
export function groupByMonth(
  transactions: readonly NormalizedTransaction[],
): Map<MonthKey, NormalizedTransaction[]> {
  const buckets = new Map<MonthKey, NormalizedTransaction[]>();
  for (const transaction of transactions) {
    const key = monthKey(transaction.date);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(transaction);
    else buckets.set(key, [transaction]);
  }
  return buckets;
}

export function summarizeMonth(
  month: MonthKey,
  transactions: readonly NormalizedTransaction[],
  options: MetricsOptions = {},
): MonthlySummary {
  const currency = options.currency ?? 'CLP';

  let income = zero(currency);
  let refunds = zero(currency);
  let grossSpending = zero(currency);
  let fixedExpenses = zero(currency);
  let variableExpenses = zero(currency);
  let internalTransfers = zero(currency);
  let cardPayments = zero(currency);

  for (const transaction of transactions) {
    const magnitude = abs(transaction.amount);

    if (transaction.kind === TransactionKind.internal_transfer) {
      // Counted once, on the outgoing leg, so a matched pair does not double it.
      if (transaction.direction === Direction.out) {
        internalTransfers = add(internalTransfers, magnitude);
      }
      continue;
    }

    if (transaction.kind === TransactionKind.credit_card_payment) {
      if (transaction.direction === Direction.out) {
        cardPayments = add(cardPayments, magnitude);
      }
      continue;
    }

    // Before the income branch on purpose: a refund raises cash like income
    // does, and `isIncome` says so, but it is money coming back from a purchase
    // the user already made — not new money arriving.
    if (isRefund(transaction)) {
      refunds = add(refunds, magnitude);
      continue;
    }

    if (isIncome(transaction.kind, transaction.direction)) {
      income = add(income, magnitude);
      continue;
    }

    if (isSpending(transaction.kind, transaction.direction)) {
      grossSpending = add(grossSpending, magnitude);
      if (categoryGroup(transaction.category) === CategoryGroup.fixed) {
        fixedExpenses = add(fixedExpenses, magnitude);
      } else {
        variableExpenses = add(variableExpenses, magnitude);
      }
    }
  }

  const netSpending = subtract(grossSpending, refunds);
  const cashInflows = add(income, refunds);
  const incomeValue = toNumber(income);

  return {
    month,
    cashInflows,
    cashOutflows: grossSpending,
    netCashFlow: subtract(cashInflows, grossSpending),
    grossSpending,
    refunds,
    netSpending,
    income,
    ...(incomeValue > 0
      ? { savingsRate: (incomeValue - toNumber(netSpending)) / incomeValue }
      : {}),
    fixedExpenses,
    variableExpenses,
    internalTransfers,
    cardPayments,
    transactionCount: transactions.length,
  };
}

/** Money coming back from a purchase the user already made. */
function isRefund(transaction: NormalizedTransaction): boolean {
  return (
    transaction.kind === TransactionKind.refund && transaction.direction === Direction.in
  );
}

/** Summaries for every month present in the data, oldest first. */
export function summarizeAll(
  transactions: readonly NormalizedTransaction[],
  options: MetricsOptions = {},
): MonthlySummary[] {
  const buckets = groupByMonth(transactions);
  return [...buckets.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([month, rows]) => summarizeMonth(month, rows, options));
}

/** Expense totals per category, largest first. */
/**
 * Spending per category, net of refunds, largest first.
 *
 * A refund is attributed to the category it carries and to no other. One that
 * arrives without a category cannot be attributed at all — guessing which
 * purchase it undoes would move somebody's grocery total on a hunch — so it is
 * absent here and visible in the month's `refunds`.
 *
 * A category can come out negative when more came back than went out that
 * month. It is not clamped: the month really did end with money returned in
 * that category, and hiding it would stop the categories summing to the total.
 */
export function totalsByCategory(
  transactions: readonly NormalizedTransaction[],
  options: MetricsOptions = {},
): CategoryTotal[] {
  const currency = options.currency ?? 'CLP';
  const totals = new Map<string, { gross: Money; refunds: Money; count: number }>();

  const bucket = (key: string) => {
    const existing = totals.get(key);
    if (existing) return existing;
    const created = { gross: zero(currency), refunds: zero(currency), count: 0 };
    totals.set(key, created);
    return created;
  };

  for (const transaction of transactions) {
    const magnitude = abs(transaction.amount);

    if (transaction.kind === TransactionKind.refund && transaction.direction === Direction.in) {
      if (transaction.category === undefined) continue;
      const entry = bucket(transaction.category);
      entry.refunds = add(entry.refunds, magnitude);
      entry.count += 1;
      continue;
    }

    if (!isSpending(transaction.kind, transaction.direction)) continue;
    const entry = bucket(transaction.category ?? 'sin-categoria');
    entry.gross = add(entry.gross, magnitude);
    entry.count += 1;
  }

  const rows = [...totals.entries()].map(([category, entry]) => ({
    category,
    amount: subtract(entry.gross, entry.refunds),
    gross: entry.gross,
    refunds: entry.refunds,
    transactionCount: entry.count,
    share: 0,
  }));

  // Share is over net spending, and only over the categories that are actually
  // net positive: a negative one would otherwise push every other share above
  // 100 %.
  const overall = rows.reduce(
    (acc, row) => (row.amount.minor > 0 ? add(acc, row.amount) : acc),
    zero(currency),
  );
  const overallValue = toNumber(overall);

  return rows
    .map((row) => ({
      ...row,
      share: overallValue > 0 && row.amount.minor > 0 ? toNumber(row.amount) / overallValue : 0,
    }))
    .sort((a, b) => compare(b.amount, a.amount) || (a.category < b.category ? -1 : 1));
}

/** Expense totals per merchant, largest first. */
export function totalsByMerchant(
  transactions: readonly NormalizedTransaction[],
  limit = 10,
  options: MetricsOptions = {},
): MerchantTotal[] {
  const currency = options.currency ?? 'CLP';
  const totals = new Map<string, { amount: Money; count: number }>();

  for (const transaction of transactions) {
    if (!isSpending(transaction.kind, transaction.direction)) continue;
    const merchant = transaction.merchant ?? 'Sin comercio';
    const magnitude = abs(transaction.amount);
    const entry = totals.get(merchant);
    if (entry) {
      entry.amount = add(entry.amount, magnitude);
      entry.count += 1;
    } else {
      totals.set(merchant, { amount: magnitude, count: 1 });
    }
  }

  void currency;

  return [...totals.entries()]
    .map(([merchant, entry]) => ({
      merchant,
      amount: entry.amount,
      transactionCount: entry.count,
    }))
    .sort((a, b) => compare(b.amount, a.amount) || (a.merchant < b.merchant ? -1 : 1))
    .slice(0, limit);
}

/** A charge that repeats at a regular cadence — a subscription, most likely. */
export interface RecurringCharge {
  merchant: string;
  /** Representative amount (the most recent one). */
  amount: Money;
  /** Average days between charges. */
  cadenceDays: number;
  occurrences: number;
  lastDate: string;
  category?: string;
}

/**
 * Find charges that repeat.
 *
 * Requires at least three occurrences from the same merchant at a stable
 * cadence and a stable amount. Three is the minimum that distinguishes a
 * subscription from two coincidences.
 */
export function findRecurringCharges(
  transactions: readonly NormalizedTransaction[],
  options: { minOccurrences?: number; toleranceDays?: number } = {},
): RecurringCharge[] {
  const minOccurrences = options.minOccurrences ?? 3;
  const toleranceDays = options.toleranceDays ?? 6;

  const byMerchant = new Map<string, NormalizedTransaction[]>();
  for (const transaction of transactions) {
    if (!isSpending(transaction.kind, transaction.direction)) continue;
    const merchant = transaction.merchant;
    if (!merchant) continue;
    const bucket = byMerchant.get(merchant);
    if (bucket) bucket.push(transaction);
    else byMerchant.set(merchant, [transaction]);
  }

  const found: RecurringCharge[] = [];

  for (const [merchant, rows] of byMerchant) {
    if (rows.length < minOccurrences) continue;
    const sorted = [...rows].sort((a, b) => (a.date < b.date ? -1 : 1));

    const gaps: number[] = [];
    for (let i = 1; i < sorted.length; i += 1) {
      gaps.push(daysApart(sorted[i - 1]?.date ?? '', sorted[i]?.date ?? ''));
    }
    if (gaps.length === 0) continue;

    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    // A monthly subscription lands 28-31 days apart; anything under a week is
    // just a shop the user visits often, not a recurring charge.
    if (mean < 20 || mean > 40) continue;
    if (gaps.some((gap) => Math.abs(gap - mean) > toleranceDays)) continue;

    const amounts = sorted.map((t) => abs(t.amount));
    const reference = amounts[amounts.length - 1] as Money;
    const stable = amounts.every(
      (amount) => Math.abs(toNumber(amount) - toNumber(reference)) <= toNumber(reference) * 0.15,
    );
    if (!stable) continue;

    const last = sorted[sorted.length - 1] as NormalizedTransaction;
    found.push({
      merchant,
      amount: reference,
      cadenceDays: Math.round(mean),
      occurrences: sorted.length,
      lastDate: last.date,
      ...(last.category !== undefined ? { category: last.category } : {}),
    });
  }

  return found.sort((a, b) => compare(b.amount, a.amount) || (a.merchant < b.merchant ? -1 : 1));
}

function daysApart(a: string, b: string): number {
  const toDays = (iso: string) => {
    const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
    return Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
  };
  return Math.abs(toDays(b) - toDays(a));
}
