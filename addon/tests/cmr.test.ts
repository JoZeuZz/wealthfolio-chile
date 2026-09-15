import { describe, expect, it } from 'vitest';
import { buildDuplicateIndex } from '../src/core/dedupe/classify';
import { buildInstallmentPlans } from '../src/core/installments/plans';
import { Confidence, TransactionKind } from '../src/core/model/kinds';
import { prepareImport } from '../src/core/pipeline';
import { defaultRules } from '../src/core/rules/builtin';
import { fromText } from './fixtures';

/**
 * CMR y las cuotas.
 *
 * Calibrado contra 4 estados de cuenta reales de CMR Banco Falabella
 * (2026-09, `pnpm calibrate -- <archivo> --parser banco-falabella.cmr`):
 * `MONTO` y `VALOR CUOTA` coinciden en toda fila que no es una cuota activa
 * (128 de 130 filas reales); difieren sólo en las cuotas activas observadas
 * (2 de 130), donde `MONTO` es la compra completa y `VALOR CUOTA` el cargo
 * del mes — confirmando, no asumiendo, la lectura que ya usaba la columna
 * etiquetada. `readAmount` ya prioriza `VALOR CUOTA` cuando existe, así que
 * el monto de cada fila ya es el cargo del ciclo, nunca el total.
 *
 * La columna de cuotas real («CUOTAS PENDIENTES») no es un par `n de m`:
 * es un entero simple — cuotas restantes tras este cargo — presente en el
 * 100 % de las filas reales (0 cuando no hay plan abierto). Ningún total se
 * infiere de ella ni de `MONTO / VALOR CUOTA`: ver
 * `detectRemainingInstallments` (`core/installments/detect.ts`) y el describe
 * «cuotas como conteo restante» más abajo.
 *
 * Evidencia real también mostró que la fecha de una cuota activa NO avanza
 * entre ciclos — la cuota 2 de una compra trae la misma `FECHA` que la
 * cuota 1 — así que sin más ajuste el fingerprint (fecha+monto+glosa) de dos
 * cuotas consecutivas de la misma compra colisiona. Ver «el fingerprint
 * distingue cuotas consecutivas» más abajo.
 */

function prepareCmr(rows: string[], header = 'Fecha;Descripcion;Monto;Cuotas') {
  return prepareImport({
    file: fromText(
      'cmr.csv',
      ['Banco Falabella - Estado de Cuenta CMR', 'Tarjeta N: XXXX-XXXX-XXXX-7788', '', header, ...rows].join(
        '\n',
      ),
    ),
    accountId: 'acc-card',
    parserId: 'banco-falabella.cmr',
    rules: defaultRules(),
    duplicateIndex: buildDuplicateIndex([]),
  });
}

describe('movimientos de una tarjeta CMR', () => {
  const kindOf = (row: string, header?: string) =>
    prepareCmr([row], header).rows[0]?.transaction.kind;

  it('una compra normal es una compra de tarjeta', () => {
    expect(kindOf('04/02/2026;FALABELLA RETAIL PLAZA VESPUCIO;49.990;')).toBe(
      TransactionKind.credit_card_purchase,
    );
  });

  it('un pago del estado de cuenta es un pago de tarjeta', () => {
    expect(kindOf('05/02/2026;PAGO RECIBIDO GRACIAS;-120.000;')).toBe(
      TransactionKind.credit_card_payment,
    );
  });

  it('una devolución del comercio es una devolución', () => {
    expect(kindOf('06/02/2026;DEVOLUCION FALABELLA RETAIL;-49.990;')).toBe(
      TransactionKind.refund,
    );
  });

  it('una reversa es una devolución', () => {
    expect(kindOf('06/02/2026;REVERSA CARGO DUPLICADO;-9.990;')).toBe(TransactionKind.refund);
  });

  it('una comisión es una comisión', () => {
    expect(kindOf('07/02/2026;COMISION MANTENCION TARJETA;3.500;')).toBe(TransactionKind.fee);
  });

  it('un interés cobrado es interés', () => {
    expect(kindOf('07/02/2026;INTERESES POR MORA;12.000;')).toBe(TransactionKind.interest);
  });

  it('un abono acreedor sin glosa reconocible queda sin clasificar', () => {
    expect(kindOf('08/02/2026;ABONO;-15.000;')).toBe(TransactionKind.unknown);
  });
});

describe('qué contiene la columna de monto', () => {
  it('usa la columna de valor de cuota cuando el estado de cuenta la trae', () => {
    // Sin ambigüedad: el banco dice cuál es cuál.
    const prepared = prepareCmr(
      ['04/02/2026;FALABELLA RETAIL;299.940;49.990;2 de 6'],
      'Fecha;Descripcion;Monto Total;Valor Cuota;Cuotas',
    );

    const row = prepared.rows[0]?.transaction;
    expect(row?.amount.minor).toBe(-49990);
    expect(row?.warnings.map((w) => w.code)).not.toContain('ambiguous-installment-amount');
  });

  it('avisa cuando hay marca de cuotas y una sola columna de monto sin etiquetar', () => {
    // `Monto` con `2 de 6` al lado puede ser la cuota o la compra entera.
    const prepared = prepareCmr(['04/02/2026;FALABELLA RETAIL;49.990;2 de 6']);
    expect(prepared.rows[0]?.transaction.warnings.map((w) => w.code)).toContain(
      'ambiguous-installment-amount',
    );
  });

  it('no avisa cuando la fila no es una cuota', () => {
    const prepared = prepareCmr(['04/02/2026;FALABELLA RETAIL;49.990;']);
    expect(prepared.rows[0]?.transaction.warnings.map((w) => w.code)).not.toContain(
      'ambiguous-installment-amount',
    );
  });
});

