import { Confidence, Direction, TransactionKind } from '../model/kinds';
import { StatementProduct } from '../model/statement';
import { normalizeDescription } from '../text';

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

/**
 * Wording used on the cash account when a card bill is paid from it.
 *
 * Every entry has to name a card and nothing else. `PAGO CREDITO` used to be
 * here and is not: in Chile it is how banks label a consumer or mortgage loan
 * instalment, so it turned a $350.000 dividendo hipotecario into debt movement
 * and took it out of the month's spending — the same bug this module exists to
 * fix, pointing the other way. It was harmless in the reconciler, where it was
 * one half of a two-sided amount-and-date match; it is not harmless as a
 * one-sided classifier.
 */
export const CASH_SIDE_CARD_PAYMENT_MARKERS: readonly string[] = [
  'PAGO TARJETA',
  'PAGO DE TARJETA',
  'PAGO T CREDITO',
  'PAGO TC',
  'PAGO CMR',
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

/**
 * Wording for cash drawn against the credit line.
 *
 * Read as whole tokens on the normalised description, never as substrings: a
 * merchant can be called `AVANCE CAPACITACION`, and `SUPERAVANCE` is one word
 * in some statements and two in others.
 *
 * A glosa that also says `COMISION` is not the advance — it is the fee charged
 * for it, and `core/chile/financial-costs` owns that reading. The guard belongs
 * here, before the advance is named, because a fee misread as a loan would
 * report a $4.500 charge as $4.500 of cash the user never received.
 */
const CASH_ADVANCE_PHRASES: readonly RegExp[] = [
  /\bAVANCES?\s+EN\s+EFECTIVO\b/,
];

/** Plausible commercial spellings that need a real statement before acting. */
const UNVERIFIED_CASH_ADVANCE_PHRASES: readonly RegExp[] = [
  /^AVANCES?$/,
  /\bAVANCES?\s+EFECTIVO\b/,
  /\bAVANCES?\s+(?:EN\s+|\d+\s+)?CUOTAS?\b/,
  /\bSUPER\s*AVANCES?\b/,
];

const CASH_ADVANCE_COST = /\b(?:COMISION(?:ES)?|INTERES(?:ES)?|IMPUESTOS?|SEGUROS?|PRIMAS?)\b/;

/** The subset of a movement this module reads. */
export interface DescribedMovement {
  description: string;
}

/**
 * Matched against the normalised description, not the raw one.
 *
 * The rule engine compares against `normalizedDescription`, so anything
 * matching raw text here would disagree with it on the same row — a glosa like
 * `PAGO  DE  TARJETA VISA`, routine in exports derived from fixed-width
 * reports, matched the rule and missed the classifier. Sharing the constants is
 * not enough if the two sides read different strings.
 */
function mentions(description: string, markers: readonly string[]): boolean {
  const text = normalizeDescription(description ?? '');
  return markers.some((marker) => text.includes(normalizeDescription(marker)));
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
 * Only the card side's own vocabulary decides "payment". The cash-side list
 * describes what the *other* account prints and has no authority here:
 * `ABONO A TARJETA` appears on both sides, so consulting it made
 * `ABONO A TARJETA POR DEVOLUCION COMERCIO` a payment — precisely the refund
 * this module was written to stop losing.
 *
 * Payment beats reversal when a description carries both, and the order is
 * fixed rather than "whichever marker appears first": `PAGO RECIBIDO - ANULA
 * CARGO ANTERIOR` is a payment that happens to explain itself, and a
 * classification that flipped with word order would answer differently for the
 * same statement re-exported with different spacing.
 *
 * A reversal that also mentions a payment goes back to ambiguous.
 * `ANULACION DE PAGO` is the opposite of a refund — it undoes a credit — and
 * calling it one would book it as income. There is no reading of that glosa
 * safe enough to act on without asking.
 */
export function classifyCardInflow(description: string): CardInflowKind {
  if (mentions(description, CARD_SIDE_PAYMENT_MARKERS)) return 'payment';
  if (mentions(description, CARD_REVERSAL_MARKERS)) {
    return normalizeDescription(description ?? '').includes('PAGO') ? 'ambiguous' : 'reversal';
  }
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
 *
 * `confidence` separates "the glosa said so" from "this is what the product
 * defaults to". Only the first is `confirmed`; the preview counts everything
 * else as needing review, and a card payment recognised by name is not a row
 * anybody has to look at.
 */
export function defaultKindForRow(input: {
  product: StatementProduct;
  direction: Direction;
  description: string;
}): DefaultKind {
  const isCard =
    input.product === StatementProduct.credit_card ||
    input.product === StatementProduct.credit_line;

  if (!isCard) {
    // The other half of an avance: the cash lands in a current account, and it
    // is borrowed money, not income. Read as income it invented $200.000 of
    // earnings and then counted the spending of that same cash again. There is
    // no kind for "debt arriving", and inventing the card leg would be a ledger
    // this addon does not keep — so it is left unresolved, which is what puts
    // it in front of a person.
    if (input.direction === Direction.in && mentionsCashAdvance(input.description)) {
      return {
        kind: TransactionKind.unknown,
        confidence: Confidence.unknown,
        ambiguousCardCredit: false,
      };
    }
    if (input.direction === Direction.out && mentionsCashSideCardPayment(input)) {
      // Without this the purchases charged to the card and the payment that
      // settles them both count as spending: the same money, twice.
      return named(TransactionKind.credit_card_payment);
    }
    return byProduct(
      input.direction === Direction.out ? TransactionKind.expense : TransactionKind.income,
    );
  }

  if (input.direction === Direction.out) {
    const advance = readCashAdvance(input.description);
    if (advance) return advance;
    return byProduct(TransactionKind.credit_card_purchase);
  }

  if (
    mentions(input.description, CARD_REVERSAL_MARKERS) &&
    mentionsConfirmedCashAdvance(input.description)
  ) {
    return named(TransactionKind.cash_advance);
  }

  switch (classifyCardInflow(input.description)) {
    case 'payment':
      return named(TransactionKind.credit_card_payment);
    case 'reversal':
      return named(TransactionKind.refund);
    default:
      return {
        kind: TransactionKind.unknown,
        confidence: Confidence.unknown,
        ambiguousCardCredit: true,
      };
  }
}

export interface DefaultKind {
  kind: TransactionKind;
  confidence: Confidence;
  /** The row is a card credit whose glosa said nothing either way. */
  ambiguousCardCredit: boolean;
}

/** The glosa named this movement. */
function named(kind: TransactionKind): DefaultKind {
  return { kind, confidence: Confidence.confirmed, ambiguousCardCredit: false };
}

/**
 * Whether an outgoing card row is an avance en efectivo.
 *
 * Only ever consulted for a card or a credit line. On a current account
 * `AVANCE EN EFECTIVO` would be the *deposit* of an advance taken elsewhere, or
 * a merchant name, and neither is a loan against this account's cupo.
 */
function readCashAdvance(description: string): DefaultKind | undefined {
  const text = normalizeDescription(description);
  const confirmed = CASH_ADVANCE_PHRASES.some((pattern) => pattern.test(text));
  const unverified = UNVERIFIED_CASH_ADVANCE_PHRASES.some((pattern) => pattern.test(text));
  if (!confirmed && !unverified) return undefined;
  if (confirmed && !CASH_ADVANCE_COST.test(text)) return named(TransactionKind.cash_advance);
  return {
    kind: TransactionKind.unknown,
    confidence: Confidence.unknown,
    ambiguousCardCredit: false,
  };
}

function mentionsConfirmedCashAdvance(description: string): boolean {
  const text = normalizeDescription(description);
  return (
    !CASH_ADVANCE_COST.test(text) &&
    CASH_ADVANCE_PHRASES.some((pattern) => pattern.test(text))
  );
}

/**
 * Whether a glosa names an avance en efectivo, on either side of it.
 *
 * Only the spelled-out forms. `AVANCE` on its own used to be read as an advance
 * "pending review": no cartola documents that bare form, real Chilean companies
 * are called `AVANCE ...`, and the review it was supposed to get did not exist —
 * the preview flags unknown rows, not confidently-typed ones.
 *
 * A glosa that also says `COMISION` is the fee for the advance, not the advance.
 */
function mentionsCashAdvance(description: string): boolean {
  const text = normalizeDescription(description);
  if (text === '' || CASH_ADVANCE_COST.test(text)) return false;
  return (
    CASH_ADVANCE_PHRASES.some((pattern) => pattern.test(text)) ||
    UNVERIFIED_CASH_ADVANCE_PHRASES.some((pattern) => pattern.test(text))
  );
}

/** Nothing named it; this is what the product defaults to. */
function byProduct(kind: TransactionKind): DefaultKind {
  return { kind, confidence: Confidence.suggested, ambiguousCardCredit: false };
}
