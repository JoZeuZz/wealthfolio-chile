import { describe, expect, it } from 'vitest';
import { readCardFacts } from '../src/core/providers/card-facts';

const read = (preamble: string, currency = 'CLP') => readCardFacts({ preamble, currency });

/**
 * Segunda ronda del reviewer de hechos del estado de cuenta.
 *
 * El hallazgo que habilita a casi todos los demás es de otro archivo:
 * `preambleText` une las celdas de una fila con un espacio, así que **una fila
 * de resumen de un Excel es una sola línea** con todas sus columnas dentro. La
 * regla «una línea a la vez», que resolvió la ronda anterior, no protege contra
 * una fila que trae nacional e internacional, o cupo total y cupo utilizado,
 * una al lado de la otra.
 */
describe('una fila con dos columnas de moneda', () => {
  /**
   * La moneda se decidía mirando la línea entera, así que la columna
   * internacional teñía a la nacional. `domesticDebt` existe precisamente para
   * no sumarse con `foreignDebt` sin tipo de cambio, y quedaban las dos en USD.
   */
  it('no marca en dólares un monto en pesos de la misma fila', () => {
    const facts = read('DEUDA NACIONAL 1.234.567 DEUDA EN DOLARES 450,00');
    expect(facts.domesticDebt?.value.currency).not.toBe('USD');
  });

  it('no marca en dólares un total que sólo menciona el equivalente', () => {
    const facts = read('TOTAL A PAGAR $450.000 (equivalente a USD 480)');
    expect(facts.billedAmount?.value.currency).not.toBe('USD');
  });

  /**
   * Dos lecturas de la misma etiqueta que difieren por cien veces tenían la
   * misma `minor` —150000 en escala 0 y 150000 en escala 2— así que la única
   * salvaguarda que debía anular el caso no se activaba.
   */
  it('dos lecturas que difieren por escala no son un acuerdo', () => {
    const facts = read('TOTAL A PAGAR NACIONAL $150.000 TOTAL A PAGAR INTERNACIONAL US$ 1.500,00');
    expect(facts.billedAmount).toBeUndefined();
  });
});

/**
 * «Pago mínimo mes anterior» es una línea estándar de una cartola chilena. El
 * guard era un lookahead de una sola palabra sobre una sola etiqueta, y las
 * cifras del ciclo pasado entraban como las de éste.
 */
describe('las cifras del ciclo anterior', () => {
  it('el pago mínimo del mes anterior no es el de este mes', () => {
    expect(read('PAGO MINIMO DEL PERIODO ANTERIOR: $50.000').minimumPayment).toBeUndefined();
    expect(read('PAGO MINIMO MES ANTERIOR $50.000').minimumPayment).toBeUndefined();
    expect(read('MONTO MINIMO A PAGAR PERIODO ANTERIOR $50.000').minimumPayment).toBeUndefined();
  });

  it('tampoco el total ni el saldo del período anterior', () => {
    expect(read('TOTAL A PAGAR MES ANTERIOR $380.000').billedAmount).toBeUndefined();
    expect(read('SALDO ADEUDADO ANTERIOR $1.900.000').totalDebt).toBeUndefined();
  });

  it('el período de facturación anterior no es el de este estado', () => {
    expect(
      read('PERIODO DE FACTURACION ANTERIOR 01/08/2026 AL 31/08/2026').billingPeriod,
    ).toBeUndefined();
  });

  it('dos períodos distintos no se resuelven eligiendo uno', () => {
    const facts = read(
      [
        'PERIODO DE FACTURACION 01/09/2026 AL 30/09/2026',
        'PERIODO DE FACTURACION 01/08/2026 AL 31/08/2026',
      ].join('\n'),
    );
    expect(facts.billingPeriod).toBeUndefined();
  });
});

/**
 * El bug del RUT otra vez, con los identificadores que nadie había enumerado.
 * Con celdas unidas, la etiqueta queda en una columna y el identificador en la
 * siguiente.
 */
