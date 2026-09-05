import type { IsoDate } from '../dates';
import type { Money } from '../money';
import type { FinancialCostKind } from './financial-cost';
import type { Confidence, Direction, TransactionKind } from './kinds';

/**
 * The canonical transaction.
 *
 * Every parser produces these and nothing else. No UI component, rule, metric
 * or report is ever allowed to read a bank's original column names — that
 * coupling is what makes "add a new bank" a rewrite instead of a new file.
 */
export interface NormalizedTransaction {
  // ── Provenance ────────────────────────────────────────────────────────
  /** Institution id, e.g. `banco-chile`. */
  sourceInstitution: string;
  /** Parser that produced this row, e.g. `banco-chile.cartola-csv`. */
  sourceParser: string;
  /** Parser version — part of the audit trail when a mapping is corrected. */
  sourceParserVersion: string;
  /** Account identifier as printed on the statement (masked before display). */
  sourceAccountRef?: string;
  /** SHA-256 of the imported file, tying a row back to its origin. */
  sourceFileHash: string;
  /** 1-based row number in the source file, for error reporting. */
  sourceLine?: number;

  // ── Identity ──────────────────────────────────────────────────────────
  /**
   * Bank-assigned transaction id, when the file carries one. The strongest
   * possible deduplication key; most Chilean exports do not have it.
   */
  externalId?: string;
  /** Deterministic content hash. Always present. See `core/dedupe`. */
  fingerprint: string;

  // ── Timing ────────────────────────────────────────────────────────────
  /** Transaction date as shown on the statement. */
  date: IsoDate;
  /** Settlement/posting date when the statement distinguishes it. */
  postedDate?: IsoDate;

  // ── Description ───────────────────────────────────────────────────────
  /** Description exactly as printed. */
  description: string;
  /** Output of `normalizeDescription` — what every matcher compares against. */
  normalizedDescription: string;
  /** Merchant after the normalisation pipeline, when one could be extracted. */
  merchant?: string;
  /** Payment processor stripped off the merchant (WEBPAY, TRANSBANK, MERPAGO…). */
  paymentProcessor?: string;

  // ── Amount ────────────────────────────────────────────────────────────
  /** Signed amount: negative leaves the account, positive enters it. */
  amount: Money;
  /** Redundant with the sign of `amount`, kept explicit for readability. */
  direction: Direction;
  /** Running balance after the movement, when the statement reports it. */
  balanceAfter?: Money;

  // ── Bank-side classification ──────────────────────────────────────────
  /** Bank reference / document number (nº operación, folio). */
  reference?: string;
  /** The bank's own movement label, preserved verbatim for traceability. */
  operationType?: string;
  /** Last 4 digits of the card involved, when the description exposes them. */
  cardLast4?: string;

  // ── Our classification ────────────────────────────────────────────────
  kind: TransactionKind;
  /** How the `kind` was reached. `suggested` and `unknown` need review. */
  kindConfidence: Confidence;
  /** Category id from `core/categories`, when one was assigned. */
  category?: string;
  /** Free-form tags added by rules. */
  tags: string[];

  /** Installment metadata when the description encodes a cuota. */
  installment?: InstallmentInfo;

  /**
   * Which financial cost this movement is, when the glosa names one.
   *
   * A refinement of `kind`, never a replacement: `fee`, `interest` and `tax`
   * keep the totals right, and this says *what the user is paying for* — the
   * difference between the price of having the card and the price of having
   * owed money on it. See `core/model/financial-cost`.
   */
  financialCost?: FinancialCostInfo;

  /** Set when this row looks like one leg of a transfer between own accounts. */
  transferCandidate?: TransferCandidate;

  /** Non-fatal problems found while parsing this row. */
  warnings: TransactionWarning[];

  /**
   * The original row, keyed by source column name.
   *
   * Kept for traceability and for re-deriving fields when a mapping is fixed.
   * Never rendered wholesale in the UI and never written to a log.
   */
  rawMetadata: Readonly<Record<string, string>>;
}

/** A cuota (installment) as encoded in a card statement description. */
export interface InstallmentInfo {
  /** Which installment this movement is, 1-based. */
  current: number;
  /** How many installments the plan has in total. */
  total: number;
  /** Confidence in the reading — `1/6` inside a date-like string is ambiguous. */
  confidence: Confidence;
  /** The exact substring the numbers were read from, for the review UI. */
  matchedText: string;
}

/** The financial cost a description named, and how firmly. */
export interface FinancialCostInfo {
  kind: FinancialCostKind;
  /** `confirmed` when the glosa named the specific cost, not just the family. */
  confidence: Confidence;
  /** The exact substring that named it, for the review UI. */
  matchedText: string;
}

/** One leg of a suspected transfer between two accounts the user owns. */
export interface TransferCandidate {
  /** Fingerprint of the opposite leg, once matched. */
  counterpartFingerprint?: string;
  /** Institution the money appears to be moving to or from. */
  counterpartInstitution?: string;
  confidence: Confidence;
  /** Why the engine thinks so — shown verbatim in the review UI. */
  reason: string;
}

export type TransactionWarningCode =
  | 'ambiguous-amount-format'
  | 'ambiguous-card-credit'
  | 'ambiguous-date-format'
  | 'ambiguous-installment'
  | 'ambiguous-installment-amount'
  | 'missing-balance'
  | 'missing-description'
  | 'unparsed-column'
  | 'zero-amount'
  | 'future-date'
  | 'unknown-kind';

export interface TransactionWarning {
  code: TransactionWarningCode;
  /** Message shown to the user. Must not contain account or personal data. */
  message: string;
}

/** A transaction that has been through the full enrichment pipeline. */
export interface EnrichedTransaction extends NormalizedTransaction {
  /** Ids of the rules that fired, in order. Makes categorisation auditable. */
  appliedRules: string[];
}
