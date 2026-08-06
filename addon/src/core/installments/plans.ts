import { addMonths, addMonthsToKey, monthKey, type MonthKey } from '../dates';
import { hashFields } from '../hash';
import { abs, add, multiplyInt, zero, type Money } from '../money';
import { Confidence } from '../model/kinds';
import type {
  InstallmentOutlook,
  InstallmentPlan,
  InstallmentSchedule,
} from '../model/installment';
import type { NormalizedTransaction } from '../model/transaction';
import { normalizeMerchant } from '../merchants/normalize';

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
    const installment = transaction.installment;
    if (!installment) continue;
    if (minimum === Confidence.confirmed && installment.confidence !== Confidence.confirmed) {
      continue;
    }

    const merchant = transaction.merchant ?? normalizeMerchant(transaction.description).merchant;
    if (!merchant) continue;

    const key = groupKey({
      merchant,
      institution: transaction.sourceInstitution,
      total: installment.total,
      amountMinor: abs(transaction.amount).minor,
      scale: transaction.amount.scale,
      currency: transaction.amount.currency,
    });

    const bucket = groups.get(key);
    if (bucket) bucket.push(transaction);
    else groups.set(key, [transaction]);
  }

  const plans: InstallmentPlan[] = [];
  for (const [key, charges] of groups) {
    const plan = buildPlan(key, charges);
    if (plan) plans.push(plan);
  }

  return plans.sort((a, b) => (a.startDate < b.startDate ? 1 : a.startDate > b.startDate ? -1 : a.id < b.id ? -1 : 1));
}

interface GroupKeyInput {
  merchant: string;
  institution: string;
  total: number;
  amountMinor: number;
  scale: number;
  currency: string;
}

function groupKey(input: GroupKeyInput): string {
  return hashFields([
    'installment-plan',
    input.institution,
    input.merchant.toUpperCase(),
    String(input.total),
    String(input.amountMinor),
    String(input.scale),
    input.currency,
  ]);
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

  const confidence = sorted.some((t) => t.installment?.confidence === Confidence.confirmed)
    ? Confidence.confirmed
    : Confidence.suggested;

  const merchant = first.merchant ?? normalizeMerchant(first.description).merchant ?? 'Sin comercio';

  return {
    id,
    merchant,
    description: first.description,
    institution: first.sourceInstitution,
    ...(first.sourceAccountRef !== undefined
      ? { sourceAccountRef: first.sourceAccountRef }
      : {}),
    originalAmount: multiplyInt(installmentAmount, total),
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
