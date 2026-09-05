import { detectAutomaticMandate, type AutomaticMandate } from '../chile/mandates';
import { detectInstallment } from '../installments/detect';
import { daysBetween, type IsoDate } from '../dates';
import { abs, add, compare, toNumber, type Money } from '../money';
import { isSpending, TransactionKind } from '../model/kinds';
import { StatementProduct } from '../model/statement';
import type { NormalizedTransaction } from '../model/transaction';
import { collapseSpaces, foldCase } from '../text';

/**
 * Recurring spending.
 *
 * The question is not "does this repeat" — plenty of things repeat — but "is
 * this a commitment that keeps running on its own". Three of the most regular
 * patterns in a Chilean statement are not recurring spending at all:
 *
 *   a purchase in 6 cuotas: same merchant, same amount, same day of the month,
 *     six times. It satisfies every statistical test and it is a *finite*
 *     obligation that ends by itself;
 *   the monthly credit-card payment: perfectly regular, and not spending — it
 *     settles purchases already counted;
 *   a transfer to one's own account: regular, and not spending either.
 *
 * So the exclusions are the load-bearing part of this file, and each one has a
 * test. What is left is the subscription and the standing mandate.
 *
 * Two sources of evidence, and they are not equal. Statistical repetition can
 * only produce `possible`: three ordinary purchases can coincide. A bank-side
 * PAC/PAT/PAGO AUTOMATICO marker lets two regular charges surface as possible;
 * three regular charges carrying that marker can become `likely`.
 *
 * Nothing here is ever `confirmed`: the addon cannot see the contract. The
 * output carries the evidence it reasoned from so the UI can show why, rather
 * than asking anyone to trust a label.
 */

export type RecurrenceConfidence = 'likely' | 'possible';

export interface RecurringCharge {
  /** Case-folded merchant, the key the charges were grouped by. */
  merchantKey: string;
  /** Merchant as it is displayed. */
  merchant: string;
  currency: string;
  /**
   * Lower median of the observed amounts.
   *
   * Not the most recent one: a single expensive month would otherwise become
   * "the" price of the subscription.
   */
  typicalAmount: Money;
  /** Distinct dates the merchant charged on. */
  occurrences: number;
  /** Charges seen. Higher than `occurrences` when a day carried more than one. */
  chargeCount: number;
  /** Lower median of the gaps between consecutive charge dates. */
  medianIntervalDays: number;
  minIntervalDays: number;
  maxIntervalDays: number;
  /** Largest relative distance from the median amount, 0..1. */
  amountSpread: number;
  firstDate: IsoDate;
  lastDate: IsoDate;
  /** Set when the bank itself declared a standing mandate. */
  mandate?: AutomaticMandate;
  confidence: RecurrenceConfidence;
  /** Category of the most recent charge, when it carries one. */
  category?: string;
  /** Fingerprints of every charge behind this pattern, sorted. Makes the claim auditable. */
  fingerprints: string[];
}

export interface RecurrenceOptions {
  /** Charges required without a declared mandate. Default 3. */
  minOccurrences?: number;
}

/**
 * Cadence windows, in days.
 *
 * Monthly only, on purpose. A weekly charge is a shop somebody visits; a yearly
 * one shows up once or twice in a year of history, which is not evidence of
 * anything. The narrow window is what `likely` requires; the wide one is the
 * outer limit of what is reported at all, and covers a biller whose charge date
 * drifts across weekends.
 */
const LIKELY_INTERVAL = { min: 24, max: 38 } as const;
const POSSIBLE_INTERVAL = { min: 20, max: 45 } as const;

/** Relative amount spread allowed at each confidence. */
const LIKELY_SPREAD = 0.15;
const POSSIBLE_SPREAD = 0.4;
const BASIS_POINTS = 10_000;

const GENERIC_MERCHANTS = new Set([
  'AUTOMATICO',
  'CARGO',
  'CARGO AUTOMATICO',
  'COMERCIO',
  'COMPRA',
  'DEBITO AUTOMATICO',
  'DESCONOCIDO',
  'PAC',
  'PAGO AUTOMATICO',
  'PAGO',
  'PAT',
  'SIN COMERCIO',
  'SUSCRIPCION',
]);

/** One date on which a merchant charged, with everything charged that day. */
interface Occurrence {
  date: IsoDate;
  amount: Money;
  charges: NormalizedTransaction[];
}

