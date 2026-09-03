import { Direction, TransactionKind } from '../model/kinds';
import { StatementProduct } from '../model/statement';
import { foldCase } from '../text';

/**
 * What a credit-card movement means, in one place.
 *
 * The vocabulary Chilean banks print on card statements was previously spelled
 * out three times — in the row mapper's default, in the transfer reconciler,
 * and in the built-in rules — and the three did not agree. That is the failure
 * mode this module exists to prevent: two stages of the same pipeline reaching
 * different conclusions about the same row, with no way to tell which one the
 * user's totals came from.
 *
 * The distinction that matters most is the one the old default erased. On a
 * card, an inflow is *not* automatically a payment of the bill:
 *
 * - a **payment** moves debt. It is not spending, and it must not appear in a
 *   spending total on either side of the pair.
 * - a **reversal** (devolución, anulación, reversa, nota de crédito) undoes a
 *   purchase. It *reduces* the month's spending.
 * - anything else is **ambiguous**, and stays that way. Guessing "payment"
 *   silently removed money from the spending picture; guessing "refund" would
 *   silently add it back. Neither is an answer.
 */

/** Wording used on the cash account when a card bill is paid from it. */
export const CASH_SIDE_CARD_PAYMENT_MARKERS: readonly string[] = [
  'PAGO TARJETA',
  'PAGO DE TARJETA',
  'PAGO T CREDITO',
  'PAGO TC',
  'PAGO CMR',
  'PAGO CREDITO',
  'PAGO AUTOMATICO TARJETA',
  'PAT TARJETA',
  'ABONO A TARJETA',
  'PAGO ESTADO DE CUENTA',
];

/** Wording printed on the card statement itself for an incoming payment. */
export const CARD_SIDE_PAYMENT_MARKERS: readonly string[] = [
  'PAGO RECIBIDO',
  'SU PAGO',
  'PAGO EN LINEA',
  'ABONO PAGO',
  'PAGO NORMAL',
  'GRACIAS POR SU PAGO',
  'PAGO PAT',
  'PAGO PAC',
];

/**
 * Wording for money going back onto the card because a charge was undone.
 *
 * `ANULA` covers `ANULACION` and `ANULADO` without a third entry; the match is
 * a substring on the accent- and case-folded description.
 */
export const CARD_REVERSAL_MARKERS: readonly string[] = [
  'DEVOLUCION',
  'ANULA',
  'REVERSA',
  'REVERSO',
  'NOTA DE CREDITO',
  'REEMBOLSO',
  'RETRACTO',
];

/** The subset of a movement this module reads. */
export interface DescribedMovement {
  description: string;
}

function mentions(description: string, markers: readonly string[]): boolean {
  const text = foldCase(description ?? '');
  return markers.some((marker) => text.includes(marker));
}

export function mentionsCashSideCardPayment(movement: DescribedMovement): boolean {
  return mentions(movement.description, CASH_SIDE_CARD_PAYMENT_MARKERS);
}

export function mentionsCardSidePayment(movement: DescribedMovement): boolean {
  return mentions(movement.description, CARD_SIDE_PAYMENT_MARKERS);
}

export type CardInflowKind = 'payment' | 'reversal' | 'ambiguous';

/**
 * What an inflow on a card statement is.
 *
 * Payment wins over reversal when a description carries both, and the order is
 * fixed rather than "whichever marker appears first in the string": a glosa
 * like `PAGO RECIBIDO - ANULA CARGO ANTERIOR` is a payment that happens to
 * explain itself, and a classification that flipped with word order would give
 * two different answers for the same statement re-exported with different
 * spacing.
 */
export function classifyCardInflow(description: string): CardInflowKind {
  if (mentions(description, CARD_SIDE_PAYMENT_MARKERS)) return 'payment';
  if (mentions(description, CASH_SIDE_CARD_PAYMENT_MARKERS)) return 'payment';
  if (mentions(description, CARD_REVERSAL_MARKERS)) return 'reversal';
  return 'ambiguous';
}

/**
 * The classification a row starts with, from its product, direction and glosa.
 *
 * Deliberately coarse for everything except the card-inflow case: the rule
 * engine, the transfer matcher and the user all refine this afterwards.
 * Inferring `income` versus `internal_transfer` from a single current-account
 * row is exactly the guess that inflates totals, so it is not attempted.
 *
 * `ambiguousCardCredit` tells the caller to attach a warning: the row is not
 * broken, it is unresolved, and the preview should say so.
 */
export function defaultKindForRow(input: {
  product: StatementProduct;
  direction: Direction;
  description: string;
}): { kind: TransactionKind; ambiguousCardCredit: boolean } {
  const isCard =
    input.product === StatementProduct.credit_card ||
    input.product === StatementProduct.credit_line;

  if (!isCard) {
    if (input.direction === Direction.out && mentionsCashSideCardPayment(input)) {
      // Without this the purchases charged to the card and the payment that
      // settles them both count as spending: the same money, twice.
      return { kind: TransactionKind.credit_card_payment, ambiguousCardCredit: false };
    }
    return {
      kind: input.direction === Direction.out ? TransactionKind.expense : TransactionKind.income,
      ambiguousCardCredit: false,
    };
  }

  if (input.direction === Direction.out) {
    return { kind: TransactionKind.credit_card_purchase, ambiguousCardCredit: false };
  }

  switch (classifyCardInflow(input.description)) {
    case 'payment':
      return { kind: TransactionKind.credit_card_payment, ambiguousCardCredit: false };
    case 'reversal':
      return { kind: TransactionKind.refund, ambiguousCardCredit: false };
    default:
      return { kind: TransactionKind.unknown, ambiguousCardCredit: true };
  }
}
