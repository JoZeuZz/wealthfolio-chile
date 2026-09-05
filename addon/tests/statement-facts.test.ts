import { describe, expect, it } from 'vitest';
import {
  CARD_FACT_KEYS,
  cardFactLabel,
  declared,
  derived,
  factPresence,
  type CreditCardStatementFacts,
} from '../src/core/model/statement-facts';
import { money } from '../src/core/money';

/**
 * Los hechos de un estado de cuenta de tarjeta.
 *
 * Qué campos existe está establecido: la CMF enumera trece elementos que el
 * estado de cuenta debe mostrar, y el artículo 26 del reglamento que entra en
 * vigencia en 2028 los detalla uno por uno. Dónde aparece cada uno en la
 * cartola que un banco chileno emite hoy no está documentado en ninguna parte
 * pública, y no se va a adivinar.
 *
 * Por eso este modelo se construye ahora y su extracción no: tener el contrato
 * listo es lo que hace que la primera cartola real sirva de inmediato, e
 * inventar el extractor sería declarar soporte de un formato que nadie
 * verificó.
 */
describe('un hecho sabe de dónde salió', () => {
  it('distingue lo que el documento declara de lo que se calculó', () => {
    const printed = declared(money(45_000, 0, 'CLP'));
    const computed = derived(money(45_000, 0, 'CLP'));

    expect(printed.source).toBe('declared');
    expect(computed.source).toBe('derived');
    expect(printed.value).toEqual(computed.value);
  });

  /**
   * La distinción no es decorativa: un monto facturado que el emisor imprimió
   * es la deuda que el emisor reconoce, y uno sumado por el addon a partir de
   * las líneas es una estimación que puede no incluir lo que no leímos. Que se
   * vean iguales en la interfaz sería el error.
   */
  it('un hecho declarado y uno derivado no son intercambiables', () => {
    const printed = declared(money(45_000, 0, 'CLP'));
    const computed = derived(money(45_000, 0, 'CLP'));
    expect(printed).not.toEqual(computed);
  });

  it('puede recordar en qué parte del documento se encontró', () => {
    expect(declared(money(1, 0, 'CLP'), 'summary').where).toBe('summary');
    // Sin la celda original: guardar dónde estaba no es guardar qué decía.
    expect(Object.keys(declared(money(1, 0, 'CLP'), 'summary'))).toEqual([
      'value',
      'source',
      'where',
    ]);
  });
});

/**
 * Ausente es ausente. `minimumPayment: 0` diría que este mes no hay que pagar
 * nada, que es una afirmación distinta de "el archivo no lo dijo" y mucho peor
 * que no decir nada.
 */
describe('lo que no está declarado no vale cero', () => {
  it('un estado de cuenta vacío no afirma ningún monto', () => {
    const facts: CreditCardStatementFacts = {};
    for (const key of CARD_FACT_KEYS) {
      expect(facts[key]).toBeUndefined();
    }
  });

  it('el informe de presencia distingue encontrado de no encontrado', () => {
    const presence = factPresence({
      minimumPayment: declared(money(35_000, 0, 'CLP')),
      dueDate: declared('2026-10-05'),
    });

    const found = presence.filter((entry) => entry.found).map((entry) => entry.key);
    expect(found).toEqual(['dueDate', 'minimumPayment']);
    expect(presence.length).toBe(CARD_FACT_KEYS.length);
  });

  /**
   * El informe de calibración se pega en un issue. Dice qué se encontró, jamás
   * cuánto: un pago mínimo es una cifra sobre la deuda de una persona.
   */
  it('el informe de presencia no lleva ningún valor', () => {
    const presence = factPresence({
      minimumPayment: declared(money(35_000, 0, 'CLP')),
      billedAmount: declared(money(412_900, 0, 'CLP')),
    });
    const serialized = JSON.stringify(presence);

    expect(serialized).not.toContain('35000');
    expect(serialized).not.toContain('412900');
    expect(serialized).not.toContain('CLP');
  });

  it('todos los hechos tienen nombre en español', () => {
    for (const key of CARD_FACT_KEYS) {
      expect(cardFactLabel(key).length).toBeGreaterThan(3);
    }
  });
});

/**
 * Los hechos del estado de cuenta no son balances.
 *
 * `openingBalance` y `closingBalance` describen el recorrido de una cuenta: se
 * suman con los movimientos y el resultado se compara. Un monto facturado, un
 * pago mínimo y un cupo disponible no participan de esa aritmética, y meterlos
 * ahí porque los cuatro son `Money` borraría la única diferencia que importa.
 */
describe('los hechos de la tarjeta viven aparte de los balances', () => {
  it('el modelo de hechos no incluye balances de recorrido', () => {
    expect(CARD_FACT_KEYS).not.toContain('openingBalance');
    expect(CARD_FACT_KEYS).not.toContain('closingBalance');
  });

  it('separa la deuda nacional de la deuda en moneda extranjera', () => {
    expect(CARD_FACT_KEYS).toContain('domesticDebt');
    expect(CARD_FACT_KEYS).toContain('foreignDebt');
  });
});
