import type { IsoDate, MonthKey } from '../dates';
import type { Money } from '../money';
import type { Confidence } from './kinds';

/**
 * A "compra en cuotas" reconstructed from the individual charges.
 *
 * Chilean card statements do not publish the plan; they publish one charge per
 * month carrying a `CUOTA 2 DE 6` marker. The engine groups those charges back
 * into the plan the user actually signed up for, which is what makes
 * "how much do I owe for the next months" answerable.
 */
export interface InstallmentPlan {
  /** Stable id derived from merchant + total count + first charge. */
  id: string;
  merchant: string;
  /** Description of the charge the plan was recognised from. */
  description: string;
  institution: string;
  /** Account/card the plan is charged to. */
  sourceAccountRef?: string;

  /** Full purchase amount, when it can be derived (`installmentAmount × total`). */
  originalAmount?: Money;
  /** Amount of a single cuota. */
  installmentAmount: Money;

  totalInstallments: number;
  /** Highest installment number actually seen in the data. */
  currentInstallment: number;
  /** `totalInstallments - currentInstallment`, floored at 0. */
  remainingInstallments: number;
  /** `installmentAmount × remainingInstallments`. */
  remainingAmount: Money;

  /** Date of the first observed charge. */
  startDate: IsoDate;
  /** Projected date of the final charge, assuming monthly cadence. */
  estimatedEndDate: IsoDate;

  /** Fingerprints of the charges that make up the plan. */
  sourceTransactionFingerprints: string[];
  /** Installment numbers seen; gaps mean months are missing from the import. */
  observedInstallments: number[];
  /** True when `observedInstallments` has holes — the projection is partial. */
  hasGaps: boolean;

  confidence: Confidence;
}

/** Projected installment load for one future month. */
export interface InstallmentSchedule {
  month: MonthKey;
  /** Sum of the cuotas falling in that month. */
  amount: Money;
  /** Plans contributing to the month. */
  planIds: string[];
}

/** Aggregate view backing the "cuotas" panel of the dashboard. */
export interface InstallmentOutlook {
  /** Total still owed across every open plan. */
  committedTotal: Money;
  /** Month-by-month projection, starting at the current month. */
  schedule: InstallmentSchedule[];
  /** Plans with at least one remaining installment. */
  openPlans: InstallmentPlan[];
  /** Plans whose last installment has already been charged. */
  closedPlans: InstallmentPlan[];
}
