import { describe, expect, it } from 'vitest';
import { activityToTransaction, toActivityCreate } from '../src/core/mapping/activities';
import { attributePayment } from '../src/core/merchants/attribution';
import { Confidence } from '../src/core/model/kinds';
import { makeTransaction } from './fixtures';

const at = (description: string) => attributePayment(description);

/**
 * Procesador no es comercio.
 *
 * Es el hallazgo mejor documentado de toda la investigación chilena, y el único
 * con fuente de un banco: el propio Banco Falabella publica un glosario donde
 * le explica al cliente que `MERCADO PAGO` "puede ser cualquier comercio que
 * acepte Mercado Pago". Flow dice lo mismo de sí mismo en su centro de ayuda.
 * Ni el banco puede resolver el comercio desde la glosa; el addon tampoco, y la
 * respuesta correcta es decirlo, no elegir el nombre que quedó a mano.
 *
 * Lo que este modelo agrega sobre la normalización que ya existía es la
 * pregunta que faltaba: *¿este procesador deja ver el comercio?* La respuesta
 * es una propiedad declarada por procesador, con su nivel de evidencia, no una
 * gramática de prefijos inventada.
 */
describe('un procesador que nunca deja ver el comercio', () => {
  it('no convierte a Mercado Pago en un comercio', () => {
    const result = at('MERCADO PAGO');
    expect(result.processor?.name).toBe('Mercado Pago');
    expect(result.merchant).toBeUndefined();
  });

  /**
   * El `4` y el `5 TCOM` son sufijos internos de ruteo. El glosario del banco
   * los muestra como parte de la misma glosa genérica, y hasta ahora el
   * pipeline los leía como el nombre de un comercio llamado «4 Tcom».
   */
  it('no inventa un comercio con el sufijo de ruteo', () => {
    const result = at('MERCADO PAGO 4 TCOM');
    expect(result.merchant).toBeUndefined();
    expect(result.unresolved).toBe('processor-hides-merchant');
  });

  /**
   * El motivo de no saber es el procesador, no la falta de texto: lo que quede
   * después de `MERCADO PAGO` es sufijo de ruteo, y después de `FLOW` no queda
   * nada. En los dos casos la razón que hay que poder mostrarle al usuario es
   * la misma — este medio de pago no dice a quién le pagaste.
   */
  it('dice que el pago pasó por Flow aunque no sepa por quién', () => {
    const result = at('FLOW');
    expect(result.processor?.name).toBe('Flow');
    expect(result.merchant).toBeUndefined();
    expect(result.unresolved).toBe('processor-hides-merchant');
  });

  it('Servipag recauda para un tercero, no es el tercero', () => {
    expect(at('SERVIPAG').merchant).toBeUndefined();
  });

  /**
   * Una marca conocida en el residuo es evidencia más fuerte que la política
   * del procesador: si la glosa dice Falabella, el comercio es Falabella
   * aunque el cargo haya entrado por Fpay. Como candidato, eso sí — bajo un
   * procesador que oculta el comercio, este archivo afirma que lo que queda no
   * es el comercio, y una marca ahí adentro no puede salir con la confianza
   * más alta del sistema.
   */
  it('una marca reconocible en el residuo gana', () => {
    const result = at('FPAY FALABELLA');
    expect(result.merchant?.name).toBe('Falabella');
    expect(result.merchant?.confidence).toBe(Confidence.suggested);
  });
});

describe('un procesador que cobra en su propio nombre', () => {
  /**
   * Apple y Google no son intermediarios hacia un tercero de la misma forma
   * que Mercado Pago: el cargo es suyo. Son el comercio hasta que la glosa
   * revele el sub-comercio.
   */
  it('Apple es el comercio cuando la glosa no dice más', () => {
    const result = at('APPLE.COM BILL');
    expect(result.merchant?.name).toBe('Apple');
    expect(result.merchant?.confidence).toBe(Confidence.suggested);
  });

  /**
   * `GOOGLE *{Company}` es la única gramática procesador-asterisco-comercio
   * documentada oficialmente para Chile: Google la publica y el glosario del
   * banco la muestra en una cartola real. Hasta ahora el alias de marca se
   * quedaba con «Google» y borraba justo el dato que la gramática entrega.
   */
  it('lee el sub-comercio que Google documenta después del asterisco', () => {
    const result = at('GOOGLE *GARENA');
    expect(result.processor?.name).toBe('Google');
    expect(result.merchant?.name).toBe('Garena');
    expect(result.merchant?.source).toBe('processor-grammar');
  });

  /**
   * El mismo documento del banco muestra `GOOGLE GARENA` sin asterisco para lo
   * que parece el mismo cargo: el asterisco se pierde en algún punto entre la
   * red y la cartola. Sin él no hay gramática, y sin gramática no se adivina.
   */
  it('sin asterisco no aplica la gramática', () => {
    expect(at('GOOGLE PLAY STORE GOOG').merchant?.name).toBe('Google');
  });
});

