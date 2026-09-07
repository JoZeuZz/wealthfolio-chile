import { describe, expect, it } from 'vitest';
import { detectFinancialCost } from '../src/core/chile/financial-costs';
import {
  FINANCIAL_COST_KINDS,
  FinancialCostKind,
  financialCostLabel,
  isCostOfBorrowing,
  transactionKindForCost,
} from '../src/core/model/financial-cost';
import { Confidence, TransactionKind } from '../src/core/model/kinds';
import { normalizeDescription } from '../src/core/text';

const read = (description: string) => detectFinancialCost(normalizeDescription(description));

/**
 * La NCG 537 de la CMF tuvo que enumerar los costos de una tarjeta para poder
 * definir el Monto No Financiable, y el glosario del reglamento de información
 * al consumidor los define uno por uno. Esa lista es la especificación: no es
 * vocabulario observado en una cartola, es vocabulario publicado por el
 * regulador, y por eso se puede modelar sin tener una cartola real delante.
 *
 * Lo que la dimensión responde es qué clase de costo es una línea. Lo que
 * deliberadamente no responde es cuánto debería costar: la fórmula del pago
 * mínimo, la CAE y el CTC son cálculos del emisor, no del addon.
 */
describe('la taxonomía de costo financiero', () => {
  it('cada costo pertenece a un tipo de movimiento que el host ya sabe expresar', () => {
    for (const cost of FINANCIAL_COST_KINDS) {
      const kind = transactionKindForCost(cost);
      expect([TransactionKind.fee, TransactionKind.interest, TransactionKind.tax]).toContain(kind);
    }
  });

  it('todos los intereses son intereses, no comisiones', () => {
    expect(transactionKindForCost(FinancialCostKind.revolving_interest)).toBe(
      TransactionKind.interest,
    );
    expect(transactionKindForCost(FinancialCostKind.late_interest)).toBe(TransactionKind.interest);
    expect(transactionKindForCost(FinancialCostKind.installment_interest)).toBe(
      TransactionKind.interest,
    );
    expect(transactionKindForCost(FinancialCostKind.cash_advance_interest)).toBe(
      TransactionKind.interest,
    );
  });

  it('el impuesto al crédito es un impuesto, no una comisión', () => {
    expect(transactionKindForCost(FinancialCostKind.credit_tax)).toBe(TransactionKind.tax);
  });

  /**
   * Deber cuesta plata y tener la tarjeta cuesta plata, y no son la misma
   * pregunta. La mantención se paga aunque el saldo esté en cero; la mora sólo
   * aparece porque hubo deuda impaga.
   */
  it('separa el costo de deber del costo de tener el instrumento', () => {
    expect(isCostOfBorrowing(FinancialCostKind.late_interest)).toBe(true);
    expect(isCostOfBorrowing(FinancialCostKind.revolving_interest)).toBe(true);
    expect(isCostOfBorrowing(FinancialCostKind.collection)).toBe(true);
    expect(isCostOfBorrowing(FinancialCostKind.credit_tax)).toBe(true);
    expect(isCostOfBorrowing(FinancialCostKind.cash_advance_interest)).toBe(true);

    expect(isCostOfBorrowing(FinancialCostKind.maintenance)).toBe(false);
    expect(isCostOfBorrowing(FinancialCostKind.international_purchase)).toBe(false);
  });

  it('todos tienen nombre en español para la interfaz', () => {
    for (const cost of FINANCIAL_COST_KINDS) {
      expect(financialCostLabel(cost).length).toBeGreaterThan(3);
    }
  });
});

