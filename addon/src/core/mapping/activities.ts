import type { ActivityCreate, ActivityType } from '@wealthfolio/addon-sdk';
import { hashFields } from '../hash';
import { abs, money, negate, toDecimalString, type Money } from '../money';
import { Confidence, Direction, TransactionKind } from '../model/kinds';
import type { EnrichedTransaction, NormalizedTransaction } from '../model/transaction';
import { normalizeDescription } from '../text';

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

/**
 * Schema version of the metadata blob we write.
 *
 * - `1` — 0.1.0 and 0.1.1. No `dir`.
 * - `2` — records `dir`, the direction the source row carried. Needed because
 *   `UNKNOWN` (and every other activity type Wealthfolio gives no cash
 *   direction) would otherwise come back as an inflow: we write the magnitude,
 *   the host stores it unsigned, and nothing on the way back remembers that the
 *   money left the account.
 * - `3` — records `proj`, a hash of the activity exactly as we wrote it. It is
 *   what lets a later read tell "this is still the row we created" from "the
 *   user changed it in Wealthfolio and our cached identity describes something
 *   that no longer exists".
 *
 * Readers must keep accepting `1` and `2`: activities written by 0.1.x are
 * still in the user's ledger and still have to round-trip. Without `proj` the
 * question "was this edited?" falls back to the host's own `isUserModified`.
 */
export const METADATA_VERSION = 3;

/**
 * Metadata written on every activity we create.
 *
 * Three categories, and confusing them is how a stale cache starts overruling
 * the ledger:
 *
 * - **Provenance** — `v`, `inst`, `parser`, `parserVersion`, `fileHash`,
 *   `runId`. Facts about the import event. The host cannot contradict them
 *   because it never knew them.
 * - **Cache** — `fp`, `wfp`, `kind`, `dir`, `cat`, `merchant`, `tags`, `cuota`,
 *   `xfer`. Values derived from the row as it was at import time. Every one of
 *   them can be made false by editing the activity in Wealthfolio, so none may
 *   be used without first asking whether the activity still matches `proj`.
 * - **Witness** — `proj`. Not data about the movement; data about whether the
 *   rest of this blob is still describing the activity it is attached to.
 *
 * Nothing here is authoritative. Wealthfolio holds the financial state; this is
 * the addon's note about how a row got there.
 */
