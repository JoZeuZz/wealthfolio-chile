import { computeFileHash, computeWeakFingerprint, withFingerprints } from './dedupe/fingerprint';
import { dedupeBatch, type DedupeBatchResult, type DuplicateIndex } from './dedupe/classify';
import { withFinancialCost } from './chile/financial-costs';
import { buildInstallmentPlans } from './installments/plans';
import { abs, add, zero, type Money } from './money';
import { Confidence, Direction, isIncome, isSpending, TransactionKind } from './model/kinds';
import type { InstallmentPlan } from './model/installment';
import type { DetectionResult, ParsedStatement, ValidationResult } from './model/statement';
import type { EnrichedTransaction } from './model/transaction';
import { detectAll, getParser, type ParserInput, type StatementParser } from './providers/registry';
import { loadWorkbook } from './parsing/workbook';
import type { SourceFile } from './parsing/tabular';
import { applyRulesToBatch, type Rule } from './rules/engine';

/**
 * The import pipeline, end to end.
 *
 * read file -> detect parser -> parse -> fingerprint -> rules ->
 * financial costs -> dedupe -> installments -> preview
 *
 * Every stage is pure: given the same bytes, the same rules and the same
 * existing-movement index, the result is byte-identical. That is what makes the
 * preview a promise rather than an estimate — what the user approves is exactly
 * what gets written.
 *
 * Nothing here writes anything. Persisting is a separate, explicit step in
 * `services/import-runner`.
 */

export interface PrepareInput {
  file: SourceFile;
  /** Wealthfolio account the statement will be imported into. */
  accountId: string;
  accountName?: string;
  /** Parser chosen by the user; omitted means auto-detect. */
  parserId?: string;
  /** Currency override from the wizard. */
  currency?: string;
  rules: readonly Rule[];
  /** Movements already in Wealthfolio, for duplicate detection. */
  duplicateIndex: DuplicateIndex;
}

export interface PreviewRow {
  /**
   * Identifies this row inside this preview.
   *
   * Not the fingerprint. Two rows a bank printed identically — two $2.500
   * coffees, two ATM withdrawals of the same amount on the same day — share a
   * fingerprint by design, and selection used to be keyed on it: ticking one
   * ticked both. The case where the user most needs to decide row by row was
   * the one case where they could not.
   */
  key: string;
  transaction: EnrichedTransaction;
  /** Weak fingerprint, carried through to activity metadata. */
  weakFingerprint: string;
  duplicate: DedupeBatchResult['results'][number]['finding'];
  /** Excluded by an `ignore` rule. */
  ignoredByRule: boolean;
  /** Final decision for this row. The user can flip it in the preview. */
  willImport: boolean;
}

export interface PreviewTotals {
  currency: string;
  rows: number;
  toImport: number;
  exactDuplicates: number;
  probableDuplicates: number;
  /**
   * Probable duplicates that are only probable because the activity was edited
   * in Wealthfolio after this addon wrote it.
   *
   * Counted apart because it is the one skip reason the user caused and can
   * resolve, and the only one where the honest answer might be "import it
   * again".
   */
  hostModifiedDuplicates: number;
  ignored: number;
  income: Money;
  expenses: Money;
  internalTransfers: Money;
  cardPayments: Money;
  net: Money;
  unknownKind: number;
  needsReview: number;
}

export interface PreparedImport {
  detections: DetectionResult[];
  /** The parser actually used. */
  parser: StatementParser;
  statement: ParsedStatement;
  validation: ValidationResult;
  rows: PreviewRow[];
  totals: PreviewTotals;
  installmentPlans: InstallmentPlan[];
  fileHash: string;
}

export class PipelineError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'PipelineError';
  }
}

/**
 * Run everything up to (but not including) writing.
 *
 * Throws only when the file cannot be read at all; a file that parses badly
 * comes back with issues so the user can see *why* rather than a dead end.
 */
export function prepareImport(input: PrepareInput): PreparedImport {
  const fileHash = computeFileHash(input.file.bytes);
  const workbook = loadWorkbook(input.file);

  const parserInput: ParserInput = {
    file: input.file,
    sheets: workbook.sheets,
    fileHash,
    accountId: input.accountId,
    ...(input.currency !== undefined ? { currency: input.currency } : {}),
  };

  const detections = detectAll(parserInput);

  const parser = input.parserId
    ? getParser(input.parserId)
    : detections[0]
      ? getParser(detections[0].parser)
      : undefined;

  if (!parser) {
    throw new PipelineError(
      'No se reconoció el formato del archivo. Elige el banco manualmente para continuar.',
      'no-parser',
    );
  }

  const statement = parser.parse(parserInput);
  const validation = parser.validate(statement);

  const scope = { accountId: input.accountId };
  const fingerprinted = withFingerprints(statement.transactions, scope);

  const ruleOutcomes = applyRulesToBatch(fingerprinted, input.rules, {
    accountId: input.accountId,
    ...(input.accountName !== undefined ? { accountName: input.accountName } : {}),
    // The statement's own product, not the host account's. A rule keyed on it
    // is asking what document the glosa was printed on, which is what makes
    // the wording mean one thing or another.
    product: statement.account.product,
  });

  // After the rules, not before: a user rule that confirms a classification
  // has to be able to stand, and the cost reading only corrects a row nobody
  // else was sure about. See `withFinancialCost`.
  const enriched = ruleOutcomes.map((outcome) => withFinancialCost(outcome.transaction));
  const dedupe = dedupeBatch(enriched, input.duplicateIndex, scope);

  const rows: PreviewRow[] = dedupe.results.map((result, index) => {
    const ignoredByRule = ruleOutcomes[index]?.ignored ?? false;
    const transaction = enriched[index] as EnrichedTransaction;
    return {
      key: `r${index}`,
      transaction: { ...transaction, fingerprint: result.transaction.fingerprint },
      weakFingerprint: computeWeakFingerprint(result.transaction, scope),
      duplicate: result.finding,
      ignoredByRule,
      // Exact duplicates and rule-ignored rows are off by default. Probable
      // duplicates are also off, because the cost of a wrong skip (one missing
      // movement the user can re-add) is lower than the cost of a wrong import
      // (a silently doubled expense).
      willImport: !ignoredByRule && result.finding.verdict === 'none',
    };
  });

  const currency = statement.account.currency;

  return {
    detections,
    parser,
    statement,
    validation,
    rows,
    totals: computeTotals(rows, currency),
    installmentPlans: buildInstallmentPlans(rows.filter((r) => r.willImport).map((r) => r.transaction)),
    fileHash,
  };
}

