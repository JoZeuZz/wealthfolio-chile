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
 * La pregunta que decide todo el cálculo de deuda comprometida es qué contiene
 * la columna de monto de un estado de cuenta en cuotas: lo que se cobra este
 * mes, o el total de la compra repetido en cada cargo. Nadie de este proyecto
 * ha visto un estado de cuenta CMR real, así que la respuesta honesta es «no se
 * sabe» — y eso tiene que estar en los datos, no en un comentario.
 *
 * Equivocarse no cuesta un poco: si el monto es el total y lo tratamos como
 * cuota, `originalAmount = cuota × n` sale mal por un factor de n.
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
