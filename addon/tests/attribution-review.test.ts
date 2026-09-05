import { describe, expect, it } from 'vitest';
import { buildInstallmentPlans } from '../src/core/installments/plans';
import { activityToTransaction, toActivityCreate } from '../src/core/mapping/activities';
import { attributePayment } from '../src/core/merchants/attribution';
import { unattributedByProcessor } from '../src/core/metrics/monthly';
import { Confidence, TransactionKind } from '../src/core/model/kinds';
import { money } from '../src/core/money';
import { makeTransaction } from './fixtures';

const at = (description: string) => attributePayment(description);

/**
 * Lo que un review especializado encontró en la primera versión de la
 * atribución. Todos los casos son glosas chilenas plausibles, y todos comparten
 * el mismo modo de falla: un nombre creíble donde el sistema ya había decidido
 * que no sabía.
 */
describe('un nombre de comercio que también es el de una pasarela', () => {
  /**
   * `FLOW`, `TOKU` y `KLAP` son palabras que caben en una razón social
   * chilena. Buscadas en cualquier posición borraban el comercio que el banco
   * sí había informado, y encima el panel le atribuía la plata al procesador.
   * Es el mismo error que RC3 tuvo que arreglar con `TAG` dentro de
   * `PATAGONIA`, un nivel más arriba.
   */
  it('un restorán llamado Sushi Flow no es la pasarela Flow', () => {
    const result = at('SUSHI FLOW LAS CONDES');
    expect(result.processor).toBeUndefined();
    expect(result.merchant?.name).toBe('Sushi Flow');
  });

  it('Toku Sushi es un restorán', () => {
    expect(at('TOKU SUSHI PROVIDENCIA').processor).toBeUndefined();
  });

  it('una razón social con Klap adentro no es la pasarela', () => {
    expect(at('TIENDA KLAP LTDA').processor).toBeUndefined();
  });

  /**
   * Donde el procesador sí encabeza la glosa —o trae su propio dominio— se
   * reconoce igual que antes.
   */
  it('el procesador al principio de la glosa sigue reconociéndose', () => {
    expect(at('FLOW').processor?.name).toBe('Flow');
    expect(at('PAGO FLOW').processor?.name).toBe('Flow');
    expect(at('PAGOS.FLOW.CL').processor?.name).toBe('Flow');
    expect(at('FLOW*BIP RECARGA').processor?.name).toBe('Flow');
  });
});

describe('cuando la glosa nombra dos intermediarios', () => {
  /**
   * El catálogo se recorría en orden de arreglo, así que ganaba el que
   * estuviera antes en el archivo y no el que estuviera antes en la glosa —
   * y sólo se pelaba ése. El nombre de la otra pasarela quedaba pegado al del
   * comercio, que es exactamente lo que la capa existe para evitar.
   */
  it('gana el que aparece primero en la glosa, y se pelan los dos', () => {
    const result = at('COMPRA WEBPAY PAYU TIENDA GENERICA');
    expect(result.processor?.name).toBe('Webpay');
    expect(result.merchant?.name).not.toContain('Payu');
    expect(result.merchant?.name).not.toContain('Webpay');
  });
});

/**
 * El `4 TCOM` / `5 TCOM` que documenta el glosario de Banco Falabella es un
 * sufijo de ruteo que puede acompañar a cualquier comercio. Tratado como parte
 * del patrón de Mercado Pago quedaba sin limpiar en todas las demás filas, y un
 * mismo local se partía en dos del ranking según el dígito.
 */
describe('el sufijo de ruteo no es parte de ningún nombre', () => {
  it('dos cargos del mismo local no se parten por el dígito', () => {
    expect(at('SUSHI GENERICO 4 TCOM').merchant?.name).toBe(
      at('SUSHI GENERICO 5 TCOM').merchant?.name,
    );
  });

  it('tampoco se pega al sub-comercio de una gramática', () => {
    expect(at('GOOGLE *GARENA 4 TCOM SANTIAGO').merchant?.name).toBe('Garena');
  });
});

describe('la confianza que un procesador oculto permite', () => {
  /**
   * El archivo declara que en un procesador `hidden` lo que queda no es el
   * comercio. Un token de marca dentro de ese texto no puede entonces salir con
   * la confianza más alta del sistema: `BIP` y `EASY` son palabras de tres y
   * cuatro letras que aparecen como nombre de vendedor o referencia de orden.
   */
  it('una marca dentro de un procesador oculto es candidata, no certeza', () => {
    const result = at('FPAY FALABELLA');
    expect(result.merchant?.name).toBe('Falabella');
    expect(result.merchant?.confidence).toBe(Confidence.suggested);
  });

  it('sin procesador, una marca reconocida sigue siendo certeza', () => {
    expect(at('SUPERMERCADO LIDER LAS CONDES').merchant?.confidence).toBe(Confidence.confirmed);
  });
});

/**
 * Un cashback con Redcompra en el supermercado es una operación real: la glosa
 * nombra el retiro y también el comercio. El comodín del banco ganaba y
 * descartaba a Lider.
 */
