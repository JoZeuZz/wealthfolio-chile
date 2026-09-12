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
   * Bank-specific statement-period pattern, matched against one preamble line
   * at a time. Capture groups one and two must contain complete dates.
   */
  periodLinePattern?: RegExp;

  /**
   * Overrides `numberFormat` for specific columns, spreadsheet sources only
   * (`.xlsx`/`.xls` — never a `.csv` read of the same bank).
   *
   * The one real BancoEstado CuentaRUT sample seen so far is an XLSX whose
   * `Cargo`/`Abono` cells print a comma thousands separator (`1,234`) while
   * `Saldo`, in the same row, prints a dot (`1.234`) — a plausible artefact of
   * how the spreadsheet cell was formatted, not necessarily of BancoEstado's
   * CSV export, which nothing here has seen for real. Scoping the override to
   * spreadsheet sources means a CSV of the same bank keeps the statement-wide
   * `numberFormat` instead of inheriting an assumption only proven for XLSX.
   */
  spreadsheetColumnNumberFormats?: Partial<Record<ColumnRole, NumberFormatHint>>;

  /**
   * Lexical evidence required before applying each spreadsheet-only number
   * format override. The evidence is evaluated against mapped data cells.
   */
  spreadsheetColumnNumberFormatEvidence?: Partial<Record<ColumnRole, RegExp>>;

  /**
   * Whether an amount-format ambiguity blocks this profile or remains a warning.
   * Omitted profiles preserve the advisory behavior.
   */
  ambiguousAmountCheck?: 'advisory' | 'authoritative';

  /**
   * The date column names a day and a month but never a year — BancoEstado's
   * CuentaRUT export does this (`03/sep`). The year is inferred from the
   * period the statement declares in its preamble; a file with no declared
   * period fails the row rather than guessing. See
   * `core/dates.ts#resolveYearForMonth`.
   */
  dateOmitsYear?: boolean;

  /**
   * Recovers the `dateOmitsYear` year hint from two structural balance rows
   * instead of a declared preamble period, for a layout that has neither.
   *
   * Banco de Chile's cuenta corriente export (calibrated 2026-09 against 8
   * real samples) never states a `Período: desde ... hasta ...` — only a
   * single `Fecha de Emisión` in the preamble — but its first and last
   * accounting rows are always `SALDO INICIAL` and `SALDO FINAL`, and their
   * `dd/mm` cells are the statement's own boundaries: `SALDO FINAL` always
   * shares its day/month with the emission date (confirmed in all 8 rollover
   * and non-rollover samples), and the missing year comes from there. A file
   * where the anchor rows are missing or the day/month promise breaks fails
   * closed rather than guessing — see `derivePeriodFromBalanceRows`.
   *
   * This is a fact about *this* export layout, not a general "emission date
   * ends the period" rule for banks nobody has calibrated — a profile without
   * this field keeps using `readPeriod`'s preamble scan.
   */
  periodFromBalanceRows?: {
    /** Matches the row that opens the statement, e.g. `SALDO INICIAL`. */
    openingLabel: RegExp;
    /** Matches the row that closes it, e.g. `SALDO FINAL`. */
    closingLabel: RegExp;
    /** Matches the preamble label introducing the single emission date. */
    emissionDateLabel: RegExp;
  };

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
