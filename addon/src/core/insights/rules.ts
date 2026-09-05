import { addMonthsToKey, formatMonthKey, type MonthKey } from '../dates';
import { add, formatCLP, isZero, subtract, toNumber, type Money } from '../money';
import { categoryLabel } from '../categories/defaults';
import type { InstallmentOutlook } from '../model/installment';
import type { CategoryTotal, MerchantTotal, MonthlySummary } from '../metrics/monthly';
import type { RecurringCharge } from '../recurring/detect';

/**
 * Deterministic insights.
 *
 * Every sentence here is computed arithmetic with a fixed template. No model is
 * involved, and none will be until these numbers are trusted: a plausible-
 * sounding wrong number is worse than no sentence at all.
 *
 * Each insight carries the figures it was derived from so the UI can show the
 * user exactly where a claim came from.
 */

export type InsightSeverity = 'positive' | 'neutral' | 'attention';

export interface Insight {
  id: string;
  severity: InsightSeverity;
  /** One sentence, ready to render. */
  message: string;
  /** Supporting figures, shown on expand. */
  detail?: string;
}

export interface InsightInput {
  month: MonthKey;
  current: MonthlySummary;
  previous?: MonthlySummary;
  categories: CategoryTotal[];
  previousCategories?: CategoryTotal[];
  merchants: MerchantTotal[];
  recurring: RecurringCharge[];
  installments?: InstallmentOutlook;
}

/** Relative change below which a difference is treated as noise, not a trend. */
const SIGNIFICANT_CHANGE = 0.15;

/** Minimum absolute change worth mentioning, in currency units. */
const SIGNIFICANT_AMOUNT = 10_000;

export function buildInsights(input: InsightInput): Insight[] {
  const insights: Insight[] = [];

  insights.push(...cashFlowInsights(input));
  insights.push(...categoryInsights(input));
  insights.push(...installmentInsights(input));
  insights.push(...recurringInsights(input));
  insights.push(...merchantInsights(input));

  return insights;
}

function cashFlowInsights(input: InsightInput): Insight[] {
  const { current, previous } = input;
  const out: Insight[] = [];

  if (toNumber(current.netCashFlow) < 0) {
    out.push({
      id: 'net-negative',
      severity: 'attention',
      message: `En ${formatMonthKey(current.month)} gastaste ${formatCLP(subtract(current.netSpending, current.income))} más de lo que ingresó.`,
      detail: `Ingresos ${formatCLP(current.income)} · Egresos ${formatCLP(current.netSpending)}`,
    });
  } else if (current.savingsRate !== undefined && current.savingsRate >= 0.2) {
    out.push({
      id: 'net-healthy',
      severity: 'positive',
      message: `Ahorraste el ${formatPercent(current.savingsRate)} de tus ingresos en ${formatMonthKey(current.month)}.`,
      detail: `Flujo neto ${formatCLP(current.netCashFlow)}`,
    });
  }

  if (previous) {
    const change = relativeChange(previous.netSpending, current.netSpending);
    if (
      change !== undefined &&
      Math.abs(change) >= SIGNIFICANT_CHANGE &&
      Math.abs(toNumber(subtract(current.netSpending, previous.netSpending))) >= SIGNIFICANT_AMOUNT
    ) {
      out.push({
        id: 'expenses-change',
        severity: change > 0 ? 'attention' : 'positive',
        message:
          change > 0
            ? `Tus gastos subieron ${formatPercent(change)} respecto de ${formatMonthKey(previous.month)}.`
            : `Tus gastos bajaron ${formatPercent(Math.abs(change))} respecto de ${formatMonthKey(previous.month)}.`,
        detail: `${formatCLP(previous.netSpending)} → ${formatCLP(current.netSpending)}`,
      });
    }

    const netChange = relativeChange(previous.netCashFlow, current.netCashFlow);
    if (netChange !== undefined && toNumber(current.netCashFlow) < toNumber(previous.netCashFlow) && Math.abs(netChange) >= SIGNIFICANT_CHANGE) {
      out.push({
        id: 'net-declining',
        severity: 'attention',
        message: `Tu flujo neto mensual cayó respecto de ${formatMonthKey(previous.month)}.`,
        detail: `${formatCLP(previous.netCashFlow)} → ${formatCLP(current.netCashFlow)}`,
      });
    }
  }

  const fixedShare = toNumber(current.income) > 0
    ? toNumber(current.fixedExpenses) / toNumber(current.income)
    : undefined;
  if (fixedShare !== undefined && fixedShare >= 0.5) {
    out.push({
      id: 'fixed-share-high',
      severity: 'attention',
      message: `El ${formatPercent(fixedShare)} de tus ingresos se va en gastos fijos.`,
      detail: `Gastos fijos ${formatCLP(current.fixedExpenses)} sobre ingresos ${formatCLP(current.income)}`,
    });
  }

  return out;
}

function categoryInsights(input: InsightInput): Insight[] {
  const { categories, previousCategories } = input;
  if (!previousCategories || previousCategories.length === 0) return [];

  const previousByCategory = new Map(previousCategories.map((c) => [c.category, c]));
  const out: Insight[] = [];

  for (const category of categories.slice(0, 8)) {
    const before = previousByCategory.get(category.category);
    if (!before) continue;
    const change = relativeChange(before.amount, category.amount);
    if (change === undefined || Math.abs(change) < SIGNIFICANT_CHANGE) continue;
    const delta = subtract(category.amount, before.amount);
    if (Math.abs(toNumber(delta)) < SIGNIFICANT_AMOUNT) continue;

    out.push({
      id: `category-change:${category.category}`,
      severity: change > 0 ? 'attention' : 'positive',
      message:
        change > 0
          ? `Tu gasto en ${categoryLabel(category.category)} aumentó ${formatPercent(change)}.`
          : `Tu gasto en ${categoryLabel(category.category)} bajó ${formatPercent(Math.abs(change))}.`,
      detail: `${formatCLP(before.amount)} → ${formatCLP(category.amount)}`,
    });

    if (out.length >= 4) break;
  }

  return out;
}

