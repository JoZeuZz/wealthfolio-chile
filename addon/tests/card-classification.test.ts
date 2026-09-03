import { describe, expect, it } from 'vitest';
import {
  CARD_REVERSAL_MARKERS,
  CARD_SIDE_PAYMENT_MARKERS,
  CASH_SIDE_CARD_PAYMENT_MARKERS,
  classifyCardInflow,
  mentionsCardSidePayment,
  mentionsCashSideCardPayment,
} from '../src/core/classify/card-semantics';
import { buildDuplicateIndex } from '../src/core/dedupe/classify';
import { TransactionKind } from '../src/core/model/kinds';
import { prepareImport } from '../src/core/pipeline';
import { defaultRules } from '../src/core/rules/builtin';
import { fromText } from './fixtures';

/**
 * Qué significa un abono en una tarjeta de crédito.
 *
 * No "un pago". Puede ser un pago, una devolución del comercio, la anulación de
 * una compra, la reversa de un cargo mal aplicado o una bonificación. Las
 * consecuencias son opuestas: un pago mueve deuda y no es gasto; una devolución
 * *reduce* el gasto del mes. Tratarlas igual desbalancea las dos métricas a la
 * vez.
 */

function prepareCard(rows: string[]) {
  return prepareImport({
    file: fromText(
      'cmr.csv',
      ['Banco Falabella - Estado de Cuenta CMR', '', 'Fecha;Descripcion;Monto', ...rows].join('\n'),
    ),
    accountId: 'acc-card',
    parserId: 'generico.tarjeta',
    rules: defaultRules(),
    duplicateIndex: buildDuplicateIndex([]),
  });
}

function kindOf(rows: string[], index = 0) {
  return prepareCard(rows).rows[index]?.transaction.kind;
}

describe('clasificación de abonos de tarjeta', () => {
  it('un cargo es una compra', () => {
    expect(kindOf(['04/02/2026;FALABELLA RETAIL PLAZA VESPUCIO;49.990'])).toBe(
      TransactionKind.credit_card_purchase,
    );
  });

  it('un abono con glosa de pago es un pago de tarjeta', () => {
    expect(kindOf(['05/02/2026;PAGO RECIBIDO GRACIAS;-120.000'])).toBe(
      TransactionKind.credit_card_payment,
    );
  });

  it('una devolución del comercio es una devolución, no un pago', () => {
    // La diferencia importa: un pago mueve deuda y sale de los totales de
    // gasto; una devolución reduce el gasto del período.
    expect(kindOf(['06/02/2026;DEVOLUCION FALABELLA RETAIL;-49.990'])).toBe(
      TransactionKind.refund,
    );
  });

  it('una anulación de compra es una devolución', () => {
    expect(kindOf(['06/02/2026;ANULACION COMPRA COMERCIO;-19.990'])).toBe(TransactionKind.refund);
  });

  it('una reversa de cargo es una devolución', () => {
    expect(kindOf(['06/02/2026;REVERSA CARGO DUPLICADO;-9.990'])).toBe(TransactionKind.refund);
  });

  it('una nota de crédito es una devolución', () => {
    expect(kindOf(['06/02/2026;NOTA DE CREDITO COMERCIO;-5.000'])).toBe(TransactionKind.refund);
  });

  it('un abono sin glosa reconocible queda sin clasificar, no como pago', () => {
    // El default anterior era `credit_card_payment`: cualquier abono que no
    // supiéramos leer desaparecía de los totales como si fuera deuda movida.
    // `unknown` llega a Wealthfolio como `UNKNOWN`, que el host marca
    // `needs_review` y excluye de todo cálculo — que es lo correcto para una
    // fila que no supimos interpretar.
    expect(kindOf(['06/02/2026;ABONO;-15.000'])).toBe(TransactionKind.unknown);
  });

  it('avisa de por qué quedó sin clasificar', () => {
    const row = prepareCard(['06/02/2026;ABONO;-15.000']).rows[0];
    expect(row?.transaction.warnings.map((w) => w.code)).toContain('ambiguous-card-credit');
  });
});

