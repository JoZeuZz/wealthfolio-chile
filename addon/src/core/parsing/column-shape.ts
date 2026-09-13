import { parseStatementDate } from '../dates';

/**
 * Coarse content shape of an unmapped column — never the values themselves.
 *
 * A calibration report can only say a column's *position*, because the
 * heading text itself may carry personal data (see `docs/PRIVACY.md`). But
 * that leaves a genuine gap when two profiles disagree on what an unmapped
 * column is for: an installment index and an amount are both digits, and the
 * report could not previously tell them apart. This buckets the column's own
 * cell values into a shape — digit-run length, presence of a decimal
 * separator, whether it parses as a date, whether it reads as an ISO-4217
 * code — never printing a digit, a letter run or a date any cell actually
 * contains.
 */
export type ColumnShape =
  | 'vacio'
  | 'fecha'
  | 'entero-corto'
  | 'entero-mediano'
  | 'entero-largo'
  | 'decimal'
  | 'codigo-moneda'
  | 'con-letras'
  | 'mixto'
  | 'otro';

const CURRENCY_CODE = /^[A-Z]{3}$/;
const CURRENCY_SIGN = /^(?:\$|US\$|USD|EUR|€)$/i;
const INTEGER_ONLY = /^\d+$/;
const DECIMAL_LIKE = /^[-+]?\$?\s*\d[\d.,]*$/;
const HAS_SEPARATOR = /[.,]/;
const HAS_LETTER = /[a-zA-Zà-ÿ]/;

/** The shape of one non-empty cell. */
function shapeOfCell(text: string): Exclude<ColumnShape, 'vacio' | 'mixto'> {
  if (CURRENCY_CODE.test(text) || CURRENCY_SIGN.test(text)) return 'codigo-moneda';
  if (INTEGER_ONLY.test(text)) {
    if (text.length <= 2) return 'entero-corto';
    if (text.length <= 4) return 'entero-mediano';
    return 'entero-largo';
  }
  if (DECIMAL_LIKE.test(text) && HAS_SEPARATOR.test(text)) return 'decimal';
  try {
    parseStatementDate(text, { order: 'DMY' });
    return 'fecha';
  } catch {
    // Not a date; fall through.
  }
  if (HAS_LETTER.test(text)) return 'con-letras';
  return 'otro';
}

/**
 * The shape of a column, from its own cell values.
 *
 * Blank cells are ignored for the verdict — a column that is blank on some
 * rows and numeric on others is still "entero-corto", not "mixto", because a
 * bank routinely leaves a cuota column empty on a purchase with no plan.
 * `vacio` only when every sampled cell is blank, and `mixto` only when the
 * non-blank cells disagree on shape — which is itself a structural fact worth
 * reporting: a column that is sometimes a date and sometimes a short integer
 * is not one role.
 */
export function describeColumnShape(values: readonly string[]): ColumnShape {
  const nonBlank = values.map((value) => value.trim()).filter((value) => value !== '');
  if (nonBlank.length === 0) return 'vacio';

  const shapes = new Set(nonBlank.map(shapeOfCell));
  return shapes.size === 1 ? ([...shapes][0] as ColumnShape) : 'mixto';
}