function installmentInsights(input: InsightInput): Insight[] {
  const outlook = input.installments;
  if (!outlook || outlook.openPlans.length === 0) return [];

  const out: Insight[] = [];

  const nextThree = outlook.schedule.filter(
    (entry) => entry.month <= addMonthsToKey(input.month, 2),
  );
  const nextThreeTotal = nextThree.reduce<Money | undefined>(
    (acc, entry) => (acc ? add(acc, entry.amount) : entry.amount),
    undefined,
  );

  if (nextThreeTotal && !isZero(nextThreeTotal)) {
    out.push({
      id: 'installments-next-three',
      severity: 'neutral',
      message: `Tienes ${formatCLP(nextThreeTotal)} comprometidos en cuotas para los próximos 3 meses.`,
      detail: `${outlook.openPlans.length} compra(s) en cuotas activas · total pendiente ${formatCLP(outlook.committedTotal)}`,
    });
  }

  const thisMonth = outlook.schedule.find((entry) => entry.month === input.month);
  if (thisMonth) {
    out.push({
      id: 'installments-this-month',
      severity: 'neutral',
      message: `Este mes pagas ${formatCLP(thisMonth.amount)} en cuotas.`,
      detail: `${thisMonth.planIds.length} plan(es) de cuotas con cargo en ${formatMonthKey(input.month)}`,
    });
  }

  const uncertain = outlook.openPlans.filter((plan) => plan.confidence !== 'confirmed' || plan.hasGaps);
  if (uncertain.length > 0) {
    out.push({
      id: 'installments-uncertain',
      severity: 'attention',
      message: `${uncertain.length} plan(es) de cuotas son estimados y conviene revisarlos.`,
      detail:
        'Se dedujeron desde la glosa o faltan meses en los datos importados, así que el monto comprometido puede estar incompleto.',
    });
  }

  return out;
}

/**
 * What repeats, and what the bank itself said repeats.
 *
 * Two sentences rather than one, because the evidence behind them is not the
 * same kind. The first counts patterns the arithmetic found; the second counts
 * standing mandates the bank printed in the glosa, which is a fact about the
 * account rather than an inference about it — and the one thing on this panel a
 * generic tool has no way to know.
 */
function recurringInsights(input: InsightInput): Insight[] {
  const currency = input.current.netSpending.currency;
  // Never total across currencies: the panel builds one of these per currency,
  // and a charge from another one would be a rate nobody has.
  const recurring = input.recurring.filter((charge) => charge.currency === currency);
  if (recurring.length === 0) return [];

  const likely = recurring.filter((charge) => charge.confidence === 'likely');
  const monthly = likely.reduce<Money | undefined>(
    (acc, charge) => (acc ? add(acc, charge.typicalAmount) : charge.typicalAmount),
    undefined,
  );

  const insights: Insight[] = [];

  if (likely.length > 0) {
    insights.push({
      id: 'recurring-count',
      severity: 'neutral',
      message: `Tienes ${likely.length} gasto(s) que se repiten cada mes${monthly ? `, unos ${formatCLP(monthly)}` : ''}.`,
      // No enumeration: the panel lists merchant, amount and evidence for each
      // charge in the card directly above this one, and printing the same five
      // rows again in prose said nothing new twice.
    });
  }

  // The weaker tier is no longer announced here. The panel groups those charges
  // under their own heading, with the rows underneath, so a sentence counting
  // them was the same claim in a second place — and the two could disagree if
  // the card ever truncated its list.

  const mandated = recurring.filter((charge) => charge.mandate !== undefined);
  if (mandated.length > 0) {
    insights.push({
      id: 'recurring-mandates',
      severity: 'neutral',
      message: `${mandated.length} de ellos son pagos automáticos declarados por tu banco (PAC/PAT).`,
      // The card above marks each one with its mandate; repeating the list here
      // was the same sentence in another shape.
    });
  }

  return insights;
}

function merchantInsights(input: InsightInput): Insight[] {
  const top = input.merchants[0];
  if (!top || input.merchants.length < 3) return [];
  const share = toNumber(input.current.netSpending) > 0
    ? toNumber(top.amount) / toNumber(input.current.netSpending)
    : 0;
  if (share < 0.2) return [];

  return [
    {
      id: 'merchant-concentration',
      severity: 'neutral',
      message: `${top.merchant} concentra el ${formatPercent(share)} de tus gastos del mes.`,
      detail: `${formatCLP(top.amount)} en ${top.transactionCount} movimiento(s)`,
    },
  ];
}

/**
 * Relative change from `before` to `after`.
 *
 * Undefined when `before` is zero: "infinite growth" is not a useful thing to
 * tell someone, and dividing by zero would produce exactly that.
 */
function relativeChange(before: Money, after: Money): number | undefined {
  const base = toNumber(before);
  if (base === 0) return undefined;
  return (toNumber(after) - base) / Math.abs(base);
}

function formatPercent(value: number): string {
  return `${Math.round(Math.abs(value) * 100)}%`;
}
