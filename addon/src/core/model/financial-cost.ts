import { TransactionKind } from './kinds';

/**
 * What kind of cost a charge is, when the charge is the price of the money
 * rather than something bought with it.
 *
 * `fee`, `interest` and `tax` already existed as transaction kinds, and they
 * were enough to keep the totals right. They were not enough to answer the
 * question a person actually asks when a card statement has six lines that are
 * not purchases: *what am I paying for?* A comisión de mantención and a
 * comisión por avance are both `fee`, arrive in the same month, and mean
 * opposite things — one is the price of having the card, the other is the price
 * of having borrowed cash with it.
 *
 * The vocabulary is not invented and not observed on a cartola. The CMF's
 * NCG 537 had to enumerate these categories to define the Monto No Financiable
 * of the minimum-payment formula, and the glosario of the reglamento de
 * información al consumidor defines each one:
 *
 *   interés adicional (rotativo), interés por mora, interés de cuotas,
 *   comisión de mantención/administración, comisión por compra internacional,
 *   comisión de avance, impuesto al crédito, gastos de cobranza.
 *
 * That is why this dimension can be modelled and tested before any real
 * statement exists: the words come from the regulator, not from a bank's file.
 *
 * Deliberately **not** here:
 *
 * - **Seguros.** The reglamento defines a premium charged to a card as an
 *   obligation the consumer takes on *voluntarily* for a product of their own
 *   (definición n°18). NCG 537 counts it inside the Monto No Financiable
 *   because that is a rule about how much has to be paid this month, not a
 *   claim that the premium is a cost of the credit. It is a service bought,
 *   so it stays ordinary spending.
 * - **Súper avance.** Searched for in every legal text of the CMF research and
 *   found in none: it is a commercial name, not a regulated category.
 * - **CAE, CAEP, CTC.** Rates the issuer computes and prints. The addon reads
 *   what a statement declares; it does not become a regulatory calculator.
 */
export const FinancialCostKind = {
  /** Interés adicional o rotativo: the price of not paying the full balance. */
  revolving_interest: 'revolving_interest',
  /** Interés por mora: the price of paying less than the minimum. */
  late_interest: 'late_interest',
  /** Interés pactado dentro de una compra en cuotas. */
  installment_interest: 'installment_interest',
  /** Comisión de mantención o administración: the price of holding the card. */
  maintenance: 'maintenance',
  /** Comisión por compra internacional o en moneda extranjera. */
  international_purchase: 'international_purchase',
  /** Comisión por avance en efectivo. Not the avance — its fee. */
  cash_advance_fee: 'cash_advance_fee',
  /** Gastos de cobranza: capped at 9% and only after 20 days late. */
  collection: 'collection',
  /** Impuesto al crédito — timbres y estampillas, DL 3.475. */
  credit_tax: 'credit_tax',
  /** A charge the glosa names as a cost without saying which one. */
  other: 'other',
} as const;

export type FinancialCostKind = (typeof FinancialCostKind)[keyof typeof FinancialCostKind];

export const FINANCIAL_COST_KINDS = Object.values(FinancialCostKind);

/**
 * The transaction kind a cost has to be, for the totals to stay right.
 *
 * The dimension refines a classification, it never replaces one: every value
 * here maps onto a kind the host can already express, so nothing in this model
 * needs an activity type Wealthfolio does not have.
 */
export function transactionKindForCost(cost: FinancialCostKind): TransactionKind {
  switch (cost) {
    case FinancialCostKind.revolving_interest:
    case FinancialCostKind.late_interest:
    case FinancialCostKind.installment_interest:
      return TransactionKind.interest;
    case FinancialCostKind.credit_tax:
      return TransactionKind.tax;
    default:
      return TransactionKind.fee;
  }
}

/**
 * Costs that exist only because there was debt.
 *
 * Maintenance is charged on a card with a zero balance; mora is not. Keeping
 * the two apart is what lets a panel answer "what did owing money cost me" —
 * the question the CMF's own minimum-payment reform is about — instead of
 * lumping it with the annual fee.
 */
export const COST_OF_BORROWING: ReadonlySet<FinancialCostKind> = new Set([
  FinancialCostKind.revolving_interest,
  FinancialCostKind.late_interest,
  FinancialCostKind.installment_interest,
  FinancialCostKind.cash_advance_fee,
  FinancialCostKind.collection,
  FinancialCostKind.credit_tax,
]);

export function isCostOfBorrowing(cost: FinancialCostKind): boolean {
  return COST_OF_BORROWING.has(cost);
}

/** How a cost is named on screen, in the wording the statement uses. */
export function financialCostLabel(cost: FinancialCostKind): string {
  switch (cost) {
    case FinancialCostKind.revolving_interest:
      return 'Interés rotativo';
    case FinancialCostKind.late_interest:
      return 'Interés por mora';
    case FinancialCostKind.installment_interest:
      return 'Interés de cuotas';
    case FinancialCostKind.maintenance:
      return 'Comisión de mantención';
    case FinancialCostKind.international_purchase:
      return 'Comisión por compra internacional';
    case FinancialCostKind.cash_advance_fee:
      return 'Comisión de avance';
    case FinancialCostKind.collection:
      return 'Gastos de cobranza';
    case FinancialCostKind.credit_tax:
      return 'Impuesto al crédito';
    case FinancialCostKind.other:
      return 'Otro costo financiero';
  }
}
