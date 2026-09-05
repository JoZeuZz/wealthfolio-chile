import { describe, expect, it } from 'vitest';
import { defaultKindForRow } from '../src/core/classify/card-semantics';
import { resolveActivityType } from '../src/core/mapping/activities';
import {
  Confidence,
  Direction,
  isSpending,
  NON_SPENDING_KINDS,
  TransactionKind,
} from '../src/core/model/kinds';
import { StatementProduct } from '../src/core/model/statement';

const card = (description: string) =>
  defaultKindForRow({
    product: StatementProduct.credit_card,
    direction: Direction.out,
    description,
  });

const account = (description: string) =>
  defaultKindForRow({
    product: StatementProduct.checking,
    direction: Direction.out,
    description,
  });

/**
 * Un avance en efectivo no es una compra.
 *
 * El reglamento lo define como la operación en que el emisor "otorga un
 * préstamo o mutuo de dinero" contra el cupo. Económicamente son dos hechos —
 * nace deuda y sale efectivo — y en la cartola se ve uno solo. El addon no
 * puede partirlo en dos sin inventar la contraparte, y hacerlo sería construir
 * un ledger paralelo al de Wealthfolio, que es exactamente lo que este proyecto
 * no hace.
 *
 * Lo que sí puede hacer es dejar de llamarlo consumo. Hasta ahora un
 * `AVANCE EN EFECTIVO` sólo recibía la etiqueta `efectivo` y quedaba como
 * `credit_card_purchase`: en el panel se veía igual que ir al supermercado.
 */
describe('el avance en efectivo tiene su propia clasificación', () => {
  it('un avance en la tarjeta no es una compra con tarjeta', () => {
    expect(card('AVANCE EN EFECTIVO').kind).toBe(TransactionKind.cash_advance);
    expect(card('AVANCE EFECTIVO CAJERO').kind).toBe(TransactionKind.cash_advance);
    expect(card('SUPER AVANCE 12 CUOTAS').kind).toBe(TransactionKind.cash_advance);
  });

  it('la glosa lo nombró, así que no es una suposición del producto', () => {
    expect(card('AVANCE EN EFECTIVO').confidence).toBe(Confidence.confirmed);
  });

  /**
   * `AVANCE` a secas puede ser el nombre de un comercio. En una tarjeta es
   * casi seguro un avance, y por eso se clasifica igual, pero como algo que el
   * usuario todavía puede desmentir.
   */
  it('un avance sin apellido se clasifica, pero pidiendo revisión', () => {
    const reading = card('AVANCE');
    expect(reading.kind).toBe(TransactionKind.cash_advance);
    expect(reading.confidence).toBe(Confidence.suggested);
  });

  it('la comisión del avance es la comisión, no el avance', () => {
    expect(card('COMISION POR AVANCE EN EFECTIVO').kind).not.toBe(TransactionKind.cash_advance);
  });

  /**
   * Un giro de cajero contra una cuenta corriente mueve dinero propio: cambia
   * de forma, no de dueño, y no genera deuda. Compartían regla y no comparten
   * significado.
   */
  it('un giro de cajero en una cuenta no es un avance', () => {
    expect(account('GIRO CAJERO AUTOMATICO').kind).not.toBe(TransactionKind.cash_advance);
    expect(account('AVANCE EN EFECTIVO').kind).not.toBe(TransactionKind.cash_advance);
  });

  it('una compra normal en la tarjeta sigue siendo una compra', () => {
    expect(card('SUPERMERCADO LIDER LAS CONDES').kind).toBe(TransactionKind.credit_card_purchase);
  });
});

describe('qué hace el avance con los totales', () => {
  /**
   * El efectivo salió del alcance de la herramienta y se gastó: contarlo es la
   * misma decisión que ya se tomó para el giro de cajero de una cuenta. Y no
   * hay doble conteo, porque el pago posterior de la tarjeta ya está fuera del
   * gasto.
   */
  it('cuenta como gasto del mes en que se retiró', () => {
    expect(isSpending(TransactionKind.cash_advance, Direction.out)).toBe(true);
    expect(NON_SPENDING_KINDS.has(TransactionKind.cash_advance)).toBe(false);
  });

  it('no cuenta como gasto en la dirección contraria', () => {
    expect(isSpending(TransactionKind.cash_advance, Direction.in)).toBe(false);
  });
});

describe('cómo llega el avance a Wealthfolio', () => {
  /**
   * El host no tiene un tipo para "préstamo contra el cupo". `WITHDRAWAL` es el
   * mismo que ya usa una compra con tarjeta, y es el menos incorrecto: el
   * dinero salió. La distinción chilena viaja en la metadata del addon, no en
   * un `ActivityType` inventado.
   */
  it('se escribe como WITHDRAWAL, igual que una compra', () => {
    expect(
      resolveActivityType({ kind: TransactionKind.cash_advance, direction: Direction.out }),
    ).toEqual({ activityType: 'WITHDRAWAL' });
  });

  it('en una cuenta de tarjeta del host no necesita sustitución', () => {
    const resolved = resolveActivityType(
      { kind: TransactionKind.cash_advance, direction: Direction.out },
      { accountType: 'CREDIT_CARD' },
    );
    expect(resolved.activityType).toBe('WITHDRAWAL');
    expect(resolved.substituted).toBeUndefined();
  });
});