describe('un procesador que sí pasa el nombre del comercio', () => {
  it('Webpay deja ver al comercio cuando el comercio está', () => {
    const result = at('COMPRA WEBPAY PARIS CL');
    expect(result.processor?.name).toBe('Webpay');
    expect(result.merchant?.name).toBe('Paris');
  });

  it('sin comercio detrás, Webpay no se asciende a comercio', () => {
    const result = at('WEBPAY');
    expect(result.processor?.name).toBe('Webpay');
    expect(result.merchant).toBeUndefined();
  });

  /**
   * PayU no está documentado para Chile en ninguna fuente, ni siquiera de
   * terceros. Se trata como pasarela porque es lo que hace, y el candidato
   * queda como candidato — lo que no puede pasar es que «Payu» termine dentro
   * del nombre del comercio, que es lo que ocurría al no reconocerlo.
   */
  it('no mete el nombre de la pasarela dentro del comercio', () => {
    const result = at('PAYU *TIENDA GENERICA');
    expect(result.merchant?.name).not.toContain('Payu');
    expect(result.processor?.name).toBe('PayU');
  });
});

describe('cuando el banco dice que no sabe', () => {
  /**
   * `PAGO ONLINE` es la glosa que Banco Falabella documenta para los comercios
   * "que no tenemos registrados". Es literalmente el banco declarando que no lo
   * sabe, y el pipeline lo leía como un comercio llamado «Online».
   */
  it('una glosa comodín del banco no es un comercio', () => {
    const result = at('PAGO ONLINE');
    expect(result.merchant).toBeUndefined();
    expect(result.unresolved).toBe('bank-placeholder');
  });

  it('un cargo genérico sin nada que leer tampoco lo es', () => {
    expect(at('CARGO NO IDENTIFICADO').merchant?.name).not.toBe('Cargo');
  });
});

describe('lo que la atribución nunca puede hacer', () => {
  it('nunca altera el descriptor original', () => {
    const descriptor = 'COMPRA INT WEBPAY *1234 SUPERMERCADO GENERICO LAS CONDES';
    expect(at(descriptor).descriptor).toBe(descriptor);
  });

  it('un comercio directo sin procesador sigue funcionando', () => {
    const result = at('SUPERMERCADO LIDER LAS CONDES');
    expect(result.merchant?.name).toBe('Lider');
    expect(result.processor).toBeUndefined();
  });

  it('una glosa vacía no produce ni comercio ni procesador', () => {
    const result = at('');
    expect(result.merchant).toBeUndefined();
    expect(result.processor).toBeUndefined();
  });
});

/**
 * El panel no lee el pipeline: reconstruye los movimientos desde las
 * actividades que el host guarda. Si la atribución no sobrevive ese viaje, todo
 * lo anterior existe sólo durante la importación y el usuario nunca lo ve.
 *
 * No se persiste: se vuelve a calcular desde la glosa, que el `comment` sí
 * guarda. Así el catálogo de procesadores puede corregirse sin reimportar nada,
 * y no hay una segunda copia de la evidencia que pueda quedar obsoleta.
 */
describe('la atribución al releer desde el host', () => {
  const stored = (description: string) => {
    const transaction = makeTransaction({
      amount: -30_000,
      date: '2026-09-10',
      description,
    });
    const create = toActivityCreate(transaction, { accountId: 'acc', runId: 'run' });
    return activityToTransaction({
      id: 'a1',
      activityType: create.activityType,
      amount: create.amount,
      currency: create.currency ?? 'CLP',
      date: create.activityDate as string,
      comment: create.comment ?? '',
      metadata: create.metadata,
    });
  };

  it('vuelve a decir qué procesador ocultó el comercio', () => {
    const reread = stored('MERCADO PAGO 4 TCOM');
    expect(reread?.attribution?.processor?.name).toBe('Mercado Pago');
    expect(reread?.attribution?.unresolved).toBe('processor-hides-merchant');
    expect(reread?.merchant).toBeUndefined();
  });

  it('conserva el comercio cuando lo había', () => {
    const reread = stored('SUPERMERCADO LIDER LAS CONDES');
    expect(reread?.merchant).toBe('Lider');
  });
});

/**
 * Un giro de cajero no es un comercio llamado «Cajero Automático».
 *
 * Pelado de su verbo, `GIRO CAJERO AUTOMATICO` deja un nombre plausible que
 * competía en el ranking de comercios contra tiendas reales y fusionaba todos
 * los giros del mes en una fila. Es una operación del banco, no alguien a quien
 * se le pagó.
 */
describe('operaciones del banco que no son comercios', () => {
  it('un giro de cajero no tiene comercio', () => {
    expect(at('GIRO CAJERO AUTOMATICO').merchant).toBeUndefined();
    expect(at('GIRO CAJERO AUTOM. RED').merchant).toBeUndefined();
    expect(at('RETIRO EFECTIVO SUCURSAL').merchant).toBeUndefined();
  });
});
