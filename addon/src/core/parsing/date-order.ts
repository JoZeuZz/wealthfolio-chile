import type { DateFieldOrder } from '../dates';

/**
 * Which field of a numeric date is the day.
 *
 * `03/09/2026` has two readings and the profile declares which to use. Treating
 * that as a per-row problem meant every row with a day of 12 or less carried a
 * warning and showed as "Revisar" — about half of a real cartola. A flag that
 * fires on half the rows is not a flag.
 *
 * The ambiguity belongs to the *file*, not to the row. A bank does not mix
 * field orders inside one export, so a single row with a field above 12 settles
 * the order for every other row in it. Only when the whole file is ambiguous is
 * there anything left to say — once, not a hundred times.
 *
 * This also fixes a quieter failure. A bank exporting `MM/DD/YYYY` against a
 * profile that declares `DMY` produced silently shifted dates: the fingerprint
 * changes, deduplication stops recognising the movement, and the expense lands
 * in the wrong month. The file now overrules the profile, because the file is
 * evidence and the profile is an expectation.
 */

export type DateOrderSource =
  /** A row in the file settled it. */
  | 'file'
  /** Nothing in the file settled it; the profile's declaration stands. */
  | 'profile'
  /**
   * Rows argue for both orders.
   *
   * Some of them are unreadable under either reading, and row mapping already
   * reports those as errors. No order is invented here.
   */
  | 'conflict';

export interface DateOrderEvidence {
  order: DateFieldOrder;
  source: DateOrderSource;
  /** Numeric dates that admit both readings. */
  ambiguousRows: number;
}

/** `d/m/y` or `m/d/y`, the only shape with two readings. */
const NUMERIC = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/;

/**
 * `d/m` or `m/d`, no year — Banco de Chile's cuenta corriente cell shape.
 * Ambiguous the same way its three-part cousin is; the missing year changes
 * nothing about which field is the day.
 */
const NUMERIC_NO_YEAR = /^(\d{1,2})[-/.](\d{1,2})$/;

/**
 * A clock suffix, dropped the same way `parseStatementDate` drops it.
 *
 * Without this an export that stamps `05/02/2026 10:31` matched nothing here:
 * the file proved no order *and* raised no ambiguity, because every row was
 * skipped and the "nothing proved it" branch only speaks when it counted
 * ambiguous rows. Silent in both directions, which is the worst of the three.
 */
const TIME_SUFFIX = /[T\s]+\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]M)?.*$/i;

export function resolveDateOrder(
  rawDates: readonly string[],
  declared: DateFieldOrder,
): DateOrderEvidence {
  let dayFirstProven = false;
  let monthFirstProven = false;
  let ambiguousRows = 0;

  for (const raw of rawDates) {
    const cleaned = String(raw ?? '').trim().replace(TIME_SUFFIX, '').trim();
    const match = NUMERIC.exec(cleaned) ?? NUMERIC_NO_YEAR.exec(cleaned);
    if (!match) continue;
    const a = Number(match[1]);
    const b = Number(match[2]);

    // Above 12 a field cannot be a month, so it is the day.
    if (a > 12 && b <= 12) dayFirstProven = true;
    else if (b > 12 && a <= 12) monthFirstProven = true;
    else if (a <= 12 && b <= 12 && a !== b) ambiguousRows += 1;
  }

  if (dayFirstProven && monthFirstProven) {
    return { order: declared, source: 'conflict', ambiguousRows };
  }
  if (dayFirstProven) return { order: 'DMY', source: 'file', ambiguousRows: 0 };
  if (monthFirstProven) return { order: 'MDY', source: 'file', ambiguousRows: 0 };
  return { order: declared, source: 'profile', ambiguousRows };
}
