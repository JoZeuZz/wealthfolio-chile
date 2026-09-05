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
  /**
   * Cash drawn against a credit line: an avance en efectivo.
   *
   * The reglamento defines it as the issuer granting "un préstamo o mutuo de
   * dinero" against the cupo, which is why it is not a purchase: two things
   * happen at once, debt is created and cash comes out. The statement shows one
   * line, and the addon keeps it as one — splitting it would mean inventing the
   * other half of a movement no bank reported.
   */
  cash_advance: 'cash_advance',
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

/**
 * Kinds that count as real outflow in cash-flow and category reports.
 *
 * `cash_advance` is here for the same reason a `GIRO CAJERO` on a current
 * account has always been spending: the cash left the tool's field of view and
 * was spent. Leaving it out would report a month where $200.000 was drawn as a
 * month where nothing happened. It cannot double-count either — the payment
 * that later settles the card is already excluded.
 *
 * `interest` is here for the charged direction only — the direction gate in
 * `isSpending` handles that, and `isIncome` keeps interest *earned* as income.
 * It used to be in none of the three sets, so an outgoing interest charge was
 * neither spending, nor income, nor deliberately excluded: it appeared in no
 * total at all. `builtin.intereses` assigns exactly that kind, and on a
 * Chilean card statement the rotativo and the mora are among the numbers that
 * matter most. Borrowing costs money, and that money is spent.
 */
export const SPENDING_KINDS: ReadonlySet<TransactionKind> = new Set([
  TransactionKind.expense,
  TransactionKind.credit_card_purchase,
  TransactionKind.cash_advance,
  TransactionKind.fee,
  TransactionKind.tax,
  TransactionKind.interest,
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
