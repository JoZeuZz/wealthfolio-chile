import type { DetectionResult, ParsedStatement, ValidationResult } from '../model/statement';
import type { Sheet, SourceFile } from '../parsing/tabular';
import type { StatementProfile } from '../parsing/profile';

/**
 * The contract every statement source implements.
 *
 * A parser is asked three separate questions, in order: *is this yours?*,
 * *what does it say?*, and *is what it says coherent?*. Keeping them separate
 * is what lets the wizard show a detection step before committing to a parse,
 * and lets validation reject a file whose totals do not add up without having
 * to re-read it.
 */
export interface StatementParser {
  /** Stable id, e.g. `banco-chile.cartola`. */
  readonly id: string;
  /** Institution id, e.g. `banco-chile`. */
  readonly institution: string;
  /** Name shown in the bank picker. */
  readonly label: string;
  /** The layout this parser implements. */
  readonly profile: StatementProfile;

  /** Cheap structural check: could this file belong to this parser? */
  detect(input: ParserInput): DetectionResult;

  /** Full parse. Only called after the user has accepted a parser. */
  parse(input: ParserInput): ParsedStatement;

  /** Coherence checks over an already parsed statement. */
  validate(statement: ParsedStatement): ValidationResult;
}

/** Everything a parser is given. Decoding happened once, upstream. */
export interface ParserInput {
  file: SourceFile;
  /** Sheets decoded from the file. Text sources produce exactly one. */
  sheets: Sheet[];
  /** SHA-256 of the file bytes. */
  fileHash: string;
  /** Account id the statement will be imported into, when already chosen. */
  accountId?: string;
  /** Currency override supplied by the user in the wizard. */
  currency?: string;
}

/** Signals a parser uses to recognise its own files. */
export interface DetectionHints {
  /**
   * Markers that only this institution emits — a bank name in a header row, a
   * product name like `CuentaRUT`. A single hit is strong evidence.
   */
  strongMarkers?: RegExp[];
  /** Weaker signals: column wording, product vocabulary. Several are needed. */
  weakMarkers?: RegExp[];
  /** File naming conventions used by the bank's download button. */
  fileNamePatterns?: RegExp[];
  /**
   * Explicit branding of a rival, supported institution that this parser
   * must never outscore, no matter how well the file otherwise fits its own
   * structural markers.
   *
   * A layout signature (a section title, a column shape) is evidence about
   * *how* a statement is laid out, not *who* issued it, so it can legitimately
   * coincide across issuers — and when it does, the issuer the file actually
   * names in plain text has to win. Checked against the same preamble text as
   * `strongMarkers`/`weakMarkers`, never the filename: a match forces this
   * parser's score to 0, dropping it below `DETECTION_FLOOR` regardless of
   * every other signal.
   */
  disqualifyingMarkers?: RegExp[];
}
