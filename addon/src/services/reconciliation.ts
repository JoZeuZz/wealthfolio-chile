import type { AddonContext } from '@wealthfolio/addon-sdk';
import {
  matchCardPayments,
  type CardPaymentMatch,
  type CardPaymentOptions,
} from '../core/reconcile/credit-card';
import {
  matchTransfers,
  type ScopedTransaction,
  type TransferMatch,
  type TransferMatchOptions,
} from '../core/reconcile/transfers';
import { loadImportedTransactions, type TransactionWindow } from './imported-transactions';

/**
 * The orchestration seam for multi-account reconciliation.
 *
 * The matchers in `core/reconcile` are pure and fully tested, but they need
 * movements from *several* accounts at once — which only the host can supply.
 * `prepareImport()` sees one file and one account, so wiring `ctx.api` into it
 * would both break its purity and still not have the data.
 *
 * This file is where the two meet, and the shape is deliberate:
 *
 *     host activities
 *           ↓   services/imported-transactions
 *     ScopedTransaction[]
 *           ↓   this facade
 *     matchTransfers() / matchCardPayments()   ← pure, no host, no storage
 *           ↓
 *     ReconciliationResult
 *
 * Nothing here decides anything. Applying a match reclassifies both legs and is
 * therefore a user action; this only computes candidates. The review UI that
 * consumes it is not built yet — see docs/ARCHITECTURE.md § Conciliación.
 */

export interface ReconciliationOptions {
  transfers?: TransferMatchOptions;
  cardPayments?: CardPaymentOptions;
}

export interface ReconciliationResult {
  transfers: TransferMatch[];
  cardPayments: CardPaymentMatch[];
  /** Fingerprints on either leg of a transfer match. */
  matchedFingerprints: Set<string>;
  /** Rows the matchers ran over. */
  considered: number;
  /**
   * True when the underlying scan was cut short.
   *
   * A partial view can pair the wrong two legs, so a caller must treat this as
   * "these suggestions are incomplete" and never auto-apply them.
   */
  truncated: boolean;
}

/**
 * Match transfers and card payments over movements from every account.
 *
 * Pure input, pure matchers: the only impure step is the read at the top.
 */
export function reconcileScoped(
  scoped: readonly ScopedTransaction[],
  options: ReconciliationOptions = {},
): Omit<ReconciliationResult, 'truncated'> {
  const transfers = matchTransfers(scoped, options.transfers ?? {});
  const cardPayments = matchCardPayments(scoped, options.cardPayments ?? {});

  return {
    transfers: transfers.matches,
    cardPayments,
    matchedFingerprints: transfers.matchedFingerprints,
    considered: scoped.length,
  };
}

/** Read the window from the host, then run the pure matchers over it. */
export async function reconcileWindow(
  ctx: AddonContext,
  window: TransactionWindow = {},
  options: ReconciliationOptions = {},
): Promise<ReconciliationResult> {
  // Deliberately unscoped by account: a transfer has one leg in each of two
  // accounts, so restricting the read to one of them can never find a pair.
  const loaded = await loadImportedTransactions(ctx, {
    ...(window.fromDate ? { fromDate: window.fromDate } : {}),
    ...(window.toDate ? { toDate: window.toDate } : {}),
  });
  return { ...reconcileScoped(loaded.scoped, options), truncated: loaded.truncated };
}
