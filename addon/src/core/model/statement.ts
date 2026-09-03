import type { IsoDate } from '../dates';
import type { Money } from '../money';
import type { NormalizedTransaction } from './transaction';

/** What kind of product the statement covers. Drives the default classification. */
export const StatementProduct = {
  /** Cuenta corriente, cuenta vista, chequera electrónica, CuentaRUT. */
  checking: 'checking',
  savings: 'savings',
  /** Tarjeta de crédito: outflows are `credit_card_purchase`, not `expense`. */
  credit_card: 'credit_card',
  /** Línea de crédito. */
  credit_line: 'credit_line',
  unknown: 'unknown',
} as const;

export type StatementProduct = (typeof StatementProduct)[keyof typeof StatementProduct];

/** Account identity as printed on the statement, before any masking. */
export interface StatementAccount {
  /** Raw account/card number as printed. Masked everywhere it is displayed. */
  number?: string;
  /** Product type, when the statement or parser can tell. */
  product: StatementProduct;
  /** Statement currency, e.g. `CLP` or `USD`. */
  currency: string;
  /** Account holder name, when present. Never logged. */
  holder?: string;
}

/** Period covered by the statement, when the file states or implies one. */
export interface StatementPeriod {
  from?: IsoDate;
  to?: IsoDate;
}

/**
 * How much of the file the parser actually turned into movements.
 *
 * Kept as counts rather than derived from the issue list because the two answer
 * different questions: one issue can describe several rows, several issues can
 * describe one, and neither tells you how many rows the file had. "Did we read
 * this statement whole?" has to be answerable without inspecting prose.
 */
export interface RowStats {
  /** Rows below the header, blank ones included. */
  dataRows: number;
  /** Rows that became a movement. */
  mapped: number;
  /** Rows deliberately dropped: blank, subtotal, legal footer, no date. */
  skipped: number;
  /** Rows that looked like movements and could not be read. */
  failed: number;
}

/** A fully parsed statement: the unit the import wizard works with. */
export interface ParsedStatement {
  /** Institution id, e.g. `banco-estado`. */
  institution: string;
  /** Parser id that produced it. */
  parser: string;
  parserVersion: string;
  account: StatementAccount;
  period: StatementPeriod;
  transactions: NormalizedTransaction[];
  /** What happened to every row below the header. */
  rowStats: RowStats;
  /** Opening/closing balances when the file reports them — used by validation. */
  openingBalance?: Money;
  closingBalance?: Money;
  /** File-level problems that are not tied to a single row. */
  issues: StatementIssue[];
  /** SHA-256 of the source bytes. */
  fileHash: string;
  /** Original file name. Shown in the import history. */
  fileName: string;
}

export type StatementIssueLevel = 'error' | 'warning' | 'info';

export interface StatementIssue {
  level: StatementIssueLevel;
  code: string;
  message: string;
  /** Source row the issue came from, when applicable. */
  line?: number;
}

/** Result of asking a parser "is this file yours?". */
export interface DetectionResult {
  /** Parser id that answered. */
  parser: string;
  institution: string;
  /**
   * 0..1. Above `DETECTION_CONFIDENT` the wizard preselects this parser but
   * still shows the choice; the user always gets the last word.
   */
  score: number;
  /** Human-readable evidence, e.g. "cabecera con columnas de Banco de Chile". */
  reasons: string[];
  /** Partial account info recovered during detection, for the preview header. */
  account?: Partial<StatementAccount>;
  period?: StatementPeriod;
}

/** Score at or above which a detection is treated as reliable. */
export const DETECTION_CONFIDENT = 0.7;

/** Score below which a detection is not offered at all. */
export const DETECTION_FLOOR = 0.35;

/** Outcome of validating a parsed statement before it can be imported. */
export interface ValidationResult {
  ok: boolean;
  issues: StatementIssue[];
  summary: ValidationSummary;
}

export interface ValidationSummary {
  /** Rows below the header, whatever became of them. */
  totalRows: number;
  parsedRows: number;
  /** Rows dropped on purpose — blanks, subtotals, footers. */
  skippedRows: number;
  /** Rows that should have been movements and could not be read. */
  errorRows: number;
  /** True when opening + movements === closing, where the file reports balances. */
  balanceReconciles?: boolean;
}