describe('leer el costo que la glosa nombra', () => {
  it('reconoce el interés por mora con la redacción de la norma', () => {
    expect(read('INTERES POR MORA')?.kind).toBe(FinancialCostKind.late_interest);
    expect(read('INTERESES MORATORIOS')?.kind).toBe(FinancialCostKind.late_interest);
    expect(read('INTERES MORATORIO TARJETA')?.kind).toBe(FinancialCostKind.late_interest);
  });

  it('reconoce el interés rotativo y el refundido como lo mismo', () => {
    expect(read('INTERES ROTATIVO')?.kind).toBe(FinancialCostKind.revolving_interest);
    expect(read('INTERES ADICIONAL')?.kind).toBe(FinancialCostKind.revolving_interest);
    expect(read('INTERESES REFUNDIDOS')?.kind).toBe(FinancialCostKind.revolving_interest);
  });

  it('distingue el interés de una compra en cuotas', () => {
    expect(read('INTERES COMPRA EN CUOTAS')?.kind).toBe(FinancialCostKind.installment_interest);
    expect(read('INTERES CUOTAS')?.kind).toBe(FinancialCostKind.installment_interest);
  });

  it('distingue el interés cobrado por un avance de su principal', () => {
    expect(read('INTERES POR AVANCE EN EFECTIVO')?.kind).toBe(
      FinancialCostKind.cash_advance_interest,
    );
  });

  it('reconoce la comisión de mantención y la de administración', () => {
    expect(read('COMISION DE MANTENCION')?.kind).toBe(FinancialCostKind.maintenance);
    expect(read('COMISION MANTENCION TARJETA')?.kind).toBe(FinancialCostKind.maintenance);
    // `ADMINISTRACION` a secas no alcanza: es también la comisión de un fondo
    // mutuo o de un edificio. El reglamento nombra el producto; el patrón
    // también.
    expect(read('COMISION DE ADMINISTRACION TARJETA')?.kind).toBe(FinancialCostKind.maintenance);
  });

  it('una comisión de mantención de edificio no es costo de la tarjeta', () => {
    expect(read('COMISION DE MANTENCION EDIFICIO')).toMatchObject({
      kind: FinancialCostKind.other,
      confidence: Confidence.suggested,
    });
  });

  it('reconoce la comisión por compra internacional', () => {
    expect(read('COMISION COMPRA INTERNACIONAL')?.kind).toBe(
      FinancialCostKind.international_purchase,
    );
    expect(read('COMISION INTERNACIONAL')?.kind).toBe(FinancialCostKind.international_purchase);
  });

  it('reconoce la comisión de avance, que no es el avance', () => {
    expect(read('COMISION POR AVANCE EN EFECTIVO')?.kind).toBe(FinancialCostKind.cash_advance_fee);
    expect(read('COMISION AVANCE EXTRANJERO')?.kind).toBe(FinancialCostKind.cash_advance_fee);
  });

  it('reconoce los gastos de cobranza', () => {
    expect(read('GASTOS DE COBRANZA')?.kind).toBe(FinancialCostKind.collection);
  });

  it('reconoce el impuesto al crédito bajo sus dos nombres', () => {
    expect(read('IMPUESTO AL CREDITO')?.kind).toBe(FinancialCostKind.credit_tax);
    expect(read('IMPUESTO DE TIMBRES Y ESTAMPILLAS')?.kind).toBe(FinancialCostKind.credit_tax);
  });

  /**
   * Una comisión que la glosa no explica sigue siendo una comisión. Decir
   * `other` es más honesto que elegir la subcategoría más común y más útil que
   * no decir nada: la línea entra igual al total de costos.
   */
  it('una comisión sin apellido es un costo sin clasificar, no un no-costo', () => {
    const reading = read('COMISION');
    expect(reading?.kind).toBe(FinancialCostKind.other);
    expect(reading?.confidence).toBe(Confidence.suggested);
  });

  it('lo específico gana a lo genérico', () => {
    expect(read('COMISION POR AVANCE EN EFECTIVO')?.confidence).toBe(Confidence.confirmed);
    expect(read('COMISION DE MANTENCION')?.confidence).toBe(Confidence.confirmed);
  });

  it('devuelve el texto que lo nombró, para poder mostrar el porqué', () => {
    expect(read('CARGO INTERES POR MORA MARZO')?.matchedText).toBe('INTERES POR MORA');
  });
});

/**
 * El precio de una dimensión nueva es el falso positivo. Estas glosas contienen
 * las letras de un costo financiero y no son uno; la de arriba, `MORANDE`, es
 * una calle del centro de Santiago y aparecería en cualquier cartola con
 * compras en el barrio.
 */
describe('las palabras que sólo parecen costos financieros', () => {
  it('una dirección que contiene MORA no es interés por mora', () => {
    expect(read('RESTAURANT MORANDE 115')).toBeUndefined();
    expect(read('PANADERIA LA MORA')).toBeUndefined();
  });

  it('un servicio de mantención contratado no es la comisión de la tarjeta', () => {
    expect(read('MANTENCION DE JARDINES SPA')).toBeUndefined();
    expect(read('MANTENCION ASCENSORES')).toBeUndefined();
  });

  it('una empresa de cobranza en la glosa no basta por sí sola', () => {
    expect(read('COBRANZAS DEL PACIFICO LTDA')).toBeUndefined();
  });

  it('un interés ganado en una cuenta de ahorro no es un costo de deber', () => {
    // La dirección la decide el pipeline, no esta función: aquí sólo importa
    // que `ABONO INTERESES` no se lea como un cargo con apellido.
    expect(read('ABONO INTERESES AHORRO')).toBeUndefined();
  });

  it('una glosa sin ninguna de estas palabras no devuelve nada', () => {
    expect(read('SUPERMERCADO LIDER LAS CONDES')).toBeUndefined();
    expect(read('')).toBeUndefined();
  });
});
