import { describe, expect, it } from 'vitest';
import { withFinancialCost } from '../src/core/chile/financial-costs';
import { FinancialCostKind } from '../src/core/model/financial-cost';
import { Confidence, Direction, TransactionKind } from '../src/core/model/kinds';
import type { NormalizedTransaction } from '../src/core/model/transaction';
import { money } from '../src/core/money';
import { normalizeDescription } from '../src/core/text';

function row(
  description: string,
  overrides: Partial<NormalizedTransaction> = {},
): NormalizedTransaction {
  return {
    sourceInstitution: 'banco-falabella',
    sourceParser: 'banco-falabella.estado-cuenta',
    sourceParserVersion: '1',
    sourceFileHash: 'hash',
    fingerprint: 'fp',
    date: '2026-09-01',
    description,
    normalizedDescription: normalizeDescription(description),
    amount: money(-4500, 0, 'CLP'),
    direction: Direction.out,
    kind: TransactionKind.credit_card_purchase,
    kindConfidence: Confidence.suggested,
    tags: [],
    warnings: [],
    rawMetadata: {},
    ...overrides,
  };
}

/**
 * La dimensión de costo financiero refina una clasificación; no la reemplaza.
 *
 * El caso que justifica el paso completo son los gastos de cobranza: ninguna
 * regla builtin los reconoce, así que en un estado de cuenta caían en el
 * default del producto —compra con tarjeta— y aparecían en el panel entre el
 * supermercado y la bencina.
 */
describe('anotar el costo financiero de una fila', () => {
  it('anota el subtipo cuando la glosa lo nombra', () => {
    const annotated = withFinancialCost(row('INTERES POR MORA'));
    expect(annotated.financialCost?.kind).toBe(FinancialCostKind.late_interest);
    expect(annotated.financialCost?.matchedText).toBe('INTERES POR MORA');
  });

  it('un cargo que ninguna regla reconocía deja de ser una compra', () => {
    const annotated = withFinancialCost(row('GASTOS DE COBRANZA'));
    expect(annotated.kind).toBe(TransactionKind.fee);
    expect(annotated.kindConfidence).toBe(Confidence.confirmed);
    expect(annotated.financialCost?.kind).toBe(FinancialCostKind.collection);
  });

  it('el impuesto al crédito es impuesto, no comisión', () => {
    expect(withFinancialCost(row('IMPUESTO AL CREDITO')).kind).toBe(TransactionKind.tax);
  });

  it('el interés rotativo es interés, no compra', () => {
    expect(withFinancialCost(row('INTERES ROTATIVO SEPTIEMBRE')).kind).toBe(
      TransactionKind.interest,
    );
  });

  /**
   * Una clasificación confirmada la puso la glosa o una regla del usuario. Este
   * paso puede agregarle un subtipo, nunca contradecirla.
   */
  it('no toca un tipo que ya estaba confirmado', () => {
    const annotated = withFinancialCost(
      row('COMISION DE MANTENCION', {
        kind: TransactionKind.expense,
        kindConfidence: Confidence.confirmed,
      }),
    );
    expect(annotated.kind).toBe(TransactionKind.expense);
    expect(annotated.financialCost?.kind).toBe(FinancialCostKind.maintenance);
  });

  /**
   * `COMISION` a secas dice que hay un costo y no cuál. Alcanza para anotarlo y
   * no para pisar la lectura que el pipeline ya tenía.
   */
  it('una lectura sugerida anota pero no reclasifica', () => {
    const annotated = withFinancialCost(row('COMISION'));
    expect(annotated.financialCost?.kind).toBe(FinancialCostKind.other);
    expect(annotated.kind).toBe(TransactionKind.credit_card_purchase);
  });

  /**
   * Un abono no es un costo aunque la glosa comparta palabras: la devolución de
   * una comisión mal cobrada dice `COMISION` y devuelve plata.
   */
  it('no reclasifica un movimiento que entra', () => {
    const annotated = withFinancialCost(
      row('DEVOLUCION INTERES POR MORA', {
        direction: Direction.in,
        amount: money(4500, 0, 'CLP'),
        kind: TransactionKind.refund,
      }),
    );
    expect(annotated.kind).toBe(TransactionKind.refund);
  });

  it('deja intacta una fila que no nombra ningún costo', () => {
    const original = row('SUPERMERCADO LIDER');
    const annotated = withFinancialCost(original);
    expect(annotated).toEqual(original);
    expect(annotated.financialCost).toBeUndefined();
  });

  /**
   * El descriptor original es la única evidencia que el usuario tiene para
   * reconocer un cargo. Ninguna anotación puede alterarlo.
   */
  it('nunca altera la descripción ni el monto', () => {
    const original = row('CARGO COMISION DE MANTENCION TARJETA');
    const annotated = withFinancialCost(original);
    expect(annotated.description).toBe(original.description);
    expect(annotated.normalizedDescription).toBe(original.normalizedDescription);
    expect(annotated.amount).toEqual(original.amount);
    expect(annotated.fingerprint).toBe(original.fingerprint);
  });
});
