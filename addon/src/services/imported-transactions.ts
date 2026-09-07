import type { AddonContext } from '@wealthfolio/addon-sdk';
import {
  activityToTransaction,
  reviewReason,
  type ReviewReason,
} from '../core/mapping/activities';
import type { Money } from '../core/money';
import type { NormalizedTransaction } from '../core/model/transaction';
import type { ScopedTransaction } from '../core/reconcile/transfers';
import { activityDateFilters, withinWindow } from './activity-index';

/**
 * Reading back the movements this addon imported.
 *
 * The dashboard and the (future) reconciliation view both need "our" movements
 * as canonical transactions again. Both used to page through the whole activity
 * table with an arbitrary cap, which silently under-reported the moment an
 * account grew past it. This asks the host for the window it actually needs and
 * reports honestly when it could not read all of it.
 */

/** Page size for the scan. */
const PAGE_SIZE = 500;

/**
 * Page cap.
 *
 * At 500 rows per page this covers 50.000 activities inside the requested
 * window — far beyond a household's movements for a year, and still bounded so
 * a pathological account cannot hang the UI. Hitting it sets `truncated`, and
 * every caller is expected to surface that rather than show a smaller number as
 * if it were the answer.
 */
const MAX_PAGES = 100;

export interface TransactionWindow {
  /** Inclusive lower bound, `YYYY-MM-DD`. Omitted means "no lower bound". */
  fromDate?: string;
  /** Inclusive upper bound, `YYYY-MM-DD`. */
  toDate?: string;
  /** Restrict to one account. Omitted means every account. */
  accountId?: string;
}

/**
 * One movement the addon wrote and could not finish describing.
 *
 * Carries everything a panel needs to show the row without asking the host
 * again, and the one thing the host's own filter cannot tell apart: whether the
 * row is a draft. A draft contributes to no balance and no total while it
 * stays one; a substituted row does contribute, under a type that is not what
 * the movement was.
 */
export interface ReviewItem {
  activityId: string;
  accountId: string;
  date: string;
  /** Signed, the addon's own reading. */
  amount: Money;
  description: string;
  reason: ReviewReason;
  /** True when the host is leaving this row out of every calculation. */
  draft: boolean;
}

export interface ImportedTransactions {
  /** Canonical transactions rebuilt from activity metadata. */
  transactions: NormalizedTransaction[];
  /** The same rows paired with the Wealthfolio account they live in. */
  scoped: ScopedTransaction[];
  /** Activities read from the host, ours or not. */
  scanned: number;
  /** What the host reports for the filtered set. */
  totalRowCount: number;
  /** True when the page cap stopped the scan short of the full result set. */
  truncated: boolean;
  /**
   * Rows this addon wrote that the host still flags for review.
   *
   * Built on the same pass rather than by a second query: a separate index
   * could disagree with the ledger, and the ledger is the answer. Scoped to the
   * same window as everything else, so a caller showing it has to say which
   * window it is.
   */
  review: ReviewItem[];
}

export async function loadImportedTransactions(
  ctx: AddonContext,
  window: TransactionWindow = {},
): Promise<ImportedTransactions> {
  const transactions: NormalizedTransaction[] = [];
  const scoped: ScopedTransaction[] = [];
  const review: ReviewItem[] = [];
  let scanned = 0;
  let totalRowCount = 0;
  let truncated = false;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = await ctx.api.activities.search(
      page,
      PAGE_SIZE,
      activityDateFilters(window),
      '',
      { id: 'date', desc: true },
    );

    totalRowCount = response.meta.totalRowCount;

    for (const activity of response.data) {
      // The request is padded by a day on each side to survive the host's
      // timezone-shifted bounds; the exact window is re-imposed here.
      if (!withinWindow(activity.date, window)) continue;
      scanned += 1;
      const transaction = activityToTransaction(activity);
      if (!transaction) continue;
      transactions.push(transaction);
      scoped.push({ accountId: activity.accountId, transaction });

      const reason = reviewReason(activity);
      if (reason) {
        review.push({
          activityId: activity.id,
          accountId: activity.accountId,
          date: transaction.date,
          amount: transaction.amount,
          description: transaction.description,
          reason,
          draft: activity.status === 'DRAFT',
        });
      }
    }

    const seen = (page + 1) * PAGE_SIZE;
    if (response.data.length < PAGE_SIZE || seen >= totalRowCount) break;
    if (page === MAX_PAGES - 1) truncated = true;
  }

  return { transactions, scoped, scanned, totalRowCount, truncated, review };
}
