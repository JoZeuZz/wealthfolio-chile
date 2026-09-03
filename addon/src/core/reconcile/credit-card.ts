import {
  mentionsCardSidePayment,
  mentionsCashSideCardPayment,
} from '../classify/card-semantics';
import { daysBetween } from '../dates';
import { abs, equals } from '../money';
import { Confidence, Direction, TransactionKind } from '../model/kinds';
import type { NormalizedTransaction } from '../model/transaction';
import type { ScopedTransaction } from './transfers';

/**
 * Credit-card payment reconciliation.
 *
 * A CMR purchase of $80.000 and the later $80.000 payment from Banco de Chile
 * are not $160.000 of spending. The purchase is the expense; the payment moves
 * money from a cash account to a debt account and changes net worth by nothing.
 *
 * This module recognises the payment leg on both sides and marks it
 * `credit_card_payment`, which every spending aggregate excludes.
 */

export interface CardPaymentMatch {
  /** The outflow from the cash account. */
  payment: ScopedTransaction;
  /** The matching inflow recorded on the card, when both sides were imported. */
  cardCredit?: ScopedTransaction;
  confidence: Confidence;
  reason: string;
}

export interface CardPaymentOptions {
  /** Days between the cash-side debit and the card-side credit. */
  windowDays?: number;
}

const DEFAULT_WINDOW = 5;

/**
 * Identify card payments.
 *
 * Two paths: a two-sided match (cash outflow paired with a card inflow), which
 * is strong evidence, and a one-sided textual match, which is only a
 * suggestion. Both produce the same reclassification, but only the first is
 * confident enough to apply without asking.
 */
export function matchCardPayments(
  scoped: readonly ScopedTransaction[],
  options: CardPaymentOptions = {},
): CardPaymentMatch[] {
  const windowDays = options.windowDays ?? DEFAULT_WINDOW;

  const cashOutflows = scoped.filter(
    (s) =>
      s.transaction.direction === Direction.out &&
      !isCardProduct(s) &&
      mentionsCardPayment(s.transaction),
  );

  const cardCredits = scoped.filter(
    (s) => s.transaction.direction === Direction.in && isCardProduct(s),
  );

  const used = new Set<string>();
  const matches: CardPaymentMatch[] = [];

  for (const payment of [...cashOutflows].sort(byDate)) {
    const counterpart = cardCredits
      .filter((credit) => !used.has(identity(credit)))
      .filter((credit) => equals(abs(credit.transaction.amount), abs(payment.transaction.amount)))
      .filter(
        (credit) =>
          Math.abs(daysBetween(payment.transaction.date, credit.transaction.date)) <= windowDays,
      )
      .sort(
        (a, b) =>
          Math.abs(daysBetween(payment.transaction.date, a.transaction.date)) -
          Math.abs(daysBetween(payment.transaction.date, b.transaction.date)),
      )[0];

    if (counterpart) {
      used.add(identity(counterpart));
      matches.push({
        payment,
        cardCredit: counterpart,
        confidence: Confidence.confirmed,
        reason:
          'Cargo en cuenta y abono en la tarjeta por el mismo monto, con glosa de pago de tarjeta.',
      });
      continue;
    }

    matches.push({
      payment,
      confidence: Confidence.suggested,
      reason:
        'La glosa indica un pago de tarjeta, pero no se importó el estado de cuenta que lo recibe.',
    });
  }

  // A card-side credit with no cash counterpart is still a payment received —
  // the money came from somewhere, it just was not imported.
  for (const credit of cardCredits) {
    if (used.has(identity(credit))) continue;
    if (!mentionsCardSidePayment(credit.transaction)) continue;
    matches.push({
      payment: credit,
      confidence: Confidence.suggested,
      reason: 'Abono en la tarjeta con glosa de pago; falta el cargo en la cuenta de origen.',
    });
  }

  return matches;
}

function isCardProduct(scoped: ScopedTransaction): boolean {
  return (
    scoped.transaction.kind === TransactionKind.credit_card_purchase ||
    scoped.transaction.kind === TransactionKind.credit_card_payment
  );
}

/**
 * The reconciler reads the same vocabulary as the row mapper and the built-in
 * rules; `core/classify/card-semantics` owns it.
 *
 * A second copy of these markers is how the preview and the import came to
 * disagree about what a card credit was.
 */
export { mentionsCardSidePayment };

export function mentionsCardPayment(transaction: NormalizedTransaction): boolean {
  return mentionsCashSideCardPayment(transaction);
}

/** Reclassify both legs of a decided card payment. */
export function applyCardPaymentMatch(match: CardPaymentMatch): NormalizedTransaction[] {
  const stamp = (transaction: NormalizedTransaction): NormalizedTransaction => ({
    ...transaction,
    kind: TransactionKind.credit_card_payment,
    kindConfidence: match.confidence,
  });

  return match.cardCredit
    ? [stamp(match.payment.transaction), stamp(match.cardCredit.transaction)]
    : [stamp(match.payment.transaction)];
}

function identity(scoped: ScopedTransaction): string {
  return `${scoped.accountId}:${scoped.transaction.fingerprint}`;
}

function byDate(a: ScopedTransaction, b: ScopedTransaction): number {
  if (a.transaction.date !== b.transaction.date) {
    return a.transaction.date < b.transaction.date ? -1 : 1;
  }
  return identity(a) < identity(b) ? -1 : 1;
}
