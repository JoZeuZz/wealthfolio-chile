import { describe, expect, it } from 'vitest';
import { readCardFacts } from '../src/core/providers/card-facts';

const read = (preamble: string, currency = 'CLP') => readCardFacts({ preamble, currency });

/**
 * Lo que un review especializado encontró en la primera versión del extractor
 * de hechos, ejecutándolo contra preámbulos chilenos plausibles.
 *
 * Todos los casos comparten el mismo modo de falla y es el peor posible para
 * este modelo: basura entrando marcada como `declared`. El tipo existe para que
 * un dato calculado no se confunda con uno impreso por el emisor, y no servía
 * de nada mientras un punto, un RUT o el día de una fecha pudieran entrar por
 * esa misma puerta con la misma etiqueta.
 */
describe('la leyenda que la norma obliga a imprimir', () => {
  /**
   * `AMOUNT` aceptaba `[\d.,]+`, que matchea un punto suelto, y un punto se
   * parsea como cero. La frase de advertencia sobre el pago mínimo aparece en
   * toda cartola de tarjeta por mandato del reglamento, y producía justo el
   * dato que este modelo promete no producir nunca.
   */
  it('no convierte el punto de una frase en un pago mínimo de cero', () => {
    const facts = read('Si usted paga solo el pago minimo, su deuda tardara mas en extinguirse.');
    expect(facts.minimumPayment).toBeUndefined();
  });

  it('tampoco lee un cero de un "no aplica."', () => {
    expect(read('Pago Minimo: no aplica.').minimumPayment).toBeUndefined();
  });
});

/**
 * El hueco entre la etiqueta y la cifra se buscaba sobre el preámbulo entero,
 * y la clase de caracteres incluía el salto de línea. Una etiqueta suelta en su
 * línea alcanzaba el primer número de la línea siguiente — que en una cartola
 * es el RUT del titular.
 */
describe('lo que hay en la línea de al lado', () => {
  it('no toma el RUT del titular como un cupo', () => {
    const facts = read(
      ['Cupo Total', 'Titular JUAN PEREZ GONZALEZ RUT 12.345.678-9'].join('\n'),
    );
    expect(facts.creditLimit).toBeUndefined();
    expect(JSON.stringify(facts)).not.toContain('12345678');
  });

  /**
   * Una cartola exportada a Excel pone las etiquetas en una fila y los valores
   * en la siguiente. Cruzando líneas, cada etiqueta se llevaba el primer número
   * de la fila de valores: el cupo total salía informado como cupo disponible,
   * y el usuario creía tener libres tres millones.
   */
  it('no reparte la fila de valores de un Excel entre todas las etiquetas', () => {
    const facts = read(
      ['Cupo Total Cupo Utilizado Cupo Disponible', '$3.000.000 $1.912.900 $1.087.100'].join('\n'),
    );
    expect(facts.availableCredit).toBeUndefined();
  });
});

/**
 * Un número pegado a una etiqueta no es necesariamente un monto. En una cartola
 * los que estorban son los días de una fecha y los contadores de cuotas.
 */
describe('números que no son dinero', () => {
  it('no lee el día de una fecha como el cupo disponible', () => {
    expect(read('CUPO DISPONIBLE al 05/10/2026 $1.087.100').availableCredit).toBeUndefined();
  });

  it('no lee un número de cuotas como el monto facturado', () => {
    expect(read('TOTAL A PAGAR EN 12 CUOTAS DE $35.000').billedAmount).toBeUndefined();
  });

  it('sigue leyendo un monto normal', () => {
    expect(read('TOTAL A PAGAR: $412.900').billedAmount?.value.minor).toBe(412_900);
    expect(read('Pago Minimo $35.000').minimumPayment?.value.minor).toBe(35_000);
  });
});

/**
 * Una etiqueta puede aparecer dos veces: el pago mínimo del período anterior es
 * una línea estándar, y el talón desprendible del pie repite el total. Ganaba la
 * primera ocurrencia sin que nada notara el desacuerdo.
 */
