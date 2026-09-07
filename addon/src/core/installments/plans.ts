import { addMonths, addMonthsToKey, monthKey, type MonthKey } from '../dates';
import { hashFields } from '../hash';
import { abs, add, multiplyInt, zero, type Money } from '../money';
import { Confidence, TransactionKind } from '../model/kinds';
import type {
  InstallmentOutlook,
  InstallmentPlan,
  InstallmentSchedule,
} from '../model/installment';
import type { NormalizedTransaction } from '../model/transaction';
import { attributePayment } from '../merchants/attribution';

/**
 * Reconstruct installment plans from individual charges.
 *
 * Charges belonging to one plan share a merchant, a cuota total and (almost
 * always) an amount; they differ only in the cuota counter and the month. That
 * triple is the grouping key.
 *
 * Everything here is a projection, not a fact: the bank never told us the plan
 * exists. So a plan built from a single `suggested` charge stays `suggested`,
 * and a plan with gaps in its observed cuotas says so, because the user needs
 * to know when "committed for the next 3 months" is an estimate.
 */

export interface BuildPlansOptions {
  /** Ignore installment readings weaker than this. */
  minimumConfidence?: Confidence;
}

/** Group charges into plans. Input order does not affect the result. */
export function buildInstallmentPlans(
  transactions: readonly NormalizedTransaction[],
  options: BuildPlansOptions = {},
): InstallmentPlan[] {
  const minimum = options.minimumConfidence ?? Confidence.suggested;

  const groups = new Map<string, NormalizedTransaction[]>();

  for (const transaction of transactions) {
    if (transaction.kind !== TransactionKind.credit_card_purchase) continue;
    const installment = transaction.installment;
    if (!installment) continue;
    if (minimum === Confidence.confirmed && installment.confidence !== Confidence.confirmed) {
      continue;
    }

    // The same attribution the rest of the pipeline uses. The old fallback
    // fired exactly on the rows attribution had refused to name and handed back
    // the raw residue: the panel said "sin comercio" and the plan said
    // "4 Tcom" — and the group key was that invented name.
    const merchant =
      transaction.merchant ?? attributePayment(transaction.description).merchant?.name;
    if (!merchant) continue;

    const key = groupKey({
      merchant,
      institution: transaction.sourceInstitution,
      total: installment.total,
      amountBand: amountBand(abs(transaction.amount).minor),
      currency: transaction.amount.currency,
    });

    const bucket = groups.get(key);
    if (bucket) bucket.push(transaction);
    else groups.set(key, [transaction]);
  }

  const plans: InstallmentPlan[] = [];
  for (const [key, charges] of groups) {
    // The exact amount used to be part of the key, which split one plan in two
    // whenever the last cuota was uneven — 16.667 / 16.667 / 16.665, routine in
    // Chile because cuotas rarely divide evenly. Neither half had gaps, so
    // nothing flagged it, and the first went on claiming a cuota still owed on
    // a plan that was fully paid.
    //
    // What actually separates two plans at one merchant with the same length is
    // a repeated cuota number: one plan numbers each charge once.
    for (const [n, run] of splitOnRepeatedCounter(charges).entries()) {
      const plan = buildPlan(n === 0 ? key : `${key}-${n}`, run);
      if (plan) plans.push(plan);
    }
  }

  return plans.sort((a, b) => (a.startDate < b.startDate ? 1 : a.startDate > b.startDate ? -1 : a.id < b.id ? -1 : 1));
}

interface GroupKeyInput {
  merchant: string;
  institution: string;
  total: number;
  amountBand: number;
  currency: string;
}

function groupKey(input: GroupKeyInput): string {
  return hashFields([
    'installment-plan',
    input.institution,
    input.merchant.toUpperCase(),
    String(input.total),
    String(input.amountBand),
    input.currency,
  ]);
}

/**
 * Cuota amounts that belong to the same purchase, bucketed together.
 *
 * The exact amount used to be the key, which split one plan in two whenever the
 * last cuota was uneven — 16.667 / 16.667 / 16.665, routine because Chilean
 * cuotas rarely divide evenly. Removing it entirely went too far the other way:
 * two real plans at one merchant with the same length and different amounts,
 * overlapping in time, landed in one group, and splitting on a repeated counter
 * cut them in the wrong place — three plans out of two, the wrong cuota amount
 * on each, and `committedTotal` overstated.
 *
 * A band keeps both properties. Two cuotas of one plan differ by at most the
 * rounding remainder, far below one percent; two different purchases at the
 * same merchant essentially never land that close. Bucketing on a rounded
 * logarithm gives roughly ±1 % bands with no boundary a plan can straddle,
 * because every cuota of a plan rounds to the same bucket unless the plan
 * itself spans a boundary — which needs a spread the rounding cannot produce.
 */
function amountBand(minor: number): number {
  if (minor <= 0) return 0;
  return Math.round(Math.log(minor) * 100);
}

/**
 * Split charges that share a merchant and a plan length into separate plans.
 *
 * A plan numbers each of its charges once, so a cuota number appearing twice
 * means a second plan. Charges are walked in date order and a repeat opens a
 * new run — which keeps two real plans apart without letting a few pesos of
 * rounding pull one plan apart.
 */
