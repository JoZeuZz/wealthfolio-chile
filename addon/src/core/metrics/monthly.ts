import { monthKey, type MonthKey } from '../dates';
import { abs, add, compare, subtract, toNumber, zero, type Money } from '../money';
import { Confidence, Direction, isIncome, isSpending, TransactionKind } from '../model/kinds';
import type { NormalizedTransaction } from '../model/transaction';
import { categoryGroup, CategoryGroup } from '../categories/defaults';
import {
  isCostOfBorrowing,
  type FinancialCostKind,
} from '../model/financial-cost';

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

/**
 * Expense totals per merchant, largest first.
 *
 * A movement whose merchant could not be resolved is left out rather than
 * filed under a shared placeholder. Grouping them fused unrelated expenses
 * into one row that then competed for the top of the ranking, and the
 * concentration insight read that row as a merchant: "Sin comercio concentra
 * el 89 % de tus gastos" was a sentence about nothing.
 *
 * The money is not dropped — `unattributedSpending` reports it under its own
 * name, which is what it is.
 */
export function totalsByMerchant(
  transactions: readonly NormalizedTransaction[],
  limit = 10,
  options: MetricsOptions = {},
): MerchantTotal[] {
  const currency = options.currency ?? 'CLP';
  const totals = new Map<string, { amount: Money; count: number }>();

  for (const transaction of transactions) {
    if (!isSpending(transaction.kind, transaction.direction)) continue;
    if (isIssuerCharge(transaction)) continue;
    const merchant = transaction.merchant;
    if (merchant === undefined || merchant === '') continue;
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

/**
 * Spending the parser could not attribute to any merchant.
 *
 * The counterpart of `totalsByMerchant`: what the ranking deliberately leaves
 * out, so a panel can still add it up instead of quietly showing a smaller
 * number than the month actually holds.
 */
export function unattributedSpending(
  transactions: readonly NormalizedTransaction[],
  options: MetricsOptions = {},
): { amount: Money; transactionCount: number } {
  const currency = options.currency ?? 'CLP';
  let amount = zero(currency);
  let transactionCount = 0;

  for (const transaction of transactions) {
    if (!isSpending(transaction.kind, transaction.direction)) continue;
    // An issuer charge is not unattributed: we know exactly who took it. It is
    // reported by `issuerCharges` under its own name.
    if (isIssuerCharge(transaction)) continue;
    if (transaction.merchant !== undefined && transaction.merchant !== '') continue;
    amount = add(amount, abs(transaction.amount));
    transactionCount += 1;
  }

  return { amount, transactionCount };
}

/** Spending with no merchant, grouped by the processor that stood in the way. */
export interface UnattributedGroup {
  /** Display name of the processor. */
  processor: string;
  amount: Money;
  transactionCount: number;
}

/**
 * Why part of the month has no merchant.
 *
 * `unattributedSpending` says how much; this says on whose account. The reasons
 * are not interchangeable: a charge routed through Mercado Pago is not a
 * mystery, it is a payment method that by design does not report who was paid —
 * which is something a person can act on. A charge the bank itself labelled
 * `PAGO ONLINE` is the bank saying it does not know either, and has no
 * processor to name, so it is counted in the total and not here.
 */
export function unattributedByProcessor(
  transactions: readonly NormalizedTransaction[],
  options: MetricsOptions = {},
): UnattributedGroup[] {
  // Filtered by currency like every other total here, rather than trusting the
  // caller to pass one currency's rows. Adding CLP to USD throws — correctly —
  // and a throw in a metric takes the whole panel down with it, which is the
  // regression the per-currency views were built to end.
  const currency = options.currency;
  const groups = new Map<string, UnattributedGroup>();

  for (const transaction of transactions) {
    if (currency !== undefined && transaction.amount.currency !== currency) continue;
    if (!isSpending(transaction.kind, transaction.direction)) continue;
    if (transaction.merchant !== undefined && transaction.merchant !== '') continue;

    const processor = transaction.attribution?.processor;
    // Only the ones that by design do not report the merchant. Webpay is a
    // passthrough: it normally carries the name the shop configured, so saying
    // "Webpay no informa el comercio" because one row lacked it is a false
    // claim about a named third party.
    if (!processor || processor.visibility !== 'hidden') continue;

    const magnitude = abs(transaction.amount);
    const existing = groups.get(processor.id);
    if (existing) {
      existing.amount = add(existing.amount, magnitude);
      existing.transactionCount += 1;
    } else {
      groups.set(processor.id, {
        processor: processor.name,
        amount: magnitude,
        transactionCount: 1,
      });
    }
  }

  return [...groups.values()].sort((a, b) => compare(b.amount, a.amount));
}

/**
 * Whether the money went to the issuer rather than to a shop.
 *
 * A fee, an interest charge, a tax on the credit and cash drawn against the
 * cupo are all charges by the bank that issued the card. None of them has a
 * merchant, and the name the glosa carries is a description of the charge —
 * seen on a real host, `INTERES POR MORA`, `GASTOS DE COBRANZA` and
 * `COMISION POR AVANCE EN EFECTIVO` sat in "Comercios principales" between the
 * supermarket and the petrol station.
 */
function isIssuerCharge(transaction: NormalizedTransaction): boolean {
  return (
    transaction.financialCost !== undefined ||
    transaction.kind === TransactionKind.fee ||
    transaction.kind === TransactionKind.interest ||
    transaction.kind === TransactionKind.tax ||
    transaction.kind === TransactionKind.cash_advance
  );
}

/**
 * What the issuer took this month, as a total.
 *
 * The counterpart of leaving those rows out of the merchant ranking: the money
 * does not vanish from the panel, and it is not filed under "sin comercio
 * identificado" either — that would say we do not know who charged it, and we
 * do. Every peso here is already inside the month's gross spending; the
 * financial-cost breakdown says what kind of charge each one was.
 */
export function issuerCharges(
  transactions: readonly NormalizedTransaction[],
  options: MetricsOptions = {},
): { amount: Money; transactionCount: number } {
  const currency = options.currency ?? 'CLP';
  let amount = zero(currency);
  let transactionCount = 0;

  for (const transaction of transactions) {
    if (!isSpending(transaction.kind, transaction.direction)) continue;
    if (!isIssuerCharge(transaction)) continue;
    amount = add(amount, abs(transaction.amount));
    transactionCount += 1;
  }

  return { amount, transactionCount };
}

/**
 * Recurring-charge detection used to live here.
 *
 * It grouped by merchant alone, which meant a purchase in six cuotas — same
 * merchant, same amount, thirty days apart, six times — was the textbook
 * subscription. It now lives in `core/recurring`, where the exclusions are the
 * point rather than an afterthought.
 */
export type { RecurringCharge } from '../recurring/detect';

/** One financial-cost line of a month, already summed. */
export interface FinancialCostTotal {
  kind: FinancialCostKind;
  amount: Money;
  transactionCount: number;
}

/**
 * What a month of credit cost, split the way the question is actually asked.
 *
 * Every peso here is already inside `grossSpending`: this is a view *of* the
 * spending, not spending beside it. A total that exceeded the month's gross
 * spending would mean something was counted twice, and the tests say so.
 *
 * `cashAdvances` sits alongside rather than inside. An avance is not a cost —
 * it is the debt itself — and adding it would report drawing $200.000 as
 * $200.000 of cost. It is reported here anyway because it is usually the line
 * that explains why there was interest at all.
 */
export interface FinancialCostBreakdown {
  currency: string;
  /** Every financial cost charged this month. */
  total: Money;
  /** The part that exists only because there was debt: interest, mora, cobranza. */
  borrowing: Money;
  /** The part charged for holding and using the instrument. */
  instrument: Money;
  /** Per cost, largest first. */
  items: FinancialCostTotal[];
  /** Cash drawn against the cupo. Not a cost. */
  cashAdvances: Money;
  cashAdvanceCount: number;
}

export function financialCostBreakdown(
  transactions: readonly NormalizedTransaction[],
  options: MetricsOptions = {},
): FinancialCostBreakdown {
  const currency = options.currency ?? currencyOf(transactions, 'CLP');

  let total = zero(currency);
  let borrowing = zero(currency);
  let instrument = zero(currency);
  let cashAdvances = zero(currency);
  let cashAdvanceCount = 0;
  const byKind = new Map<FinancialCostKind, { amount: Money; transactionCount: number }>();

  for (const transaction of transactions) {
    const magnitude = abs(transaction.amount);

    if (
      transaction.kind === TransactionKind.cash_advance &&
      transaction.direction === Direction.out
    ) {
      cashAdvances = add(cashAdvances, magnitude);
      cashAdvanceCount += 1;
    }

    const cost = transaction.financialCost;
    if (!cost) continue;

    // `isSpending` covers direction and kind at once, and the kind half is not
    // optional: `metadata.fc` survives a reclassification in Wealthfolio — it
    // is the record of what the glosa said — but a row the host now calls a
    // transfer is not in gross spending, and a breakdown that included it would
    // claim to be a part of a total it is not inside.
    if (!isSpending(transaction.kind, transaction.direction)) continue;

    // A bare `COMISION` says there is a charge and not which one. The
    // classification step already refuses to act on that reading; counting it
    // here at full weight reported a $1.500.000 comisión de corretaje as the
    // month's cost of credit.
    if (cost.confidence !== Confidence.confirmed) continue;

    total = add(total, magnitude);
    if (isCostOfBorrowing(cost.kind)) {
      borrowing = add(borrowing, magnitude);
    } else {
      instrument = add(instrument, magnitude);
    }

    const entry = byKind.get(cost.kind);
    if (entry) {
      entry.amount = add(entry.amount, magnitude);
      entry.transactionCount += 1;
    } else {
      byKind.set(cost.kind, { amount: magnitude, transactionCount: 1 });
    }
  }

  const items = [...byKind.entries()]
    .map(([kind, entry]) => ({ kind, ...entry }))
    .sort((a, b) => compare(b.amount, a.amount));

  return {
    currency,
    total,
    borrowing,
    instrument,
    items,
    cashAdvances,
    cashAdvanceCount,
  };
}
