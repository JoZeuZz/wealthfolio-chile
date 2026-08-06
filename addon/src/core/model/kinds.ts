/**
 * The classification vocabulary of the canonical model.
 *
 * These are *our* semantics, not Wealthfolio's. Mapping onto Wealthfolio's 14
 * activity types happens once, at the very edge of the pipeline
 * (`core/mapping`), so the domain logic never has to reason in terms of
 * DEPOSIT/WITHDRAWAL/TRANSFER_IN.
 */

/**
 * What a movement *means* economically.
 *
 * The critical distinction is between kinds that change net worth (`income`,
 * `expense`) and kinds that only move it around (`internal_transfer`,
 * `credit_card_payment`). Conflating them is the classic double-counting bug:
 * paying a $80.000 card bill is not $80.000 of spending on top of the $80.000
 * of purchases it settles.
 */
export const TransactionKind = {
  /** Money entering the household from outside: salary, honorarios, refunds from third parties. */
  income: 'income',
  /** Money leaving the household: a real purchase or payment. */
  expense: 'expense',
  /** A move between two accounts the user owns. Net effect on wealth: zero. */
  internal_transfer: 'internal_transfer',
  /** Settling a credit-card balance. Moves debt, is not new spending. */
  credit_card_payment: 'credit_card_payment',
  /** A purchase charged to a credit line rather than a cash balance. */
  credit_card_purchase: 'credit_card_purchase',
  /** Reversal of an earlier expense (anulación, devolución). */
  refund: 'refund',
  /** Bank or card fee: comisión, mantención, cargo por administración. */
  fee: 'fee',
  /** Interest charged or earned. */
  interest: 'interest',
  /** Tax movements: impuesto de timbres, retenciones. */
  tax: 'tax',
  /** Money moved into or out of an investment vehicle. */
  investment: 'investment',
  /** Not classified yet. Never silently counted as income or expense. */
  unknown: 'unknown',
} as const;

export type TransactionKind = (typeof TransactionKind)[keyof typeof TransactionKind];

export const TRANSACTION_KINDS = Object.values(TransactionKind);

/** Direction of the cash movement relative to the account being imported. */
export const Direction = {
  in: 'in',
  out: 'out',
} as const;

export type Direction = (typeof Direction)[keyof typeof Direction];

/**
 * How sure the engine is about an inference.
 *
 * Only `confirmed` may act without asking. `suggested` always needs a human
 * click; `unknown` is shown as an open question. Nothing in the pipeline is
 * allowed to promote a suggestion to a confirmation on its own.
 */
export const Confidence = {
  confirmed: 'confirmed',
  suggested: 'suggested',
  unknown: 'unknown',
} as const;

export type Confidence = (typeof Confidence)[keyof typeof Confidence];

/**
 * Kinds that must be excluded from "how much did I spend this month".
 *
 * `internal_transfer` and `credit_card_payment` move existing money;
 * `credit_card_purchase` *is* the spending, and counting the later payment too
 * would double it.
 */
export const NON_SPENDING_KINDS: ReadonlySet<TransactionKind> = new Set([
  TransactionKind.internal_transfer,
  TransactionKind.credit_card_payment,
  TransactionKind.investment,
  TransactionKind.unknown,
]);

/** Kinds that count as real outflow in cash-flow and category reports. */
export const SPENDING_KINDS: ReadonlySet<TransactionKind> = new Set([
  TransactionKind.expense,
  TransactionKind.credit_card_purchase,
  TransactionKind.fee,
  TransactionKind.tax,
]);

/** Kinds that count as real inflow. */
export const INCOME_KINDS: ReadonlySet<TransactionKind> = new Set([
  TransactionKind.income,
  TransactionKind.refund,
]);

export function isSpending(kind: TransactionKind, direction: Direction): boolean {
  return direction === Direction.out && SPENDING_KINDS.has(kind);
}

export function isIncome(kind: TransactionKind, direction: Direction): boolean {
  if (kind === TransactionKind.interest) return direction === Direction.in;
  return direction === Direction.in && INCOME_KINDS.has(kind);
}
