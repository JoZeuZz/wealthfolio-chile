import { describe, expect, it } from 'vitest';
import { readCardFacts } from '../src/core/providers/card-facts';

const read = (preamble: string, currency = 'CLP') => readCardFacts({ preamble, currency });

/**
 * Cuarta y última pasada, calibrada a lo que puede aparecer en una cartola
 * chilena de verdad y no a un preámbulo construido para romper el patrón. Tres
 * hallazgos, ninguno P0: dos de ellos son etiquetas legítimas que el
 * endurecimiento de las rondas anteriores había dejado mudas.
 */
describe('el cupo de avance no es el cupo de la tarjeta', () => {
  /**
   * Todo emisor chileno separa el cupo de compras del cupo de avance en
   * efectivo, y la línea rara vez trae el «para» que el veto conocía: se
   * imprime «Cupo Disponible en Efectivo», «Avance en Efectivo» o —en CMR—
   * «Súper Avance».
   */
  it('el disponible en efectivo no es el disponible de la tarjeta', () => {
    expect(read('CUPO DISPONIBLE EN EFECTIVO $500.000').availableCredit).toBeUndefined();
    expect(read('Cupo Disponible Avance en Efectivo $500.000').availableCredit).toBeUndefined();
    expect(read('MONTO DISPONIBLE EN EFECTIVO $500.000').availableCredit).toBeUndefined();
    expect(read('CUPO DISPONIBLE SUPER AVANCE $500.000').availableCredit).toBeUndefined();
  });

  it('ni el cupo total de avances es el cupo total', () => {
    expect(read('CUPO TOTAL EN EFECTIVO $600.000').creditLimit).toBeUndefined();
  });

  it('el cupo de la tarjeta se sigue leyendo', () => {
    expect(read('CUPO DISPONIBLE $1.765.433').availableCredit?.value.minor).toBe(1_765_433);
    expect(read('CUPO TOTAL $3.000.000').creditLimit?.value.minor).toBe(3_000_000);
  });
});

/**
 * `CUENTA N°` y `TARJETA N°` marcan una línea como portadora de un
 * identificador. Escritos como prefijo de una `N` suelta mordían `NACIONAL`,
 * que es justo el nombre de la sección que este modelo distingue — y sólo ese
 * lado, porque `INTERNACIONAL` no empieza con `N`.
 *
 * La asimetría es lo peor: sobre una cartola con las dos secciones sobrevivía
 * la deuda en dólares y desaparecía la de pesos, en un modelo cuyo propósito
 * declarado es que esas dos no se puedan sumar.
 */
describe('una sección nacional no es un número de cuenta', () => {
  it('lee la deuda nacional aunque la fila diga CUENTA NACIONAL', () => {
    expect(read('CUENTA NACIONAL DEUDA NACIONAL $1.234.567').domesticDebt?.value.minor).toBe(
      1_234_567,
    );
  });

  it('y el total de una sección de tarjeta nacional', () => {
    expect(read('TARJETA NACIONAL TOTAL A PAGAR $150.000').billedAmount?.value.minor).toBe(
      150_000,
    );
  });

  it('un número de cuenta o de tarjeta de verdad sigue vetando la línea', () => {
    expect(read('CUENTA N° 00-123-45678-90 CUPO TOTAL $3.000.000').creditLimit).toBeUndefined();
    expect(read('TARJETA NRO 4557 8812 3456 1234 CUPO TOTAL $3.000.000').creditLimit).toBeUndefined();
  });
});

/**
 * El paréntesis se excluyó del hueco para que el patrón capturara el negativo
 * contable. El efecto colateral dejó mudas dos convenciones corrientes de una
 * planilla: la unidad en la celda de encabezado y el llamado a nota al pie, que
 * es donde una cartola chilena cuelga el texto legal del pago mínimo.
 */
describe('un paréntesis entre la etiqueta y la cifra', () => {
  it('la unidad entre paréntesis no impide leer la cifra', () => {
    expect(read('TOTAL A PAGAR ($) 150.000').billedAmount?.value.minor).toBe(150_000);
    expect(read('CUPO DISPONIBLE (CLP) 1.765.433').availableCredit?.value.minor).toBe(1_765_433);
  });

  it('el llamado a nota al pie tampoco', () => {
    expect(read('PAGO MINIMO (1) $12.500').minimumPayment?.value.minor).toBe(12_500);
    expect(read('PAGO MINIMO (*) $12.500').minimumPayment?.value.minor).toBe(12_500);
  });

  /**
   * Y el paréntesis que sí es un signo sigue siendo un signo: un total a pagar
   * negativo es plata a favor de quien pagó de más.
   */
  it('el negativo contable sigue leyéndose como negativo', () => {
    expect(read('TOTAL A PAGAR ($45.230)').billedAmount?.value.minor).toBe(-45_230);
  });
});