describe('el lado de la cuenta corriente', () => {
  function prepareChecking(rows: string[]) {
    return prepareImport({
      file: fromText(
        'cartola.csv',
        ['Fecha;Descripcion;Cargo;Abono;Saldo', ...rows].join('\n'),
      ),
      accountId: 'acc-cash',
      parserId: 'generico.cuenta',
      rules: defaultRules(),
      duplicateIndex: buildDuplicateIndex([]),
    });
  }

  it('un pago de tarjeta desde la cuenta no es un gasto', () => {
    // Si lo fuera, el mes contaría las compras de la tarjeta *y* el pago que
    // las liquida: el mismo dinero dos veces.
    const prepared = prepareChecking(['05/02/2026;PAGO TARJETA CMR;120.000;;880.000']);
    expect(prepared.rows[0]?.transaction.kind).toBe(TransactionKind.credit_card_payment);
  });

  it('una compra normal sigue siendo un gasto', () => {
    const prepared = prepareChecking(['05/02/2026;COMPRA SUPERMERCADO;20.000;;980.000']);
    expect(prepared.rows[0]?.transaction.kind).toBe(TransactionKind.expense);
  });

  it('un abono sin glosa reconocible sigue siendo un ingreso', () => {
    // En una cuenta corriente el abono por defecto sí es dinero que entra; la
    // ambigüedad del abono es específica de la tarjeta.
    const prepared = prepareChecking(['05/02/2026;ABONO;;500.000;1.500.000']);
    expect(prepared.rows[0]?.transaction.kind).toBe(TransactionKind.income);
  });
});

describe('vocabulario en un solo lugar', () => {
  it('la clasificación y el reconciliador leen la misma lista', () => {
    for (const marker of CARD_SIDE_PAYMENT_MARKERS) {
      expect(mentionsCardSidePayment({ description: marker })).toBe(true);
      expect(classifyCardInflow(marker)).toBe('payment');
    }
    for (const marker of CASH_SIDE_CARD_PAYMENT_MARKERS) {
      expect(mentionsCashSideCardPayment({ description: marker })).toBe(true);
    }
    for (const marker of CARD_REVERSAL_MARKERS) {
      expect(classifyCardInflow(marker)).toBe('reversal');
    }
  });

  it('un pago gana a una reversa cuando la glosa menciona las dos', () => {
    // "PAGO RECIBIDO - ANULA CARGO ANTERIOR" es un pago que además explica algo.
    // El orden es determinista, no depende de cuál marcador aparezca primero.
    expect(classifyCardInflow('PAGO RECIBIDO - ANULA CARGO ANTERIOR')).toBe('payment');
  });

  it('la regla predefinida usa exactamente los mismos marcadores', () => {
    const rule = defaultRules().find((candidate) => candidate.id === 'builtin.pago-tarjeta');
    const markers = rule?.conditions.map((condition) => String(condition.value)).sort();
    expect(markers).toEqual(
      [...CASH_SIDE_CARD_PAYMENT_MARKERS, ...CARD_SIDE_PAYMENT_MARKERS].slice().sort(),
    );
  });

  it('la regla predefinida ya no decide el tipo, sólo la categoría', () => {
    // Una lista plana `match: 'any'` no puede decir "uno de estos marcadores Y
    // además una salida", así que la regla llamaba pago de tarjeta a un
    // `PAGO RECIBIDO` en una cuenta corriente. Clasificar mira la dirección y
    // el producto; la regla categoriza.
    const rule = defaultRules().find((candidate) => candidate.id === 'builtin.pago-tarjeta');
    expect(rule?.actions.map((action) => action.type)).toEqual(['set_category']);
  });

  it('no clasifica lo que no reconoce', () => {
    expect(classifyCardInflow('ABONO')).toBe('ambiguous');
    expect(classifyCardInflow('')).toBe('ambiguous');
  });
});
