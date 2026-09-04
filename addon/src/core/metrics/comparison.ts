import type { MonthKey } from '../dates';
import { isZero, sign, subtract, toNumber, type Money } from '../money';
import type { MonthlySummary } from './monthly';

/**
 * A month against the month before it.
 *
 * The whole point of this file is what it refuses to compute. A percentage is
 * a division, and three of the shapes a real month takes make that division
 * either impossible or a lie:
 *
 *   0 → 100.000     the growth is not "infinite", it is *new*
 *   100.000 → 0     the change is not "-100 %", the thing stopped
 *   -40.000 → +180.000   arithmetic gives -550 %, a person reads "it fell"
 *
 * So the result is a tagged union: the caller has to look at the shape before
 * it can render a number, and there is no shape that hands it a percentage it
 * should not show. The alternative — an optional `ratio` — is exactly how a
 * dashboard ends up printing `+Infinity %`.
 *
 * Two magnitudes it deliberately does not mix: `netSpending` belongs to the
 * spending view and `netCashFlow` to the cash view, and they answer different
 * questions about the same month (see `MonthlySummary`). Each is compared with
 * its own counterpart and never with the other.
 */

export type MonthlyDelta =
  /** No previous month in the data, or one that cannot serve as a baseline. */
  | { kind: 'no-baseline' }
  /** Both months are zero. Nothing happened; there is nothing to say. */
  | { kind: 'both-zero' }
  /** Zero before, something now. */
  | { kind: 'new'; amount: Money }
  /** Something before, zero now. */
  | { kind: 'gone'; amount: Money }
  /** The sign changed. Real, and not a percentage. */
  | { kind: 'sign-flip'; before: Money; after: Money; absolute: Money }
  /** The honest case: same sign, non-zero base. */
  | { kind: 'relative'; before: Money; after: Money; absolute: Money; ratio: number };

export interface MonthlyComparison {
  /** Currency both months are expressed in. */
  currency: string;
  month: MonthKey;
  /** The month compared against, or `undefined` when there was none. */
  previousMonth?: MonthKey;
  /**
   * True only when a real baseline was used.
   *
   * False for three different reasons — no previous month, a previous month in
   * another currency, or one that does not precede the current one — and the
   * UI says "sin base comparable" for all three rather than showing a delta
   * derived from nothing.
   */
  comparable: boolean;
  netSpending: MonthlyDelta;
  income: MonthlyDelta;
  netCashFlow: MonthlyDelta;
}

const NO_BASELINE: MonthlyDelta = { kind: 'no-baseline' };

/**
 * Compare two monthly summaries.
 *
 * `previous` is `undefined` when the data holds no movements for that month,
 * which is a different statement from "that month was zero" and is reported as
 * such.
 */
export function compareMonths(
  current: MonthlySummary,
  previous: MonthlySummary | undefined,
): MonthlyComparison {
  const currency = current.netSpending.currency;

  if (
    previous === undefined ||
    previous.netSpending.currency !== currency ||
    previous.month >= current.month
  ) {
    return {
      currency,
      month: current.month,
      ...(previous !== undefined ? { previousMonth: previous.month } : {}),
      comparable: false,
      netSpending: NO_BASELINE,
      income: NO_BASELINE,
      netCashFlow: NO_BASELINE,
    };
  }

  return {
    currency,
    month: current.month,
    previousMonth: previous.month,
    comparable: true,
    netSpending: delta(previous.netSpending, current.netSpending),
    income: delta(previous.income, current.income),
    netCashFlow: delta(previous.netCashFlow, current.netCashFlow),
  };
}

/** One magnitude, before and after. Same currency by construction. */
function delta(before: Money, after: Money): MonthlyDelta {
  const beforeZero = isZero(before);
  const afterZero = isZero(after);

  if (beforeZero && afterZero) return { kind: 'both-zero' };
  if (beforeZero) return { kind: 'new', amount: after };
  if (afterZero) return { kind: 'gone', amount: before };

  const absolute = subtract(after, before);
  if (sign(before) !== sign(after)) {
    return { kind: 'sign-flip', before, after, absolute };
  }

  // Divided by the magnitude, not the signed value: from -40.000 to -60.000 the
  // outflow grew, and `(−60.000 − −40.000) / −40.000` would call that +50 %.
  return {
    kind: 'relative',
    before,
    after,
    absolute,
    ratio: (toNumber(after) - toNumber(before)) / Math.abs(toNumber(before)),
  };
}
