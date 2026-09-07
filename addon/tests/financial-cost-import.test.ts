import { describe, expect, it } from 'vitest';
import { buildDuplicateIndex } from '../src/core/dedupe/classify';
import {
  activityToTransaction,
  readChileMetadata,
  toActivityCreate,
} from '../src/core/mapping/activities';
import { FinancialCostKind } from '../src/core/model/financial-cost';
import { TransactionKind } from '../src/core/model/kinds';
import { prepareImport } from '../src/core/pipeline';
import { defaultRules } from '../src/core/rules/builtin';
import { fromText } from './fixtures';

/**
 * Un estado de cuenta sintético con las líneas que no son compras.
 *
 * Ninguna de estas glosas viene de una cartola real: son la redacción que el
 * reglamento de información al consumidor y la NCG 537 usan para nombrar cada
 * concepto. Es la única forma honesta de probar esto mientras
 * `samples/private/` siga vacío.
 */
const STATEMENT = [
  'Banco Falabella - Estado de Cuenta CMR',
  'Tarjeta N: XXXX-XXXX-XXXX-7788',
  'Periodo: 01/09/2026 al 30/09/2026',
  '',
  'Fecha;Descripcion;Monto;Cuotas;Rubro',
  '02/09/2026;SUPERMERCADO GENERICO SUCURSAL CENTRO;45.000;;Alimentacion',
  '03/09/2026;AVANCE EN EFECTIVO;200.000;;Avances',
  '03/09/2026;COMISION POR AVANCE EN EFECTIVO;7.500;;Comisiones',
  '05/09/2026;INTERES POR MORA;12.400;;Intereses',
  '05/09/2026;GASTOS DE COBRANZA;9.900;;Cobranza',
  '06/09/2026;IMPUESTO AL CREDITO;1.200;;Impuestos',
  '30/09/2026;COMISION DE MANTENCION TARJETA;5.900;;Comisiones',
  '30/09/2026;DEVOLUCION COMISION DE MANTENCION;-5.900;;Comisiones',
  '30/09/2026;DEVOLUCION INTERES POR MORA;-4.500;;Intereses',
  '30/09/2026;DEVOLUCION IMPUESTO AL CREDITO;-1.200;;Impuestos',
  '30/09/2026;PAGO RECIBIDO COMISION DE SERVICIO;-25.000;;Pagos',
  '30/09/2026;MANTENCION ASCENSORES;18.000;;Servicios',
  '30/09/2026;TIMBRES Y GOMAS SPA;12.000;;Comercio',
  '30/09/2026;LIBRERIA EL INTERES;9.000;;Comercio',
  '30/09/2026;DEVOLUCION COMPRA LIDER;-8.000;;Comercio',
  '30/09/2026;INTERES POR AVANCE EN EFECTIVO;6.000;;Intereses',
  '30/09/2026;DEVOLUCION COMPRA CUENTA PROPIA LIDER;-7.000;;Comercio',
].join('\n');

function prepared() {
  return prepareImport({
    file: fromText('estado-cuenta.csv', STATEMENT),
    accountId: 'acct-cmr',
    accountName: 'CMR',
    rules: defaultRules(),
    duplicateIndex: buildDuplicateIndex([]),
  });
}

const find = (description: string) => {
  const row = prepared().rows.find((r) => r.transaction.description === description);
  if (!row) throw new Error(`no row matched ${description}`);
  return row.transaction;
};

