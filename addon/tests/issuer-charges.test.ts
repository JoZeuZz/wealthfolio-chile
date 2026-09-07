import { describe, expect, it } from 'vitest';
import { attributePayment } from '../src/core/merchants/attribution';
import {
  financialCostBreakdown,
  issuerCharges,
  summarizeMonth,
  totalsByMerchant,
  unattributedSpending,
} from '../src/core/metrics/monthly';
import { FinancialCostKind } from '../src/core/model/financial-cost';
import { Confidence, TransactionKind } from '../src/core/model/kinds';
import type { NormalizedTransaction } from '../src/core/model/transaction';
import { makeTransaction } from './fixtures';

function row(
  description: string,
  amount: number,
  overrides: Partial<Omit<NormalizedTransaction, 'amount'>> = {},
): NormalizedTransaction {
  const attribution = attributePayment(description);
  return makeTransaction({
    description,
    amount: -amount,
    date: '2026-09-10',
    attribution,
    ...(attribution.merchant ? { merchant: attribution.merchant.name } : {}),
    ...overrides,
  });
}

const MONTH = [
  row('SUPERMERCADO GENERICO SUCURSAL CENTRO', 45_000),
  row('INTERES POR MORA', 12_400, {
    kind: TransactionKind.interest,
    kindConfidence: Confidence.confirmed,
    financialCost: {
      kind: FinancialCostKind.late_interest,
      confidence: Confidence.confirmed,
      matchedText: 'INTERES POR MORA',
    },
  }),
  row('GASTOS DE COBRANZA', 9_900, {
    kind: TransactionKind.fee,
    kindConfidence: Confidence.confirmed,
    financialCost: {
      kind: FinancialCostKind.collection,
      confidence: Confidence.confirmed,
      matchedText: 'GASTOS DE COBRANZA',
    },
  }),
  row('IMPUESTO AL CREDITO', 1_200, {
    kind: TransactionKind.tax,
    kindConfidence: Confidence.confirmed,
    financialCost: {
      kind: FinancialCostKind.credit_tax,
      confidence: Confidence.confirmed,
      matchedText: 'IMPUESTO AL CREDITO',
    },
  }),
  row('AVANCE EN EFECTIVO', 200_000, {
    kind: TransactionKind.cash_advance,
    kindConfidence: Confidence.confirmed,
  }),
];

/**
 * Un cobro del emisor no es un comercio.
 *
 * Visto en el host real: «Interes POR Mora», «Gastos de Cobranza» y «Comision
 * POR Avance en Efectivo» aparecían en «Comercios principales», entre el
 * supermercado y la bencina, porque el nombre se lee del texto de la glosa y la
 * glosa de un cargo del banco también tiene texto. Nadie le pagó a un comercio
 * llamado Interés por Mora: ese dinero se lo quedó el emisor, y ya tiene su
 * lugar propio en el desglose de costos financieros.
 */
describe('el ranking de comercios y los cobros del emisor', () => {
  it('no rankea un interés ni una cobranza como si fueran comercios', () => {
    const merchants = totalsByMerchant(MONTH, 10, { currency: 'CLP' }).map((t) => t.merchant);
    expect(merchants).toEqual(['Supermercado Generico Sucursal Centro']);
  });

  it('un avance en efectivo tampoco es un comercio', () => {
    const merchants = totalsByMerchant(MONTH, 10, { currency: 'CLP' }).map((t) => t.merchant);
    expect(merchants.join(' ')).not.toMatch(/avance/i);
  });

  /**
   * El dinero no desaparece del panel: se informa aparte, con su nombre. Lo que
   * no puede pasar es que quede contado como «sin comercio identificado», que
   * diría que no sabemos quién cobró. Sí lo sabemos.
   */
  it('informa aparte cuánto se llevó el emisor', () => {
    const charges = issuerCharges(MONTH, { currency: 'CLP' });
    expect(charges.amount.minor).toBe(12_400 + 9_900 + 1_200);
    expect(charges.transactionCount).toBe(3);
  });

  it('un fee genérico no prueba que el emisor recibió el dinero', () => {
    const charges = issuerCharges(
      [
        row('COMISION CORRETAJE PROPIEDAD', 1_500_000, {
          kind: TransactionKind.fee,
          kindConfidence: Confidence.confirmed,
        }),
      ],
      { currency: 'CLP' },
    );
    expect(charges.amount.minor).toBe(0);
    expect(charges.transactionCount).toBe(0);
  });

  it('no los cuenta como gasto sin comercio identificado', () => {
    const rest = unattributedSpending(MONTH, { currency: 'CLP' });
    expect(rest.transactionCount).toBe(0);
  });

  /**
   * Ni el ranking ni el desglose son un total nuevo: los cobros del emisor ya
   * estaban dentro del gasto bruto del mes y siguen estándolo.
   */
  it('no cambia el gasto del mes', () => {
    const { grossSpending } = summarizeMonth('2026-09', MONTH, { currency: 'CLP' });
    const merchants = totalsByMerchant(MONTH, 10, { currency: 'CLP' });
    const charges = issuerCharges(MONTH, { currency: 'CLP' });
    const advances = financialCostBreakdown(MONTH, { currency: 'CLP' }).cashAdvances;
    const ranked = merchants.reduce((sum, t) => sum + t.amount.minor, 0);
    expect(ranked + charges.amount.minor).toBe(grossSpending.minor);
    expect(advances.minor).toBe(200_000);
  });

  it('un mes sin cargos del emisor informa cero movimientos', () => {
    const charges = issuerCharges([row('SUPERMERCADO GENERICO', 45_000)], { currency: 'CLP' });
    expect(charges.transactionCount).toBe(0);
  });
});
