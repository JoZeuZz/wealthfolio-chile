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
 * Decorations this project can prove are cosmetic and safe to discard before
 * judging a format's shape: color/locale/currency bracket tags (`[Red]`,
 * `[$$-es-CL]`), quoted literals (`"$"`), backslash escapes, underscore
 * spacers (`_-`) and asterisk fills (`*x`). Order matters: brackets and
 * quotes are stripped as whole runs first so an escape or spacer marker
 * inside one is never re-matched as if it stood alone in the code.
 */
const DECORATION_PATTERN = /\[[^\]]*\]|"[^"]*"|\\.|_.|\*./g;

/**
 * What is left over once every provable decoration is stripped, for a format
 * this project is willing to call safe: digits, grouping/decimal marks and a
 * bare currency symbol. Anything else — `%`, `E` (scientific), `/`
 * (fraction), unrecognised literal text — means the format is not one of the
 * shapes this project has proven safe, and money is the one place a "does
 * this look like a percent?" guess is worse than refusing to answer.
 */
const SAFE_CORE_PATTERN = /^[0-9#.,\s$€]*$/;

/**
 * A trailing comma right after the digit placeholders scales the printed
 * value by 1000 per comma (Excel's thousands-scaling convention) — it is not
 * another grouping separator. `#,##0` groups (12345 -> "12,345"); `#,##0,`
 * scales (12345000 -> "12,345"). Both satisfy `GROUPED_PATTERN`, so this has
 * to be checked before deciding a code is `grouped-integer`, not folded into
 * it: reading a scaled cell as grouped would store a value 1000x too small.
 */
const TRAILING_SCALE_COMMA_PATTERN = /,+\s*$/;

/**
 * Reduces an Excel number-format code (`CellObject.z`) to a closed shape.
 *
 * Only the code's *first* section is read (positive-number section of a
 * `pos;neg;zero;text` format) — a bank export shaping negatives differently
 * from positives would still classify the amount column by how a positive
 * charge prints, which is what every real sample seen so far actually is.
 *
 * This function sits on a financial boundary: `spreadsheetColumnStructuralEvidence`
 * (`core/parsing/profile.ts`) lets a resolved shape override how a whole
 * column is parsed, so a wrong shape here can misplace a decimal point or a
 * factor of 1000 for every row in the column. It does not attempt to support
 * Excel's full format grammar — only shapes it can prove safe from the code
 * text alone are classified as anything but `unknown`; every other one,
 * including one this project has simply never seen, fails closed.
 */
export function classifyNumberFormatCode(code: string | undefined): NumberFormatShape {
  const normalized = (code ?? '').trim();
  if (normalized === '' || normalized.toLowerCase() === 'general') return 'general';

  const section = (normalized.split(';')[0] ?? '').trim();
  // Currency is read off the undecorated section: a currency symbol quoted
  // (`"$"`) or inside a locale tag (`[$$-es-CL]`) still means the column is
  // money, and stripping decorations first would throw that signal away.
  const hasCurrency = CURRENCY_PATTERN.test(section);

  const core = section.replace(DECORATION_PATTERN, '');
  if (!SAFE_CORE_PATTERN.test(core)) return 'unknown';
  if (!DIGIT_RUN_PATTERN.test(core)) return 'unknown';
  if (TRAILING_SCALE_COMMA_PATTERN.test(core)) return 'unknown';

  const decimalMatch = core.match(/0\.(0+)/);
  const decimals = decimalMatch ? (decimalMatch[1] as string).length : 0;
  const grouped = GROUPED_PATTERN.test(core);

  if (decimals === 0) {
    if (hasCurrency) return 'currency-integer';
    return grouped ? 'grouped-integer' : 'integer';
  }
  if (decimals === 1) return 'decimal-1';
  if (decimals === 2) return hasCurrency ? 'currency-decimal-2' : 'decimal-2';
  if (decimals === 3) return 'decimal-3';
  return 'unknown';
}
