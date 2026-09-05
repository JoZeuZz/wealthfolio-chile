import { describe, expect, it } from 'vitest';
import { attributePayment } from '../src/core/merchants/attribution';
import { unattributedByProcessor } from '../src/core/metrics/monthly';
import type { NormalizedTransaction } from '../src/core/model/transaction';
import { makeTransaction } from './fixtures';

function spend(description: string, amount: number): NormalizedTransaction {
  const attribution = attributePayment(description);
  return makeTransaction({
    description,
    amount: -amount,
    date: '2026-09-10',
    attribution,
    ...(attribution.merchant ? { merchant: attribution.merchant.name } : {}),
  });
}

/**
 * Qué explica el gasto sin comercio.
 *
 * El panel ya informaba cuánto quedó sin atribuir, y eso era mejor que
 * mezclarlo con comercios reales. Pero no decía por qué, y las razones no son
 * intercambiables: un cargo que pasó por Mercado Pago no es un misterio — es un
 * medio de pago que, por diseño, no informa a quién le pagaste, y eso es
 * accionable (pagar directo, o mirar la app del procesador). Un cargo que el
 * banco rotuló `PAGO ONLINE` es el banco diciendo que tampoco lo sabe.
 */
describe('por qué un gasto quedó sin comercio', () => {
  it('atribuye lo no identificado al procesador que lo ocultó', () => {
    const groups = unattributedByProcessor(
      [
        spend('MERCADO PAGO 4 TCOM', 30_000),
        spend('MERCADO PAGO', 12_000),
        spend('FLOW', 8_000),
        spend('SUPERMERCADO LIDER', 45_000),
      ],
    );

    expect(groups.map((g) => g.processor)).toEqual(['Mercado Pago', 'Flow']);
    expect(groups[0]?.amount.minor).toBe(42_000);
    expect(groups[0]?.transactionCount).toBe(2);
  });

  it('un gasto con comercio no aparece aunque haya pasado por un procesador', () => {
    const groups = unattributedByProcessor([spend('COMPRA WEBPAY PARIS CL', 29_990)]);
    expect(groups).toEqual([]);
  });

  /**
   * Sin procesador reconocido no hay a quién atribuirlo. El monto sigue
   * contándose en `unattributedSpending`, que es el total; esto es sólo la
   * parte que tiene explicación.
   */
  it('no inventa un grupo para lo que no tiene procesador', () => {
    const groups = unattributedByProcessor([spend('CARGO NO IDENTIFICADO', 5_000)]);
    expect(groups).toEqual([]);
  });

  it('ordena por monto, de mayor a menor', () => {
    const groups = unattributedByProcessor([spend('FLOW', 90_000), spend('MERCADO PAGO', 10_000)]);
    expect(groups.map((g) => g.processor)).toEqual(['Flow', 'Mercado Pago']);
  });
});
