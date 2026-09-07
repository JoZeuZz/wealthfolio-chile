import { describe, expect, it } from 'vitest';
import { readCardFacts } from '../src/core/providers/card-facts';

const read = (preamble: string, currency = 'CLP') => readCardFacts({ preamble, currency });

/**
 * Tercera pasada adversarial sobre el extractor de hechos.
 *
 * Las dos anteriores cerraron el cruce entre líneas. Ésta encontró que la misma
 * clase de error sobrevivía **dentro** de una línea: una fila de resumen de un
 * Excel llega aplanada, con dos etiquetas y dos valores seguidos, y el hueco
 * entre una etiqueta y su cifra podía saltarse la etiqueta de al lado.
 */
describe('una corrida de dígitos que no es un monto', () => {
  /**
   * El umbral frenaba tres dígitos, así que un año y las cuatro últimas cifras
   * de una tarjeta —cuatro dígitos exactos— pasaban. La segunda es además una
   * fuga: la cola de la tarjeta terminaba dibujada como un monto en la vista
   * previa.
   */
  it('un año no es el monto facturado', () => {
    expect(read('TOTAL A PAGAR OCTUBRE 2026 $ 150.000').billedAmount?.value.minor).not.toBe(2_026);
    expect(read('EL PAGO MINIMO VIGENTE DESDE 2026 ES OBLIGATORIO').minimumPayment).toBeUndefined();
  });

  it('la cola de una tarjeta no es el cupo disponible', () => {
    const facts = read('TARJETA VISA CUPO DISPONIBLE TERMINADA EN 4021 $ 2.850.000');
    expect(JSON.stringify(facts)).not.toContain('4021');
  });

  it('un número de sucursal tampoco', () => {
    expect(read('CUPO TOTAL SUCURSAL 4521').creditLimit).toBeUndefined();
  });

  /**
   * La defensa deja de depender de cuántos dígitos tiene la corrida: un monto
   * en pesos impreso en una cartola lleva separador de miles o signo de moneda,
   * y un identificador no lleva ninguno de los dos.
   */
  it('una cifra con separador o con signo de moneda se sigue leyendo', () => {
    expect(read('CUPO TOTAL: $1.500.000').creditLimit?.value.minor).toBe(1_500_000);
    expect(read('PAGO MINIMO $500').minimumPayment?.value.minor).toBe(500);
  });
});

/**
 * `preambleText` une las celdas de una fila con un espacio. Una fila de resumen
 * con dos columnas llega entonces como `ETIQUETA ETIQUETA valor valor`, y el
 * hueco entre la primera etiqueta y la primera cifra cabía dentro del límite
 * saltándose la segunda etiqueta entera.
 */
describe('dos etiquetas seguidas en la misma fila', () => {
  it('la segunda etiqueta no se lleva la cifra de la primera', () => {
    const facts = read('MONTO FACTURADO PAGO MINIMO 150.000 12.500');
    expect(facts.minimumPayment?.value.minor).not.toBe(150_000);
  });

  it('ni la primera la de la segunda', () => {
    const facts = read('PAGO MINIMO MONTO FACTURADO 12.500 150.000');
    expect(facts.billedAmount?.value.minor).not.toBe(12_500);
  });

  it('el cupo total no se informa como cupo disponible', () => {
    const facts = read('CUPO TOTAL CUPO DISPONIBLE 3.000.000 2.850.000');
    expect(facts.availableCredit?.value.minor).not.toBe(3_000_000);
  });

  it('un hueco normal entre etiqueta y cifra sigue funcionando', () => {
    expect(read('PAGO MINIMO DE LA TARJETA: $35.000').minimumPayment?.value.minor).toBe(35_000);
    expect(read('TOTAL A PAGAR EN PESOS $412.900').billedAmount?.value.minor).toBe(412_900);
  });
});

/**
 * La ventana en que se busca la moneda miraba cuatro caracteres más allá del
 * final del match, y como el match ya se come los espacios finales, esos cuatro
 * caían sobre el principio de la celda siguiente — que en un resumen es la
 * columna en dólares.
 */
describe('la moneda de la celda de al lado', () => {
  it('un saldo en pesos con su equivalente al lado sigue siendo en pesos', () => {
    expect(read('SALDO ADEUDADO $ 1.200.000 (US$ 1.250)').totalDebt?.value.currency).toBe('CLP');
  });

  it('la deuda nacional no se contagia de la columna en dólares', () => {
    const facts = read('DEUDA NACIONAL 1.200.000 USD 450,00');
    expect(facts.domesticDebt?.value.currency).not.toBe('USD');
  });

  it('el marcador que sí acompaña a su cifra se sigue leyendo', () => {
    expect(read('SALDO EN MONEDA EXTRANJERA US$ 450,00').foreignDebt?.value.currency).toBe('USD');
  });
});

/**
 * El seguro de desgravamen es línea de rutina en una cartola de tarjeta chilena
 * y tiene vencimiento propio. El veto cubría `VENCIMIENTO POLIZA` pero no
 * `VENCIMIENTO DE LA POLIZA`, así que o el usuario veía la fecha de la póliza
 * como fecha de pago, o —cuando ambas aparecían— perdía la de pago por
 * desacuerdo.
 */
describe('vencimientos que no son el del estado de cuenta', () => {
  it('el de una póliza o un seguro no es la fecha de pago', () => {
    expect(read('FECHA DE VENCIMIENTO DE LA POLIZA 15/10/2026').dueDate).toBeUndefined();
    expect(read('FECHA DE VENCIMIENTO DEL SEGURO 15/10/2026').dueDate).toBeUndefined();
    expect(read('FECHA DE VENCIMIENTO DE LA CUOTA 15/10/2026').dueDate).toBeUndefined();
  });

  it('y no le quita el vencimiento real al estado de cuenta', () => {
    const facts = read(
      ['PAGAR HASTA 20/10/2026', 'FECHA DE VENCIMIENTO DE LA POLIZA 15/10/2026'].join('\n'),
    );
    expect(facts.dueDate?.value).toBe('2026-10-20');
  });
});

/**
 * El filtro de cifras del ciclo pasado conocía cuatro palabras y le faltaban
 * las simétricas. Es el mismo hallazgo que la ronda anterior, con el vocabulario
 * completo.
 */
describe('las otras formas de decir «el mes pasado»', () => {
  it('el pago mínimo del mes pasado tampoco es el de éste', () => {
    expect(read('PAGO MINIMO MES PASADO $ 9.000').minimumPayment).toBeUndefined();
    expect(read('TOTAL A PAGAR FACTURACION PREVIA $ 90.000').billedAmount).toBeUndefined();
  });
});

/**
 * Formas de imprimir un monto que una cartola chilena usa y que se estaban
 * perdiendo. Un falso negativo es el lado correcto del error, pero no cuando lo
 * causa una convención tipográfica del propio país.
 */
describe('notación chilena que sí es un monto', () => {
  it('lee el cierre con punto y guion', () => {
    expect(read('TOTAL A PAGAR $150.000.-').billedAmount?.value.minor).toBe(150_000);
  });

  it('lee una cifra tras un relleno de puntos', () => {
    expect(
      read('CUPO TOTAL ............................ 3.000.000').creditLimit?.value.minor,
    ).toBe(3_000_000);
  });

  it('lee un signo positivo explícito', () => {
    expect(read('TOTAL A PAGAR + $150.000').billedAmount?.value.minor).toBe(150_000);
  });
});
