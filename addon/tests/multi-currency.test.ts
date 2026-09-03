import { describe, expect, it } from 'vitest';
import { money } from '../src/core/money';
import { currenciesOf, summarizeByCurrency } from '../src/core/metrics/monthly';
import { TransactionKind } from '../src/core/model/kinds';
import { makeTransaction } from './fixtures';

/**
 * Más de una moneda.
 *
 * Sumar CLP con USD sin tipo de cambio da un número inventado, así que
 * `summarizeMonth` se niega. Pero negarse dejaba el panel entero en un mensaje
 * de error: quien tiene una cuenta en dólares no veía tampoco sus totales en
 * pesos. Separar por moneda dice la verdad y además la dice completa.
 *
 * `ExchangeRatesAPI` del SDK 3.7.0 expone `getAll`, `update` y `add`: tipos
 * vigentes, no históricos. Convertir un movimiento de hace ocho meses con el
 * tipo de hoy sería otro número inventado, sólo que más difícil de detectar.
 */

const clp = (amount: number, date: string) =>
  makeTransaction({ amount, date, description: 'MOVIMIENTO CLP' });

const usd = (amount: number, date: string) => ({
  ...makeTransaction({ amount, date, description: 'MOVIMIENTO USD' }),
  amount: money(amount, 2, 'USD'),
});

describe('currenciesOf', () => {
  it('lista las monedas presentes, en orden estable', () => {
    expect(currenciesOf([usd(-1000, '2026-02-03'), clp(-50000, '2026-02-04')])).toEqual([
      'CLP',
      'USD',
    ]);
  });

  it('no inventa ninguna cuando no hay movimientos', () => {
    expect(currenciesOf([])).toEqual([]);
  });
});

describe('summarizeByCurrency', () => {
  const rows = [
    clp(-50000, '2026-02-04'),
    clp(900000, '2026-02-01'),
    usd(-1000, '2026-02-03'),
  ];

  it('devuelve un resumen por moneda, nunca uno mezclado', () => {
    const summaries = summarizeByCurrency('2026-02', rows);
    expect(summaries.map((s) => s.currency)).toEqual(['CLP', 'USD']);
  });

  it('cada resumen contiene sólo los movimientos de su moneda', () => {
    const [clpSummary, usdSummary] = summarizeByCurrency('2026-02', rows);
    expect(clpSummary?.summary.grossSpending).toEqual(money(50000, 0, 'CLP'));
    expect(usdSummary?.summary.grossSpending).toEqual(money(1000, 2, 'USD'));
  });

  it('ordena por cantidad de movimientos, de mayor a menor', () => {
    const summaries = summarizeByCurrency('2026-02', rows);
    expect(summaries[0]?.transactions).toHaveLength(2);
    expect(summaries[1]?.transactions).toHaveLength(1);
  });

  it('con una sola moneda devuelve exactamente un resumen', () => {
    const summaries = summarizeByCurrency('2026-02', [clp(-50000, '2026-02-04')]);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.currency).toBe('CLP');
  });

  it('sin movimientos devuelve la moneda de respaldo y totales en cero', () => {
    const summaries = summarizeByCurrency('2026-02', [], { fallbackCurrency: 'CLP' });
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.summary.grossSpending.minor).toBe(0);
  });

  it('nunca suma monedas distintas', () => {
    const summaries = summarizeByCurrency('2026-02', rows);
    for (const entry of summaries) {
      expect(entry.summary.grossSpending.currency).toBe(entry.currency);
      expect(entry.summary.income.currency).toBe(entry.currency);
    }
  });

  it('las devoluciones se agrupan con su propia moneda', () => {
    const summaries = summarizeByCurrency('2026-02', [
      clp(-100000, '2026-02-10'),
      { ...clp(20000, '2026-02-11'), kind: TransactionKind.refund },
      usd(-1000, '2026-02-12'),
    ]);
    const clpSummary = summaries.find((s) => s.currency === 'CLP');
    expect(clpSummary?.summary.refunds.minor).toBe(20000);
    expect(summaries.find((s) => s.currency === 'USD')?.summary.refunds.minor).toBe(0);
  });
});