describe('los otros identificadores chilenos', () => {
  it('un número de cliente no es un cupo', () => {
    expect(read('CUPO TOTAL  NRO CLIENTE 12345678').creditLimit).toBeUndefined();
  });

  it('un folio no es el monto facturado', () => {
    expect(read('TOTAL A PAGAR  FOLIO 20250930').billedAmount).toBeUndefined();
  });

  it('un código de comercio no es dinero', () => {
    expect(read('MONTO FACTURADO  COMERCIO 597012345678').billedAmount).toBeUndefined();
  });

  it('un RUT sin guion tampoco', () => {
    expect(read('CUPO TOTAL  CLIENTE 123456789').creditLimit).toBeUndefined();
  });

  /**
   * La defensa de fondo no es la lista de nombres —siempre faltará uno— sino la
   * forma: una cifra en pesos impresa en una cartola lleva separador de miles,
   * y ninguno de estos identificadores lo lleva.
   */
  it('una corrida larga de dígitos sin separador no es un monto', () => {
    expect(read('CUPO DISPONIBLE  SERIE A012345678').availableCredit).toBeUndefined();
  });
});

/**
 * Los patrones eran prefijos, así que la etiqueta se llevaba la cifra de su
 * propio sub-concepto. `CUPO TOTAL UTILIZADO` es el peor de todos: informaba
 * como cupo total exactamente la cifra contraria.
 */
describe('etiquetas que son el prefijo de otra cosa', () => {
  it('el cupo utilizado no es el cupo total', () => {
    expect(read('CUPO TOTAL UTILIZADO 1.800.000').creditLimit).toBeUndefined();
  });

  it('el cupo para avances no es el cupo disponible', () => {
    expect(read('CUPO DISPONIBLE PARA AVANCES 500.000').availableCredit).toBeUndefined();
  });

  it('un subtotal nacional no es el total ni la deuda entera', () => {
    expect(read('TOTAL A PAGAR NACIONAL $1.234.567').billedAmount).toBeUndefined();
    expect(read('SALDO ADEUDADO NACIONAL $1.234.567').totalDebt).toBeUndefined();
    expect(read('MONTO FACTURADO NACIONAL $1.234.567').billedAmount).toBeUndefined();
  });

  it('la deuda en dólares no es la deuda total', () => {
    expect(read('DEUDA TOTAL EN DOLARES US$ 450,00').totalDebt).toBeUndefined();
  });

  it('lo que no lleva calificador se sigue leyendo', () => {
    expect(read('CUPO TOTAL: $1.500.000').creditLimit?.value.minor).toBe(1_500_000);
    expect(read('CUPO DISPONIBLE: $200.000').availableCredit?.value.minor).toBe(200_000);
    expect(read('SALDO ADEUDADO: $1.900.000').totalDebt?.value.minor).toBe(1_900_000);
  });
});

/**
 * `money.ts` documenta que el signo al final —`1.234-`— aparece en
 * exportaciones chilenas. La captura terminaba antes del guion, así que ese
 * manejo nunca se ejercía y el signo se perdía: un cupo excedido se mostraba
 * como holgura.
 */
describe('el signo escrito al final', () => {
  it('un cupo excedido escrito con guion final sigue siendo negativo', () => {
    expect(read('CUPO DISPONIBLE 1.200.000-').availableCredit?.value.minor).toBe(-1_200_000);
  });

  it('un saldo a favor escrito con guion final tampoco es deuda', () => {
    expect(read('TOTAL A PAGAR 450.000-').billedAmount?.value.minor).toBe(-450_000);
  });
});

/**
 * El hueco entre etiqueta y cifra se comía el signo peso antes de que el patrón
 * de monto lo viera, de modo que la salvaguarda que acepta una cifra corta
 * cuando lleva símbolo de moneda estaba muerta y `PAGO MINIMO $500` no se leía.
 */
describe('una cifra corta con símbolo de moneda', () => {
  it('se lee, porque el símbolo dice que es dinero', () => {
    expect(read('PAGO MINIMO $500').minimumPayment?.value.minor).toBe(500);
  });

  it('sin símbolo ni separador sigue sin leerse', () => {
    expect(read('PAGO MINIMO 12').minimumPayment).toBeUndefined();
  });
});
