import type { ActivitySearchFilters, AddonContext } from '@wealthfolio/addon-sdk';
import { addDays, type IsoDate } from '../core/dates';
import { buildDuplicateIndex, type DuplicateIndex, type ExistingMovement } from '../core/dedupe/classify';
import { weakFingerprintOf } from '../core/dedupe/fingerprint';
import {
  activityDetailsToSignedMoney,
  activityProjection,
  readChileMetadata,
  type HostAccountType,
} from '../core/mapping/activities';

/**
 * Rebuilding the duplicate index from Wealthfolio itself.
 *
 * The fingerprint of every movement we import is written into the activity's
 * `metadata`, and `ActivityDetails` hands that metadata back on search. So the
 * dedupe index is derived from Wealthfolio's own data rather than from a
 * parallel ledger in addon storage.
 *
 * That matters: a shadow ledger would drift the moment the user deleted an
 * activity by hand, and the addon would then refuse to re-import a movement
 * that no longer exists.
 *
 * Amounts come back through `activityDetailsToSignedMoney`, never raw: the host
 * stores magnitudes and puts the direction in the activity type, so a raw read
 * would compare `+85400` against our `-85400` and miss every probable
 * duplicate. See `core/mapping/activities`.
 */

/** Page size for the activity scan. Large enough to keep round trips down. */
const PAGE_SIZE = 500;

/** Hard cap so a huge account cannot hang the preview. */
const MAX_PAGES = 40;

export interface LoadIndexOptions {
  accountId: string;
  /** Only look at activities on or after this date, when known. `YYYY-MM-DD`. */
  fromDate?: string;
  /** Only look at activities on or before this date. `YYYY-MM-DD`. */
  toDate?: string;
}

export interface LoadIndexResult {
  index: DuplicateIndex;
  /** Movements actually read. */
  scanned: number;
  /** What the host says the filtered set holds. */
  totalRowCount: number;
  /**
   * True when the page cap stopped the scan before the end of the result set.
   *
   * A truncated scan cannot prove a movement is new, so the caller must refuse
   * to import rather than quietly risk a double write.
   */
  truncated: boolean;
}

/**
 * Read every activity in an account (optionally within a date window) and build
 * the dedupe index from it.
 *
 * Throws whatever the host throws. Callers must not swallow that into an empty
 * index: "we could not check" and "there is nothing to check" are different
 * answers, and only one of them makes importing safe.
 */
export async function loadDuplicateIndexResult(
  ctx: AddonContext,
  options: LoadIndexOptions,
): Promise<LoadIndexResult> {
  const movements: ExistingMovement[] = [];
  let totalRowCount = 0;
  let truncated = false;

  // Same account, every row of this scan: one lookup, not one per activity.
  // Without it, `activityDetailsToSignedMoney` falls back to its
  // no-`accountType` reading, which disagrees with `imported-transactions.ts`
  // on the sign of a raw `INTEREST` row on a credit-card account — and two
  // readers of the same activity disagreeing on its sign is exactly what lets
  // a duplicate slip past this index.
  const accounts = await ctx.api.accounts.getAll();
  const accountType: HostAccountType | undefined = accounts.find(
    (account) => account.id === options.accountId,
  )?.accountType;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = await ctx.api.activities.search(
      page,
      PAGE_SIZE,
      activityDateFilters(options),
      '',
      { id: 'date', desc: true },
    );

    totalRowCount = response.meta.totalRowCount;

    for (const activity of response.data) {
      if (!withinWindow(activity.date, options)) continue;
      const metadata = readChileMetadata(activity.metadata);
      const modified = wasModifiedAfterImport(activity, metadata?.proj);
      const date = toIsoDate(activity.date);
      const amount = activityDetailsToSignedMoney(activity, accountType, {
        metadataCacheIsCurrent: !modified,
      });
      movements.push({
        ...(metadata?.fp ? { fingerprint: metadata.fp } : {}),
        // Derived here rather than read from `metadata.wfp`, which only exists
        // on rows this addon wrote. Everything else — a movement entered by
        // hand, or imported with Wealthfolio's own CSV importer — was loaded
        // into the index and then structurally unreachable: neither `exact` nor
        // `probable` could ever find it, so importing the same cartola through
        // this addon produced a complete second copy while the result card said
        // re-importing would duplicate nothing.
        //
        // `metadata.wfp` stays as the strong-path key for our own rows.
        weakFingerprint: metadata?.wfp ?? weakFingerprintOf({ accountId: options.accountId, date, amount }),
        activityId: activity.id,
        date,
        amount,
        description: activity.comment ?? '',
        ...(modified ? { hostModified: true } : {}),
      });
    }

    const seen = (page + 1) * PAGE_SIZE;
    if (response.data.length < PAGE_SIZE || seen >= totalRowCount) break;
    if (page === MAX_PAGES - 1) truncated = true;
  }

  return {
    index: buildDuplicateIndex(movements),
    scanned: movements.length,
    totalRowCount,
    truncated,
  };
}