describe('planes de cuotas con monto incierto', () => {
  it('no deriva el total de la compra de un monto que no sabe qué es', () => {
    // `cuota × n` con una cuota que en realidad era el total da un número n
    // veces mayor que la compra. Preferible no darlo.
    const prepared = prepareCmr([
      '04/01/2026;FALABELLA RETAIL PLAZA VESPUCIO;49.990;1 de 6',
      '04/02/2026;FALABELLA RETAIL PLAZA VESPUCIO;49.990;2 de 6',
    ]);

    const plans = buildInstallmentPlans(prepared.rows.map((row) => row.transaction));
    expect(plans).toHaveLength(1);
    expect(plans[0]?.originalAmount).toBeUndefined();
    expect(plans[0]?.confidence).not.toBe(Confidence.confirmed);
  });

  it('sí lo deriva cuando la cuota viene etiquetada', () => {
    const prepared = prepareCmr(
      [
        '04/01/2026;FALABELLA RETAIL PLAZA VESPUCIO;299.940;49.990;1 de 6',
        '04/02/2026;FALABELLA RETAIL PLAZA VESPUCIO;299.940;49.990;2 de 6',
      ],
      'Fecha;Descripcion;Monto Total;Valor Cuota;Cuotas',
    );

    const plans = buildInstallmentPlans(prepared.rows.map((row) => row.transaction));
    expect(plans[0]?.originalAmount?.minor).toBe(299940);
  });

  it('sigue proyectando lo que falta por pagar, que no depende del total', () => {
    const prepared = prepareCmr([
      '04/01/2026;FALABELLA RETAIL PLAZA VESPUCIO;49.990;1 de 6',
      '04/02/2026;FALABELLA RETAIL PLAZA VESPUCIO;49.990;2 de 6',
    ]);

    const plans = buildInstallmentPlans(prepared.rows.map((row) => row.transaction));
    expect(plans[0]?.remainingInstallments).toBe(4);
  });
});

describe('cuotas como conteo restante (forma real de CUOTAS PENDIENTES)', () => {
  it('lee un entero simple sin inventar total', () => {
    const prepared = prepareCmr(['04/02/2026;FALABELLA RETAIL PLAZA VESPUCIO;49.990;3']);
    const row = prepared.rows[0]?.transaction;
    expect(row?.installment).toBeUndefined();
    expect(row?.installmentRemaining).toBe(3);
  });

  it('cero es un dato — no hay plan abierto, no "sin evidencia"', () => {
    const prepared = prepareCmr(['04/02/2026;FALABELLA RETAIL PLAZA VESPUCIO;49.990;0']);
    expect(prepared.rows[0]?.transaction.installmentRemaining).toBe(0);
  });

  it('una fila sin nada en la columna no reporta conteo', () => {
    const prepared = prepareCmr(['04/02/2026;FALABELLA RETAIL PLAZA VESPUCIO;49.990;']);
    expect(prepared.rows[0]?.transaction.installmentRemaining).toBeUndefined();
  });

  it('no arma un plan a partir de un conteo restante — no hay total que agrupar', () => {
    // buildInstallmentPlans agrupa por `installment.total`; un conteo restante
    // nunca alimenta `installment`, así que estas filas no producen un plan.
    // Silencioso a propósito: es preferible no mostrar un plan a inventar uno.
    const prepared = prepareCmr([
      '04/01/2026;FALABELLA RETAIL PLAZA VESPUCIO;49.990;3',
      '04/02/2026;FALABELLA RETAIL PLAZA VESPUCIO;49.990;2',
    ]);

    const plans = buildInstallmentPlans(prepared.rows.map((row) => row.transaction));
    expect(plans).toHaveLength(0);
  });
});

describe('el fingerprint distingue cuotas consecutivas', () => {
  it('misma fecha, mismo monto, misma glosa, distinto conteo restante: distinto fingerprint', () => {
    // Evidencia real (2026-09, comparación cruzada entre 2 estados de cuenta
    // consecutivos vía `pnpm calibrate -- A B --compare`): la FECHA de una
    // cuota activa no avanza entre ciclos. Sin el conteo restante en el
    // fingerprint, la cuota 2 se leería como duplicado exacto de la cuota 1
    // y se perdería silenciosamente al reimportar el ciclo siguiente.
    const prepared = prepareCmr([
      '04/01/2026;FALABELLA RETAIL PLAZA VESPUCIO;49.990;3',
      '04/01/2026;FALABELLA RETAIL PLAZA VESPUCIO;49.990;2',
    ]);

    const [first, second] = prepared.rows.map((row) => row.transaction.fingerprint);
    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(first).not.toBe(second);
  });

  it('dos cuotas con el mismo conteo restante siguen siendo el mismo hecho, no dos', () => {
    // Dos filas idénticas en todo, incluido el conteo restante, son
    // exactamente el caso que el dedupe existente ya cubre — reimportar el
    // mismo archivo no debe duplicar.
    const prepared = prepareCmr([
      '04/01/2026;FALABELLA RETAIL PLAZA VESPUCIO;49.990;3',
      '04/01/2026;FALABELLA RETAIL PLAZA VESPUCIO;49.990;3',
    ]);

    const [first, second] = prepared.rows.map((row) => row.transaction.fingerprint);
    expect(first).toBe(second);
  });
});
