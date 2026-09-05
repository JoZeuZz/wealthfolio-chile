import { describe, expect, it } from 'vitest';
import { buildInsights } from '../src/core/insights/rules';
import {
  summarizeMonth,
  totalsByCategory,
  totalsByMerchant,
  unattributedSpending,
} from '../src/core/metrics/monthly';
import { toDecimalString } from '../src/core/money';
import { makeTransaction } from './fixtures';

/**
 * Un movimiento sin comercio no es un comercio.
 *
 * El ranking agrupaba bajo la etiqueta «Sin comercio» todo lo que no había
 * podido atribuir, y esa etiqueta competía por el primer puesto con comercios
 * reales. Dos gastos que no tienen nada que ver quedaban fusionados en una
 * sola fila, y el insight de concentración leía esa fila como si fuera un
 * comercio: «un solo comercio se llevó el 30 % de tu gasto» era falso.
 *
 * Es la misma exclusión que la detección de recurrencia ya aplica a las
 * claves genéricas (`core/recurring/detect.ts`): sin clave estable no hay
 * grupo. El dinero no desaparece — se informa aparte, con su propio nombre.
 */

function spend(description: string, amount: number, merchant?: string) {
  return makeTransaction({
    description,
    amount: -amount,
    date: '2026-08-10',
    ...(merchant ? { merchant } : {}),
  });
}

describe('comercios y movimientos sin comercio', () => {
  it('no rankea como comercio lo que no tiene comercio', () => {
    const totals = totalsByMerchant([
      spend('GIRO CAJERO AUTOMATICO', 90_000),
      spend('CARGO NO IDENTIFICADO', 60_000),
      spend('SUPERMERCADO LIDER', 45_000, 'Lider'),
    ]);

    expect(totals.map((t) => t.merchant)).toEqual(['Lider']);
  });

  it('no fusiona dos gastos ajenos en una sola fila', () => {
    const totals = totalsByMerchant([
      spend('GIRO CAJERO AUTOMATICO', 90_000),
      spend('CARGO NO IDENTIFICADO', 60_000),
    ]);

    expect(totals).toEqual([]);
  });

  it('informa aparte cuánto quedó sin atribuir', () => {
    const rest = unattributedSpending([
      spend('GIRO CAJERO AUTOMATICO', 90_000),
      spend('CARGO NO IDENTIFICADO', 60_000),
      spend('SUPERMERCADO LIDER', 45_000, 'Lider'),
    ]);

    expect(toDecimalString(rest.amount)).toBe('150000');
    expect(rest.transactionCount).toBe(2);
  });

  it('sin movimientos sin comercio el resto es cero', () => {
    const rest = unattributedSpending([spend('SUPERMERCADO LIDER', 45_000, 'Lider')]);

    expect(rest.amount.minor).toBe(0);
    expect(rest.transactionCount).toBe(0);
  });

  it('la concentración de gasto ya no la puede declarar un movimiento sin comercio', () => {
    const transactions = [
      spend('GIRO CAJERO AUTOMATICO', 500_000),
      spend('SUPERMERCADO LIDER', 30_000, 'Lider'),
      spend('FARMACIA CRUZ VERDE', 20_000, 'Cruz Verde'),
      spend('BENCINERA COPEC', 10_000, 'Copec'),
    ];
    const summary = summarizeMonth('2026-08', transactions);

    const insights = buildInsights({
      month: '2026-08',
      current: summary,
      categories: totalsByCategory(transactions),
      merchants: totalsByMerchant(transactions),
      recurring: [],
    });

    // Antes, el giro de $500.000 se llevaba el primer puesto del ranking y el
    // insight lo anunciaba: «Sin comercio concentra el 89% de tus gastos».
    expect(insights.map((i) => i.message).join(' ')).not.toMatch(/Sin comercio/);
  });
});
