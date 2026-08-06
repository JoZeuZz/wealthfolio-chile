import type { ActivityCreate, ActivityType } from '@wealthfolio/addon-sdk';
import { abs, toDecimalString } from '../money';
import { Direction, TransactionKind } from '../model/kinds';
import type { EnrichedTransaction, NormalizedTransaction } from '../model/transaction';

/**
 * The boundary between our model and Wealthfolio's.
 *
 * This is the only file that knows about `ActivityCreate`, `DEPOSIT` or
 * `TRANSFER_OUT`. Everything upstream reasons in `TransactionKind`, which means
 * a change to Wealthfolio's activity model is a change to this file and nothing
 * else.
 *
 * Wealthfolio's semantics, from docs/activities/activity-types.md:
 *
 * - `DEPOSIT` / `WITHDRAWAL` are *external* flows and move net contribution.
 * - `TRANSFER_IN` / `TRANSFER_OUT` default to internal and net to zero at
 *   portfolio level — exactly the behaviour an inter-account move needs.
 * - `FEE`, `TAX`, `INTEREST`, `CREDIT` are cash-only and leave contribution
 *   alone.
 *
 * Mapping onto those is what keeps the double-counting guarantee intact once
 * the data leaves us.
 */

/** Namespace for our metadata inside a Wealthfolio activity. */
export const METADATA_NAMESPACE = 'wealthfolioChile';

/** Metadata written on every activity we create. */
export interface ChileMetadata {
  /** Schema version of this metadata blob. */
  v: number;
  /** Content fingerprint — the idempotency key for re-imports. */
  fp: string;
  /** Weak fingerprint, for probable-duplicate lookups. */
  wfp?: string;
  /** Institution id. */
  inst: string;
  /** Parser id and version that produced the row. */
  parser: string;
  parserVersion: string;
  /** SHA-256 of the source file. */
  fileHash: string;
  /** Import run id. */
  runId: string;
  /** Our transaction kind, so a re-read can rebuild the model. */
  kind: TransactionKind;
  /** Category id, if assigned. */
  cat?: string;
  merchant?: string;
  tags?: string[];
  /** Installment counter, when the row is part of a plan. */
  cuota?: { n: number; of: number };
  /** Fingerprint of the matched transfer counterpart. */
  xfer?: string;
}

export interface MapToActivityOptions {
  accountId: string;
  runId: string;
  weakFingerprint?: string;
}

/**
 * Convert one canonical transaction into a Wealthfolio activity.
 *
 * `amount` is always the positive magnitude: direction is carried by the
 * activity type, which is how Wealthfolio's calculator expects it.
 */
export function toActivityCreate(
  transaction: EnrichedTransaction | NormalizedTransaction,
  options: MapToActivityOptions,
): ActivityCreate {
  const { activityType, subtype } = resolveActivityType(transaction);
  const magnitude = abs(transaction.amount);

  const metadata: ChileMetadata = {
    v: 1,
    fp: transaction.fingerprint,
    ...(options.weakFingerprint ? { wfp: options.weakFingerprint } : {}),
    inst: transaction.sourceInstitution,
    parser: transaction.sourceParser,
    parserVersion: transaction.sourceParserVersion,
    fileHash: transaction.sourceFileHash,
    runId: options.runId,
    kind: transaction.kind,
    ...(transaction.category ? { cat: transaction.category } : {}),
    ...(transaction.merchant ? { merchant: transaction.merchant } : {}),
    ...(transaction.tags.length > 0 ? { tags: transaction.tags } : {}),
    ...(transaction.installment
      ? { cuota: { n: transaction.installment.current, of: transaction.installment.total } }
      : {}),
    ...(transaction.transferCandidate?.counterpartFingerprint
      ? { xfer: transaction.transferCandidate.counterpartFingerprint }
      : {}),
  };

  return {
    accountId: options.accountId,
    activityType,
    ...(subtype ? { subtype } : {}),
    activityDate: transaction.date,
    amount: toDecimalString(magnitude),
    currency: transaction.amount.currency,
    comment: buildComment(transaction),
    metadata: { [METADATA_NAMESPACE]: metadata },
  };
}

export function toActivityCreateBatch(
  transactions: readonly (EnrichedTransaction | NormalizedTransaction)[],
  options: MapToActivityOptions,
): ActivityCreate[] {
  return transactions.map((transaction) => toActivityCreate(transaction, options));
}

interface ResolvedType {
  activityType: ActivityType;
  subtype?: string;
}

/**
 * Pick the Wealthfolio activity type for a canonical kind.
 *
 * The important cases:
 *
 * - Internal transfers and card payments become `TRANSFER_IN`/`TRANSFER_OUT`,
 *   which Wealthfolio nets to zero across the portfolio. They therefore cannot
 *   inflate income or spending on either side.
 * - Card purchases become `WITHDRAWAL`: the money is gone at purchase time,
 *   which is the moment the user experienced the expense.
 * - `unknown` becomes `UNKNOWN`, which Wealthfolio flags for review and leaves
 *   out of every calculation until a human classifies it. That is precisely the
 *   behaviour we want for a row we could not read.
 */
export function resolveActivityType(transaction: {
  kind: TransactionKind;
  direction: Direction;
}): ResolvedType {
  const outgoing = transaction.direction === Direction.out;

  switch (transaction.kind) {
    case TransactionKind.income:
      return { activityType: 'DEPOSIT' };

    case TransactionKind.expense:
    case TransactionKind.credit_card_purchase:
      return { activityType: 'WITHDRAWAL' };

    case TransactionKind.internal_transfer:
    case TransactionKind.investment:
      return { activityType: outgoing ? 'TRANSFER_OUT' : 'TRANSFER_IN' };

    case TransactionKind.credit_card_payment:
      return { activityType: outgoing ? 'TRANSFER_OUT' : 'TRANSFER_IN' };

    case TransactionKind.refund:
      return { activityType: 'CREDIT', subtype: 'REFUND' };

    case TransactionKind.fee:
      return { activityType: 'FEE' };

    case TransactionKind.tax:
      return { activityType: 'TAX' };

    case TransactionKind.interest:
      // Interest earned is income; interest charged is a cost of borrowing,
      // which Wealthfolio models as a fee with an INTEREST_CHARGE subtype.
      return outgoing
        ? { activityType: 'FEE', subtype: 'INTEREST_CHARGE' }
        : { activityType: 'INTEREST' };

    case TransactionKind.unknown:
    default:
      return { activityType: 'UNKNOWN' };
  }
}

/**
 * The comment shown in Wealthfolio's activity list.
 *
 * The original description, plus the cuota marker when there is one, because
 * that is the context a person needs when they see the row six months later.
 */
function buildComment(transaction: NormalizedTransaction): string {
  const parts = [transaction.description.trim()];
  if (transaction.installment) {
    parts.push(`(cuota ${transaction.installment.current}/${transaction.installment.total})`);
  }
  return parts.join(' ').slice(0, 500);
}

/** Read our metadata back off an activity, if it is one of ours. */
export function readChileMetadata(
  metadata: Record<string, unknown> | undefined,
): ChileMetadata | undefined {
  if (!metadata) return undefined;
  const raw = metadata[METADATA_NAMESPACE];
  if (!raw || typeof raw !== 'object') return undefined;
  const candidate = raw as Partial<ChileMetadata>;
  if (typeof candidate.fp !== 'string' || candidate.fp === '') return undefined;
  return candidate as ChileMetadata;
}