function splitOnRepeatedCounter(charges: NormalizedTransaction[]): NormalizedTransaction[][] {
  const ordered = [...charges].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : a.fingerprint < b.fingerprint ? -1 : 1,
  );
  const runs: NormalizedTransaction[][] = [];
  let current: NormalizedTransaction[] = [];
  let seen = new Set<number>();

  for (const charge of ordered) {
    const counter = charge.installment?.current ?? 0;
    if (seen.has(counter)) {
      runs.push(current);
      current = [];
      seen = new Set<number>();
    }
    seen.add(counter);
    current.push(charge);
  }
  if (current.length > 0) runs.push(current);
  return runs;
}

function buildPlan(id: string, charges: NormalizedTransaction[]): InstallmentPlan | undefined {
  const sorted = [...charges].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : a.fingerprint < b.fingerprint ? -1 : 1,
  );
  const first = sorted[0];
  if (!first?.installment) return undefined;

  const total = first.installment.total;
  const installmentAmount = abs(first.amount);
  const observed = [...new Set(sorted.map((t) => t.installment?.current ?? 0))].sort(
    (a, b) => a - b,
  );
  const current = Math.max(...observed);
  const remainingInstallments = Math.max(0, total - current);

  // The first charge in the data is not necessarily cuota 1, so the plan's
  // start is back-dated from whichever cuota was actually seen first.
  const firstObserved = Math.min(...observed);
  const startDate = addMonths(first.date, -(firstObserved - 1));

  // A charge whose amount column the statement never labelled could be this
  // month's instalment or the whole purchase. Multiplying it by the plan length
  // to get the purchase back is only right under the first reading, and wrong
  // by a factor of the plan length under the second.
  const amountIsUncertain = sorted.some((t) =>
    t.warnings.some((warning) => warning.code === 'ambiguous-installment-amount'),
  );

  const confidence =
    !amountIsUncertain && sorted.some((t) => t.installment?.confidence === Confidence.confirmed)
      ? Confidence.confirmed
      : Confidence.suggested;

  const merchant =
    first.merchant ?? attributePayment(first.description).merchant?.name ?? 'Sin comercio';

  return {
    id,
    merchant,
    description: first.description,
    institution: first.sourceInstitution,
    ...(first.sourceAccountRef !== undefined
      ? { sourceAccountRef: first.sourceAccountRef }
      : {}),
    // Omitted rather than guessed when the charge amount's meaning is unknown.
    // `remainingAmount` below stays: what is left to pay is the charge repeated,
    // whatever the charge turns out to represent.
    ...(amountIsUncertain ? {} : { originalAmount: multiplyInt(installmentAmount, total) }),
    installmentAmount,
    totalInstallments: total,
    currentInstallment: current,
    remainingInstallments,
    remainingAmount: multiplyInt(installmentAmount, remainingInstallments),
    startDate,
    estimatedEndDate: addMonths(startDate, total - 1),
    sourceTransactionFingerprints: sorted.map((t) => t.fingerprint),
    observedInstallments: observed,
    hasGaps: observed.length !== current - firstObserved + 1,
    confidence,
  };
}

/**
 * Project the remaining cuotas month by month.
 *
 * `fromMonth` is normally the current month. Cuotas already charged are not
 * projected — the outlook answers "what is still coming", not "what happened".
 */
export function buildOutlook(
  plans: readonly InstallmentPlan[],
  fromMonth: MonthKey,
  horizonMonths = 12,
  currency = 'CLP',
): InstallmentOutlook {
  const openPlans = plans.filter((plan) => plan.remainingInstallments > 0);
  const closedPlans = plans.filter((plan) => plan.remainingInstallments === 0);

  const byMonth = new Map<MonthKey, { amount: Money; planIds: string[] }>();

  for (const plan of openPlans) {
    for (let i = 1; i <= plan.remainingInstallments; i += 1) {
      const chargeMonth = monthKey(addMonths(plan.startDate, plan.currentInstallment + i - 1));
      if (chargeMonth < fromMonth) continue;
      if (chargeMonth > addMonthsToKey(fromMonth, horizonMonths - 1)) continue;

      const entry = byMonth.get(chargeMonth);
      if (entry) {
        entry.amount = add(entry.amount, plan.installmentAmount);
        if (!entry.planIds.includes(plan.id)) entry.planIds.push(plan.id);
      } else {
        byMonth.set(chargeMonth, { amount: plan.installmentAmount, planIds: [plan.id] });
      }
    }
  }

  const schedule: InstallmentSchedule[] = [...byMonth.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([month, entry]) => ({ month, amount: entry.amount, planIds: entry.planIds }));

  const committedTotal = openPlans.reduce<Money>(
    (acc, plan) => add(acc, plan.remainingAmount),
    zero(currency),
  );

  return { committedTotal, schedule, openPlans, closedPlans };
}

/** Cuotas charged in a given month, across every plan. */
export function installmentsInMonth(
  plans: readonly InstallmentPlan[],
  month: MonthKey,
  currency = 'CLP',
): Money {
  let total = zero(currency);
  for (const plan of plans) {
    for (let i = 0; i < plan.totalInstallments; i += 1) {
      if (monthKey(addMonths(plan.startDate, i)) === month) {
        total = add(total, plan.installmentAmount);
        break;
      }
    }
  }
  return total;
}