/**
 * Has this activity changed since the addon wrote it?
 *
 * Two sources, in order of precision:
 *
 * 1. The projection we recorded (metadata schema 3 and later). It hashes only
 *    the fields identity depends on, so it answers the question exactly: the
 *    account, day, amount, currency, type, subtype or comment is different from
 *    what we wrote. It also stays quiet for changes the host makes on its own —
 *    linking a transfer pair rewrites the row, and `isUserModified` with it,
 *    without altering a single one of those fields.
 * 2. Failing that, the host's own `isUserModified`, which is set on any update
 *    after creation (`ActivityUpdate -> ActivityDB` in upstream sets it to 1).
 *    Coarser — it cannot say *what* changed — but it is the host's own record
 *    and it works for the activities 0.1.x wrote with no projection at all.
 *
 * When neither is available the answer is "not modified", which is what the
 * addon assumed before any of this existed.
 */
function wasModifiedAfterImport(
  activity: { isUserModified?: boolean } & Parameters<typeof activityProjection>[0],
  recordedProjection: string | undefined,
): boolean {
  if (recordedProjection !== undefined) {
    return activityProjection(activity) !== recordedProjection;
  }
  return activity.isUserModified === true;
}

/** Convenience wrapper for callers that only need the index itself. */
export async function loadDuplicateIndex(
  ctx: AddonContext,
  options: LoadIndexOptions,
): Promise<DuplicateIndex> {
  return (await loadDuplicateIndexResult(ctx, options)).index;
}

/**
 * Filters for `activities.search`.
 *
 * v3.6.2 names the date bounds `dateFrom`/`dateTo` (`YYYY-MM-DD`) at the
 * adapter and both backends. They are absent from `ActivitySearchFilters` in
 * the SDK's type declarations, but the addon bridge forwards the filter object
 * verbatim, so they do reach the query — see docs/UPSTREAM.md. The cast is the
 * honest way to say "wider than the published type".
 *
 * The bounds are padded by a day on each side, and that is not caution. The
 * backend resolves them in the *instance timezone* while our activity dates go
 * in as bare calendar days and land at UTC midnight, so under `America/Santiago`
 * a window asked for as 05→06 answers with 06→07 — observed against a real
 * container on 2026-08-07. Without the padding, a movement on the first day of
 * the window never reaches the duplicate index, the import declares it new, and
 * the user ends up with it twice. Callers narrow the result back to the exact
 * days with {@link withinWindow}.
 */
export function activityDateFilters(
  options: Omit<LoadIndexOptions, 'accountId'> & { accountId?: string },
): ActivitySearchFilters {
  return {
    ...(options.accountId ? { accountIds: options.accountId } : {}),
    ...(options.fromDate ? { dateFrom: addDays(options.fromDate as IsoDate, -1) } : {}),
    ...(options.toDate ? { dateTo: addDays(options.toDate as IsoDate, 1) } : {}),
  } as ActivitySearchFilters;
}

/**
 * Is this activity inside the calendar window the caller actually asked for?
 *
 * The counterpart to the padding in {@link activityDateFilters}: the host is
 * asked for one day more on each side, and the exact window is re-imposed here
 * where the dates are ours to compare.
 */
export function withinWindow(
  date: Date | string,
  window: { fromDate?: string; toDate?: string },
): boolean {
  const day = toIsoDate(date);
  if (window.fromDate && day < window.fromDate) return false;
  if (window.toDate && day > window.toDate) return false;
  return true;
}

function toIsoDate(value: Date | string): string {
  if (typeof value === 'string') return value.slice(0, 10);
  // `Date` from the host is an instant; the calendar day is read in UTC because
  // that is how Wealthfolio stores activity dates.
  return value.toISOString().slice(0, 10);
}
