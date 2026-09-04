import type { DateFieldOrder } from '../dates';
import type { NumberFormatHint } from '../money';
import type { StatementProduct } from '../model/statement';
import type { ColumnRole } from './columns';

/**
 * A declarative description of one statement layout.
 *
 * Adding a bank should mean writing one of these, not writing a parser. When a
 * real cartola finally arrives and a column turns out to be named something
 * else, the fix is a string in a profile — which is why the bank adapters can
 * be built and tested before any real file exists.
 */
export interface StatementProfile {
  /** Institution id, e.g. `banco-chile`. */
  institution: string;
  /** Human name shown in the wizard. */
  institutionLabel: string;
  /** Parser id, e.g. `banco-chile.cartola`. */
  parserId: string;
  /** Bumped whenever the mapping changes; recorded on every imported row. */
  parserVersion: string;

  product: StatementProduct;
  defaultCurrency: string;
  numberFormat: NumberFormatHint;
  dateOrder: DateFieldOrder;

  /**
   * How to read a single amount column.
   *
   * `signed` — the column already carries the sign.
   * `debit-positive` — positive values are outflows (typical of card statements).
   * `credit-positive` — positive values are inflows.
   */
  amountSign: 'signed' | 'debit-positive' | 'credit-positive';

  /** Extra header synonyms merged on top of the generic ones. */
  columnSynonyms?: Partial<Record<ColumnRole, string[]>>;

  /**
   * Rows whose description matches are dropped before mapping: subtotals,
   * "SALDO ANTERIOR", legal footers.
   */
  ignoreRowPatterns?: RegExp[];

  /**
   * How much the running-balance column can be trusted to prove the parse.
   *
   * `authoritative` — the balance column is known to walk exactly, so a single
   * step that does not add up means the file was misread and the import is
   * blocked.
   * `advisory` — a balance column exists but nobody has confirmed against a
   * real export that it walks (banks print partial, rounded or per-page
   * balances). A mismatch is reported and the user decides.
   *
   * The distinction is evidence, not caution: claiming `authoritative` for a
   * layout we have never seen would turn a bank quirk into a refused import.
   * A *systematic* mismatch is treated as an error either way — see
   * `validateStatement`.
   */
  balanceCheck: 'authoritative' | 'advisory';

  /**
   * Marks the profile as built from public documentation rather than a real
   * export. The wizard shows a warning and the import history records it, so a
   * miscalibrated mapping is never mistaken for a verified one.
   */
  validationStatus: 'verified' | 'pending-real-sample';

  /** What is still needed to promote the profile to `verified`. */
  validationNotes?: string;
}

/** Descriptions that are never movements, in any Chilean statement seen so far. */
export const COMMON_IGNORE_PATTERNS: RegExp[] = [
  /^SALDO\s+(ANTERIOR|INICIAL|FINAL|ACTUAL|DISPONIBLE|CONTABLE)/i,
  /^TOTAL(ES)?\b/i,
  /^SUBTOTAL/i,
  /^RESUMEN\b/i,
  /^MOVIMIENTOS?\s+(DEL|ENTRE)\b/i,
  /^P[AÁ]GINA\s+\d+/i,
];
