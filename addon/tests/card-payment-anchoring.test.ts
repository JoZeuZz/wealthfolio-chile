import { describe, expect, it } from 'vitest';
import {
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
 * P1 (review independiente) — `PAGO TARJETA` hacía substring matching libre.
 *
 * `mentions()` comparaba con `text.includes(marker)`: cualquier glosa de
 * comercio que CONTUVIERA la frase en algún punto — no sólo la propia glosa
 * de pago que el banco emite — se leía como pago de tarjeta. Un comercio real
 * llamado algo como "PAGO TARJETA EXPRESS" convertía una compra normal en
 * `credit_card_payment`, que el host mapea fuera de spending.
 *
 * La glosa real de un pago la emite el banco y empieza con el marcador
 * ("PAGO TARJETA", "PAGO TARJETA CMR", ...); un nombre de comercio que
 * contiene la misma frase la trae en medio de la descripción, nunca al
 * principio. El matcher de pago ahora exige que el marcador abra la
 * descripción normalizada — anclado, no libre. `CARD_REVERSAL_MARKERS`
 * (`DEVOLUCION`, `ANULA`, ...) NO cambia: esos sí aparecen legítimamente en
 * medio de una glosa ("ABONO A TARJETA POR DEVOLUCION COMERCIO"), y ese caso
 * ya tiene su propia cobertura en `card-classification.test.ts`.
 */

describe('marcadores de pago: anclados al inicio de la glosa, no substring libre', () => {
  it.each(['PAGO TARJETA', 'PAGO TARJETA CMR', 'PAGO TARJETA BANCO'])(
    'reconoce "%s" como pago del lado de la tarjeta',
    (description) => {
      expect(mentionsCardSidePayment({ description })).toBe(true);
      expect(classifyCardInflow(description)).toBe('payment');
    },
  );

  it.each(['PAGO TARJETA', 'PAGO TARJETA CMR', 'PAGO TARJETA BANCO'])(
    'reconoce "%s" como pago del lado de la cuenta corriente',
    (description) => {
      expect(mentionsCashSideCardPayment({ description })).toBe(true);
    },
  );

  it.each([
    'COMERCIO PAGO TARJETA EXPRESS',
    'SUPERMERCADO PAGO TARJETA',
    'SERVICIO PAGO TARJETA ONLINE',
  ])('NO reconoce "%s" — el marcador está en medio de un nombre de comercio', (description) => {
    expect(mentionsCardSidePayment({ description })).toBe(false);
    expect(mentionsCashSideCardPayment({ description })).toBe(false);
    expect(classifyCardInflow(description)).not.toBe('payment');
  });

  it('un comercio que contiene la frase, en un movimiento saliente de cuenta corriente, sigue siendo un gasto', () => {
    const prepared = prepareImport({
      file: fromText(
        'cartola.csv',
        ['Fecha;Descripcion;Cargo;Abono;Saldo', '05/02/2026;COMERCIO PAGO TARJETA EXPRESS;15.000;;985.000'].join(
          '\n',
        ),
      ),
      accountId: 'acc-cash',
      parserId: 'generico.cuenta',
      rules: defaultRules(),
      duplicateIndex: buildDuplicateIndex([]),
    });

    expect(prepared.rows[0]?.transaction.kind).toBe(TransactionKind.expense);
  });

  it('el mismo comercio en el lado de la tarjeta sigue siendo una compra, no un pago', () => {
    const prepared = prepareImport({
      file: fromText(
        'cmr.csv',
        ['Banco Falabella - Estado de Cuenta CMR', '', 'Fecha;Descripcion;Monto', '04/02/2026;SUPERMERCADO PAGO TARJETA;15.000'].join(
          '\n',
        ),
      ),
      accountId: 'acc-card',
      parserId: 'generico.tarjeta',
      rules: defaultRules(),
      duplicateIndex: buildDuplicateIndex([]),
    });

    expect(prepared.rows[0]?.transaction.kind).toBe(TransactionKind.credit_card_purchase);
  });
});