describe('la misma etiqueta, dos veces', () => {
  /**
   * El pago mínimo del período anterior es una línea estándar y no es el pago
   * mínimo de este ciclo: se distingue por su nombre, no descartando los dos.
   */
  it('el mínimo del período anterior no compite con el de este ciclo', () => {
    const facts = read(
      ['PAGO MINIMO PERIODO ANTERIOR $30.000', 'PAGO MINIMO $54.355'].join('\n'),
    );
    expect(facts.minimumPayment?.value.minor).toBe(54_355);
  });

  /**
   * Cuando sí es la misma etiqueta dos veces —el talón desprendible del pie
   * repite el total— y las cifras no coinciden, la etiqueta no alcanza para
   * este estado de cuenta. Eso se arregla contra una cartola real, no eligiendo
   * una de las dos.
   */
  it('no elige una de dos cifras que no coinciden', () => {
    const facts = read(['TOTAL A PAGAR $412.900', 'TOTAL A PAGAR $99.000'].join('\n'));
    expect(facts.billedAmount).toBeUndefined();
  });

  it('dos veces la misma cifra sí es un hecho', () => {
    const facts = read(['TOTAL A PAGAR $412.900', 'TOTAL A PAGAR $412.900'].join('\n'));
    expect(facts.billedAmount?.value.minor).toBe(412_900);
  });
});

/**
 * El signo se borraba en todos los campos con el argumento de que un pago
 * mínimo significa lo mismo con cualquier signo. Eso vale para el mínimo y para
 * el cupo total, y no para los otros tres: un cupo disponible negativo es un
 * cupo excedido, y un total a pagar negativo es plata a favor de quien pagó de
 * más.
 */
describe('el signo que sí significa algo', () => {
  it('un cupo excedido no es cupo disponible', () => {
    expect(read('Cupo Disponible: -$120.000').availableCredit?.value.minor).toBe(-120_000);
  });

  it('un saldo a favor no es deuda', () => {
    expect(read('TOTAL A PAGAR: ($45.230)').billedAmount?.value.minor).toBe(-45_230);
  });

  it('el pago mínimo y el cupo total siguen siendo magnitudes', () => {
    expect(read('Pago Minimo: $-35.000').minimumPayment?.value.minor).toBe(35_000);
    expect(read('Cupo Total: ($1.500.000)').creditLimit?.value.minor).toBe(1_500_000);
  });
});

/**
 * La deuda en moneda extranjera se parseaba con la moneda del estado de cuenta.
 * Una deuda de US$450 quedaba anotada como $450 pesos, sumable con la deuda
 * nacional sin ningún tipo de cambio — que es exactamente lo que el modelo dice
 * que no se puede hacer.
 */
describe('la deuda que no está en pesos', () => {
  it('no anota dólares como si fueran pesos', () => {
    const facts = read('Deuda en Moneda Extranjera: US$ 450,25');
    expect(facts.foreignDebt?.value.currency).not.toBe('CLP');
  });

  it('sin saber la moneda no registra el hecho', () => {
    expect(read('Deuda en Moneda Extranjera: 450,25').foreignDebt).toBeUndefined();
  });

  it('la deuda nacional sigue en la moneda del estado de cuenta', () => {
    expect(read('Deuda Nacional: $300.000').domesticDebt?.value.currency).toBe('CLP');
  });
});

/**
 * `FECHA DE PAGO` es la del último pago recibido tanto como la del próximo, y
 * una cartola de tarjeta trae vencimientos que no son el suyo: el de la póliza
 * del seguro de desgravamen, por ejemplo.
 */
describe('fechas que no son el vencimiento', () => {
  it('la fecha del último pago recibido no es el vencimiento', () => {
    expect(read('Ultimo pago recibido. Fecha de pago 05/02/2026.').dueDate).toBeUndefined();
  });

  it('el vencimiento de una póliza tampoco', () => {
    expect(read('Fecha de vencimiento poliza 01/01/2027').dueDate).toBeUndefined();
  });

  it('PAGAR HASTA sigue siendo el vencimiento', () => {
    expect(read('PAGAR HASTA: 05/10/2026').dueDate?.value).toBe('2026-10-05');
  });
});
