import type { AddonContext } from '@wealthfolio/addon-sdk';
import { buildDuplicateIndex, type DuplicateIndex, type ExistingMovement } from '../core/dedupe/classify';
import { readChileMetadata } from '../core/mapping/activities';
import { money, type Money } from '../core/money';

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
 */

/** Page size for the activity scan. Large enough to keep round trips down. */
const PAGE_SIZE = 500;

/** Hard cap so a huge account cannot hang the preview. */
const MAX_PAGES = 40;

export interface LoadIndexOptions {
  accountId: string;
  /** Only look at activities on or after this date, when known. */
  fromDate?: string;
  toDate?: string;
}

export async function loadDuplicateIndex(
  ctx: AddonContext,
  options: LoadIndexOptions,
): Promise<DuplicateIndex> {
  const movements: ExistingMovement[] = [];

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = await ctx.api.activities.search(
      page,
      PAGE_SIZE,
      {
        accountIds: options.accountId,
        ...(options.fromDate ? { startDate: options.fromDate } : {}),
        ...(options.toDate ? { endDate: options.toDate } : {}),
      },
      '',
      { id: 'date', desc: true },
    );

    for (const activity of response.data) {
      const metadata = readChileMetadata(activity.metadata);
      movements.push({
        ...(metadata?.fp ? { fingerprint: metadata.fp } : {}),
        ...(metadata?.wfp ? { weakFingerprint: metadata.wfp } : {}),
        activityId: activity.id,
        date: toIsoDate(activity.date),
        amount: toMoney(activity.amount, activity.currency),
        description: activity.comment ?? '',
      });
    }

    const seen = (page + 1) * PAGE_SIZE;
    if (response.data.length < PAGE_SIZE || seen >= response.meta.totalRowCount) break;
  }

  return buildDuplicateIndex(movements);
}

/**
 * Parse an amount Wealthfolio returns as a decimal string.
 *
 * The string form is authoritative — it is what the backend stores — so the
 * scale is taken from the digits present rather than assumed per currency.
 */
export function toMoney(amount: string | null | undefined, currency: string): Money {
  const text = String(amount ?? '0').trim();
  const negative = text.startsWith('-');
  const digits = text.replace(/[^\d.]/g, '');
  const [whole = '0', fraction = ''] = digits.split('.');
  const scale = Math.min(6, fraction.length);
  const minor = Number(`${whole}${fraction.slice(0, scale)}`);
  if (!Number.isSafeInteger(minor)) return money(0, 0, currency);
  return money(negative ? -minor : minor, scale, currency || 'CLP');
}

function toIsoDate(value: Date | string): string {
  if (typeof value === 'string') return value.slice(0, 10);
  // `Date` from the host is an instant; the calendar day is read in UTC because
  // that is how Wealthfolio stores activity dates.
  return value.toISOString().slice(0, 10);
}
