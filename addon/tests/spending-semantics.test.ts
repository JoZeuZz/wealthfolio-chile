import { describe, expect, it } from 'vitest';
import { summarizeMonth, totalsByCategory } from '../src/core/metrics/monthly';
import { TransactionKind } from '../src/core/model/kinds';
import { makeTransaction } from './fixtures';

/**
 * Flujo de caja y gasto no son la misma pregunta.
 *
 * Una compra de $100.000 con una devolución de $20.000 tiene dos lecturas
 * correctas y distintas:
 *
 *   caja   → entró 20.000, salió 100.000, neto −80.000
 *   gasto  → gasto bruto 100.000, devoluciones 20.000, gasto neto 80.000
 *
 * Hasta ahora la devolución se sumaba a `income` y la tasa de ahorro salía de
 * dividir por ella: con esos números daba −400 %. Presentar las dos cosas bajo
 * un mismo nombre no es un detalle de presentación, es un número falso.
 */

const compra = () =>
  makeTransaction({
    amount: -100000,
    date: '2026-02-10',
    description: 'COMPRA TIENDA',
    kind: TransactionKind.expense,
    category: 'compras',
  });

const devolucion = () =>
  makeTransaction({
    amount: 20000,
    date: '2026-02-12',
    description: 'DEVOLUCION TIENDA',
    kind: TransactionKind.refund,
    category: 'compras',
  });

const sueldo = () =>
  makeTransaction({
    amount: 900000,
    date: '2026-02-01',
    description: 'ABONO SUELDO',
    kind: TransactionKind.income,
    category: 'ingresos.sueldo',
  });

describe('compra con devolución', () => {
  const summary = () => summarizeMonth('2026-02', [compra(), devolucion()]);

  it('la vista de caja reporta entrada, salida y neto', () => {
    const s = summary();
    expect(s.cashInflows.minor).toBe(20000);
    expect(s.cashOutflows.minor).toBe(100000);
    expect(s.netCashFlow.minor).toBe(-80000);
  });

  it('la vista de gasto reporta bruto, devoluciones y neto', () => {
    const s = summary();
    expect(s.grossSpending.minor).toBe(100000);
    expect(s.refunds.minor).toBe(20000);
    expect(s.netSpending.minor).toBe(80000);
  });

  it('una devolución no es un ingreso', () => {
    // Es dinero que vuelve de un gasto propio, no dinero nuevo que entra al
    // hogar. Contarlo como ingreso infla los ingresos y rompe la tasa de ahorro.
    expect(summary().income.minor).toBe(0);
  });

  it('sin ingresos no se inventa una tasa de ahorro', () => {
    expect(summary().savingsRate).toBeUndefined();
  });
});

describe('tasa de ahorro', () => {
  it('se calcula sobre el gasto neto y los ingresos de verdad', () => {
    // 900.000 de ingreso, 80.000 de gasto neto ⇒ se ahorró el 91,1 %.
    const s = summarizeMonth('2026-02', [sueldo(), compra(), devolucion()]);
    expect(s.income.minor).toBe(900000);
    expect(s.netSpending.minor).toBe(80000);
    expect(s.savingsRate).toBeCloseTo((900000 - 80000) / 900000, 6);
  });
});

describe('invariantes de la vista de gasto', () => {
  it('fijo más variable es el gasto bruto', () => {
    const s = summarizeMonth('2026-02', [
      compra(),
      makeTransaction({
        amount: -45000,
        date: '2026-02-05',
        description: 'CUENTA LUZ',
        kind: TransactionKind.expense,
        category: 'servicios.electricidad',
      }),
      devolucion(),
    ]);

    expect(s.fixedExpenses.minor + s.variableExpenses.minor).toBe(s.grossSpending.minor);
  });

  it('el gasto neto es el bruto menos las devoluciones', () => {
    const s = summarizeMonth('2026-02', [compra(), devolucion()]);
    expect(s.netSpending.minor).toBe(s.grossSpending.minor - s.refunds.minor);
  });

  it('transferencias y pagos de tarjeta quedan fuera de las dos vistas', () => {
    const s = summarizeMonth('2026-02', [
      makeTransaction({
        amount: -200000,
        date: '2026-02-03',
        description: 'TRASPASO',
        kind: TransactionKind.internal_transfer,
      }),
      makeTransaction({
        amount: -120000,
        date: '2026-02-04',
        description: 'PAGO TARJETA',
        kind: TransactionKind.credit_card_payment,
      }),
    ]);

    expect(s.grossSpending.minor).toBe(0);
    expect(s.cashOutflows.minor).toBe(0);
    expect(s.internalTransfers.minor).toBe(200000);
    expect(s.cardPayments.minor).toBe(120000);
  });
});

describe('gasto por categoría', () => {
  it('reporta bruto, devoluciones y neto por categoría', () => {
    const totals = totalsByCategory([compra(), devolucion()]);
    const compras = totals.find((entry) => entry.category === 'compras');

    expect(compras?.gross.minor).toBe(100000);
    expect(compras?.refunds.minor).toBe(20000);
    expect(compras?.amount.minor).toBe(80000);
  });

  it('una devolución sin categoría no se atribuye a ninguna', () => {
    const sinCategoria = makeTransaction({
      amount: 20000,
      date: '2026-02-12',
      description: 'DEVOLUCION',
      kind: TransactionKind.refund,
    });

    const totals = totalsByCategory([compra(), sinCategoria]);
    const compras = totals.find((entry) => entry.category === 'compras');
    expect(compras?.refunds.minor).toBe(0);
    expect(compras?.amount.minor).toBe(100000);
  });

  it('una devolución mayor que el gasto del mes deja la categoría en negativo', () => {
    // No se recorta a cero: el mes realmente terminó con dinero de vuelta en esa
    // categoría, y esconderlo haría que las categorías no sumaran el total.
    const grande = makeTransaction({
      amount: 150000,
      date: '2026-02-12',
      description: 'DEVOLUCION GRANDE',
      kind: TransactionKind.refund,
      category: 'compras',
    });

    const totals = totalsByCategory([compra(), grande]);
    expect(totals.find((entry) => entry.category === 'compras')?.amount.minor).toBe(-50000);
  });
});
