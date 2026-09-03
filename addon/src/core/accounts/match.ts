import { maskAccountNumber } from '../privacy';
import { StatementProduct } from '../model/statement';

/**
 * Does this statement belong in the account the user picked?
 *
 * The most expensive mistake this addon can make is importing a perfectly
 * valid cartola into the wrong Wealthfolio account. Every other safeguard
 * misses it: the parse is correct, the preview looks right, and deduplication
 * cannot help because fingerprints are scoped *by account* — in the wrong
 * account the movements genuinely are new. The result is one account polluted
 * and another one empty, and nothing anywhere says so.
 *
 * So the file and the account are compared before anything is written, and the
 * outcome distinguishes four states rather than a yes/no. "We checked and they
 * agree" and "we had nothing to check with" are different answers, and only one
 * of them is worth showing as a reassurance.
 */

export type AccountMatchVerdict =
  /** A hard signal matched: same account number. */
  | 'confirmed'
  /** Nothing contradicts the choice, and nothing proved it either. */
  | 'compatible'
  /** A hard signal disagrees. Importing here would put money in the wrong place. */
  | 'mismatch';

export interface AccountMatch {
  verdict: AccountMatchVerdict;
  /**
   * Whether this must stop the import.
   *
   * Only signals that cannot be a matter of preference block. A currency or an
   * account number that disagrees is wrong however the user keeps their books;
   * modelling a credit card as a cash account is a choice, and refusing it
   * would be the addon deciding how someone does their accounting.
   */
  blocking: boolean;
  /** Shown in the wizard, in the order they were evaluated. */
  reasons: string[];
  /** Signals that could not be compared at all. */
  unverified: string[];
}

/** What the statement says about the account it covers. */
export interface StatementAccountFacts {
  /** Raw account or card number as printed, when the file carries one. */
  number?: string;
  product: StatementProduct;
  currency: string;
}

/** The subset of a Wealthfolio `Account` this comparison reads. */
export interface HostAccountFacts {
  accountNumber?: string;
  accountType: 'CASH' | 'CREDIT_CARD' | 'SECURITIES' | 'CRYPTOCURRENCY';
  currency: string;
}

/**
 * Digits that can be compared between two account numbers.
 *
 * Card statements print `XXXX-XXXX-XXXX-7788`, so only the tail is ever
 * comparable. Four is the shortest tail worth an opinion: below that, a match
 * is coincidence and a mismatch is noise.
 */
const MIN_COMPARABLE_DIGITS = 4;
const MAX_COMPARABLE_DIGITS = 8;

export function matchStatementToAccount(
  statement: StatementAccountFacts,
  account: HostAccountFacts,
): AccountMatch {
  const reasons: string[] = [];
  const unverified: string[] = [];
  let blocking = false;
  let confirmed = false;

  // ── Currency ────────────────────────────────────────────────────────
  if (statement.currency.toUpperCase() !== account.currency.toUpperCase()) {
    blocking = true;
    reasons.push(
      `La cartola está en ${statement.currency} y la cuenta de Wealthfolio en ${account.currency}. ` +
        'Los movimientos quedarían registrados en la moneda equivocada.',
    );
  }

  // ── Account number ──────────────────────────────────────────────────
  const fileDigits = comparableDigits(statement.number);
  const accountDigits = comparableDigits(account.accountNumber);

  if (fileDigits && accountDigits) {
    const length = Math.min(fileDigits.length, accountDigits.length, MAX_COMPARABLE_DIGITS);
    if (fileDigits.slice(-length) === accountDigits.slice(-length)) {
      confirmed = true;
      reasons.push(
        `El número de la cartola coincide con el de la cuenta (${maskAccountNumber(accountDigits)}).`,
      );
    } else {
      blocking = true;
      // Both numbers are masked even here: a mismatch message is still a place
      // where two account numbers would otherwise end up side by side.
      reasons.push(
        `El número de la cartola (${maskAccountNumber(fileDigits)}) no coincide con el de la cuenta ` +
          `(${maskAccountNumber(accountDigits)}).`,
      );
    }
  } else {
    unverified.push('numero-cuenta');
    reasons.push(
      fileDigits
        ? 'La cuenta de Wealthfolio no tiene número registrado, así que no se pudo comprobar que sea la misma.'
        : 'La cartola no trae un número de cuenta legible, así que no se pudo comprobar que sea la misma.',
    );
  }

  // ── Product ─────────────────────────────────────────────────────────
  const productReason = compareProduct(statement.product, account.accountType);
  if (productReason) {
    reasons.push(productReason.message);
    if (productReason.blocking) blocking = true;
  }

  const verdict: AccountMatchVerdict = blocking ? 'mismatch' : confirmed ? 'confirmed' : 'compatible';
  return { verdict, blocking, reasons, unverified };
}

/**
 * A bank statement in an instruments account is a different kind of wrong from
 * a card statement in a cash account.
 *
 * The first cannot be intended: cash movements in a `SECURITIES` or
 * `CRYPTOCURRENCY` account distort holdings that have nothing to do with them.
 * The second is a modelling choice people legitimately make, so it is said out
 * loud and left alone.
 */
function compareProduct(
  product: StatementProduct,
  accountType: HostAccountFacts['accountType'],
): { message: string; blocking: boolean } | undefined {
  if (accountType === 'SECURITIES' || accountType === 'CRYPTOCURRENCY') {
    return {
      blocking: true,
      message:
        `La cuenta de destino es de tipo ${accountType}, no una cuenta de dinero. ` +
        'Una cartola bancaria ahí desvirtúa las tenencias de esa cuenta.',
    };
  }

  const isCardStatement =
    product === StatementProduct.credit_card || product === StatementProduct.credit_line;

  if (isCardStatement && accountType === 'CASH') {
    return {
      blocking: false,
      message:
        'Es un estado de cuenta de tarjeta y la cuenta de destino es de efectivo. ' +
        'Se puede importar igual; sólo revisa que sea lo que quieres.',
    };
  }

  if (!isCardStatement && accountType === 'CREDIT_CARD') {
    return {
      blocking: false,
      message:
        'Es una cartola de cuenta y la cuenta de destino es una tarjeta de crédito. ' +
        'Se puede importar igual; sólo revisa que sea lo que quieres.',
    };
  }

  return undefined;
}

/** Digits of an account number, or `undefined` when there are too few to judge. */
function comparableDigits(value: string | undefined): string | undefined {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits.length >= MIN_COMPARABLE_DIGITS ? digits : undefined;
}
