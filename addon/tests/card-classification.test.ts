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
import { Confidence, TransactionKind } from '../src/core/model/kinds';
import { StatementProduct } from '../src/core/model/statement';
import { prepareImport } from '../src/core/pipeline';
import { defaultRules } from '../src/core/rules/builtin';
import { applyRules } from '../src/core/rules/engine';
import { fromText, makeTransaction } from './fixtures';

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
    // `unknown` llega a Wealthfolio como `UNKNOWN`, que el host excluye de
    // todo cálculo (`EconomicEventKind::Other`), y `toActivityCreate` lo manda
    // con `needsReview` para que además se pueda encontrar — que es lo correcto
    // para una fila que no supimos interpretar.
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

  it('la regla predefinida no repite ningún marcador: se apoya en la clasificación', () => {
    // Repetir la lista de glosas en la regla le daba un alcance mucho mayor que
    // al clasificador —disparaba en cualquier dirección y en cualquier
    // producto— y `stopProcessing` escondía la fila de todas las reglas de
    // abajo. Condicionar sobre el tipo ya decidido no puede desalinearse.
    const rule = defaultRules().find((candidate) => candidate.id === 'builtin.pago-tarjeta');
    expect(rule?.conditions).toEqual([
      { field: 'kind', operator: 'equals', value: TransactionKind.credit_card_payment },
    ]);
    expect(rule?.actions.map((action) => action.type)).toEqual(['set_category']);
  });

  it('no clasifica lo que no reconoce', () => {
    expect(classifyCardInflow('ABONO')).toBe('ambiguous');
    expect(classifyCardInflow('')).toBe('ambiguous');
  });

  it('"PAGO TARJETA" en el lado de la tarjeta es un pago, no queda ambiguo', () => {
    // Calibración contra 4 estados de cuenta reales de CMR (2026-09): el 100%
    // de los abonos que el clasificador dejaba `unknown` contenían esta frase.
    // CMR imprime su propio lado del pago con la misma glosa que
    // `CASH_SIDE_CARD_PAYMENT_MARKERS` usa para el lado de la cuenta corriente
    // — bancos distintos, misma palabra, lado distinto — así que hace falta
    // como marcador propio del lado de la tarjeta, no tomado prestado de esa
    // lista (eso reabriría el bug que `ABONO A TARJETA` ya dejó documentado).
    expect(classifyCardInflow('PAGO TARJETA')).toBe('payment');
    expect(classifyCardInflow('PAGO TARJETA AUTOMATICO CMR')).toBe('payment');
  });
});

/**
 * Casos que salieron de una revisión adversarial del primer intento.
 *
 * Los cuatro son glosas chilenas corrientes que la primera versión clasificaba
 * peor que el código que venía a reemplazar. Están aquí para que no vuelvan.
 */
describe('el alcance de los marcadores', () => {
  function prepareChecking(rows: string[]) {
    return prepareImport({
      file: fromText('cartola.csv', ['Fecha;Descripcion;Cargo;Abono;Saldo', ...rows].join('\n')),
      accountId: 'acc-cash',
      parserId: 'generico.cuenta',
      rules: defaultRules(),
      duplicateIndex: buildDuplicateIndex([]),
    });
  }

  it('un dividendo hipotecario no es un pago de tarjeta', () => {
    // `PAGO CREDITO` como subcadena suelta convierte cualquier crédito de
    // consumo o hipotecario en movimiento de deuda de tarjeta, y lo saca del
    // gasto del mes: el mismo error que el arreglo venía a corregir, al revés.
    const prepared = prepareChecking([
      '05/02/2026;PAGO CREDITO HIPOTECARIO BANCO;350.000;;650.000',
    ]);
    expect(prepared.rows[0]?.transaction.kind).toBe(TransactionKind.expense);
  });

  it('un crédito de consumo tampoco', () => {
    const prepared = prepareChecking(['05/02/2026;PAGO CREDITO DE CONSUMO;120.000;;880.000']);
    expect(prepared.rows[0]?.transaction.kind).toBe(TransactionKind.expense);
  });

  it('un PAT de la luz no se categoriza como pago de tarjeta', () => {
    const prepared = prepareChecking(['05/02/2026;PAGO PAT ENEL DISTRIBUCION;45.000;;955.000']);
    expect(prepared.rows[0]?.transaction.category).not.toBe('pago-tarjeta');
  });

  it('la regla de comisiones sigue alcanzando a una comisión', () => {
    // La regla de pago de tarjeta corta el resto de las reglas. Si además
    // dispara de más, se lleva por delante la categorización de todo lo que
    // venga después.
    const prepared = prepareChecking(['05/02/2026;COMISION MANTENCION CUENTA;3.500;;996.500']);
    expect(prepared.rows[0]?.transaction.kind).toBe(TransactionKind.fee);
  });

  it('un abono a la tarjeta por devolución es una devolución', () => {
    // `ABONO A TARJETA` es glosa del lado de la cuenta corriente y también algo
    // que la tarjeta imprime. Consultarla al clasificar un abono de tarjeta
    // devolvía "pago" justo en el caso que el arreglo existía para separar.
    const prepared = prepareCard(['06/02/2026;ABONO A TARJETA POR DEVOLUCION COMERCIO;-49.990']);
    expect(prepared.rows[0]?.transaction.kind).toBe(TransactionKind.refund);
  });

  it('la anulación de un pago no es una devolución', () => {
    // Es lo contrario: deshace un abono. Contarla como devolución la sumaría
    // como ingreso.
    expect(classifyCardInflow('ANULACION DE PAGO')).toBe('ambiguous');
    expect(classifyCardInflow('REVERSA PAGO AUTOMATICO')).toBe('ambiguous');
  });

  it('reconoce la glosa aunque venga con espacios de más', () => {
    // La regla compara contra `normalizedDescription` y el clasificador contra
    // la glosa cruda: con doble espacio los dos daban respuestas distintas
    // sobre la misma fila.
    const prepared = prepareChecking(['05/02/2026;PAGO  DE  TARJETA VISA;120.000;;880.000']);
    expect(prepared.rows[0]?.transaction.kind).toBe(TransactionKind.credit_card_payment);
  });

  it('un pago de tarjeta reconocido por su glosa queda confirmado, no sugerido', () => {
    // Antes lo confirmaba la regla vía `set_kind`. Al mover la decisión al
    // clasificador todo pasó a `suggested`, y la vista previa contaba cada pago
    // de tarjeta como fila «requiere revisión».
    const prepared = prepareChecking(['2026-02-05;PAGO TARJETA CMR;120.000;;880.000']);
    expect(prepared.rows[0]?.transaction.kindConfidence).toBe('confirmed');
    expect(prepared.totals.needsReview).toBe(0);
  });

  it('lo que sólo sigue el default del producto queda sugerido', () => {
    const prepared = prepareChecking(['2026-02-05;COMPRA SUPERMERCADO;20.000;;980.000']);
    expect(prepared.rows[0]?.transaction.kindConfidence).toBe('suggested');
  });
});