describe('un retiro que además nombra un comercio', () => {
  it('la marca gana al comodín del banco', () => {
    expect(at('RETIRO DE EFECTIVO REDCOMPRA LIDER').merchant?.name).toBe('Lider');
  });

  it('un retiro sin comercio sigue sin comercio', () => {
    expect(at('GIRO CAJERO AUTOMATICO').merchant).toBeUndefined();
  });
});

/**
 * El panel dice, de un procesador nombrado, que «no informa el comercio». Es
 * una afirmación sobre un tercero, y el propio catálogo dice lo contrario de
 * Webpay: es una pasarela que normalmente sí pasa el nombre que el comercio
 * configuró. Que en una fila no lo haya traído no autoriza la acusación.
 */
describe('a quién se le atribuye la falta de comercio', () => {
  const spend = (description: string, amount: number) => {
    const attribution = attributePayment(description);
    return makeTransaction({
      description,
      amount: -amount,
      date: '2026-09-10',
      attribution,
      ...(attribution.merchant ? { merchant: attribution.merchant.name } : {}),
    });
  };

  it('sólo se nombra a los que por diseño no lo informan', () => {
    const groups = unattributedByProcessor([
      spend('MERCADO PAGO', 30_000),
      spend('COMPRA WEBPAY 1234', 12_000),
    ]);
    expect(groups.map((g) => g.processor)).toEqual(['Mercado Pago']);
  });
});

/**
 * El panel no lee el pipeline: reconstruye desde el `comment` que se guardó, y
 * `buildComment` le agrega el marcador de cuota. Ese sufijo hacía que los
 * comodines anclados del banco dejaran de matchear, y la misma fila que el
 * preview mostró «sin comercio» aparecía en el panel como un comercio llamado
 * «Online Cuota 3».
 */
describe('la relectura no puede inventar lo que el import descartó', () => {
  const roundTrip = (description: string, installment?: { current: number; total: number }) => {
    const transaction = makeTransaction({
      amount: -30_000,
      date: '2026-09-10',
      description,
      kind: TransactionKind.credit_card_purchase,
      ...(installment
        ? {
            installment: {
              current: installment.current,
              total: installment.total,
              confidence: Confidence.confirmed,
              matchedText: `${installment.current}/${installment.total}`,
            },
          }
        : {}),
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

  it('el marcador de cuota no convierte un comodín en un comercio', () => {
    expect(roundTrip('PAGO ONLINE', { current: 3, total: 12 })?.merchant).toBeUndefined();
  });

  it('ni resucita un comercio de un procesador que lo oculta', () => {
    expect(
      roundTrip('MERCADO PAGO 4 TCOM', { current: 3, total: 12 })?.merchant,
    ).toBeUndefined();
  });

  it('un comercio real sobrevive al marcador', () => {
    expect(roundTrip('SUPERMERCADO LIDER', { current: 2, total: 6 })?.merchant).toBe('Lider');
  });
});

/**
 * Los planes de cuotas se agrupaban y se rotulaban con un fallback anterior a
 * la atribución, que devolvía justo el nombre que la atribución se negó a dar.
 * El panel decía «sin comercio» y el plan decía «4 Tcom».
 */
describe('los planes de cuotas usan la misma atribución que el resto', () => {
  it('un plan de un procesador oculto no recibe un nombre inventado', () => {
    const plans = buildInstallmentPlans([
      makeTransaction({
        amount: -30_000,
        date: '2026-09-10',
        description: 'MERCADO PAGO TIENDA 4 TCOM',
        kind: TransactionKind.credit_card_purchase,
        installment: {
          current: 3,
          total: 12,
          confidence: Confidence.confirmed,
          matchedText: '3/12',
        },
      }),
    ]);

    for (const plan of plans) {
      expect(plan.merchant).not.toContain('Tcom');
      expect(plan.merchant).not.toContain('Mercado Pago');
    }
  });
});

/**
 * Toda métrica de este archivo filtra por moneda antes de sumar. Ésta era la
 * única que confiaba en que el llamador le pasara una sola: sumar CLP y USD
 * lanza —correctamente— y una excepción dentro de una métrica se lleva el panel
 * entero, que es justo la regresión que las vistas por moneda vinieron a
 * terminar.
 */
describe('el desglose por procesador y las monedas', () => {
  it('no revienta con monedas mezcladas', () => {
    const clp = attributePayment('MERCADO PAGO');
    const rows = [
      makeTransaction({ amount: -30_000, date: '2026-09-10', description: 'MERCADO PAGO', attribution: clp }),
      {
        ...makeTransaction({ amount: -50, date: '2026-09-11', description: 'MERCADO PAGO', attribution: clp }),
        amount: money(-50, 2, 'USD'),
      },
    ];

    expect(() => unattributedByProcessor(rows, { currency: 'CLP' })).not.toThrow();
    expect(unattributedByProcessor(rows, { currency: 'CLP' })[0]?.amount.minor).toBe(30_000);
  });
});
