import type { ActivitySearchFilters, AddonContext } from '@wealthfolio/addon-sdk';
import { buildDuplicateIndex, type DuplicateIndex, type ExistingMovement } from '../core/dedupe/classify';
import { activityDetailsToSignedMoney, readChileMetadata } from '../core/mapping/activities';

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
      const metadata = readChileMetadata(activity.metadata);
      movements.push({
        ...(metadata?.fp ? { fingerprint: metadata.fp } : {}),
        ...(metadata?.wfp ? { weakFingerprint: metadata.wfp } : {}),
        activityId: activity.id,
        date: toIsoDate(activity.date),
        amount: activityDetailsToSignedMoney(activity),
        description: activity.comment ?? '',
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
 * v3.6.2 names the date bounds `dateFrom`/`dateTo` (`YYYY-MM-DD`, inclusive) at
 * the adapter and both backends. They are absent from `ActivitySearchFilters`
 * in the SDK's type declarations, but the addon bridge forwards the filter
 * object verbatim, so they do reach the query — see docs/UPSTREAM.md. The cast
 * is the honest way to say "wider than the published type".
 */
export function activityDateFilters(
  options: Omit<LoadIndexOptions, 'accountId'> & { accountId?: string },
): ActivitySearchFilters {
  return {
    ...(options.accountId ? { accountIds: options.accountId } : {}),
    ...(options.fromDate ? { dateFrom: options.fromDate } : {}),
    ...(options.toDate ? { dateTo: options.toDate } : {}),
  } as ActivitySearchFilters;
}

function toIsoDate(value: Date | string): string {
  if (typeof value === 'string') return value.slice(0, 10);
  // `Date` from the host is an instant; the calendar day is read in UTC because
  // that is how Wealthfolio stores activity dates.
  return value.toISOString().slice(0, 10);
}
