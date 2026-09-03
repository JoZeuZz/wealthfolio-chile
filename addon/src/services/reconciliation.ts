import type { AddonContext } from '@wealthfolio/addon-sdk';
import {
  matchCardPayments,
  type CardPaymentMatch,
  type CardPaymentOptions,
} from '../core/reconcile/credit-card';
import {
  matchTransfers,
  type AmbiguousTransfer,
  type ScopedTransaction,
  type TransferMatch,
  type TransferMatchOptions,
} from '../core/reconcile/transfers';
import { loadImportedTransactions, type TransactionWindow } from './imported-transactions';
import { loadSettings } from './settings';

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
  /**
   * Movements with several equally plausible counterparts.
   *
   * Carried alongside the matches rather than folded into them: "we found the
   * pair" and "we found four movements and cannot tell which two go together"
   * are different answers, and only the first is a finding.
   */
  ambiguousTransfers: AmbiguousTransfer[];
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
    ambiguousTransfers: transfers.ambiguous,
    cardPayments,
    matchedFingerprints: transfers.matchedFingerprints,
    considered: scoped.length,
  };
}

/**
 * Read the window from the host, then run the pure matchers over it.
 *
 * The day window comes from the user's settings unless the caller overrides it.
 * Without this the stored `transferWindowDays` was decoration: something the
 * settings could hold and nothing would ever read.
 */
export async function reconcileWindow(
  ctx: AddonContext,
  window: TransactionWindow = {},
  options: ReconciliationOptions = {},
): Promise<ReconciliationResult> {
  const settings = await loadSettings(ctx.api.storage);

  // Deliberately unscoped by account: a transfer has one leg in each of two
  // accounts, so restricting the read to one of them can never find a pair.
  const loaded = await loadImportedTransactions(ctx, {
    ...(window.fromDate ? { fromDate: window.fromDate } : {}),
    ...(window.toDate ? { toDate: window.toDate } : {}),
  });

  const effective: ReconciliationOptions = {
    ...options,
    transfers: { windowDays: settings.transferWindowDays, ...options.transfers },
    cardPayments: { windowDays: settings.transferWindowDays, ...options.cardPayments },
  };

  return { ...reconcileScoped(loaded.scoped, effective), truncated: loaded.truncated };
}