describe('un estado de cuenta con costos financieros, de punta a punta', () => {
  it('el avance deja de contarse como una compra', () => {
    expect(find('AVANCE EN EFECTIVO').kind).toBe(TransactionKind.cash_advance);
  });

  it('la comisión del avance es una comisión con apellido', () => {
    const row = find('COMISION POR AVANCE EN EFECTIVO');
    expect(row.kind).toBe(TransactionKind.fee);
    expect(row.financialCost?.kind).toBe(FinancialCostKind.cash_advance_fee);
  });

  it('el interés del avance es costo, nunca principal ni compra', () => {
    const row = find('INTERES POR AVANCE EN EFECTIVO');
    expect(row.kind).toBe(TransactionKind.interest);
    expect(row.financialCost?.kind).toBe(FinancialCostKind.cash_advance_interest);
  });

  it('el interés por mora se distingue del rotativo', () => {
    const row = find('INTERES POR MORA');
    expect(row.kind).toBe(TransactionKind.interest);
    expect(row.financialCost?.kind).toBe(FinancialCostKind.late_interest);
  });

  it('los gastos de cobranza dejan de aparecer como compra en el supermercado', () => {
    const row = find('GASTOS DE COBRANZA');
    expect(row.kind).toBe(TransactionKind.fee);
    expect(row.financialCost?.kind).toBe(FinancialCostKind.collection);
  });

  it('el impuesto al crédito queda como impuesto', () => {
    const row = find('IMPUESTO AL CREDITO');
    expect(row.kind).toBe(TransactionKind.tax);
    expect(row.financialCost?.kind).toBe(FinancialCostKind.credit_tax);
  });

  it('la mantención queda separada de la comisión de avance', () => {
    expect(find('COMISION DE MANTENCION TARJETA').financialCost?.kind).toBe(
      FinancialCostKind.maintenance,
    );
  });

  it('una compra corriente no recibe ninguna anotación de costo', () => {
    const row = find('SUPERMERCADO GENERICO SUCURSAL CENTRO');
    expect(row.financialCost).toBeUndefined();
    expect(row.kind).toBe(TransactionKind.credit_card_purchase);
  });

  it.each([
    'DEVOLUCION COMISION DE MANTENCION',
    'DEVOLUCION INTERES POR MORA',
    'DEVOLUCION IMPUESTO AL CREDITO',
  ])('una devolución conserva dirección y semántica aunque diga %s', (description) => {
    const row = find(description);
    expect(row.kind).toBe(TransactionKind.refund);
    expect(row.direction).toBe('in');
    expect(row.amount.minor).toBeGreaterThan(0);
    expect(row.financialCost).toBeUndefined();
  });

  it('una devolución confirmada todavía recibe su categoría de comercio', () => {
    const row = find('DEVOLUCION COMPRA LIDER');
    expect(row.kind).toBe(TransactionKind.refund);
    expect(row.category).toBe('alimentacion.supermercado');
  });

  it('una devolución confirmada no se convierte en transferencia propia', () => {
    const row = find('DEVOLUCION COMPRA CUENTA PROPIA LIDER');
    expect(row.kind).toBe(TransactionKind.refund);
    expect(row.transferCandidate).toBeUndefined();
  });

  it('un pago de tarjeta confirmado gana a palabras de costo financiero', () => {
    const row = find('PAGO RECIBIDO COMISION DE SERVICIO');
    expect(row.kind).toBe(TransactionKind.credit_card_payment);
    expect(row.direction).toBe('in');
    expect(row.amount.minor).toBeGreaterThan(0);
    expect(row.financialCost).toBeUndefined();
  });

  it.each([
    'MANTENCION ASCENSORES',
    'TIMBRES Y GOMAS SPA',
    'LIBRERIA EL INTERES',
  ])('una palabra financiera dentro de un comercio no convierte %s en costo', (description) => {
    const row = find(description);
    expect(row.kind).toBe(TransactionKind.credit_card_purchase);
    expect(row.financialCost).toBeUndefined();
  });

  /**
   * Un costo financiero es gasto y ya lo era antes de esta dimensión. Lo que
   * cambia es de qué clase, no cuánto: los totales del preview no se mueven
   * porque una línea pase de `credit_card_purchase` a `fee`, ya que ambos están
   * en `SPENDING_KINDS`.
   */
  it('ningún costo se cuenta dos veces', () => {
    const { totals, rows } = prepared();
    const outflow = rows
      .filter((row) => row.transaction.direction === 'out')
      .reduce((sum, row) => sum + Math.abs(row.transaction.amount.minor), 0);
    const principal = rows
      .filter((row) => row.transaction.kind === TransactionKind.cash_advance)
      .reduce((sum, row) => sum + Math.abs(row.transaction.amount.minor), 0);
    expect(Math.abs(totals.expenses.minor) + principal).toBe(outflow);
  });
});

describe('el costo financiero sobrevive el viaje a Wealthfolio', () => {
  it('viaja en la metadata del addon, no en un tipo de actividad inventado', () => {
    const row = find('INTERES POR MORA');
    const activity = toActivityCreate(row, { accountId: 'acct-cmr', runId: 'run-1' });

    // `FEE` con subtipo `INTEREST_CHARGE` es lo que el host ya sabe expresar.
    expect(activity.activityType).toBe('FEE');
    expect(readChileMetadata(activity.metadata)?.fc).toBe(FinancialCostKind.late_interest);
  });

  it('el avance se escribe como retiro y se relee como avance', () => {
    const row = find('AVANCE EN EFECTIVO');
    expect(row.merchant).toBeUndefined();
    expect(row.attribution).toBeUndefined();
    const activity = toActivityCreate(row, { accountId: 'acct-cmr', runId: 'run-1' });

    expect(activity.activityType).toBe('WITHDRAWAL');
    expect(readChileMetadata(activity.metadata)?.kind).toBe(TransactionKind.cash_advance);
    expect(readChileMetadata(activity.metadata)?.merchant).toBeUndefined();
  });

  it('una fila sin costo no escribe el campo', () => {
    const row = find('SUPERMERCADO GENERICO SUCURSAL CENTRO');
    const activity = toActivityCreate(row, { accountId: 'acct-cmr', runId: 'run-1' });
    expect(readChileMetadata(activity.metadata)?.fc).toBeUndefined();
  });
});

/**
 * Wealthfolio manda: una actividad que el usuario editó en el host deja de
 * describirse por la metadata del addon. Pero mientras la actividad sigue
 * siendo la que este addon escribió, releerla tiene que devolver lo mismo que
 * se escribió — si no, el panel y el import discrepan sobre la misma fila.
 */
describe('releer un costo financiero desde el host', () => {
  it('devuelve la misma dimensión que se escribió', () => {
    const row = find('GASTOS DE COBRANZA');
    const activity = toActivityCreate(row, { accountId: 'acct-cmr', runId: 'run-1' });

    const reread = activityToTransaction({
      id: 'a1',
      accountId: 'acct-cmr',
      activityType: activity.activityType,
      amount: activity.amount,
      currency: activity.currency ?? 'CLP',
      date: activity.activityDate as string,
      comment: activity.comment ?? '',
      metadata: activity.metadata,
    });

    expect(reread?.financialCost?.kind).toBe(FinancialCostKind.collection);
    expect(reread?.financialCost?.matchedText).toBeUndefined();
    expect(reread?.kind).toBe(TransactionKind.fee);
  });

  it('una fila sin costo se relee sin costo', () => {
    const row = find('SUPERMERCADO GENERICO SUCURSAL CENTRO');
    const activity = toActivityCreate(row, { accountId: 'acct-cmr', runId: 'run-1' });

    const reread = activityToTransaction({
      id: 'a2',
      accountId: 'acct-cmr',
      activityType: activity.activityType,
      amount: activity.amount,
      currency: activity.currency ?? 'CLP',
      date: activity.activityDate as string,
      comment: activity.comment ?? '',
      metadata: activity.metadata,
    });

    expect(reread?.financialCost).toBeUndefined();
  });
});
