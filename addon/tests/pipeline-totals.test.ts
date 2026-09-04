import { describe, expect, it } from 'vitest';
import { buildDuplicateIndex } from '../src/core/dedupe/classify';
import { Confidence, TransactionKind } from '../src/core/model/kinds';
import { computeTotals, prepareImport, type PreviewRow } from '../src/core/pipeline';
import type { Rule } from '../src/core/rules/engine';
import { fromText, makeTransaction } from './fixtures';

/**
 * Qué cuenta como «requiere revisión».
 *
 * El contador tiene que ser corto para que alguien lo mire. Contaba toda compra
 * corriente, que es lo mismo que no contar nada; al recortarlo se fue también
 * el único caso donde una clasificación dudosa cuesta dinero por los dos lados.
 */

type RowOverrides = Omit<Partial<PreviewRow['transaction']>, 'amount'> & { amount: number };

let rowCounter = 0;

function row(overrides: RowOverrides): PreviewRow {
  const { amount, ...rest } = overrides;
  const transaction = makeTransaction({ amount, date: '2026-02-10', ...rest });
  rowCounter += 1;
  return {
    key: `r${rowCounter}`,
    transaction: { ...transaction, appliedRules: [] },
    weakFingerprint: 'wfp',
    duplicate: { verdict: 'none', reason_code: 'new', reason: 'Movimiento nuevo.' },
    ignoredByRule: false,
    willImport: true,
  };
}

describe('needsReview', () => {
  it('no cuenta una compra corriente clasificada por el producto', () => {
    const totals = computeTotals(
      [row({ amount: -20000, kind: TransactionKind.expense, kindConfidence: Confidence.suggested })],
      'CLP',
    );
    expect(totals.needsReview).toBe(0);
  });

  it('cuenta una fila que nada supo clasificar, sea cual sea su confianza', () => {
    const totals = computeTotals(
      [row({ amount: -20000, kind: TransactionKind.unknown, kindConfidence: Confidence.confirmed })],
      'CLP',
    );
    expect(totals.needsReview).toBe(1);
  });

  it('cuenta una fila con advertencia', () => {
    const totals = computeTotals(
      [
        row({
          amount: -20000,
          kind: TransactionKind.expense,
          warnings: [{ code: 'zero-amount', message: 'x' }],
        }),
      ],
      'CLP',
    );
    expect(totals.needsReview).toBe(1);
  });

  it('cuenta una transferencia propia que sólo es una suposición', () => {
    // Marcarla mal saca el movimiento de gastos *y* de ingresos. Es la
    // clasificación con el costo más simétrico que hay, y una regla la deja en
    // `suggested`: si nadie la mira, $450.000 desaparecen del mes sin rastro.
    const totals = computeTotals(
      [
        row({
          amount: -450000,
          kind: TransactionKind.internal_transfer,
          kindConfidence: Confidence.suggested,
        }),
      ],
      'CLP',
    );
    expect(totals.needsReview).toBe(1);
  });

  it('no la cuenta cuando la conciliación la confirmó', () => {
    const totals = computeTotals(
      [
        row({
          amount: -450000,
          kind: TransactionKind.internal_transfer,
          kindConfidence: Confidence.confirmed,
        }),
      ],
      'CLP',
    );
    expect(totals.needsReview).toBe(0);
  });

  it('un pago de tarjeta supuesto también se cuenta', () => {
    const totals = computeTotals(
      [
        row({
          amount: -120000,
          kind: TransactionKind.credit_card_payment,
          kindConfidence: Confidence.suggested,
        }),
      ],
      'CLP',
    );
    expect(totals.needsReview).toBe(1);
  });
});

describe('a través del pipeline', () => {
  it('una regla `mark_transfer` deja la fila marcada para revisar', () => {
    const rules: Rule[] = [
      {
        id: 'test.giro',
        name: 'Giro',
        enabled: true,
        priority: 10,
        match: 'any',
        conditions: [{ field: 'description', operator: 'contains', value: 'GIRO' }],
        actions: [{ type: 'mark_transfer' }],
        origin: 'user',
      },
    ];

    const prepared = prepareImport({
      file: fromText(
        'cartola.csv',
        ['Fecha;Descripcion;Cargo;Abono;Saldo', '2026-02-10;GIRO ATM;450.000;;550.000'].join('\n'),
      ),
      accountId: 'acc-1',
      parserId: 'generico.cuenta',
      rules,
      duplicateIndex: buildDuplicateIndex([]),
    });

    expect(prepared.rows[0]?.transaction.kind).toBe(TransactionKind.internal_transfer);
    expect(prepared.totals.needsReview).toBe(1);
  });
});
