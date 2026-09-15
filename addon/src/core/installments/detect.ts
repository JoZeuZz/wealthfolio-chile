import { StatementProduct } from '../model/statement';
import { Confidence } from '../model/kinds';
import type { InstallmentInfo } from '../model/transaction';
import { normalizeDescription } from '../text';

/**
 * Installment (cuota) detection from statement text.
 *
 * Chilean card statements encode a plan as a counter inside the description:
 * `FALABELLA CUOTA 2 DE 6`, `PARIS 2/6`, `CMR 02/06`. The last of those is
 * indistinguishable from a date, so the detector reports confidence rather than
 * a boolean: only an explicit `CUOTA` keyword yields `confirmed`, and nothing
 * downstream is allowed to act on a `suggested` reading without a human.
 */

/** Longest plan the detector will believe. Chilean retail tops out well below. */
const MAX_INSTALLMENTS = 60;

/** `CUOTA 2 DE 6`, `CUOTA 2/6`, `CUOTA N 2 DE 6` — explicit and unambiguous. */
const EXPLICIT = /\bCUOTAS?\s*(?:N[º°]?\s*)?(\d{1,2})\s*(?:DE|\/|-)\s*(\d{1,2})\b/;

/** `2 DE 6 CUOTAS` — same certainty, other word order. */
const EXPLICIT_TRAILING = /\b(\d{1,2})\s*(?:DE|\/)\s*(\d{1,2})\s*CUOTAS?\b/;

/** A bare `2/6` somewhere in the description. Real, but also date-shaped. */
const BARE = /\b(\d{1,2})\s*\/\s*(\d{1,2})\b/;

/**
 * Read installment information out of a description and/or a dedicated column.
 *
 * `column` is the value of a `CUOTA` column when the export has one; a value
 * there is authoritative because the bank labelled it itself.
 */
export function detectInstallment(
  description: string,
  column = '',
  options: { product?: StatementProduct } = {},
): InstallmentInfo | undefined {
  const fromColumn = detectFromColumn(column);
  if (fromColumn) return fromColumn;

  const text = normalizeDescription(description);
  if (text === '') return undefined;

  const explicit = EXPLICIT.exec(text) ?? EXPLICIT_TRAILING.exec(text);
  if (explicit) {
    const info = build(explicit[1], explicit[2], explicit[0], Confidence.confirmed);
    if (info) return info;
  }

  // Without the keyword, a `2/6` could equally be the 2nd of June. It is
  // reported so the user can confirm it, never treated as established fact.
  const bare = BARE.exec(text);
  if (bare) {
    // A date-shaped pair is not evidence of a plan. Both branches here used to
    // return the same value, so the guard was computed and thrown away and
    // `PARIS 03/06` produced a 3-of-6 plan. `detectInstallment` runs on every
    // row of every product, not only on cards, so a date inside a
    // current-account glosa manufactured a commitment that does not exist and
    // `buildOutlook` counted it in `committedTotal`.
    //
    // The explicit forms are unaffected: `CUOTA 3 DE 6` and a dedicated
    // installment column both say what they are.
    // A date-shaped pair is only a plan where plans live. `1/3` on a CMR
    // statement is the first of three cuotas; the same text in a
    // current-account glosa is the first of March.
    //
    // The guard was computed and thrown away — both branches returned the same
    // value — so `PARIS 03/06` produced a 3-of-6 plan on any product, and
    // `detectInstallment` runs on every row of every statement.
    // `buildOutlook` then counted a commitment that does not exist in
    // `committedTotal`.
    //
    // A pair that cannot be read as a date (`3/24`) needs no product to be
    // unambiguous, so it is accepted everywhere.
    if (looksLikeDate(bare[1] as string, bare[2] as string) && !cardLike(options.product)) {
      return undefined;
    }
    const info = build(bare[1], bare[2], bare[0], Confidence.suggested);
    if (info) return info;
  }

  return undefined;
}

function detectFromColumn(column: string): InstallmentInfo | undefined {
  const text = normalizeDescription(column);
  if (text === '') return undefined;

  const pair = /^(\d{1,2})\s*(?:DE|\/|-)\s*(\d{1,2})$/.exec(text);
  if (pair) return build(pair[1], pair[2], text, Confidence.confirmed);

  const explicit = EXPLICIT.exec(text) ?? EXPLICIT_TRAILING.exec(text);
  if (explicit) return build(explicit[1], explicit[2], explicit[0], Confidence.confirmed);

  return undefined;
}

function build(
  currentText: string | undefined,
  totalText: string | undefined,
  matchedText: string,
  confidence: Confidence,
): InstallmentInfo | undefined {
  const current = Number(currentText);
  const total = Number(totalText);
  if (!Number.isInteger(current) || !Number.isInteger(total)) return undefined;
  if (total < 2 || total > MAX_INSTALLMENTS) return undefined;
  if (current < 1 || current > total) return undefined;
  return { current, total, confidence, matchedText: matchedText.trim() };
}

/**
 * True when `a/b` is at least as plausible as a day/month pair.
 *
 * `03/06` reads as 3 June; `03/24` cannot, because there is no 24th month.
 */
/** Products on which an unlabelled `n/m` is more likely a cuota than a date. */
function cardLike(product?: StatementProduct): boolean {
  return product === StatementProduct.credit_card || product === StatementProduct.credit_line;
}

function looksLikeDate(a: string, b: string): boolean {
  const day = Number(a);
  const month = Number(b);
  return day >= 1 && day <= 31 && month >= 1 && month <= 12;
}

/** Longest remaining-cuotas count trusted from a bare-integer column. */
const MAX_REMAINING = 60;

/** A bare non-negative integer, and nothing else in the cell. */
const BARE_INTEGER = /^\d{1,2}$/;

/**
 * Read a remaining-cuotas count from a dedicated column that prints only a
 * running count — `banco-falabella.cmr`'s real "CUOTAS PENDIENTES" export,
 * confirmed against 4 real statements (2026-09), rather than the `current/m
 * total` pair `detectInstallment` reads elsewhere.
 *
 * Column only, never free text: a bare number inside a description proves
 * nothing on its own — it is what {@link BARE} in `detectInstallment` already
 * treats as a `suggested` plan, a different and weaker claim than a bank
 * labelling its own dedicated column this way. `0` is a real, meaningful
 * reading (no plan open on this charge) and is returned, not treated as
 * "nothing here" — callers that only care about active plans compare against
 * it explicitly.
 */
export function detectRemainingInstallments(column: string): number | undefined {
  const text = column.trim();
  if (!BARE_INTEGER.test(text)) return undefined;
  const value = Number(text);
  if (value > MAX_REMAINING) return undefined;
  return value;
}

/**
 * Does the description mention installments at all?
 *
 * Used by the review UI to flag rows worth a second look even when no counter
 * could be extracted (`EN 6 CUOTAS SIN INTERES` names a plan without numbering
 * this particular charge).
 */
export function mentionsInstallments(description: string): boolean {
  return /\bCUOTAS?\b/.test(normalizeDescription(description));
}