/**
 * Una regla escrita para cuentas corrientes leyendo un estado de cuenta.
 *
 * `builtin.transferencia-propia` dispara sobre `TRASPASO` con `match: 'any'`,
 * lo que en una cuenta corriente chilena es correcto: `TRASPASO A CUENTA
 * PROPIA` mueve plata entre cuentas del mismo dueño y no es gasto. En una
 * tarjeta la misma palabra significa otra cosa por completo —`TRASPASO A 12
 * CUOTAS`, `TRASPASO DE DEUDA`, `TRASPASO DE SALDO` son refinanciamiento— y
 * marcarlo como transferencia interna arrastra tres consecuencias:
 *
 * 1. `internal_transfer` saliente en una tarjeta se resuelve a `TRANSFER_OUT`,
 *    que Wealthfolio **rechaza** en una cuenta `CREDIT_CARD`
 *    (`account_activity_validation_message`, v3.7.0), así que se sustituye por
 *    `WITHDRAWAL`;
 * 2. `WITHDRAWAL` en una tarjeta es `Expense` para el informe de gasto del host
 *    (`spending::classify_activity`, v3.7.0) — el mismo sitio del que la regla
 *    pretendía sacarlo;
 * 3. `stopProcessing` esconde la fila de todas las reglas de abajo.
 *
 * Lo que hace falta no es un tipo de actividad distinto: no lo hay. Es que la
 * regla sepa sobre qué producto está corriendo.
 */
describe('reglas y producto de la cartola', () => {
  it('«traspaso» en una tarjeta no es una transferencia entre cuentas propias', () => {
    const transaction = makeTransaction({
      description: 'TRASPASO A 12 CUOTAS',
      amount: -120_000,
      date: '2026-02-03',
      kind: TransactionKind.credit_card_purchase,
    });

    const { transaction: out } = applyRules(transaction, defaultRules(), {
      accountId: 'acc-1',
      product: StatementProduct.credit_card,
    });

    expect(out.kind).toBe(TransactionKind.credit_card_purchase);
    expect(out.appliedRules).not.toContain('builtin.transferencia-propia');
  });

  it('la misma glosa en una cuenta corriente sí lo es', () => {
    const transaction = makeTransaction({
      description: 'TRASPASO A CUENTA PROPIA',
      amount: -120_000,
      date: '2026-02-03',
      kind: TransactionKind.expense,
      kindConfidence: Confidence.suggested,
    });

    const { transaction: out } = applyRules(transaction, defaultRules(), {
      accountId: 'acc-1',
      product: StatementProduct.checking,
    });

    expect(out.kind).toBe(TransactionKind.internal_transfer);
  });

  it('sin producto conocido la regla sigue aplicando, como hasta ahora', () => {
    const transaction = makeTransaction({
      description: 'TRASPASO A CUENTA PROPIA',
      amount: -120_000,
      date: '2026-02-03',
      kind: TransactionKind.expense,
      kindConfidence: Confidence.suggested,
    });

    const { transaction: out } = applyRules(transaction, defaultRules(), { accountId: 'acc-1' });

    expect(out.kind).toBe(TransactionKind.internal_transfer);
  });
});