/** Recompute the preview totals. Called again whenever the user toggles a row. */
export function computeTotals(rows: readonly PreviewRow[], currency: string): PreviewTotals {
  let income = zero(currency);
  let expenses = zero(currency);
  let internalTransfers = zero(currency);
  let cardPayments = zero(currency);
  let unknownKind = 0;
  let needsReview = 0;

  const selected = rows.filter((row) => row.willImport);

  for (const row of selected) {
    const { transaction } = row;
    const magnitude = abs(transaction.amount);

    if (transaction.kind === TransactionKind.unknown) unknownKind += 1;
    if (needsAttention(transaction)) needsReview += 1;

    if (transaction.kind === TransactionKind.internal_transfer) {
      if (transaction.direction === Direction.out) {
        internalTransfers = add(internalTransfers, magnitude);
      }
      continue;
    }
    if (transaction.kind === TransactionKind.credit_card_payment) {
      if (transaction.direction === Direction.out) {
        cardPayments = add(cardPayments, magnitude);
      }
      continue;
    }
    if (isIncome(transaction.kind, transaction.direction)) {
      income = add(income, magnitude);
      continue;
    }
    if (isSpending(transaction.kind, transaction.direction)) {
      expenses = add(expenses, magnitude);
    }
  }

  return {
    currency,
    rows: rows.length,
    toImport: selected.length,
    exactDuplicates: rows.filter((row) => row.duplicate.verdict === 'exact').length,
    probableDuplicates: rows.filter((row) => row.duplicate.verdict === 'probable').length,
    hostModifiedDuplicates: rows.filter((row) => row.duplicate.reason_code === 'host-modified')
      .length,
    ignored: rows.filter((row) => row.ignoredByRule).length,
    income,
    expenses,
    internalTransfers,
    cardPayments,
    net: add(income, { minor: -expenses.minor, scale: expenses.scale, currency: expenses.currency }),
    unknownKind,
    needsReview,
  };
}

/**
 * Is this row worth a person's time?
 *
 * The count has to stay short or nobody reads it. Counting every `suggested`
 * row made it equal to "all of them", which is the same as marking nothing —
 * `suggested` is the ordinary state of a purchase classified from its product.
 *
 * Three things earn a look:
 *
 * - nothing classified it, so the host will file it as `UNKNOWN` and leave it
 *   out of every calculation;
 * - it carries a warning the parser raised about the row itself;
 * - it was classified as money the user merely moved, on a guess. That last one
 *   is the case the narrower check lost: a rule marking `GIRO ATM` as an
 *   internal transfer takes $450.000 out of expenses *and* out of income at
 *   `suggested` confidence. It is the classification with the most symmetric
 *   cost in the model, which is why the transfer matcher refuses to confirm one
 *   without evidence, and it should not be the one row nobody is told to check.
 */
function needsAttention(transaction: EnrichedTransaction): boolean {
  if (transaction.warnings.length > 0) return true;
  if (transaction.kind === TransactionKind.unknown) return true;
  const movesExistingMoney =
    transaction.kind === TransactionKind.internal_transfer ||
    transaction.kind === TransactionKind.credit_card_payment;
  return movesExistingMoney && transaction.kindConfidence !== Confidence.confirmed;
}

/**
 * Toggle one row and return a new preview with totals refreshed.
 *
 * A `legacy-source-conflict` row never accepts `willImport: true`. Its
 * `probable` verdict exists because an old parser/version may have written a
 * different amount for this same source file than the current parser now
 * computes — re-selecting it by hand is exactly the silent-second-Activity
 * risk the guard in `core/dedupe/classify.ts` exists to stop, not an
 * ordinary "I know better than the heuristic" override. Every other
 * `probable` reason keeps the existing override behaviour.
 */
export function setRowSelection(
  prepared: PreparedImport,
  key: string,
  willImport: boolean,
): PreparedImport {
  const rows = prepared.rows.map((row) => {
    if (row.key !== key) return row;
    if (willImport && row.duplicate.reason_code === 'legacy-source-conflict') return row;
    return { ...row, willImport };
  });
  return {
    ...prepared,
    rows,
    totals: computeTotals(rows, prepared.totals.currency),
    installmentPlans: buildInstallmentPlans(
      rows.filter((row) => row.willImport).map((row) => row.transaction),
    ),
  };
}