export interface ChileMetadata {
  /** Schema version of this metadata blob. See `METADATA_VERSION`. */
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
  /**
   * Direction the row had before it was written, as `'in'` or `'out'`.
   *
   * Only consulted for activity types Wealthfolio gives no direction of its own
   * (`UNKNOWN`, `ADJUSTMENT`, `SPLIT`, anything upstream adds later). For every
   * type with documented semantics the `activityType` wins, so stale or
   * hand-edited metadata can never turn a `WITHDRAWAL` into an inflow.
   */
  dir?: Direction;
  /** Category id, if assigned. */
  cat?: string;
  merchant?: string;
  tags?: string[];
  /** Installment counter, when the row is part of a plan. */
  cuota?: { n: number; of: number };
  /** Fingerprint of the matched transfer counterpart. */
  xfer?: string;
  /**
   * Hash of the activity as this addon wrote it. See {@link activityProjection}.
   *
   * Absent on metadata written before schema 3.
   */
  proj?: string;
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
 *
 * For the types that carry no direction that erases information, so the
 * original direction is also written to `metadata.dir`. See `METADATA_VERSION`.
 */
export function toActivityCreate(
  transaction: EnrichedTransaction | NormalizedTransaction,
  options: MapToActivityOptions,
): ActivityCreate {
  const { activityType, subtype } = resolveActivityType(transaction);
  const magnitude = abs(transaction.amount);

  const comment = buildComment(transaction);
  const amount = toDecimalString(magnitude);

  const metadata: ChileMetadata = {
    v: METADATA_VERSION,
    fp: transaction.fingerprint,
    ...(options.weakFingerprint ? { wfp: options.weakFingerprint } : {}),
    inst: transaction.sourceInstitution,
    parser: transaction.sourceParser,
    parserVersion: transaction.sourceParserVersion,
    fileHash: transaction.sourceFileHash,
    runId: options.runId,
    kind: transaction.kind,
    dir: transaction.direction,
    ...(transaction.category ? { cat: transaction.category } : {}),
    ...(transaction.merchant ? { merchant: transaction.merchant } : {}),
    ...(transaction.tags.length > 0 ? { tags: transaction.tags } : {}),
    ...(transaction.installment
      ? { cuota: { n: transaction.installment.current, of: transaction.installment.total } }
      : {}),
    ...(transaction.transferCandidate?.counterpartFingerprint
      ? { xfer: transaction.transferCandidate.counterpartFingerprint }
      : {}),
    // Hashed from the fields below, so reading the activity back can tell
    // "unchanged since we wrote it" from "edited in Wealthfolio, and every
    // cached value above now describes a movement that is not there any more".
    proj: activityProjection({
      accountId: options.accountId,
      activityType,
      ...(subtype ? { subtype } : {}),
      date: transaction.date,
      amount,
      currency: transaction.amount.currency,
      comment,
    }),
  };

  return {
    accountId: options.accountId,
    activityType,
    ...(subtype ? { subtype } : {}),
    activityDate: transaction.date,
    amount,
    currency: transaction.amount.currency,
    comment,
    // A JSON *string*, not an object. `NewActivity.metadata` is `Option<String>`
    // in the v3.6.2 backend, so an object costs the whole batch a 422 before a
    // single row is written. Reads are asymmetric — `ActivityDetails.metadata`
    // comes back already parsed — which is why `readChileMetadata` takes both.
    metadata: JSON.stringify({ [METADATA_NAMESPACE]: metadata }),
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

/**
 * ── The inverse mapping ────────────────────────────────────────────────
 *
 * Wealthfolio stores `amount` as an unsigned magnitude and expresses direction
 * through `activityType`. Our model does the opposite: the sign lives in the
 * amount. Reading an activity back therefore has to reapply the sign, and it
 * has to do it *once*, here — a second copy of this table in the dashboard or
 * the dedupe index is how `+85400` ends up being compared against `-85400`.
 */

/** Cash direction a Wealthfolio activity type implies. `0` means "no direction". */
export type ActivityFlowSign = -1 | 0 | 1;

/**
 * The subset of `ActivityDetails` the sign rules need.
 *
 * Declared structurally rather than importing `ActivityDetails` so a test can
 * build one by hand, and so nothing outside this file has to know the shape.
 */
export interface HostActivityAmount {
  activityType: string;
  subtype?: string | null;
  amount: string | number | null | undefined;
  currency: string;
  /**
   * The activity's metadata blob, when the host hands one back.
   *
   * Optional because a caller may only have the amount fields, but it is what
   * lets a directionless type recover the sign it was written with. Either
   * shape: parsed from `activities.search`, still a JSON string from a create.
   */
  metadata?: string | Record<string, unknown>;
}

/**
 * Cash-flow sign of a Wealthfolio activity type, from
 * `docs/activities/activity-types.md` in upstream v3.6.2.
 *
 * `SPLIT`, `ADJUSTMENT` and `UNKNOWN` have no automatic cash impact, so they
 * get `0`: guessing a direction for a row Wealthfolio itself refuses to
 * classify would put an invented number into the user's totals.
 */
export function activityFlowSign(activityType: string): ActivityFlowSign {
  switch (activityType) {
    // `CREDIT` covers refunds, rebates and bonuses; all of them increase cash.
    case 'DEPOSIT':
    case 'TRANSFER_IN':
    case 'INTEREST':
    case 'DIVIDEND':
    case 'CREDIT':
    case 'SELL':
      return 1;

    case 'WITHDRAWAL':
    case 'TRANSFER_OUT':
    case 'FEE':
    case 'TAX':
    case 'BUY':
      return -1;

    case 'SPLIT':
    case 'ADJUSTMENT':
    case 'UNKNOWN':
    default:
      return 0;
  }
}

/**
 * A hash of the fields that make a stored activity the movement it is.
 *
 * Computed the same way on both sides of the wire: when the activity is built
 * (`toActivityCreate`) and when it is read back. If the two differ, something
 * changed the activity after we wrote it, and every cached value in our
 * metadata — the fingerprint above all — now describes a movement that is no
 * longer there.
 *
 * Deliberately narrow. It covers what identity depends on (account, day,
 * magnitude, currency, type, subtype, comment) and nothing else, so a change
 * the host makes for its own reasons — linking a transfer pair, which flips
 * `isUserModified` without touching any of these — does not read as an edit.
 */
export function activityProjection(activity: ProjectableActivity): string {
  return hashFields([
    'proj-v1',
    activity.accountId ?? '',
    civilDate(activity.date),
    canonicalAmountText(activity.amount, activity.currency),
    activity.currency,
    activity.activityType,
    activity.subtype ?? '',
    activity.comment ?? '',
  ]);
}

/** The activity fields {@link activityProjection} reads. */
export interface ProjectableActivity extends HostActivityAmount {
  accountId?: string;
  date: Date | string;
  comment?: string | null;
}

/**
 * One spelling for an amount, whatever spelling the host chose.
 *
 * `85400`, `85400.00` and `85400.0` are the same money. Hashing the raw string
 * would report an edit every time the backend changed how it formats decimals.
 */
function canonicalAmountText(amount: string | number | null | undefined, currency: string): string {
  const parsed = parseHostAmount(amount, currency);
  const text = toDecimalString(abs(parsed));
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
}

/**
 * Our kind for a Wealthfolio activity type, when our own record is missing or
 * contradicted.
 *
 * Coarse on purpose: `WITHDRAWAL` covers both `expense` and
 * `credit_card_purchase`, and `TRANSFER_OUT` covers `internal_transfer`,
 * `credit_card_payment` and `investment`. Picking one of those from the type
 * alone would be a guess, so this returns the plain reading and the caller only
 * falls back to it when the metadata's finer answer is incompatible with what
 * the host actually stores. Types our model has no equivalent for — `BUY`,
 * `SELL`, `DIVIDEND`, `SPLIT`, `ADJUSTMENT` — become `unknown` rather than
 * being forced into a cash kind.
 */
export function kindFromActivityType(
  activityType: string,
  subtype?: string | null,
): TransactionKind {
  switch (activityType) {
    case 'DEPOSIT':
      return TransactionKind.income;
    case 'WITHDRAWAL':
      return TransactionKind.expense;
    case 'TRANSFER_IN':
    case 'TRANSFER_OUT':
      return TransactionKind.internal_transfer;
    case 'CREDIT':
      return TransactionKind.refund;
    case 'FEE':
      return subtype === 'INTEREST_CHARGE' ? TransactionKind.interest : TransactionKind.fee;
    case 'TAX':
      return TransactionKind.tax;
    case 'INTEREST':
      return TransactionKind.interest;
    default:
      return TransactionKind.unknown;
  }
}

/** `Direction` implied by an activity type, or `undefined` when it implies none. */
export function activityDirection(activityType: string): Direction | undefined {
  const flow = activityFlowSign(activityType);
  if (flow === 0) return undefined;
  return flow < 0 ? Direction.out : Direction.in;
}

/**
 * Direction we recorded when we wrote the activity, if we wrote it and if the
 * value is one we recognise.
 *
 * Validated rather than trusted: metadata is JSON that survived a round trip
 * through the host's database and could have been edited by anything.
 */
function recordedDirection(
  metadata: string | Record<string, unknown> | undefined,
): Direction | undefined {
  const dir = readChileMetadata(metadata)?.dir;
  return dir === Direction.in || dir === Direction.out ? dir : undefined;
}

/**
 * The direction of a stored activity: the host's activity type first, our own
 * metadata only as the fallback.
 *
 * That order is the whole rule. `WITHDRAWAL` means money left the account no
 * matter what our metadata claims, so a stale `dir` can never flip a type whose
 * semantics Wealthfolio defines. Metadata is consulted exactly where the host
 * has nothing to say — `UNKNOWN`, `ADJUSTMENT`, `SPLIT`, and whatever upstream
 * adds next.
 *
 * `undefined` means neither source knows: an `UNKNOWN` written by 0.1.0/0.1.1,
 * or an activity some other addon created.
 */
export function resolveActivityDirection(activity: HostActivityAmount): Direction | undefined {
  return activityDirection(activity.activityType) ?? recordedDirection(activity.metadata);
}

/**
 * Parse an amount Wealthfolio returns as a decimal string.
 *
 * The string form is authoritative — it is what the backend stores — so the
 * scale is taken from the digits present rather than assumed per currency.
 */
export function parseHostAmount(amount: string | number | null | undefined, currency: string): Money {
  const text = String(amount ?? '0').trim();
  const negative = text.startsWith('-');
  const digits = text.replace(/[^\d.]/g, '');
  const [whole = '0', fraction = ''] = digits.split('.');
  const scale = Math.min(6, fraction.length);
  const minor = Number(`${whole}${fraction.slice(0, scale)}`);
  if (!Number.isSafeInteger(minor)) return money(0, 0, currency || 'CLP');
  return money(negative ? -minor : minor, scale, currency || 'CLP');
}

/**
 * Rebuild our signed amount from a stored Wealthfolio activity.
 *
 * The single source of truth for "what does this activity do to the balance".
 *
 * Three cases, in order:
 *
 * 1. The type has a direction — it wins, always.
 * 2. It does not, but we wrote the row and recorded `dir` — the sign we
 *    originally had is restored. Without this an `UNKNOWN` outflow comes back
 *    as an inflow, because `toActivityCreate()` writes the magnitude.
 * 3. Neither — the stored sign is preserved untouched, because inventing one
 *    would be worse than reporting what the host holds.
 */
export function activityDetailsToSignedMoney(activity: HostActivityAmount): Money {
  const parsed = parseHostAmount(activity.amount, activity.currency);
  const direction = resolveActivityDirection(activity);
  if (!direction) return parsed;
  const magnitude = abs(parsed);
  return direction === Direction.out ? negate(magnitude) : magnitude;
}

/**
 * Read our metadata back off an activity, if it is one of ours.
 *
 * Accepts both shapes on purpose. `activities.search` returns metadata parsed,
 * but the same blob is a JSON string on the way in and in anything that echoes
 * a create back, and a reader that only understood one of the two would decide
 * a movement is not ours purely because of which side of the wire it came from.
 */
export function readChileMetadata(
  metadata: string | Record<string, unknown> | undefined,
): ChileMetadata | undefined {
  if (!metadata) return undefined;
  const parsed = typeof metadata === 'string' ? parseMetadataJson(metadata) : metadata;
  if (!parsed) return undefined;
  const raw = parsed[METADATA_NAMESPACE];
  if (!raw || typeof raw !== 'object') return undefined;
  const candidate = raw as Partial<ChileMetadata>;
  if (typeof candidate.fp !== 'string' || candidate.fp === '') return undefined;
  return candidate as ChileMetadata;
}

/** A metadata string the host never wrote is not an error — it is simply not ours. */
function parseMetadataJson(metadata: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(metadata);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** A stored activity, as much of it as the inverse mapping reads. */
export interface HostActivity extends HostActivityAmount {
  id?: string;
  date: Date | string;
  comment?: string | null;
}

/**
 * Rebuild a canonical transaction from an activity this addon created.
 *
 * Returns `undefined` for anything the addon did not write: without our
 * metadata there is no kind, no category and no fingerprint, and inventing them
 * from a comment string would put guesses into the user's reports.
 */
export function activityToTransaction(activity: HostActivity): NormalizedTransaction | undefined {
  const metadata = readChileMetadata(activity.metadata);
  if (!metadata) return undefined;

  const amount = activityDetailsToSignedMoney(activity);
  const direction = resolveActivityDirection(activity) ?? directionOfAmount(amount);
  const description = activity.comment ?? '';
  const kind = reconcileKind(activity, metadata, direction);

  return {
    sourceInstitution: metadata.inst,
    sourceParser: metadata.parser,
    sourceParserVersion: metadata.parserVersion,
    sourceFileHash: metadata.fileHash,
    fingerprint: metadata.fp,
    date: civilDate(activity.date),
    description,
    normalizedDescription: normalizeDescription(description),
    ...(metadata.merchant ? { merchant: metadata.merchant } : {}),
    amount,
    direction,
    kind,
    // `suggested` once the host has contradicted us: the row is classified, but
    // by a coarser reading than the one the import made.
    kindConfidence: kind === metadata.kind ? Confidence.confirmed : Confidence.suggested,
    ...(metadata.cat ? { category: metadata.cat } : {}),
    tags: metadata.tags ?? [],
    ...(metadata.cuota
      ? {
          installment: {
            current: metadata.cuota.n,
            total: metadata.cuota.of,
            confidence: Confidence.confirmed,
            matchedText: `${metadata.cuota.n}/${metadata.cuota.of}`,
          },
        }
      : {}),
    warnings: [],
    rawMetadata: {},
  };
}

/**
 * Our kind for a stored activity, with the host holding the casting vote.
 *
 * `metadata.kind` is a cache of what the import decided. If the user has since
 * changed the activity's type in Wealthfolio, that cache is a claim the ledger
 * contradicts — and a dashboard that keeps counting a `DEPOSIT` as an expense
 * because our own note says so is reporting a number the user can see is wrong.
 *
 * So the cached kind is kept only while it *maps to* the type the host actually
 * holds. That test is the exact inverse of how the activity was written, which
 * means it accepts every finer distinction our model makes and the host's type
 * cannot express — `credit_card_purchase` under `WITHDRAWAL`,
 * `credit_card_payment` under `TRANSFER_OUT` — and rejects only real
 * disagreement.
 */
function reconcileKind(
  activity: HostActivity,
  metadata: ChileMetadata,
  direction: Direction,
): TransactionKind {
  const cached = (metadata.kind ?? TransactionKind.unknown) as TransactionKind;
  const implied = resolveActivityType({ kind: cached, direction });
  if (implied.activityType === activity.activityType) return cached;
  return kindFromActivityType(activity.activityType, activity.subtype);
}

function directionOfAmount(amount: Money): Direction {
  return amount.minor < 0 ? Direction.out : Direction.in;
}

/** Read the calendar day out of whatever shape the host returns. */
function civilDate(value: Date | string): string {
  return typeof value === 'string' ? value.slice(0, 10) : value.toISOString().slice(0, 10);
}
