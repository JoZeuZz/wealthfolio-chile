import { describe, expect, it } from 'vitest';
import { compareMonths, type MonthlyDelta } from '../src/core/metrics/comparison';
import { summarizeMonth } from '../src/core/metrics/monthly';
import { money } from '../src/core/money';
import { Direction, TransactionKind } from '../src/core/model/kinds';
import { makeTransaction } from './fixtures';

/**
 * Comparing a month with the one before it.
 *
 * Every case here is a shape the arithmetic can take, not a scenario somebody
 * imagined: a zero base, a sign that flips, a currency that is not in both
 * months. The rule the whole file defends is that a comparison never invents a
 * number — when there is no honest percentage it says so instead.
 */

function summary(month: string, rows: ReturnType<typeof makeTransaction>[], currency = 'CLP') {
  return summarizeMonth(month, rows, { currency });
}

function spend(date: string, amount: number) {
  return makeTransaction({
    date,
    amount: -amount,
    kind: TransactionKind.expense,
    direction: Direction.out,
  });
}

function earn(date: string, amount: number) {
  return makeTransaction({
    date,
    amount,
    kind: TransactionKind.income,
    direction: Direction.in,
  });
}

describe('compareMonths', () => {
  it('sin mes anterior no hay base comparable', () => {
    const current = summary('2026-09', [spend('2026-09-03', 100_000)]);
    const comparison = compareMonths(current, undefined);

    expect(comparison.comparable).toBe(false);
    expect(comparison.netSpending).toEqual<MonthlyDelta>({ kind: 'no-baseline' });
    expect(comparison.income).toEqual<MonthlyDelta>({ kind: 'no-baseline' });
    expect(comparison.netCashFlow).toEqual<MonthlyDelta>({ kind: 'no-baseline' });
  });

  it('0 → 100 es nuevo este mes, no un porcentaje infinito', () => {
    const previous = summary('2026-08', []);
    const current = summary('2026-09', [spend('2026-09-03', 100_000)]);
    const comparison = compareMonths(current, previous);

    expect(comparison.comparable).toBe(true);
    expect(comparison.netSpending).toEqual<MonthlyDelta>({
      kind: 'new',
      amount: money(100_000, 0, 'CLP'),
    });
  });

  it('100 → 0 dice que el gasto desapareció', () => {
    const previous = summary('2026-08', [spend('2026-08-03', 100_000)]);
    const current = summary('2026-09', []);

    expect(compareMonths(current, previous).netSpending).toEqual<MonthlyDelta>({
      kind: 'gone',
      amount: money(100_000, 0, 'CLP'),
    });
  });

  it('0 → 0 no es una comparación que mostrar', () => {
    const previous = summary('2026-08', []);
    const current = summary('2026-09', [earn('2026-09-03', 500_000)]);

    expect(compareMonths(current, previous).netSpending).toEqual<MonthlyDelta>({
      kind: 'both-zero',
    });
  });

  it('100 → 200 sube el 100 %', () => {
    const previous = summary('2026-08', [spend('2026-08-03', 100_000)]);
    const current = summary('2026-09', [spend('2026-09-03', 200_000)]);
    const delta = compareMonths(current, previous).netSpending;

    expect(delta.kind).toBe('relative');
    if (delta.kind !== 'relative') throw new Error('unreachable');
    expect(delta.ratio).toBeCloseTo(1);
    expect(delta.absolute).toEqual(money(100_000, 0, 'CLP'));
  });

  it('200 → 100 baja el 50 %', () => {
    const previous = summary('2026-08', [spend('2026-08-03', 200_000)]);
    const current = summary('2026-09', [spend('2026-09-03', 100_000)]);
    const delta = compareMonths(current, previous).netSpending;

    if (delta.kind !== 'relative') throw new Error('esperaba un delta relativo');
    expect(delta.ratio).toBeCloseTo(-0.5);
    expect(delta.absolute).toEqual(money(-100_000, 0, 'CLP'));
  });

  it('un flujo que cruza de negativo a positivo no lleva porcentaje', () => {
    const previous = summary('2026-08', [earn('2026-08-01', 60_000), spend('2026-08-03', 100_000)]);
    const current = summary('2026-09', [earn('2026-09-01', 300_000), spend('2026-09-03', 120_000)]);
    const delta = compareMonths(current, previous).netCashFlow;

    expect(delta.kind).toBe('sign-flip');
    if (delta.kind !== 'sign-flip') throw new Error('unreachable');
    expect(delta.before).toEqual(money(-40_000, 0, 'CLP'));
    expect(delta.after).toEqual(money(180_000, 0, 'CLP'));
    expect(delta.absolute).toEqual(money(220_000, 0, 'CLP'));
  });

  it('y tampoco al revés', () => {
    const previous = summary('2026-08', [earn('2026-08-01', 300_000), spend('2026-08-03', 120_000)]);
    const current = summary('2026-09', [earn('2026-09-01', 60_000), spend('2026-09-03', 100_000)]);

    expect(compareMonths(current, previous).netCashFlow.kind).toBe('sign-flip');
  });

  it('un gasto neto negativo por devoluciones se compara como cualquier otro', () => {
    const refund = makeTransaction({
      date: '2026-09-05',
      amount: 150_000,
      kind: TransactionKind.refund,
      direction: Direction.in,
    });
    const previous = summary('2026-08', [spend('2026-08-03', 100_000)]);
    const current = summary('2026-09', [spend('2026-09-03', 50_000), refund]);
    const delta = compareMonths(current, previous).netSpending;

    expect(delta.kind).toBe('sign-flip');
  });

  it('nunca compara dos monedas distintas', () => {
    const previous = summarizeMonth('2026-08', [], { currency: 'USD' });
    const current = summary('2026-09', [spend('2026-09-03', 100_000)]);
    const comparison = compareMonths(current, previous);

    expect(comparison.comparable).toBe(false);
    expect(comparison.netSpending).toEqual<MonthlyDelta>({ kind: 'no-baseline' });
  });

  it('un mes anterior que no precede al actual no es una base', () => {
    const previous = summary('2026-10', [spend('2026-10-03', 100_000)]);
    const current = summary('2026-09', [spend('2026-09-03', 200_000)]);

    expect(compareMonths(current, previous).comparable).toBe(false);
  });

  it('nombra los dos meses que comparó', () => {
    const previous = summary('2026-08', [spend('2026-08-03', 100_000)]);
    const current = summary('2026-09', [spend('2026-09-03', 200_000)]);
    const comparison = compareMonths(current, previous);

    expect(comparison.month).toBe('2026-09');
    expect(comparison.previousMonth).toBe('2026-08');
    expect(comparison.currency).toBe('CLP');
  });

  it('permutar los movimientos no cambia la comparación', () => {
    const previousRows = [spend('2026-08-03', 100_000), earn('2026-08-01', 300_000)];
    const currentRows = [
      spend('2026-09-03', 50_000),
      earn('2026-09-01', 200_000),
      spend('2026-09-20', 70_000),
    ];
    const forward = compareMonths(
      summary('2026-09', currentRows),
      summary('2026-08', previousRows),
    );
    const reversed = compareMonths(
      summary('2026-09', [...currentRows].reverse()),
      summary('2026-08', [...previousRows].reverse()),
    );

    expect(reversed).toEqual(forward);
  });
});
