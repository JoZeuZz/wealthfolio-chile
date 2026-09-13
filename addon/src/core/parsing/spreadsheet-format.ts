/**
 * Closed-vocabulary shape of a spreadsheet cell's own storage — never its
 * value, its formatted text, or a neighbouring cell.
 *
 * `core/money.ts#splitDecimal` cannot tell "12,450" apart from a reversed
 * thousands grouping and a genuine 3-decimal fraction: both are legal under
 * `es-CL`, and the ambiguity lives entirely in the text. A `.xls`/`.xlsx` cell
 * carries a second, independent fact the text alone does not: whether Excel
 * stored it as a native number and what number format it was given. That is
 * container evidence, not another reading of the same string, which is why it
 * can resolve a case the text never can — see `resolveSpreadsheetColumnNumberFormats`
 * in `core/providers/profile-parser.ts` for where a resolved shape is allowed
 * to change how a column is read, always gated on real evidence.
 */

/** SheetJS's own `CellObject.t`, reduced to what this project can act on. */
export type NativeCellType = 'number' | 'string' | 'blank' | 'other';

export type NumberFormatShape =
  | 'integer'
  | 'grouped-integer'
  | 'decimal-1'
  | 'decimal-2'
  | 'decimal-3'
  | 'currency-integer'
  | 'currency-decimal-2'
  | 'general'
  | 'unknown';

/** `undefined` means no cell object exists at that address — a blank cell. */
export function classifyNativeCellType(cellType: string | undefined): NativeCellType {
  switch (cellType) {
    case 'n':
      return 'number';
    case 's':
    case 'str':
      return 'string';
    case undefined:
      return 'blank';
    default:
      // 'b' boolean, 'e' error, 'd' date, 'z' stub — none of them are a plain
      // number or text, and none of them are worth a category of their own.
      return 'other';
  }
}

const CURRENCY_PATTERN = /[$€]|USD|CLP|EUR/i;
// Matches the thousands-grouping marker in an Excel format code: `#,##0`,
// `0,000`, or a literal digit run split by a comma into groups of three.
const GROUPED_PATTERN = /#,##0|0,000|,##0|\d,\d{3}(?!\d)/;
const DIGIT_RUN_PATTERN = /0/;

/**
 * Reduces an Excel number-format code (`CellObject.z`) to a closed shape.
 *
 * Only the code's *first* section is read (positive-number section of a
 * `pos;neg;zero;text` format) — a bank export shaping negatives differently
 * from positives would still classify the amount column by how a positive
 * charge prints, which is what every real sample seen so far actually is.
 */
export function classifyNumberFormatCode(code: string | undefined): NumberFormatShape {
  const normalized = (code ?? '').trim();
  if (normalized === '' || normalized.toLowerCase() === 'general') return 'general';

  const section = (normalized.split(';')[0] ?? '').trim();
  if (!DIGIT_RUN_PATTERN.test(section)) return 'unknown';

  const decimalMatch = section.match(/0\.(0+)/);
  const decimals = decimalMatch ? (decimalMatch[1] as string).length : 0;
  const hasCurrency = CURRENCY_PATTERN.test(section);
  const grouped = GROUPED_PATTERN.test(section);

  if (decimals === 0) {
    if (hasCurrency) return 'currency-integer';
    return grouped ? 'grouped-integer' : 'integer';
  }
  if (decimals === 1) return 'decimal-1';
  if (decimals === 2) return hasCurrency ? 'currency-decimal-2' : 'decimal-2';
  if (decimals === 3) return 'decimal-3';
  return 'unknown';
}