export function findRecurringCharges(
  transactions: readonly NormalizedTransaction[],
  options: RecurrenceOptions = {},
): RecurringCharge[] {
  const minOccurrences = Math.max(3, options.minOccurrences ?? 3);
  const groups = new Map<string, NormalizedTransaction[]>();

  for (const transaction of transactions) {
    if (!isEligible(transaction)) continue;
    const merchant = transaction.merchant as string;
    const merchantKey = normalizeMerchant(merchant);
    // The currency is part of the key, not an assumption about the caller. Two
    // charges from the same merchant in different currencies are two different
    // commitments, and totalling them would need a rate nobody has.
    const key = `${transaction.amount.currency} ${merchantKey}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(transaction);
    else groups.set(key, [transaction]);
  }

  const found: RecurringCharge[] = [];
  for (const rows of groups.values()) {
    const charge = describeGroup(rows, minOccurrences);
    if (charge) found.push(charge);
  }

  // Deterministic: strongest evidence first, then by size, then by name. Never
  // by input order, which is what makes the result permutation-invariant.
  //
  // Currency comes before amount because `compare` refuses two currencies, and
  // rightly: $9.900 and US$9,99 have no order between them. Grouping by
  // currency first means the comparison only ever runs where it is defined —
  // the previous implementation sorted straight by amount and threw the moment
  // a dollar subscription appeared next to a peso one.
  return found.sort(
    (a, b) =>
      confidenceRank(a.confidence) - confidenceRank(b.confidence) ||
      (a.currency < b.currency ? -1 : a.currency > b.currency ? 1 : 0) ||
      compare(b.typicalAmount, a.typicalAmount) ||
      (a.merchantKey < b.merchantKey ? -1 : a.merchantKey > b.merchantKey ? 1 : 0),
  );
}

/**
 * Which movements may take part at all.
 *
 * `isSpending` already rejects transfers, card payments, investments, unknowns
 * and every inflow, including refunds. The kinds are repeated below anyway: a
 * future change to `SPENDING_KINDS` should not be able to quietly turn a card
 * payment into a subscription, and the tests name each exclusion separately.
 */
function isEligible(transaction: NormalizedTransaction): boolean {
  if (!isSpending(transaction.kind, transaction.direction)) return false;
  if (transaction.amount.minor >= 0) return false;
  if (
    transaction.kind === TransactionKind.internal_transfer ||
    transaction.kind === TransactionKind.credit_card_payment ||
    transaction.kind === TransactionKind.refund
  ) {
    return false;
  }
  // A cuota is a finite obligation that ends on its own. It is the false
  // positive that matters most here, because it passes every other test: same
  // merchant, same amount, thirty days apart, six times over.
  if (transaction.installment !== undefined) return false;
  // And again from the description, because the field is not always there. A
  // row imported by 0.1.x carries no `cuota` metadata, and a user who edits the
  // activity in Wealthfolio can drop it; the marker the bank printed survives
  // both. A bare `3/6` is accepted only for a known card purchase, where that
  // shape is more likely a cuota than a date.
  const declared = detectInstallment(
    transaction.description,
    '',
    transaction.kind === TransactionKind.credit_card_purchase
      ? { product: StatementProduct.credit_card }
      : {},
  );
  if (declared !== undefined) return false;
  if (transaction.merchant === undefined) return false;
  const merchantKey = normalizeMerchant(transaction.merchant);
  return merchantKey !== '' && !GENERIC_MERCHANTS.has(merchantKey);
}

function describeGroup(
  rows: readonly NormalizedTransaction[],
  minOccurrences: number,
): RecurringCharge | undefined {
  const occurrences = toOccurrences(rows);
  const mandate = mandateOf(rows);
  // The bank naming a standing instruction is worth one occurrence of
  // statistical evidence, and no more: two charges still have to be a month
  // apart for the same amount.
  const required = mandate ? Math.max(2, minOccurrences - 1) : minOccurrences;
  if (occurrences.length < required) return undefined;

  const intervals: number[] = [];
  for (let i = 1; i < occurrences.length; i += 1) {
    intervals.push(
      daysBetween((occurrences[i - 1] as Occurrence).date, (occurrences[i] as Occurrence).date),
    );
  }
  if (intervals.length === 0) return undefined;

  const minInterval = Math.min(...intervals);
  const maxInterval = Math.max(...intervals);
  if (minInterval < POSSIBLE_INTERVAL.min || maxInterval > POSSIBLE_INTERVAL.max) return undefined;

  const amounts = occurrences.map((occurrence) => occurrence.amount);
  const typicalAmount = lowerMedianMoney(amounts);
  const spread = amountSpread(amounts, typicalAmount);
  if (!spreadWithin(amounts, typicalAmount, POSSIBLE_SPREAD)) return undefined;

  const regular =
    minInterval >= LIKELY_INTERVAL.min &&
    maxInterval <= LIKELY_INTERVAL.max &&
    spreadWithin(amounts, typicalAmount, LIKELY_SPREAD);

  // Two charges are one interval and one comparison — the thinnest evidence
  // this function will act on at all, and only because the bank named a
  // mandate. At that width the loose thresholds are not defensible: `PAT` is a
  // token that a merchant can legitimately carry in its own name (there are
  // real Chilean companies called "PAT ..."), so a pair of ordinary purchases
  // 44 days apart at somewhat similar amounts must not become a subscription.
  if (occurrences.length < 3 && !regular) return undefined;
  // A day with two charges from one merchant is a shop, not a rhythm. It does
  // not disqualify the pattern, but it cannot be the strong reading either.
  const oneChargePerDay = occurrences.every((occurrence) => occurrence.charges.length === 1);
  const confidence: RecurrenceConfidence =
    regular && oneChargePerDay && mandate !== undefined && occurrences.length >= 3
      ? 'likely'
      : 'possible';

  const last = occurrences[occurrences.length - 1] as Occurrence;
  const lastCharge = last.charges[last.charges.length - 1] as NormalizedTransaction;
  const merchant = lastCharge.merchant as string;

  return {
    merchantKey: normalizeMerchant(merchant),
    merchant,
    currency: typicalAmount.currency,
    typicalAmount,
    occurrences: occurrences.length,
    chargeCount: rows.length,
    medianIntervalDays: lowerMedian(intervals),
    minIntervalDays: minInterval,
    maxIntervalDays: maxInterval,
    amountSpread: spread,
    firstDate: (occurrences[0] as Occurrence).date,
    lastDate: last.date,
    ...(mandate !== undefined ? { mandate } : {}),
    confidence,
    ...(lastCharge.category !== undefined ? { category: lastCharge.category } : {}),
    fingerprints: rows.map((row) => row.fingerprint).sort(),
  };
}

/**
 * Collapse a group into one entry per date.
 *
 * Cadence is a property of when a merchant charges, so two charges on the same
 * day are one point in time with a bigger amount, not a zero-day gap that would
 * sink the whole pattern.
 */
function toOccurrences(rows: readonly NormalizedTransaction[]): Occurrence[] {
  const byDate = new Map<IsoDate, Occurrence>();
  for (const row of rows) {
    const magnitude = abs(row.amount);
    const existing = byDate.get(row.date);
    if (existing) {
      existing.amount = add(existing.amount, magnitude);
      existing.charges.push(row);
    } else {
      byDate.set(row.date, { date: row.date, amount: magnitude, charges: [row] });
    }
  }
  const occurrences = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  // Within a date, order the charges by fingerprint so the "last charge" the
  // category and the merchant spelling come from does not depend on input order.
  for (const occurrence of occurrences) {
    occurrence.charges.sort((a, b) => (a.fingerprint < b.fingerprint ? -1 : 1));
  }
  return occurrences;
}

/**
 * The mandate the group declares, if the charges agree on one.
 *
 * Specific before generic, and a fixed order rather than "the most frequent",
 * so a group with one PAC row and one PAGO AUTOMATICO row always reports the
 * same thing regardless of which came first in the file.
 */
function mandateOf(rows: readonly NormalizedTransaction[]): AutomaticMandate | undefined {
  const mandates = rows.map((row) => detectAutomaticMandate(row.normalizedDescription));
  if (mandates.some((mandate) => mandate === undefined)) return undefined;

  const seen = new Set(mandates);
  if (seen.has('pac') && seen.has('pat')) return undefined;
  if (seen.has('pac')) return 'pac';
  if (seen.has('pat')) return 'pat';
  return 'automatico';
}

/**
 * The lower median.
 *
 * With an even count the two middle values are not averaged: an average of two
 * amounts can land on a value no month ever had, and half of a day is not an
 * interval. The lower of the two is always a number the data actually contains.
 */
function lowerMedian(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)] as number;
}

function lowerMedianMoney(values: readonly Money[]): Money {
  const sorted = [...values].sort((a, b) => compare(a, b));
  return sorted[Math.floor((sorted.length - 1) / 2)] as Money;
}

/** Largest relative distance from the median, 0..1. Zero median means no spread to speak of. */
function amountSpread(values: readonly Money[], median: Money): number {
  const base = Math.abs(toNumber(median));
  if (base === 0) return 0;
  return Math.max(...values.map((value) => Math.abs(toNumber(value) - toNumber(median)) / base));
}

/** Threshold decisions stay exact even when their displayed ratio is a float. */
function spreadWithin(values: readonly Money[], median: Money, limit: number): boolean {
  const limitBasisPoints = BigInt(Math.round(limit * BASIS_POINTS));
  return values.every((value) => {
    const scale = Math.max(value.scale, median.scale);
    const amount = BigInt(value.minor) * 10n ** BigInt(scale - value.scale);
    const typical = BigInt(median.minor) * 10n ** BigInt(scale - median.scale);
    const base = typical < 0n ? -typical : typical;
    if (base === 0n) return amount === 0n;
    const delta = amount >= typical ? amount - typical : typical - amount;
    return delta * BigInt(BASIS_POINTS) <= base * limitBasisPoints;
  });
}

function normalizeMerchant(merchant: string): string {
  return collapseSpaces(foldCase(merchant).replace(/[^A-Z0-9]+/g, ' '));
}

function confidenceRank(confidence: RecurrenceConfidence): number {
  return confidence === 'likely' ? 0 : 1;
}
