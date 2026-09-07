import { describe, expect, it } from 'vitest';
import { financialCostBreakdown, summarizeMonth } from '../src/core/metrics/monthly';
import { FinancialCostKind } from '../src/core/model/financial-cost';
import { Confidence, TransactionKind } from '../src/core/model/kinds';
import type { NormalizedTransaction } from '../src/core/model/transaction';
import { makeTransaction } from './fixtures';

function cost(
  kind: FinancialCostKind,
  amount: number,
  transactionKind: TransactionKind,
): NormalizedTransaction {
  return makeTransaction({
    amount: -amount,
    date: '2026-09-10',
    description: 'CARGO',
    kind: transactionKind,
    kindConfidence: Confidence.confirmed,
    financialCost: { kind, confidence: Confidence.confirmed, matchedText: 'CARGO' },
  });
}

const MONTH = [
  makeTransaction({ amount: -45000, date: '2026-09-02', description: 'SUPERMERCADO' }),
  cost(FinancialCostKind.late_interest, 12400, TransactionKind.interest),
  cost(FinancialCostKind.revolving_interest, 8000, TransactionKind.interest),
  cost(FinancialCostKind.maintenance, 5900, TransactionKind.fee),
  cost(FinancialCostKind.credit_tax, 1200, TransactionKind.tax),
  makeTransaction({
    amount: -200000,
    date: '2026-09-03',
    description: 'AVANCE EN EFECTIVO',
    kind: TransactionKind.cash_advance,
    kindConfidence: Confidence.confirmed,
  }),
];

/**
 * El desglose es una vista *del* gasto, no un gasto aparte.
 *
 * Cada peso que aparece aquí ya está dentro de `grossSpending`: la dimensión
 * dice de qué clase es el gasto, no agrega gasto. Si alguna vez el desglose
 * superara el gasto bruto del mes, el panel estaría contando algo dos veces.
 */
describe('el desglose de costos financieros del mes', () => {
  it('mide consumo por las filas que son compras, no restando otros totales', () => {
    const summary = summarizeMonth('2026-09', MONTH, { currency: 'CLP' });
    expect(summary.consumptionSpending.minor).toBe(45_000);
    expect(summary.grossSpending.minor).toBe(45_000 + 12_400 + 8_000 + 5_900 + 1_200 + 200_000);
  });

  it('consumo, costos y principal no se cuentan dos veces en un mes completamente clasificado', () => {
    const summary = summarizeMonth('2026-09', MONTH, { currency: 'CLP' });
    const costs = financialCostBreakdown(MONTH, { currency: 'CLP' });
    expect(summary.consumptionSpending.minor + costs.total.minor + costs.cashAdvances.minor).toBe(
      summary.grossSpending.minor,
    );
    expect(costs.items.reduce((sum, item) => sum + item.amount.minor, 0)).toBe(
      costs.total.minor,
    );
  });

  it('una comisión sugerida no se convierte en consumo por seguir bajo tipo compra', () => {
    const ambiguousCommission = makeTransaction({
      amount: -9_000,
      date: '2026-09-21',
      description: 'COMISION',
      kind: TransactionKind.credit_card_purchase,
      kindConfidence: Confidence.suggested,
      financialCost: {
        kind: FinancialCostKind.other,
        confidence: Confidence.suggested,
        matchedText: 'COMISION',
      },
    });
    const summary = summarizeMonth('2026-09', [ambiguousCommission], { currency: 'CLP' });
    expect(summary.consumptionSpending.minor).toBe(0);
  });

  it('nunca supera el gasto bruto del mes', () => {
    const { grossSpending } = summarizeMonth('2026-09', MONTH, { currency: 'CLP' });
    const breakdown = financialCostBreakdown(MONTH, { currency: 'CLP' });
    expect(breakdown.total.minor).toBeLessThanOrEqual(grossSpending.minor);
  });

  it('suma sólo las líneas que nombran un costo', () => {
    const breakdown = financialCostBreakdown(MONTH, { currency: 'CLP' });
    expect(breakdown.total.minor).toBe(12400 + 8000 + 5900 + 1200);
  });

  it('separa lo que costó deber de lo que cuesta tener la tarjeta', () => {
    const breakdown = financialCostBreakdown(MONTH, { currency: 'CLP' });
    expect(breakdown.borrowing.minor).toBe(12400 + 8000 + 1200);
    expect(breakdown.instrument.minor).toBe(5900);
  });

  it('lista los costos de mayor a menor', () => {
    const { items } = financialCostBreakdown(MONTH, { currency: 'CLP' });
    expect(items.map((item) => item.kind)).toEqual([
      FinancialCostKind.late_interest,
      FinancialCostKind.revolving_interest,
      FinancialCostKind.maintenance,
      FinancialCostKind.credit_tax,
    ]);
  });

  /**
   * El avance no es un costo: es la deuda misma. Se informa al lado porque es
   * la línea que explica por qué hubo interés, y se cuenta aparte porque
   * sumarlo a los costos diría que retirar $200.000 costó $200.000.
   */
  it('el avance se informa aparte, no como costo', () => {
    const breakdown = financialCostBreakdown(MONTH, { currency: 'CLP' });
    expect(breakdown.cashAdvances.minor).toBe(200000);
    expect(breakdown.cashAdvanceCount).toBe(1);
    expect(breakdown.total.minor).not.toBe(12400 + 8000 + 5900 + 1200 + 200000);
  });

  it('un mes sin costos devuelve cero y ninguna línea', () => {
    const breakdown = financialCostBreakdown(
      [makeTransaction({ amount: -45000, date: '2026-09-02', description: 'SUPERMERCADO' })],
      { currency: 'CLP' },
    );
    expect(breakdown.total.minor).toBe(0);
    expect(breakdown.items).toEqual([]);
    expect(breakdown.cashAdvances.minor).toBe(0);
  });

  /**
   * Una devolución de comisión mal cobrada lleva la misma dimensión y devuelve
   * plata. Contarla como costo diría que le cobraron dos veces.
   */
  it('no cuenta un abono como costo', () => {
    const refund = makeTransaction({
      amount: 5900,
      date: '2026-09-20',
      description: 'DEVOLUCION COMISION',
      kind: TransactionKind.refund,
      financialCost: {
        kind: FinancialCostKind.maintenance,
        confidence: Confidence.confirmed,
        matchedText: 'COMISION',
      },
    });
    const breakdown = financialCostBreakdown([...MONTH, refund], { currency: 'CLP' });
    expect(breakdown.total.minor).toBe(12400 + 8000 + 5900 + 1200);
  });
});
