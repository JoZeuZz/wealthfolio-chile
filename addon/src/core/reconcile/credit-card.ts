import {
  mentionsCardSidePayment,
  mentionsCashSideCardPayment,
} from '../classify/card-semantics';
import { daysBetween } from '../dates';
import { abs, equals } from '../money';
import { Confidence, Direction, TransactionKind } from '../model/kinds';
import { StatementProduct } from '../model/statement';
import type { NormalizedTransaction } from '../model/transaction';
import { getParser } from '../providers/registry';
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

  const cashOutflows = scoped
    .filter(
      (s) =>
        s.transaction.direction === Direction.out &&
        !isCardProduct(s) &&
        mentionsCardPayment(s.transaction),
    )
    .sort(byDate);

  const cardCredits = scoped
    .filter((s) => s.transaction.direction === Direction.in && isCardProduct(s))
    .sort(byDate);

  interface Pairing {
    payment: ScopedTransaction;
    credit: ScopedTransaction;
    gapDays: number;
  }

  const pairings: Pairing[] = [];
  for (const payment of cashOutflows) {
    for (const credit of cardCredits) {
      if (!equals(abs(credit.transaction.amount), abs(payment.transaction.amount))) continue;
      const gapDays = Math.abs(daysBetween(payment.transaction.date, credit.transaction.date));
      if (gapDays > windowDays) continue;
      pairings.push({ payment, credit, gapDays });
    }
  }

  const taken = new Set<string>();
  const matches: CardPaymentMatch[] = [];

  // Same shape as the transfer matcher, for the same reason. Walking the
  // payments in order and taking the nearest free credit let a payment from the
  // 10th claim a credit dated the 15th while another payment sat on the 15th
  // itself — and once that credit was consumed the second payment had a single
  // candidate left, so it *looked* unambiguous. The choice made by one leg was
  // manufacturing certainty for the next.
  for (;;) {
    const open = pairings.filter(
      (p) => !taken.has(identity(p.payment)) && !taken.has(identity(p.credit)),
    );
    if (open.length === 0) break;

    const settled: Pairing[] = [];
    for (const payment of cashOutflows) {
      if (taken.has(identity(payment))) continue;
      const best = bestPairing(open.filter((p) => identity(p.payment) === identity(payment)));
      if (!best) continue;
      const bestForCredit = bestPairing(
        open.filter((p) => identity(p.credit) === identity(best.credit)),
      );
      if (!bestForCredit || identity(bestForCredit.payment) !== identity(payment)) continue;
      settled.push(best);
    }

    if (settled.length === 0) break;

    for (const pairing of settled) {
      if (taken.has(identity(pairing.payment)) || taken.has(identity(pairing.credit))) continue;
      taken.add(identity(pairing.payment));
      taken.add(identity(pairing.credit));
      matches.push({
        payment: pairing.payment,
        cardCredit: pairing.credit,
        confidence: Confidence.confirmed,
        reason:
          'Cargo en cuenta y abono en la tarjeta por el mismo monto, con glosa de pago de tarjeta.',
      });
    }
  }

  // Whatever is left. A payment with candidates it cannot choose between is
  // still a payment — the glosa says so — it just has no named counterpart.
  for (const payment of cashOutflows) {
    if (taken.has(identity(payment))) continue;
    const open = pairings.filter(
      (p) => identity(p.payment) === identity(payment) && !taken.has(identity(p.credit)),
    );
    matches.push({
      payment,
      confidence: Confidence.suggested,
      reason:
        open.length > 0
          ? `Hay ${open.length} abonos en la tarjeta igual de cercanos y del mismo monto: no se puede decir cuál corresponde a este pago.`
          : 'La glosa indica un pago de tarjeta, pero no se importó el estado de cuenta que lo recibe.',
    });
  }

  // A card credit nothing on the cash side could be about. `pairings` is
  // consulted rather than `taken`: a credit left unpaired *because* the payment
  // beside it was undecidable is not a credit whose originating charge is
  // missing, and saying so double-counted every ambiguous payment.
  for (const credit of cardCredits) {
    if (taken.has(identity(credit))) continue;
    if (pairings.some((p) => identity(p.credit) === identity(credit))) continue;
    if (!mentionsCardSidePayment(credit.transaction)) continue;
    matches.push({
      payment: credit,
      confidence: Confidence.suggested,
      reason: 'Abono en la tarjeta con glosa de pago; falta el cargo en la cuenta de origen.',
    });
  }

  return matches;
}

/** Closest credit, or `undefined` when two are the same distance away. */
function bestPairing<T extends { gapDays: number; credit: ScopedTransaction }>(
  group: readonly T[],
): T | undefined {
  const sorted = [...group].sort(
    (a, b) => a.gapDays - b.gapDays || (identity(a.credit) < identity(b.credit) ? -1 : 1),
  );
  const best = sorted[0];
  const runnerUp = sorted[1];
  if (!best) return undefined;
  if (runnerUp && runnerUp.gapDays === best.gapDays) return undefined;
  return best;
}

function isCardProduct(scoped: ScopedTransaction): boolean {
  const product = getParser(scoped.transaction.sourceParser)?.profile.product;
  if (product !== undefined) {
    return product === StatementProduct.credit_card || product === StatementProduct.credit_line;
  }
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
